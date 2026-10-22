import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';

const CHARACTER_IDS = new Set(['chiikawa', 'hachiware', 'usagi', 'momonga', 'kurimanju', 'shisa', 'rakko', 'furuhonya']);
const LEGACY_CHARACTER_IDS = new Set(['chiikawa', 'hachiware', 'usagi']);
const COLORS = ['#e99aaa', '#85b8e3', '#e5bf62', '#a8bd93', '#b5a0d4', '#e6a47b', '#77bcb5', '#be9c88'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEFAULT_LIMITS = {
  create: { limit: 10, windowMs: 60_000 },
  join: { limit: 30, windowMs: 60_000 },
  chat: { limit: 20, windowMs: 10_000 },
};

class RequestError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new RequestError(code, message); };
const countCharacters = (value) => [...value].length;

function profileFrom(payload) {
  if (typeof payload.nickname !== 'string') fail('INVALID_PROFILE', '닉네임을 입력해 줘.');
  const nickname = payload.nickname.trim();
  if (!nickname || countCharacters(nickname) > 20 || /[\u0000-\u001f\u007f]/u.test(nickname)) {
    fail('INVALID_PROFILE', '닉네임은 줄바꿈 없이 1~20자로 입력해 줘.');
  }
  if (!CHARACTER_IDS.has(payload.character)) fail('INVALID_CHARACTER', '캐릭터를 다시 골라 줘.');
  return { nickname, character: payload.character };
}

function sameToken(left, right) {
  if (typeof right !== 'string' || right.length !== left.length) return false;
  const candidate = Buffer.from(right);
  const expected = Buffer.from(left);
  return candidate.length === expected.length && timingSafeEqual(expected, candidate);
}

/**
 * In-memory, single-process room server. No persistence or horizontal scaling.
 * Options: hostGraceMs (60s), memberReconnectTtlMs (5m in active rooms),
 * emptyRoomTtlMs (10m), pendingTtlMs (2m),
 * maxMembers (8), maxMessages (100), maxTextLength (200), maxRooms (1000),
 * allowedOrigins (array), staticDir (directory or false), and rateLimits.
 * Returns { httpServer, io, listen(port = 47831, host = '127.0.0.1'), close() }.
 * listen() resolves to { host, port, url }; close() clears all timers and sockets.
 */
