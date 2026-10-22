import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io as createClient } from 'socket.io-client';
import { createRoomServer } from '../server/index.mjs';

function nextEvent(socket, event, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`Timed out waiting for ${event}`)); }, timeoutMs);
    function listener(data) {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(data);
    }
    socket.on(event, listener);
  });
}
const request = (socket, event, payload = {}) => socket.timeout(2000).emitWithAck(event, payload);
async function success(socket, event, payload = {}) {
  const response = await request(socket, event, payload);
  assert.equal(response.ok, true, `${event}: ${response.error ?? ''}`);
  return response.data;
}

async function fixture(t, options = {}) {
  const server = createRoomServer({ staticDir: false, ...options });
  const address = await server.listen(0);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.disconnect();
    await server.close();
  });
  return {
    ...address,
    server,
    async client(clientOptions = {}) {
      const socket = createClient(address.url, { transports: ['websocket'], forceNew: true, reconnection: false, ...clientOptions });
      clients.push(socket);
      await nextEvent(socket, 'connect');
      return socket;
    },
  };
}
const hostProfile = { nickname: '치이', character: 'chiikawa' };
const guestProfile = { nickname: '하치', character: 'hachiware' };

test('all eight selectable characters can create a room and appear in snapshots', async (t) => {
  const f = await fixture(t);
  const ids = ['chiikawa', 'hachiware', 'usagi', 'momonga', 'kurimanju', 'shisa', 'rakko', 'furuhonya'];
  for (const character of ids) {
    const client = await f.client();
    const created = await success(client, 'room:create', { nickname: character, character });
    assert.equal(created.room.members[0].character, character);
  }
});
async function createRoom(host) { return success(host, 'room:create', hostProfile); }
async function joinRoom(host, guest, code, profile = guestProfile) {
  const pending = await success(guest, 'room:join', { code, ...profile });
  assert.equal(pending.pending, true);
  const approved = nextEvent(guest, 'join:approved');
  await success(host, 'room:approve', { requestId: pending.requestId });
  return approved;
}

function assertNoPrivateFields(value) {
  const serialized = JSON.stringify(value);
  for (const field of ['token', 'socketId', 'sent', 'timer', 'disconnectedAt']) assert.equal(serialized.includes(`"${field}":`), false, `${field} leaked`);
}

test('create → host approval → chat; retries are deduplicated and snapshots keep credentials private', async (t) => {
  const f = await fixture(t);
  const host = await f.client();
  const guest = await f.client();
  const third = await f.client();
  const created = await createRoom(host);
  assert.match(created.room.code, /^[A-Z2-9]{8}$/u);
  assert.equal(created.room.hostId, created.session.memberId);
  assert.ok(created.session.token.length >= 40);
  assertNoPrivateFields(created.room);
  assert.deepEqual(await (await fetch(`${f.url}/health`)).json(), { ok: true, rooms: 1 });

  const hostPending = nextEvent(host, 'room:state', (room) => room.pending.length === 1);
  const joining = await success(guest, 'room:join', { code: created.room.code.toLowerCase(), ...guestProfile });
  assert.equal((await hostPending).pending[0].id, joining.requestId);
  assert.equal((await request(guest, 'chat:send', { clientId: randomUUID(), text: '아직 입장 전' })).code, 'NOT_IN_ROOM');
  const approved = nextEvent(guest, 'join:approved');
  await success(host, 'room:approve', { requestId: joining.requestId });
  const joined = await approved;
  assert.equal(joined.room.members.length, 2);
  assert.equal(joined.room.pending.length, 0);
  assertNoPrivateFields(joined.room);
  assert.notEqual(joined.session.token, created.session.token);

  const guestState = nextEvent(guest, 'room:state');
  const hostState = nextEvent(host, 'room:state', (room) => room.pending.length === 1);
  await success(third, 'room:join', { code: created.room.code, nickname: '우사', character: 'usagi' });
  assert.equal((await guestState).pending.length, 0);
  assert.equal((await hostState).pending.length, 1);

  const received = [];
  guest.on('chat:message', (message) => received.push(message));
  const incoming = nextEvent(guest, 'chat:message');
  const payload = { clientId: randomUUID(), text: '안녕 🐰' };
  const first = await success(host, 'chat:send', payload);
  assert.equal((await incoming).id, first.message.id);
  const second = await success(host, 'chat:send', payload);
  assert.equal(second.message.id, first.message.id);
  const resumed = await success(guest, 'room:resume', joined.session);
  assert.equal(resumed.room.messages.length, 1);
  assert.equal(received.length, 1);
  assert.equal(resumed.room.messages[0].text, payload.text);
});

