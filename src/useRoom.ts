import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { Ack, ChatMessage, Profile, RoomSnapshot, Session } from '../shared/protocol';

export type Joined = { room: RoomSnapshot; session: Session };
const sessionKey = (endpoint: string) => `corner.session:${endpoint}`;
const leaveKey = (endpoint: string) => `corner.leave:${endpoint}`;
type RequestFailure = Error & { code?: string };
function emitRequest<T>(socket: Socket, event: string, payload: object): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (timeoutError: Error | null, ack: Ack<T>) => {
      if (timeoutError) return reject(new Error('응답이 늦어지고 있어. 연결되면 다시 이어갈게.'));
      if (!ack?.ok) return reject(Object.assign(new Error(ack?.error || '요청을 처리하지 못했어.'), { code: ack && !ack.ok ? ack.code : undefined }));
      resolve(ack.data);
    });
  });
}
export function normalizeServer(raw: string): string {
  const url = new URL(raw.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('서버 주소는 http:// 또는 https://로 시작해야 해.');
  return url.origin;
}
export function parseInvitation(raw: string): { code: string; endpoint?: string } {
  const parts = raw.trim().split('|').map((part) => part.trim());
  if (parts.length === 3 && parts[0] === '치이카와 모퉁이') return { endpoint: normalizeServer(parts[1]), code: parts[2].replace(/[^a-z0-9]/gi, '').toUpperCase() };
  return { code: raw.trim().replace(/[^a-z0-9]/gi, '').toUpperCase() };
}
function readSavedSession(endpoint: string, leaving = false): Session | null {
  try {
    const saved = JSON.parse(localStorage.getItem(leaving ? leaveKey(endpoint) : sessionKey(endpoint)) || 'null');
    return saved && typeof saved.memberId === 'string' && typeof saved.roomId === 'string' && typeof saved.token === 'string' ? saved : null;
  } catch { return null; }
}
export function useRoom(endpoint: string) {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectedEndpoint, setConnectedEndpoint] = useState('');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const socketRef = useRef<Socket | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const pendingRef = useRef(false);
  const leavingRef = useRef(false);
  const readyRef = useRef(false);
  const reconnectRef = useRef<() => void>(() => {});
  const acceptJoined = useCallback((joined: Joined, targetEndpoint: string) => {
    sessionRef.current = joined.session;
    setSession(joined.session); setRoom(joined.room); setPending(false); pendingRef.current = false;
    localStorage.setItem(sessionKey(targetEndpoint), JSON.stringify(joined.session));
    setError(''); setNotice('');
  }, []);
  const clearSession = useCallback((targetEndpoint: string) => {
    localStorage.removeItem(sessionKey(targetEndpoint)); sessionRef.current = null;
    setSession(null); setRoom(null); setPending(false); pendingRef.current = false;
  }, []);
  useEffect(() => {
    if (!endpoint) return;
    const socket = io(endpoint, { autoConnect: false, reconnection: true, timeout: 7000 });
    let disposed = false;
    let retryTimer: number | undefined;
    let connectionVersion = 0;
    socketRef.current = socket;
    sessionRef.current = readSavedSession(endpoint);
    leavingRef.current = Boolean(readSavedSession(endpoint, true));
    readyRef.current = false;
    setSession(null); setRoom(null); setConnected(false); setConnectedEndpoint(''); setPending(false); pendingRef.current = false;
    const reconnect = () => {
      if (disposed) return;
      socket.disconnect();
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => { if (!disposed) socket.connect(); }, 1200);
    };
    reconnectRef.current = reconnect;
    socket.on('connect', async () => {
      const version = ++connectionVersion;
      readyRef.current = false;
      setConnected(false); setConnectedEndpoint(''); setError('');
      const current = () => !disposed && version === connectionVersion && socket.connected;
      try {
        // An offline leave must reclaim the old server seat before this connection can create a new one.
        const leaving = readSavedSession(endpoint, true);
        leavingRef.current = Boolean(leaving);
        if (leaving) {
          let resumed = false;
          try { await emitRequest<Joined>(socket, 'room:resume', { roomId: leaving.roomId, token: leaving.token }); resumed = true; }
          catch (cause) { if ((cause as RequestFailure).code !== 'INVALID_SESSION') throw cause; }
          if (!current()) return;
          if (resumed) await emitRequest(socket, 'room:leave', {});
          if (!current()) return;
          localStorage.removeItem(leaveKey(endpoint));
          leavingRef.current = false;
          setNotice('이전 방에서 나왔어. 새 모퉁이에서 다시 만나자.');
        }
        const saved = sessionRef.current;
        if (saved) {
          try {
            const joined = await emitRequest<Joined>(socket, 'room:resume', { roomId: saved.roomId, token: saved.token });
            if (!current()) return;
            acceptJoined(joined, endpoint);
          } catch (cause) {
            if (!current()) return;
            if ((cause as RequestFailure).code !== 'INVALID_SESSION') throw cause;
            clearSession(endpoint); setNotice((cause as Error).message || '이전 방이 종료됐어. 새 방으로 다시 만나자.');
          }
        }
        if (!current()) return;
        readyRef.current = true; setConnected(true); setConnectedEndpoint(endpoint);
      } catch (cause) {
        if (!current()) return;
        setError(leavingRef.current ? '이전 방에서 나오는 중이야. 연결이 돌아오면 자동으로 마무리할게.' : (cause as Error).message);
        reconnect();
      }
    });
    socket.on('disconnect', () => {
      ++connectionVersion; readyRef.current = false;
      setConnected(false); setConnectedEndpoint('');
      if (pendingRef.current) { setPending(false); pendingRef.current = false; setError('연결이 끊겨 입장 요청이 취소됐어. 다시 요청해줘.'); }
    });
    socket.on('connect_error', () => { readyRef.current = false; setConnected(false); });
    socket.on('room:state', (next: RoomSnapshot) => { if (!leavingRef.current) setRoom(next); });
    socket.on('chat:message', (message: ChatMessage) => setRoom((previous) => previous && !previous.messages.some((m) => m.id === message.id) ? { ...previous, messages: [...previous.messages, message].slice(-100) } : previous));
    socket.on('join:approved', (joined: Joined) => { acceptJoined(joined, endpoint); setNotice('친구들의 모퉁이에 도착했어!'); });
    socket.on('join:rejected', ({ reason }: { reason: string }) => { setPending(false); pendingRef.current = false; setError(reason || '방장이 이번 입장 요청을 받지 않았어.'); });
    socket.on('room:removed', ({ reason }: { reason: string }) => { clearSession(endpoint); if (!leavingRef.current) setError(reason || '방에서 나왔어.'); });
    socket.connect();
    return () => { disposed = true; window.clearTimeout(retryTimer); socket.removeAllListeners(); socket.disconnect(); if (socketRef.current === socket) socketRef.current = null; };
  }, [endpoint, acceptJoined, clearSession]);

  const request = useCallback(async <T,>(event: string, payload: object): Promise<T> => {
    const socket = socketRef.current;
    if (!socket?.connected || !readyRef.current || leavingRef.current) throw new Error('서버에 연결 중이야. 연결 상태를 확인하고 다시 눌러줘.');
    return emitRequest<T>(socket, event, payload);
  }, []);
  const perform = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError('');
    try { return await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : '잠깐 문제가 생겼어. 다시 시도해줘.'); return undefined; }
    finally { setBusy(false); }
  }, []);
  const create = (profile: Profile) => perform(async () => { const joined = await request<Joined>('room:create', profile); acceptJoined(joined, endpoint); return joined; });
  const join = (code: string, profile: Profile) => perform(async () => {
    await request<{ pending: true; requestId: string }>('room:join', { code, ...profile }); if (!sessionRef.current) { setPending(true); pendingRef.current = true; } return true;
  });
  const leave = () => perform(async () => {
    const socket = socketRef.current;
    const currentSession = sessionRef.current;
    if (!currentSession) {
      if (socket?.connected) await request('room:leave', {});
      clearSession(endpoint);
      return true;
    }
    // Keep only the credential needed for eventual departure; never log its contents.
    localStorage.setItem(leaveKey(endpoint), JSON.stringify(currentSession));
    leavingRef.current = true; readyRef.current = false;
    clearSession(endpoint); setConnected(false); setConnectedEndpoint('');
    if (!socket?.connected) {
      setNotice('방에서 나왔어. 연결이 돌아오면 마무리할게.');
      return true;
    }
    try {
      await emitRequest(socket, 'room:leave', {});
      localStorage.removeItem(leaveKey(endpoint));
      if (socketRef.current !== socket) return true;
      leavingRef.current = false;
      if (socket.connected) { readyRef.current = true; setConnected(true); setConnectedEndpoint(endpoint); }
    } catch {
      if (socketRef.current !== socket) return true;
      setNotice('방에서 나왔어. 연결이 돌아오면 마무리할게.');
      reconnectRef.current();
    }
    return true;
  });
  const act = (event: string, payload: object) => perform(() => request(event, payload));
  const send = async (text: string, clientId: string) => {
    try {
      const result = await request<{message: ChatMessage}>('chat:send', { text, clientId });
      setRoom((previous) => previous && !previous.messages.some((m) => m.id === result.message.id) ? { ...previous, messages: [...previous.messages, result.message].slice(-100) } : previous);
      setError(''); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : '메시지를 보내지 못했어. 입력한 글은 남겨둘게.'); return false; }
  };
  return { room, session, connected, connectedEndpoint, pending, busy, error, notice, setError, setNotice, create, join, leave, act, send };
}
