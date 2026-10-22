import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { createRoomServer } from '../server/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = process.env.CHROME_EXECUTABLE || (
  process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()
);
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
async function request(socket, event, payload = {}) {
  const response = await socket.timeout(3000).emitWithAck(event, payload);
  assert.equal(response.ok, true, response.error);
  return response.data;
}

// The renderer and Socket.IO browser client run unchanged except that polling is
// forced, exercising the supported fallback when a WebSocket cannot be opened.
async function browserHarness() {
  const result = await build({
    stdin: {
      contents: `
        import React, { useEffect } from 'react';
        import { createRoot } from 'react-dom/client';
        import { useRoom, normalizeServer, parseInvitation } from './src/useRoom';
        window.testNormalizeServer = normalizeServer;
        window.testParseInvitation = parseInvitation;
        function Harness() {
          const room = useRoom(window.testEndpoint);
          useEffect(() => { window.testRoom = room; });
          return React.createElement('div');
        }
        createRoot(document.getElementById('root')).render(React.createElement(Harness));
      `,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'force-polling-for-ordering-test',
      setup(builder) {
        builder.onResolve({ filter: /^socket.io-client$/ }, () => ({ path: 'socket', namespace: 'test-socket' }));
        builder.onLoad({ filter: /.*/, namespace: 'test-socket' }, () => ({
          contents: `
            import { io as connect } from ${JSON.stringify(`${root}/node_modules/socket.io-client/build/esm/index.js`)};
            export function io(url, options) {
              const socket = connect(url, { ...options, transports: ['polling'], upgrade: false,
                auth: { ...options.auth, testCase: window.testCase } });
              window.testEvents = [];
              socket.onAny((event) => window.testEvents.push(event));
              return socket;
            }
          `,
          loader: 'js',
          resolveDir: root,
        }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

test('resume ACK cannot overwrite newer events in the same polling response', {
  skip: !existsSync(chrome) && 'Install Playwright Chromium or set CHROME_EXECUTABLE to run browser ordering checks.',
  timeout: 20_000,
}, async (t) => {
  const server = createRoomServer({ staticDir: false });
  const address = await server.listen(0);
  t.after(() => server.close());
  // Match the public /chiikawa reverse proxy, which strips the route prefix
  // before forwarding polling requests to the ordinary Socket.IO server.
  const prefixedRequests = [];
  const proxy = createServer((incoming, outgoing) => {
    prefixedRequests.push(incoming.url);
    if (!incoming.url.startsWith('/chiikawa/')) { outgoing.writeHead(404).end(); return; }
    const forwarded = httpRequest(`${address.url}${incoming.url.slice('/chiikawa'.length)}`, {
      method: incoming.method, headers: incoming.headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    forwarded.on('error', () => outgoing.writeHead(502).end());
    incoming.pipe(forwarded);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const prefixedEndpoint = `http://127.0.0.1:${proxy.address().port}/chiikawa`;
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  t.after(() => browser.close());
  const bundle = await browserHarness();

  for (const kind of ['chat', 'state', 'removed']) {
    await t.test(`later ${kind} stays authoritative`, async (subtest) => {
      const host = io(address.url, { transports: ['websocket'], auth: { characterSet: 8 }, forceNew: true, reconnection: false });
      const guest = io(address.url, { transports: ['websocket'], forceNew: true, reconnection: false });
      subtest.after(() => { host.disconnect(); guest.disconnect(); });
      await Promise.all([once(host, 'connect'), once(guest, 'connect')]);
      const created = await request(host, 'room:create', { nickname: '방장', character: 'momonga' });
      const pending = await request(guest, 'room:join', { code: created.room.code, nickname: '친구', character: 'hachiware' });
      const approved = once(guest, 'join:approved');
      await request(host, 'room:approve', { requestId: pending.requestId });
      const joined = await approved;
      guest.disconnect();

      let injected = false;
      const onConnection = (socket) => {
        if (socket.handshake.auth?.testCase !== kind) return;
        let originalFlush;
        socket.prependListener('room:resume', () => {
          originalFlush = socket.conn.flush;
          socket.conn.flush = () => {};
        });
        socket.on('room:resume', () => {
          // Hold one poll until the resume ACK and a later real room event are
          // queued together, as happens with a delayed HTTP polling response.
          const hostSocket = server.io.sockets.sockets.get(host.id);
          const [event, payload] = kind === 'chat'
            ? ['chat:send', { clientId: 'after-resume', text: '다시 만났어!' }]
            : kind === 'state'
              ? ['room:lock', { locked: true }]
              : ['room:kick', { memberId: joined.session.memberId }];
          hostSocket.listeners(event)[0](payload, (ack) => assert.equal(ack.ok, true));
          injected = true;
          socket.conn.flush = originalFlush;
          socket.conn.flush();
        });
      };
      server.io.on('connection', onConnection);
      subtest.after(() => server.io.off('connection', onConnection));

      const page = await browser.newPage();
      subtest.after(() => page.close());
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      const endpoint = kind === 'chat' ? prefixedEndpoint : address.url;
      await page.goto(`${endpoint}/health`);
      await page.setContent('<div id="root"></div>');
      await page.evaluate(({ endpoint, session, kind }) => {
        window.testEndpoint = endpoint;
        window.testCase = kind;
        localStorage.setItem(`corner.session:${endpoint}`, JSON.stringify(session));
      }, { endpoint, session: joined.session, kind });
      await page.addScriptTag({ content: bundle });
      await page.waitForFunction(() => window.testRoom?.connected && window.testEvents.length >= 2);
      const observed = await page.evaluate(() => ({
        messages: window.testRoom.room?.messages.map((message) => message.text),
        locked: window.testRoom.room?.locked,
        hasRoom: Boolean(window.testRoom.room),
        hasSession: Boolean(window.testRoom.session),
        savedSession: localStorage.getItem(`corner.session:${window.testEndpoint}`) !== null,
        events: window.testEvents,
      }));
      assert.equal(injected, true);
      assert.deepEqual(pageErrors, []);
      if (kind === 'chat') {
        assert.equal(prefixedRequests.some((url) => url.startsWith('/chiikawa/socket.io/')), true);
        const urls = await page.evaluate(() => ({
          bare: window.testNormalizeServer('https://example.com/'),
          prefixed: window.testNormalizeServer('https://example.com/chiikawa/'),
          invitation: window.testParseInvitation('치이카와 모퉁이 | https://example.com/chiikawa/ | ABC234'),
          codeOnly: window.testParseInvitation('ABC234'),
        }));
        assert.deepEqual(urls, {
          bare: 'https://example.com',
          prefixed: 'https://example.com/chiikawa',
          invitation: { endpoint: 'https://example.com/chiikawa', code: 'ABC234' },
          codeOnly: { code: 'ABC234' },
        });
        assert.deepEqual(observed.events, ['room:state', 'chat:message']);
        assert.deepEqual(observed.messages, ['다시 만났어!']);
      } else if (kind === 'state') {
        assert.deepEqual(observed.events, ['room:state', 'room:state']);
        assert.equal(observed.locked, true);
      } else {
        assert.deepEqual(observed.events, ['room:state', 'room:removed']);
        assert.equal(observed.hasRoom, false);
        assert.equal(observed.hasSession, false);
        assert.equal(observed.savedSession, false);
      }
    });
  }
});