test('all host operations reject guests; kick revokes access and resume credentials', async (t) => {
  const f = await fixture(t);
  const host = await f.client();
  const guest = await f.client();
  const created = await createRoom(host);
  const joined = await joinRoom(host, guest, created.room.code);
  for (const [event, payload] of [
    ['room:approve', { requestId: 'missing' }], ['room:reject', { requestId: 'missing' }],
    ['room:kick', { memberId: created.session.memberId }], ['room:lock', { locked: true }],
    ['room:rotate-code', {}], ['room:transfer', { memberId: joined.session.memberId }],
  ]) assert.equal((await request(guest, event, payload)).code, 'HOST_ONLY', event);

  const removed = nextEvent(guest, 'room:removed');
  await success(host, 'room:kick', { memberId: joined.session.memberId });
  assert.ok((await removed).reason);
  assert.equal((await request(guest, 'chat:send', { clientId: randomUUID(), text: '다시' })).code, 'NOT_IN_ROOM');
  assert.equal((await request(guest, 'room:resume', joined.session)).code, 'INVALID_SESSION');
  const freshConnection = await f.client();
  assert.equal((await request(freshConnection, 'room:resume', joined.session)).code, 'INVALID_SESSION');
  // A fresh entry request always needs host approval, including after a kick.
  assert.equal((await success(freshConnection, 'room:join', { code: created.room.code, ...guestProfile })).pending, true);
});

test('host reconnect retains authority during grace; absence transfers it to the oldest online member', async (t) => {
  const f = await fixture(t, { hostGraceMs: 150 });
  const host = await f.client();
  const guest = await f.client();
  const created = await createRoom(host);
  const joined = await joinRoom(host, guest, created.room.code);
  const offline = nextEvent(guest, 'room:state', (room) => room.members.some((member) => member.id === created.session.memberId && !member.online));
  host.disconnect();
  assert.equal((await offline).hostId, created.session.memberId);
  const returning = await f.client();
  const resumed = await success(returning, 'room:resume', created.session);
  assert.equal(resumed.room.hostId, created.session.memberId);
  assert.equal(resumed.session.memberId, created.session.memberId);
  const transferred = nextEvent(guest, 'room:state', (room) => room.hostId === joined.session.memberId);
  returning.disconnect();
  assert.equal((await transferred).hostId, joined.session.memberId);
  const lateHost = await f.client();
  const lateResume = await success(lateHost, 'room:resume', created.session);
  assert.equal(lateResume.room.hostId, joined.session.memberId);
  assert.equal((await request(lateHost, 'room:lock', { locked: true })).code, 'HOST_ONLY');
  await success(guest, 'room:transfer', { memberId: created.session.memberId });
  await success(lateHost, 'room:lock', { locked: true });
});

