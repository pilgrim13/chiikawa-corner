import express from 'express';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
function sameToken(tokenHash, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/u.test(tokenHash)) return false;
  return timingSafeEqual(Buffer.from(tokenHash, 'hex'), Buffer.from(hashToken(token), 'hex'));
}

/**
 * Single-process room server. A stateFile opt-in persists rooms across restarts.
 * Options: hostGraceMs (60s), memberReconnectTtlMs (5m in active rooms),
 * emptyRoomTtlMs (10m),
 * maxMembers (8), maxMessages (100), maxTextLength (200), maxRooms (1000),
 * allowedOrigins (array), staticDir (directory or false), rateLimits, and stateFile.
 * Returns { httpServer, io, listen(port = 47831, host = '127.0.0.1'), close() }.
 * listen() resolves to { host, port, url }; close() clears all timers and sockets.
 */
export function createRoomServer(options = {}) {
  const hostGraceMs = options.hostGraceMs ?? 60_000;
  const memberReconnectTtlMs = options.memberReconnectTtlMs ?? 300_000;
  const emptyRoomTtlMs = options.emptyRoomTtlMs ?? 600_000;
  const maxMembers = options.maxMembers ?? 8;
  const maxMessages = options.maxMessages ?? 100;
  const maxTextLength = options.maxTextLength ?? 200;
  const maxRooms = options.maxRooms ?? 1000;
  const configuredOrigins = options.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const origins = new Set(configuredOrigins.map((origin) => origin.replace(/\/$/u, '')));
  const rateLimits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, value]) => [key, { ...value, ...options.rateLimits?.[key] }]));
  // Library users (including local relay tests) are deliberately ephemeral.
  // Only the standalone server below opts into a persistent file.
  const stateFile = options.stateFile ? resolve(options.stateFile) : null;
  const rooms = new Map();
  const codes = new Map();
  const buckets = new Map();
  let closing = false;
  let storageError = false;

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
  app.get('/health', (_request, response) => response.status(storageError ? 503 : 200).json({ ok: !storageError, rooms: rooms.size }));
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
    lastChatAt: member.lastChatAt, hasChatted: member.hasChatted,
  });
  const messageFor = (message, viewer) => ({ ...message, character: characterFor(message.character, viewer) });
  const sessionFor = (room, member, token) => ({ memberId: member.id, token, roomId: room.id });
  const snapshot = (room, viewer) => ({
    id: room.id, code: room.code, name: room.name, hostId: room.hostId, locked: room.locked,
    members: [...room.members.values()].map((member) => publicMember(member, viewer)),
    messages: room.messages.map((message) => messageFor(message, viewer)),
    pending: [], // Keep the field for already-installed apps.
  });
  function broadcastState(room) {
    if (closing) return;
    for (const member of room.members.values()) {
      const viewer = member.socketId && io.sockets.sockets.get(member.socketId);
      viewer?.emit('room:state', snapshot(room, viewer));
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
  }
  function newCode() {
    let code;
    do { code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''); } while (codes.has(code));
    return code;
  }
  function rotateCode(room) {
    const replacement = newCode();
    codes.delete(room.code);
    room.code = replacement;
    codes.set(replacement, room.id);
    return replacement;
  }
  function newMember(room, socket, profile) {
    const usedColors = new Set([...room.members.values()].map((member) => member.color));
    const token = randomBytes(32).toString('base64url');
    const joinedAt = Date.now();
    const member = {
      id: randomUUID(), tokenHash: hashToken(token), ...profile,
      color: COLORS.find((color) => !usedColors.has(color)) ?? COLORS[room.members.size % COLORS.length],
      joinedAt, lastChatAt: joinedAt, hasChatted: false,
      socketId: socket.id, disconnectedAt: null, reconnectTimer: null, sent: new Map(),
    };
    room.members.set(member.id, member);
    socket.data.membership = { roomId: room.id, memberId: member.id };
    return { member, token };
  }
  function persistRooms() {
    if (!stateFile) return;
    if (storageError) fail('STORAGE_UNAVAILABLE', '방 저장 공간을 사용할 수 없어. 서버 관리자가 복구한 뒤 다시 연결해 줘.');
    let temporary;
    try {
      const data = { version: 1, rooms: [...rooms.values()].map((room) => ({
        id: room.id, code: room.code, name: room.name, hostId: room.hostId,
        locked: room.locked, emptySince: room.emptySince,
        members: [...room.members.values()].map((member) => ({
          id: member.id, tokenHash: member.tokenHash, nickname: member.nickname,
          character: member.character, color: member.color, joinedAt: member.joinedAt,
          lastChatAt: member.lastChatAt, hasChatted: member.hasChatted,
          disconnectedAt: member.disconnectedAt, wasOnline: Boolean(member.socketId),
          sent: [...member.sent.entries()],
        })),
        messages: room.messages,
      })) };
      mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
      temporary = `${stateFile}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const fd = openSync(temporary, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, stateFile);
      temporary = null;
      // Windows cannot reliably open directories as file handles. On POSIX,
      // syncing the directory also durably records the replacement rename.
      if (process.platform !== 'win32') {
        let directoryFd;
        try {
          directoryFd = openSync(dirname(stateFile), 'r');
          fsyncSync(directoryFd);
        } catch (error) {
          if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        } finally {
          if (directoryFd !== undefined) closeSync(directoryFd);
        }
      }
    } catch (error) {
      if (temporary) try { unlinkSync(temporary); } catch { /* File may already have been renamed. */ }
      storageError = true;
      for (const room of rooms.values()) {
        clearTimeout(room.hostTimer);
        clearTimeout(room.emptyTimer);
        for (const member of room.members.values()) clearTimeout(member.reconnectTimer);
      }
      throw new RequestError('STORAGE_UNAVAILABLE', '방 저장 공간을 사용할 수 없어. 서버 관리자가 복구한 뒤 다시 연결해 줘.');
    }
  }
  function loadRooms() {
    if (!stateFile || !existsSync(stateFile)) return;
    if (!lstatSync(stateFile).isFile()) throw new Error('방 저장 경로가 일반 파일이 아니야. 서버 시작을 중단했어.');
    chmodSync(stateFile, 0o600);
    let state;
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); }
    catch { throw new Error('방 저장 파일을 읽지 못했어. 기존 파일을 보존하고 서버 시작을 중단했어.'); }
    if (state?.version !== 1 || !Array.isArray(state.rooms)) throw new Error('지원하지 않는 방 저장 형식이야. 기존 파일을 보존하고 서버 시작을 중단했어.');
    const now = Date.now();
    for (const savedRoom of state.rooms) {
      if (!savedRoom || typeof savedRoom.id !== 'string' || typeof savedRoom.code !== 'string'
        || typeof savedRoom.name !== 'string' || typeof savedRoom.hostId !== 'string'
        || typeof savedRoom.locked !== 'boolean' || !Array.isArray(savedRoom.members)
        || !Array.isArray(savedRoom.messages) || rooms.has(savedRoom.id) || codes.has(savedRoom.code)) {
        throw new Error('방 저장 파일에 잘못된 방 정보가 있어. 기존 파일을 보존하고 서버 시작을 중단했어.');
      }
      const room = {
        id: savedRoom.id, code: savedRoom.code, name: savedRoom.name,
        hostId: savedRoom.hostId, locked: savedRoom.locked,
        members: new Map(), messages: savedRoom.messages,
        emptySince: Number.isFinite(savedRoom.emptySince) ? savedRoom.emptySince : null,
        hostTimer: null, emptyTimer: null,
      };
      for (const savedMember of savedRoom.members) {
        if (!savedMember || typeof savedMember.id !== 'string'
          || !/^[a-f0-9]{64}$/u.test(savedMember.tokenHash)
          || typeof savedMember.nickname !== 'string' || !CHARACTER_IDS.has(savedMember.character)
          || typeof savedMember.color !== 'string' || !Number.isFinite(savedMember.joinedAt)
          || !Number.isFinite(savedMember.lastChatAt) || typeof savedMember.hasChatted !== 'boolean'
          || !Array.isArray(savedMember.sent) || room.members.has(savedMember.id)) {
          throw new Error('방 저장 파일에 잘못된 참여자 정보가 있어. 기존 파일을 보존하고 서버 시작을 중단했어.');
        }
        room.members.set(savedMember.id, {
          id: savedMember.id, tokenHash: savedMember.tokenHash,
          nickname: savedMember.nickname, character: savedMember.character,
          color: savedMember.color, joinedAt: savedMember.joinedAt,
          lastChatAt: savedMember.lastChatAt, hasChatted: savedMember.hasChatted,
          socketId: null, disconnectedAt: savedMember.wasOnline ? now :
            (Number.isFinite(savedMember.disconnectedAt) ? savedMember.disconnectedAt : now),
          reconnectTimer: null, sent: new Map(savedMember.sent),
        });
      }
      if (!room.members.has(room.hostId)) throw new Error('방 저장 파일에 방장 정보가 없어. 기존 파일을 보존하고 서버 시작을 중단했어.');
      rooms.set(room.id, room);
      codes.set(room.code, room.id);
    }
    for (const room of rooms.values()) {
      // A connected member becomes temporarily offline while the server is
      // replaced. The original room code and session token remain usable.
      if (room.emptySince === null) room.emptySince = now;
      updateEmptyTimer(room);
    }
    // Save the restart boundary so repeated restarts do not reset the empty
    // room recovery window or a member's reconnect deadline indefinitely.
    persistRooms();
  }
  function destroyRoom(room) {
    clearTimeout(room.hostTimer);
    clearTimeout(room.emptyTimer);
    const connected = [];
    for (const member of room.members.values()) {
      clearTimeout(member.reconnectTimer);
      const socket = io.sockets.sockets.get(member.socketId);
      if (socket?.data.membership?.roomId === room.id) connected.push(socket);
    }
    rooms.delete(room.id);
    codes.delete(room.code);
    persistRooms();
    for (const socket of connected) {
      delete socket.data.membership;
      socket.emit('room:removed', { reason: '방이 닫혔어.' });
    }
  }
  function updateEmptyTimer(room) {
    if (closing) return;
    const online = [...room.members.values()].some((member) => member.socketId);
    if (online) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
      room.emptySince = null;
      return;
    }
    if (room.emptyTimer) return;
    room.emptySince ??= Date.now();
    room.emptyTimer = setTimeout(() => {
      room.emptyTimer = null;
      try {
        if (rooms.has(room.id) && ![...room.members.values()].some((member) => member.socketId)) destroyRoom(room);
      } catch (error) { if (!storageError) throw error; }
    }, Math.max(0, emptyRoomTtlMs - (Date.now() - room.emptySince)));
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
        room.hostTimer = setTimeout(() => {
          try { if (rooms.has(room.id)) { electHost(room); persistRooms(); broadcastState(room); } }
          catch (error) { if (!storageError) throw error; }
        }, remaining);
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
    room.members.delete(member.id);
    member.tokenHash = '';
    member.sent.clear();
    if (room.members.size === 0) destroyRoom(room);
    else {
      if (room.hostId === member.id) electHost(room, true);
      updateEmptyTimer(room);
      persistRooms();
    }
    if (socket?.data.membership?.memberId === member.id) delete socket.data.membership;
    if (reason) socket?.emit('room:removed', { reason });
    if (!rooms.has(room.id)) return;
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
  function scheduleOfflineExpiry(room) {
    for (const member of room.members.values()) {
      if (member.socketId || member.reconnectTimer || member.disconnectedAt === null) continue;
      const remaining = memberReconnectTtlMs - (Date.now() - member.disconnectedAt);
      if (remaining <= 0) continue;
      member.reconnectTimer = setTimeout(() => {
        member.reconnectTimer = null;
        try { if (rooms.has(room.id) && room.members.get(member.id) === member) expireDisconnectedMembers(room); }
        catch (error) { if (!storageError) throw error; }
      }, remaining);
      member.reconnectTimer.unref();
    }
  }

  loadRooms();

  io.on('connection', (socket) => {
    function handle(event, callback) {
      socket.on(event, (rawPayload, acknowledgement) => {
        const ack = typeof acknowledgement === 'function' ? acknowledgement : () => {};
        try {
          if (storageError) fail('STORAGE_UNAVAILABLE', '방 저장 공간을 사용할 수 없어. 서버 관리자가 복구한 뒤 다시 연결해 줘.');
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
      const room = { id: randomUUID(), code: newCode(), name: name.trim(), hostId: '', locked: false, members: new Map(), messages: [], emptySince: null, hostTimer: null, emptyTimer: null };
      rooms.set(room.id, room);
      codes.set(room.code, room.id);
      const { member, token } = newMember(room, socket, profile);
      room.hostId = member.id;
      persistRooms();
      return { room: snapshot(room, socket), session: sessionFor(room, member, token) };
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
      const { member, token } = newMember(room, socket, profile);
      room.emptySince = null;
      persistRooms();
      const joined = { room: snapshot(room, socket), session: sessionFor(room, member, token) };
      // Older installed apps enter only after this event. Emit it before the ACK
      // so their pending state cannot overwrite the accepted session.
      socket.emit('join:approved', joined);
      broadcastState(room);
      return joined;
    });

    handle('room:resume', (payload) => {
      const room = typeof payload.roomId === 'string' ? rooms.get(payload.roomId) : null;
      const member = room && [...room.members.values()].find((candidate) => sameToken(candidate.tokenHash, payload.token));
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
      scheduleOfflineExpiry(room);
      persistRooms();
      broadcastState(room);
      return { room: snapshot(room, socket), session: sessionFor(room, member, payload.token) };
    });

    handle('room:leave', () => {
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
      // Without approval, an expelled friend could reuse the old invitation.
      rotateCode(room);
      removeMember(room, target, '방장이 방에서 내보냈어.');
      return { code: room.code };
    });

    handle('room:lock', ({ locked }) => {
      const { room } = memberContext(socket, true);
      if (typeof locked !== 'boolean') fail('INVALID_LOCK', '입장 잠금 값을 다시 확인해 줘.');
      room.locked = locked;
      persistRooms();
      broadcastState(room);
      return {};
    });

    handle('room:rotate-code', () => {
      const { room } = memberContext(socket, true);
      rotateCode(room);
      persistRooms();
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
      persistRooms();
      broadcastState(room);
      return {};
    });

    handle('profile:update', (payload) => {
      const { room, member } = memberContext(socket);
      Object.assign(member, profileFrom(payload));
      persistRooms();
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
      member.lastChatAt = message.sentAt;
      member.hasChatted = true;
      member.sent.set(clientId, message);
      // Retain retry receipts beyond the visible history without unbounded memory growth.
      if (member.sent.size > 1000) member.sent.delete(member.sent.keys().next().value);
      room.messages.push(message);
      if (room.messages.length > maxMessages) room.messages.splice(0, room.messages.length - maxMessages);
      persistRooms();
      for (const recipient of room.members.values()) {
        const viewer = recipient.socketId && io.sockets.sockets.get(recipient.socketId);
        viewer?.emit('chat:message', messageFor(message, viewer));
      }
      return { message: messageFor(message, socket) };
    });

    socket.on('disconnect', () => {
      const membership = socket.data.membership;
      const room = membership && rooms.get(membership.roomId);
      const member = room?.members.get(membership.memberId);
      if (!room || !member || member.socketId !== socket.id || closing || storageError) return;
      member.socketId = null;
      member.disconnectedAt = Date.now();
      clearTimeout(member.reconnectTimer);
      member.reconnectTimer = null;
      scheduleOfflineExpiry(room);
      electHost(room);
      updateEmptyTimer(room);
      persistRooms();
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
  const server = createRoomServer({ stateFile: process.env.CORNER_STATE_PATH ?? resolve(dirname(fileURLToPath(import.meta.url)), '../.runtime/rooms-v1.json') });
  server.listen(Number(process.env.PORT ?? 47831), process.env.HOST ?? '127.0.0.1')
    .then(({ url }) => process.stdout.write(`치이카와 모퉁이 서버: ${url}\n`))
    .catch((error) => { process.stderr.write(`서버를 시작하지 못했어: ${error.code ?? 'UNKNOWN'}\n`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
}