export function createRoomServer(options = {}) {
  const hostGraceMs = options.hostGraceMs ?? 60_000;
  const memberReconnectTtlMs = options.memberReconnectTtlMs ?? 300_000;
  const emptyRoomTtlMs = options.emptyRoomTtlMs ?? 600_000;
  const pendingTtlMs = options.pendingTtlMs ?? 120_000;
  const maxMembers = options.maxMembers ?? 8;
  const maxMessages = options.maxMessages ?? 100;
  const maxTextLength = options.maxTextLength ?? 200;
  const maxRooms = options.maxRooms ?? 1000;
  const configuredOrigins = options.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const origins = new Set(configuredOrigins.map((origin) => origin.replace(/\/$/u, '')));
  const rateLimits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, value]) => [key, { ...value, ...options.rateLimits?.[key] }]));
  const rooms = new Map();
  const codes = new Map();
  const buckets = new Map();
  let closing = false;

  function originAllowed(origin) {
    if (!origin || origin === 'null' || origin === 'file://') return true;
    if (origins.has(origin.replace(/\/$/u, ''))) return true;
    try {
      const url = new URL(origin);
      return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch { return false; }
  }

  const app = express();
  app.disable('x-powered-by');
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 16_384,
    cors: { origin: (origin, callback) => callback(null, originAllowed(origin)), methods: ['GET', 'POST'] },
    allowRequest: (request, callback) => callback(null, originAllowed(request.headers.origin)),
  });
  app.get('/health', (_request, response) => response.json({ ok: true, rooms: rooms.size }));
  const staticDir = options.staticDir === false ? null : resolve(options.staticDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../dist'));
  if (staticDir && existsSync(resolve(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    app.get('/', (_request, response) => response.sendFile(resolve(staticDir, 'index.html')));
  }

  function limit(action, identity) {
    const policy = rateLimits[action];
    if (policy.limit <= 0) return;
    const key = `${action}:${identity}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.until) {
      bucket = { count: 0, until: now + policy.windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= policy.limit) fail('RATE_LIMITED', '조금 빠른 것 같아. 잠시 기다렸다가 다시 해 줘.');
    bucket.count += 1;
  }
  const bucketCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
  }, 60_000);
  bucketCleanup.unref();

  function characterFor(character, viewer) {
    const characterSet = viewer?.handshake.auth?.characterSet;
    // Older apps only ship three image files. Project outgoing data per socket;
    // a member may reconnect from either version without losing the real choice.
    return (Number.isInteger(characterSet) && characterSet >= 8) || LEGACY_CHARACTER_IDS.has(character) ? character : 'chiikawa';
  }
  const publicMember = (member, viewer) => ({
    id: member.id, nickname: member.nickname, character: characterFor(member.character, viewer),
    color: member.color, online: Boolean(member.socketId), joinedAt: member.joinedAt,
  });
  const publicRequest = (request, viewer) => ({ id: request.id, nickname: request.nickname, character: characterFor(request.character, viewer), requestedAt: request.requestedAt });
  const messageFor = (message, viewer) => ({ ...message, character: characterFor(message.character, viewer) });
  const sessionFor = (room, member) => ({ memberId: member.id, token: member.token, roomId: room.id });
  const snapshot = (room, viewerId, viewer) => ({
    id: room.id, code: room.code, name: room.name, hostId: room.hostId, locked: room.locked,
    members: [...room.members.values()].map((member) => publicMember(member, viewer)),
    messages: room.messages.map((message) => messageFor(message, viewer)),
    pending: viewerId === room.hostId ? [...room.pending.values()].map((request) => publicRequest(request, viewer)) : [],
  });
  function broadcastState(room) {
    if (closing) return;
    for (const member of room.members.values()) {
      const viewer = member.socketId && io.sockets.sockets.get(member.socketId);
      viewer?.emit('room:state', snapshot(room, member.id, viewer));
    }
  }
  function memberContext(socket, hostOnly = false) {
    const membership = socket.data.membership;
    const room = membership && rooms.get(membership.roomId);
    const member = room?.members.get(membership.memberId);
    if (!room || !member || member.socketId !== socket.id) fail('NOT_IN_ROOM', '먼저 방에 들어와 줘.');
    if (hostOnly && room.hostId !== member.id) fail('HOST_ONLY', '방장만 할 수 있어.');
    return { room, member };
  }
  function assertAvailable(socket) {
    if (socket.data.membership) fail('ALREADY_IN_ROOM', '지금 방에서 나간 다음 다른 방에 들어갈 수 있어.');
    if (socket.data.pending) fail('ALREADY_PENDING', '입장 요청을 기다리고 있어. 취소한 다음 다시 해 줘.');
  }
  function newCode() {
    let code;
    do { code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''); } while (codes.has(code));
    return code;
  }
  function newMember(room, socket, profile) {
    const usedColors = new Set([...room.members.values()].map((member) => member.color));
    const member = {
      id: randomUUID(), token: randomBytes(32).toString('base64url'), ...profile,
      color: COLORS.find((color) => !usedColors.has(color)) ?? COLORS[room.members.size % COLORS.length],
      joinedAt: Date.now(), socketId: socket.id, disconnectedAt: null, reconnectTimer: null, sent: new Map(),
    };
    room.members.set(member.id, member);
    socket.data.membership = { roomId: room.id, memberId: member.id };
    return member;
  }
  function removePending(room, requestId, reason) {
    const request = room.pending.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    room.pending.delete(requestId);
    const socket = io.sockets.sockets.get(request.socketId);
    if (socket?.data.pending?.requestId === requestId) delete socket.data.pending;
    if (reason) socket?.emit('join:rejected', { reason });
    return request;
  }
  function destroyRoom(room) {
    clearTimeout(room.hostTimer);
    clearTimeout(room.emptyTimer);
    for (const request of [...room.pending.values()]) removePending(room, request.id, '방이 닫혔어. 새 초대를 받아 줘.');
    for (const member of room.members.values()) {
      clearTimeout(member.reconnectTimer);
      const socket = io.sockets.sockets.get(member.socketId);
      if (socket?.data.membership?.roomId === room.id) delete socket.data.membership;
      socket?.emit('room:removed', { reason: '방이 닫혔어.' });
    }
    rooms.delete(room.id);
    codes.delete(room.code);
  }
  function updateEmptyTimer(room) {
    if (closing) return;
    const online = [...room.members.values()].some((member) => member.socketId);
    if (online) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
      return;
    }
    if (room.emptyTimer) return;
    room.emptyTimer = setTimeout(() => {
      room.emptyTimer = null;
      if (rooms.has(room.id) && ![...room.members.values()].some((member) => member.socketId)) destroyRoom(room);
    }, emptyRoomTtlMs);
    room.emptyTimer.unref();
  }
  function electHost(room, force = false) {
    clearTimeout(room.hostTimer);
    room.hostTimer = null;
    const currentHost = room.members.get(room.hostId);
    if (currentHost?.socketId && !force) return;
    if (currentHost && !force) {
      const remaining = hostGraceMs - (Date.now() - currentHost.disconnectedAt);
      if (remaining > 0) {
        room.hostTimer = setTimeout(() => { if (rooms.has(room.id)) { electHost(room); broadcastState(room); } }, remaining);
        room.hostTimer.unref();
        return;
      }
    }
    const candidates = [...room.members.values()].filter((member) => member.socketId).sort((a, b) => a.joinedAt - b.joinedAt);
    if (candidates[0]) room.hostId = candidates[0].id;
    else if (!currentHost) room.hostId = room.members.keys().next().value ?? '';
  }
  function removeMember(room, member, reason) {
    clearTimeout(member.reconnectTimer);
    member.reconnectTimer = null;
    const socket = io.sockets.sockets.get(member.socketId);
    if (socket?.data.membership?.memberId === member.id) delete socket.data.membership;
    if (reason) socket?.emit('room:removed', { reason });
    room.members.delete(member.id);
    member.token = '';
    member.sent.clear();
    if (room.members.size === 0) { destroyRoom(room); return; }
    if (room.hostId === member.id) electHost(room, true);
    updateEmptyTimer(room);
    broadcastState(room);
  }
  function reconnectExpired(member) {
    return !member.socketId && member.disconnectedAt !== null && Date.now() - member.disconnectedAt >= memberReconnectTtlMs;
  }
  function expireDisconnectedMembers(room) {
    // Empty rooms retain their separate 10-minute recovery window. Once a friend
    // is online again, old offline reservations must stop occupying room slots.
    if (![...room.members.values()].some((member) => member.socketId)) return;
    for (const member of [...room.members.values()]) {
      if (reconnectExpired(member)) removeMember(room, member);
    }
  }

  io.on('connection', (socket) => {
    function handle(event, callback) {
      socket.on(event, (rawPayload, acknowledgement) => {
        const ack = typeof acknowledgement === 'function' ? acknowledgement : () => {};
        try {
          const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};
          ack({ ok: true, data: callback(payload) ?? {} });
        } catch (error) {
          ack({ ok: false, code: error instanceof RequestError ? error.code : 'INTERNAL_ERROR', error: error instanceof RequestError ? error.message : '처리하지 못했어. 잠시 뒤 다시 해 줘.' });
        }
      });
    }

    handle('room:create', (payload) => {
      assertAvailable(socket);
      const profile = profileFrom(payload);
      const name = payload.name == null || payload.name === '' ? `${profile.nickname}의 모퉁이` : payload.name;
      if (typeof name !== 'string' || !name.trim() || countCharacters(name.trim()) > 40 || /[\u0000-\u001f\u007f]/u.test(name)) fail('INVALID_NAME', '방 이름은 줄바꿈 없이 1~40자로 입력해 줘.');
      limit('create', socket.handshake.address);
      if (rooms.size >= maxRooms) fail('SERVER_FULL', '지금 방이 너무 많아. 잠시 뒤 다시 만들어 줘.');
      const room = { id: randomUUID(), code: newCode(), name: name.trim(), hostId: '', locked: false, members: new Map(), pending: new Map(), messages: [], hostTimer: null, emptyTimer: null };
      rooms.set(room.id, room);
      codes.set(room.code, room.id);
      const member = newMember(room, socket, profile);
      room.hostId = member.id;
      return { room: snapshot(room, member.id, socket), session: sessionFor(room, member) };
    });

    handle('room:join', (payload) => {
      assertAvailable(socket);
      const profile = profileFrom(payload);
      limit('join', socket.handshake.address);
      const code = typeof payload.code === 'string' ? payload.code.replace(/[\s-]/gu, '').toUpperCase() : '';
      const room = rooms.get(codes.get(code));
      if (!room) fail('ROOM_NOT_FOUND', '방을 찾지 못했어. 초대 번호를 다시 확인해 줘.');
      expireDisconnectedMembers(room);
      if (room.locked) fail('ROOM_LOCKED', '방장이 입장을 잠가 뒀어.');
      if (room.members.size >= maxMembers) fail('ROOM_FULL', `방에는 ${maxMembers}명까지 함께 있을 수 있어.`);
      if (![...room.members.values()].some((member) => member.socketId)) fail('HOST_UNAVAILABLE', '지금 방에 접속한 친구가 없어. 잠시 뒤 다시 들어와 줘.');
      if (room.pending.size >= 32) fail('TOO_MANY_PENDING', '입장을 기다리는 친구가 많아. 잠시 뒤 다시 해 줘.');
      const request = { id: randomUUID(), socketId: socket.id, ...profile, requestedAt: Date.now(), timer: null };
      request.timer = setTimeout(() => {
        if (rooms.has(room.id)) { removePending(room, request.id, '입장 요청 시간이 지났어. 다시 요청해 줘.'); broadcastState(room); }
      }, pendingTtlMs);
      request.timer.unref();
      room.pending.set(request.id, request);
      socket.data.pending = { roomId: room.id, requestId: request.id };
      broadcastState(room);
      return { pending: true, requestId: request.id };
    });

    handle('room:resume', (payload) => {
      if (socket.data.pending) fail('ALREADY_PENDING', '입장 요청을 취소한 다음 다시 연결해 줘.');
      const room = typeof payload.roomId === 'string' ? rooms.get(payload.roomId) : null;
      const member = room && [...room.members.values()].find((candidate) => sameToken(candidate.token, payload.token));
      if (!room || !member) fail('INVALID_SESSION', '이전 입장 정보가 만료됐어. 새 초대로 다시 들어와 줘.');
      if (reconnectExpired(member) && [...room.members.values()].some((candidate) => candidate.socketId)) {
        removeMember(room, member);
        fail('INVALID_SESSION', '자리를 비운 지 오래되어 입장 정보가 만료됐어. 새 초대로 다시 들어와 줘.');
      }
      if (socket.data.membership && (socket.data.membership.roomId !== room.id || socket.data.membership.memberId !== member.id)) fail('ALREADY_IN_ROOM', '지금 방에서 나간 다음 다시 연결해 줘.');
      const oldSocket = member.socketId && io.sockets.sockets.get(member.socketId);
      if (oldSocket && oldSocket.id !== socket.id) {
        delete oldSocket.data.membership;
        oldSocket.emit('room:removed', { reason: '다른 창에서 다시 연결했어.' });
      }
      socket.data.membership = { roomId: room.id, memberId: member.id };
      clearTimeout(member.reconnectTimer);
      member.reconnectTimer = null;
      member.socketId = socket.id;
      member.disconnectedAt = null;
      expireDisconnectedMembers(room);
      electHost(room);
      updateEmptyTimer(room);
      broadcastState(room);
      return { room: snapshot(room, member.id, socket), session: sessionFor(room, member) };
    });

    handle('room:approve', ({ requestId }) => {
      const { room } = memberContext(socket, true);
      expireDisconnectedMembers(room);
      const request = room.pending.get(requestId);
      if (!request) fail('REQUEST_NOT_FOUND', '이미 처리되었거나 취소된 입장 요청이야.');
      const guest = io.sockets.sockets.get(request.socketId);
      if (!guest?.connected) { removePending(room, requestId); broadcastState(room); fail('REQUEST_NOT_FOUND', '친구의 연결이 끊겼어. 다시 요청해 달라고 해 줘.'); }
      if (room.members.size >= maxMembers) fail('ROOM_FULL', `방에는 ${maxMembers}명까지 함께 있을 수 있어.`);
      removePending(room, requestId);
      const member = newMember(room, guest, { nickname: request.nickname, character: request.character });
      guest.emit('join:approved', { room: snapshot(room, member.id, guest), session: sessionFor(room, member) });
      broadcastState(room);
      return {};
    });

    handle('room:reject', ({ requestId }) => {
      const { room } = memberContext(socket, true);
      if (!room.pending.has(requestId)) fail('REQUEST_NOT_FOUND', '이미 처리되었거나 취소된 입장 요청이야.');
      removePending(room, requestId, '방장이 이번 입장 요청을 받지 않았어.');
      broadcastState(room);
      return {};
    });

    handle('room:leave', () => {
      if (socket.data.pending) {
        const room = rooms.get(socket.data.pending.roomId);
        if (room) { removePending(room, socket.data.pending.requestId); broadcastState(room); }
        else delete socket.data.pending;
      }
      if (socket.data.membership) {
        const { room, member } = memberContext(socket);
        removeMember(room, member);
      }
      return {};
    });

    handle('room:kick', ({ memberId }) => {
      const { room } = memberContext(socket, true);
      const target = room.members.get(memberId);
      if (!target) fail('MEMBER_NOT_FOUND', '이미 방에서 나간 친구야.');
      if (memberId === room.hostId) fail('CANNOT_KICK_HOST', '방장은 나가기 버튼을 이용해 줘.');
      removeMember(room, target, '방장이 방에서 내보냈어.');
      return {};
    });

    handle('room:lock', ({ locked }) => {
      const { room } = memberContext(socket, true);
      if (typeof locked !== 'boolean') fail('INVALID_LOCK', '입장 잠금 값을 다시 확인해 줘.');
      room.locked = locked;
      broadcastState(room);
      return {};
    });

    handle('room:rotate-code', () => {
      const { room } = memberContext(socket, true);
      const replacement = newCode();
      codes.delete(room.code);
      room.code = replacement;
      codes.set(room.code, room.id);
      broadcastState(room);
      return { code: room.code };
    });

    handle('room:transfer', ({ memberId }) => {
      const { room } = memberContext(socket, true);
      const target = room.members.get(memberId);
      if (!target?.socketId) fail('MEMBER_NOT_ONLINE', '접속 중인 친구에게 방장을 넘길 수 있어.');
      clearTimeout(room.hostTimer);
      room.hostTimer = null;
      room.hostId = memberId;
      broadcastState(room);
      return {};
    });

    handle('profile:update', (payload) => {
      const { room, member } = memberContext(socket);
      Object.assign(member, profileFrom(payload));
      broadcastState(room);
      return {};
    });

    handle('chat:send', ({ clientId, text }) => {
      const { room, member } = memberContext(socket);
      if (typeof clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/u.test(clientId)) fail('INVALID_MESSAGE_ID', '메시지 번호를 만들지 못했어. 다시 보내 줘.');
      if (typeof text !== 'string' || !text.trim() || countCharacters(text.trim()) > maxTextLength || text.includes('\u0000')) fail('INVALID_MESSAGE', `메시지는 1~${maxTextLength}자로 입력해 줘.`);
      const previous = member.sent.get(clientId);
      if (previous) return { message: messageFor(previous, socket) };
      limit('chat', `${room.id}:${member.id}`);
      const message = { id: randomUUID(), memberId: member.id, nickname: member.nickname, character: member.character, text: text.trim(), sentAt: Date.now(), kind: 'chat' };
      member.sent.set(clientId, message);
      // Retain retry receipts beyond the visible history without unbounded memory growth.
      if (member.sent.size > 1000) member.sent.delete(member.sent.keys().next().value);
      room.messages.push(message);
      if (room.messages.length > maxMessages) room.messages.splice(0, room.messages.length - maxMessages);
      for (const recipient of room.members.values()) {
        const viewer = recipient.socketId && io.sockets.sockets.get(recipient.socketId);
        viewer?.emit('chat:message', messageFor(message, viewer));
      }
      return { message: messageFor(message, socket) };
    });

    socket.on('disconnect', () => {
      if (socket.data.pending) {
        const room = rooms.get(socket.data.pending.roomId);
        if (room) { removePending(room, socket.data.pending.requestId); broadcastState(room); }
      }
      const membership = socket.data.membership;
      const room = membership && rooms.get(membership.roomId);
      const member = room?.members.get(membership.memberId);
      if (!room || !member || member.socketId !== socket.id || closing) return;
      member.socketId = null;
      member.disconnectedAt = Date.now();
      clearTimeout(member.reconnectTimer);
      member.reconnectTimer = setTimeout(() => {
        member.reconnectTimer = null;
        if (rooms.has(room.id) && room.members.get(member.id) === member) expireDisconnectedMembers(room);
      }, memberReconnectTtlMs);
      member.reconnectTimer.unref();
      electHost(room);
      updateEmptyTimer(room);
      broadcastState(room);
    });
  });

  return {
    httpServer,
    io,
    listen(port = 47831, host = '127.0.0.1') {
      return new Promise((resolveListen, rejectListen) => {
        const onError = (error) => rejectListen(error);
        httpServer.once('error', onError);
        httpServer.listen(port, host, () => {
          httpServer.off('error', onError);
          const address = httpServer.address();
          resolveListen({ host, port: address.port, url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}` });
        });
      });
    },
    async close() {
      closing = true;
      clearInterval(bucketCleanup);
      for (const room of rooms.values()) {
        clearTimeout(room.hostTimer);
        clearTimeout(room.emptyTimer);
        for (const request of room.pending.values()) clearTimeout(request.timer);
        for (const member of room.members.values()) clearTimeout(member.reconnectTimer);
      }
      await new Promise((resolveClose) => io.close(() => resolveClose()));
      rooms.clear();
      codes.clear();
      buckets.clear();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createRoomServer();
  server.listen(Number(process.env.PORT ?? 47831), process.env.HOST ?? '127.0.0.1')
    .then(({ url }) => process.stdout.write(`치이카와 모퉁이 서버: ${url}\n`))
    .catch((error) => { process.stderr.write(`서버를 시작하지 못했어: ${error.code ?? 'UNKNOWN'}\n`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
}