test('room isolation, Unicode length validation, and bounded recent history', async (t) => {
  const f = await fixture(t, { maxMessages: 2 });
  const firstHost = await f.client();
  const secondHost = await f.client();
  const first = await createRoom(firstHost);
  const second = await createRoom(secondHost);
  assert.notEqual(first.room.id, second.room.id);
  const leaked = [];
  secondHost.on('chat:message', (message) => leaked.push(message));
  assert.equal((await request(firstHost, 'chat:send', { clientId: randomUUID(), text: ' ' })).code, 'INVALID_MESSAGE');
  assert.equal((await request(firstHost, 'chat:send', { clientId: randomUUID(), text: '🐰'.repeat(201) })).code, 'INVALID_MESSAGE');
  assert.equal((await request(firstHost, 'profile:update', { nickname: '가'.repeat(21), character: 'chiikawa' })).code, 'INVALID_PROFILE');
  await success(firstHost, 'chat:send', { clientId: randomUUID(), text: '🐰'.repeat(200) });
  await success(firstHost, 'chat:send', { clientId: randomUUID(), text: '둘' });
  await success(firstHost, 'chat:send', { clientId: randomUUID(), text: '셋' });
  const state = await success(firstHost, 'room:resume', first.session);
  assert.deepEqual(state.room.messages.map((message) => message.text), ['둘', '셋']);
  const otherState = await success(secondHost, 'room:resume', second.session);
  assert.deepEqual(otherState.room.messages, []);
  assert.deepEqual(leaked, []);
  assert.equal((await request(secondHost, 'room:kick', { memberId: first.session.memberId })).code, 'MEMBER_NOT_FOUND');
});

test('pending disconnect is cleaned; lock, code rotation, rejection, and explicit leave work', async (t) => {
  const f = await fixture(t);
  const host = await f.client();
  const waiting = await f.client();
  const created = await createRoom(host);
  const pending = await success(waiting, 'room:join', { code: created.room.code, ...guestProfile });
  const cleared = nextEvent(host, 'room:state', (room) => room.pending.length === 0);
  waiting.disconnect();
  await cleared;
  assert.equal((await request(host, 'room:approve', { requestId: pending.requestId })).code, 'REQUEST_NOT_FOUND');
  const guest = await f.client();
  await success(host, 'room:lock', { locked: true });
  assert.equal((await request(guest, 'room:join', { code: created.room.code, ...guestProfile })).code, 'ROOM_LOCKED');
  const rotated = await success(host, 'room:rotate-code');
  assert.notEqual(rotated.code, created.room.code);
  await success(host, 'room:lock', { locked: false });
  assert.equal((await request(guest, 'room:join', { code: created.room.code, ...guestProfile })).code, 'ROOM_NOT_FOUND');
  const pendingAgain = await success(guest, 'room:join', { code: rotated.code, ...guestProfile });
  const rejected = nextEvent(guest, 'join:rejected');
  await success(host, 'room:reject', { requestId: pendingAgain.requestId });
  assert.ok((await rejected).reason);
  const joined = await joinRoom(host, guest, rotated.code);
  const transferred = nextEvent(guest, 'room:state', (room) => room.hostId === joined.session.memberId);
  await success(host, 'room:leave');
  await transferred;
  assert.equal((await request(host, 'room:resume', created.session)).code, 'INVALID_SESSION');
  await success(guest, 'room:leave');
  assert.equal((await request(guest, 'room:resume', joined.session)).code, 'INVALID_SESSION');
  assert.deepEqual(await (await fetch(`${f.url}/health`)).json(), { ok: true, rooms: 0 });
});

test('capacity and rate limits are enforced; duplicate retries do not spend the chat allowance', async (t) => {
  const f = await fixture(t, { maxMembers: 2, rateLimits: { chat: { limit: 1, windowMs: 60_000 } } });
  const host = await f.client();
  const guest = await f.client();
  const extra = await f.client();
  const created = await createRoom(host);
  await joinRoom(host, guest, created.room.code);
  assert.equal((await request(extra, 'room:join', { code: created.room.code, ...guestProfile })).code, 'ROOM_FULL');
  const payload = { clientId: randomUUID(), text: '한 번' };
  const first = await success(host, 'chat:send', payload);
  const duplicate = await success(host, 'chat:send', payload);
  assert.equal(first.message.id, duplicate.message.id);
  assert.equal((await request(host, 'chat:send', { clientId: randomUUID(), text: '두 번' })).code, 'RATE_LIMITED');
});

