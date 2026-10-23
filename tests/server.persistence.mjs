import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { io as createClient } from 'socket.io-client';
import { createRoomServer } from '../server/index.mjs';

function connected(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

async function request(socket, event, payload = {}) {
  const result = await socket.timeout(2000).emitWithAck(event, payload);
  assert.equal(result.ok, true, `${event}: ${result.error ?? ''}`);
  return result.data;
}

test('active room, code, roles, chat and idempotent retries survive a server restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'corner-room-state-'));
  const stateFile = join(directory, 'rooms.json');
  const instances = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.disconnect();
    for (const instance of instances) if (!instance.closed) await instance.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function start() {
    const server = createRoomServer({ staticDir: false, stateFile });
    const address = await server.listen(0);
    const instance = {
      server, url: address.url, closed: false,
      async close() { if (this.closed) return; this.closed = true; await this.server.close(); },
    };
    instances.push(instance);
    return instance;
  }
  async function client(instance) {
    const socket = createClient(instance.url, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { characterSet: 8 } });
    clients.push(socket);
    await connected(socket);
    return socket;
  }
  const first = await start();
  const host = await client(first);
  const guest = await client(first);
  const created = await request(host, 'room:create', { nickname: '치이', character: 'chiikawa' });
  assert.equal(created.room.members[0].hasChatted, false);
  assert.equal(created.room.members[0].lastChatAt, created.room.members[0].joinedAt);
  const joined = await request(guest, 'room:join', { code: created.room.code, nickname: '하치', character: 'hachiware' });
  const messagePayload = { clientId: randomUUID(), text: '업데이트 뒤에도 같이 놀자' };
  const sent = await request(host, 'chat:send', messagePayload);
  const before = await request(host, 'room:resume', created.session);
  assert.equal(before.room.members[0].hasChatted, true);
  assert.equal(before.room.members[0].lastChatAt, sent.message.sentAt);
  assert.equal(before.room.members[1].hasChatted, false);
  await request(host, 'room:lock', { locked: true });
  const rotated = await request(host, 'room:rotate-code');
  await first.close(); // Simulates replacing the process while both clients are online.

  const stored = readFileSync(stateFile, 'utf8');
  assert.equal(stored.includes(created.session.token), false, 'raw session credentials must not be persisted');
  assert.equal(stored.includes(joined.session.token), false);
  if (process.platform !== 'win32') assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(stored).rooms[0].code, rotated.code);

  const second = await start();
  assert.deepEqual(await (await fetch(`${second.url}/health`)).json(), { ok: true, rooms: 1 });
  const resumedHostSocket = await client(second);
  const resumedGuestSocket = await client(second);
  const resumedHost = await request(resumedHostSocket, 'room:resume', created.session);
  const resumedGuest = await request(resumedGuestSocket, 'room:resume', joined.session);
  assert.equal(resumedHost.room.id, created.room.id);
  assert.equal(resumedHost.room.code, rotated.code);
  assert.equal(resumedHost.room.hostId, created.session.memberId);
  assert.equal(resumedGuest.room.members.length, 2);
  assert.equal(resumedGuest.room.messages[0].id, sent.message.id);
  assert.equal(resumedGuest.room.members[0].lastChatAt, sent.message.sentAt);
  assert.equal(resumedGuest.room.members[0].hasChatted, true);
  assert.equal((await request(resumedHostSocket, 'chat:send', messagePayload)).message.id, sent.message.id);
  const afterRetry = (await request(resumedHostSocket, 'room:resume', created.session)).room;
  assert.equal(afterRetry.messages.length, 1);
  assert.equal(afterRetry.members[0].lastChatAt, sent.message.sentAt, 'retry must not reset the idle clock');

  // Lock and kick protections must also survive, including code rotation.
  const stranger = await client(second);
  assert.equal((await stranger.timeout(2000).emitWithAck('room:join', { code: rotated.code, nickname: '새 친구', character: 'usagi' })).code, 'ROOM_LOCKED');
  await request(resumedHostSocket, 'room:kick', { memberId: joined.session.memberId });
  const newCode = (await request(resumedHostSocket, 'room:resume', created.session)).room.code;
  assert.notEqual(newCode, rotated.code);
  await second.close();
  const third = await start();
  const returner = await client(third);
  assert.equal((await request(returner, 'room:resume', created.session)).room.code, newCode);
  const expelled = await client(third);
  assert.equal((await expelled.timeout(2000).emitWithAck('room:resume', joined.session)).code, 'INVALID_SESSION');
  assert.equal((await expelled.timeout(2000).emitWithAck('room:join', { code: rotated.code, nickname: '하치', character: 'hachiware' })).code, 'ROOM_NOT_FOUND');
});

test('unsupported state file blocks startup without overwriting it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'corner-invalid-state-'));
  const stateFile = join(directory, 'rooms.json');
  const original = '{"version":99,"rooms":[]}';
  try {
    writeFileSync(stateFile, original);
    assert.throws(() => createRoomServer({ staticDir: false, stateFile }), /지원하지 않는 방 저장 형식/u);
    assert.equal(readFileSync(stateFile, 'utf8'), original);
  } finally {
    rmSync(dirname(stateFile), { recursive: true, force: true });
  }
});

test('a failed durable write stops later room actions instead of acknowledging unpersisted state', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'corner-broken-storage-'));
  const stateFile = join(directory, 'storage', 'rooms.json');
  const server = createRoomServer({ staticDir: false, stateFile });
  const address = await server.listen(0);
  const socket = createClient(address.url, { transports: ['websocket'], forceNew: true, reconnection: false });
  t.after(async () => { socket.disconnect(); await server.close(); rmSync(directory, { recursive: true, force: true }); });
  await connected(socket);
  // Turn the would-be storage directory into a file after startup.
  writeFileSync(dirname(stateFile), 'not a directory');
  const first = await socket.timeout(2000).emitWithAck('room:create', { nickname: '치이', character: 'chiikawa' });
  assert.equal(first.code, 'STORAGE_UNAVAILABLE');
  const second = await socket.timeout(2000).emitWithAck('room:create', { nickname: '하치', character: 'hachiware' });
  assert.equal(second.code, 'STORAGE_UNAVAILABLE');
  const health = await fetch(`${address.url}/health`);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).ok, false);
});