test('room creation and entry attempts are rate limited across connections from the same address', async (t) => {
  const f = await fixture(t, { rateLimits: { create: { limit: 1, windowMs: 60_000 }, join: { limit: 1, windowMs: 60_000 } } });
  const host = await f.client();
  const other = await f.client();
  const created = await createRoom(host);
  assert.equal((await request(other, 'room:create', guestProfile)).code, 'RATE_LIMITED');
  assert.equal((await request(other, 'room:join', { code: 'MISSING1', ...guestProfile })).code, 'ROOM_NOT_FOUND');
  const retry = await f.client();
  assert.equal((await request(retry, 'room:join', { code: created.room.code, ...guestProfile })).code, 'RATE_LIMITED');
  assert.equal((await request(retry, 'room:resume', { roomId: created.room.id, token: '가'.repeat(created.session.token.length) })).code, 'INVALID_SESSION');
});

test('offline reservations expire in active rooms; a timely reconnect cancels expiry', async (t) => {
  const f = await fixture(t, { maxMembers: 2, memberReconnectTtlMs: 80 });
  const host = await f.client();
  const guest = await f.client();
  const created = await createRoom(host);
  const joined = await joinRoom(host, guest, created.room.code);
  const offline = nextEvent(host, 'room:state', (room) => room.members.some((member) => member.id === joined.session.memberId && !member.online));
  guest.disconnect();
  await offline;
  const returning = await f.client();
  const resumed = await success(returning, 'room:resume', joined.session);
  assert.equal(resumed.session.memberId, joined.session.memberId);
  await new Promise((resolve) => setTimeout(resolve, 110));
  const retained = await success(host, 'room:resume', created.session);
  assert.equal(retained.room.members.find((member) => member.id === joined.session.memberId)?.online, true);

  const expired = nextEvent(host, 'room:state', (room) => room.members.length === 1);
  returning.disconnect();
  assert.equal((await expired).hostId, created.session.memberId);
  const replacement = await f.client();
  assert.equal((await request(replacement, 'room:resume', joined.session)).code, 'INVALID_SESSION');
  const replacementJoined = await joinRoom(host, replacement, created.room.code);
  assert.equal(replacementJoined.room.members.length, 2);
  assert.notEqual(replacementJoined.session.memberId, joined.session.memberId);

  // With nobody online, the room's longer recovery window still applies. The
  // first returnee then frees other expired reservations immediately.
  host.disconnect();
  replacement.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 110));
  const hostReturning = await f.client();
  const recovered = await success(hostReturning, 'room:resume', created.session);
  assert.equal(recovered.room.members.length, 1);
  assert.equal(recovered.room.hostId, created.session.memberId);
  const expiredReplacement = await f.client();
  assert.equal((await request(expiredReplacement, 'room:resume', replacementJoined.session)).code, 'INVALID_SESSION');
});

test('empty rooms expire and pending requests time out', async (t) => {
  const f = await fixture(t, { emptyRoomTtlMs: 70, pendingTtlMs: 40 });
  const host = await f.client();
  const guest = await f.client();
  const created = await createRoom(host);
  const rejected = nextEvent(guest, 'join:rejected');
  await success(guest, 'room:join', { code: created.room.code, ...guestProfile });
  assert.match((await rejected).reason, /시간/u);
  host.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await request(guest, 'room:resume', created.session)).code, 'INVALID_SESSION');
  assert.deepEqual(await (await fetch(`${f.url}/health`)).json(), { ok: true, rooms: 0 });
});

test('origin checks accept desktop/loopback/configured origins and reject other browser origins', async (t) => {
  const f = await fixture(t, { allowedOrigins: ['https://friends.example'] });
  for (const origin of ['null', 'http://localhost:5173', 'https://friends.example']) {
    const client = await f.client({ extraHeaders: { Origin: origin } });
    assert.equal(client.connected, true);
  }
  const blocked = createClient(f.url, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://unknown.example' } });
  t.after(() => blocked.disconnect());
  const error = await nextEvent(blocked, 'connect_error');
  assert.ok(error);
  assert.equal(blocked.connected, false);
});
