import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { RoomSnapshot } from '../shared/protocol';
import { characterAsset } from './characters';
import './browser-float.css';
import floatStyles from './browser-float.css?inline';

type DocumentPip = {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
};

export type BrowserFloatProps = {
  room: RoomSnapshot | null;
  memberId: string | null;
  connected: boolean;
  quiet?: boolean;
  onSend(text: string, clientId?: string): Promise<boolean> | boolean;
};

const absoluteAsset = (character: RoomSnapshot['members'][number]['character']) =>
  new URL(characterAsset(character), document.baseURI).href;

function FloatContents({ room, memberId, connected, quiet, onSend, onReturn }: Omit<BrowserFloatProps, 'room'> & { room: RoomSnapshot; onReturn(): void }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const composing = useRef(false);
  const inFlight = useRef(false);
  const retry = useRef<{ text: string; clientId: string } | null>(null);
  const messages = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const visibleMessages = room.messages.slice(-40);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);
  useEffect(() => {
    if (messages.current && nearBottom.current) messages.current.scrollTop = messages.current.scrollHeight;
  }, [room.messages]);
  useEffect(() => { input.current?.focus(); }, []);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || text.length > 200 || !connected || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError('');
    const clientId = retry.current?.text === text ? retry.current.clientId : globalThis.crypto.randomUUID();
    retry.current = { text, clientId };
    try {
      if (await onSend(text, clientId)) {
        setDraft((current) => current.trim() === text ? '' : current);
        retry.current = null;
        nearBottom.current = true;
      } else setError('아직 보내지 못했어. 입력한 글은 남겨뒀어.');
    } catch {
      setError('연결을 확인한 뒤 다시 보내줘. 입력한 글은 남겨뒀어.');
    } finally {
      inFlight.current = false;
      setSending(false);
      input.current?.focus();
    }
  };

  return <main className="corner-float" aria-label="치이카와 모퉁이 작은 창">
    <header className="corner-float-header">
      <div><p className="corner-float-eyebrow">우리의 작은 모퉁이</p><h1>{room.name}</h1></div>
      <button type="button" className="corner-float-back" onClick={onReturn} title="원래 탭으로 돌아가기">큰 화면 ↗</button>
    </header>
    <div className={`corner-float-status${connected ? '' : ' is-offline'}`} role="status"><span />{connected ? `${room.members.length}명의 친구와 함께` : '다시 연결하는 중 · 입력한 글은 남아 있어'}</div>
    <section className={`corner-float-scene${room.members.length > 4 ? ' is-crowded' : ''}`} aria-label="작은 창에서 산책하는 친구들" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(room.members.length, 1), 4)}, minmax(0, 1fr))` }}>
      {room.members.slice(0, 8).map((member, index) => {
        const latest = room.messages.filter((message) => message.memberId === member.id && message.kind !== 'system').at(-1);
        const speaking = !quiet && latest && now - latest.sentAt < 10000;
        return <div className={`corner-float-pet${member.online ? '' : ' is-away'}`} key={member.id} style={{ animationDelay: `${-index * 1.3}s` }}>
          {speaking && <span className="corner-float-bubble" title={latest.text}>{latest.text}</span>}
          <img src={absoluteAsset(member.character)} alt="" draggable={false} />
          <span className="corner-float-pet-name" title={`${member.nickname}${member.online ? '' : ' · 잠시 자리 비움'}`}>{member.nickname}{member.id === memberId && ' · 나'}</span>
        </div>;
      })}
    </section>
    <div className="corner-float-messages" ref={messages} role="log" aria-label="친구들의 대화" aria-live="polite" aria-relevant="additions" onScroll={() => {
      const list = messages.current;
      if (list) nearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 36;
    }}>
      {visibleMessages.length === 0 && <p className="corner-float-empty">가볍게 인사부터 해볼까?</p>}
      {visibleMessages.map((message) => message.kind === 'system'
        ? <p className="corner-float-system" key={message.id}>{message.text}</p>
        : <article className={`corner-float-message${message.memberId === memberId ? ' is-mine' : ''}`} key={message.id}>
          <img src={absoluteAsset(message.character)} alt="" />
          <div><span>{message.nickname}{message.memberId === memberId && ' · 나'}</span><p>{message.text}</p></div>
        </article>)}
    </div>
    <form className="corner-float-composer" onSubmit={send}>
      {error && <p className="corner-float-error" role="alert">{error}</p>}
      <textarea ref={input} value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} maxLength={200} aria-label="작은 창에서 친구에게 보낼 말" placeholder={connected ? '조그맣게 안녕, 하고 말해줘' : '연결을 기다리며 글을 적어둘 수 있어'} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault(); void send();
        }
      }} />
      <div className="corner-float-compose-actions"><span>{draft.length}/200 · Enter로 보내기</span><button type="submit" disabled={!draft.trim() || !connected || sending}>{sending ? '보내는 중' : '보내기'} <span aria-hidden="true">↗</span></button></div>
    </form>
  </main>;
}

/** One portal shares the existing room connection; opening PiP never creates a second member. */
export function BrowserFloat(props: BrowserFloatProps) {
  const { room } = props;
  const helpId = useId();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const pipWindow = useRef<Window | null>(null);
  const removeCloseListener = useRef<(() => void) | null>(null);
  const openingRef = useRef(false);
  const generation = useRef(0);
  const api = (window as Window & { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;
  const supported = !window.corner && window.isSecureContext && window.top === window && typeof api?.requestWindow === 'function';

  useEffect(() => {
    setHost(null);
    setOpening(false);
    setError('');
    return () => {
      generation.current += 1;
      openingRef.current = false;
      removeCloseListener.current?.();
      removeCloseListener.current = null;
      pipWindow.current?.close();
      pipWindow.current = null;
    };
  }, [room?.id]);

  if (window.corner || !room) return null;

  const close = () => {
    removeCloseListener.current?.();
    removeCloseListener.current = null;
    pipWindow.current?.close();
    pipWindow.current = null;
    setHost(null);
  };
  const open = async () => {
    if (!supported || !api || openingRef.current) return;
    if (pipWindow.current && !pipWindow.current.closed) { pipWindow.current.focus(); return; }
    openingRef.current = true;
    setOpening(true);
    setError('');
    const attempt = generation.current;
    let floating: Window | undefined;
    try {
      // Keep this call directly inside the click handler to preserve transient user activation.
      floating = await api.requestWindow({ width: 420, height: 560 });
      if (attempt !== generation.current) { floating.close(); return; }
      const doc = floating.document;
      doc.documentElement.lang = 'ko';
      doc.documentElement.className = 'corner-float-document';
      doc.title = '치이카와 모퉁이 · 작은 창';
      const style = doc.createElement('style');
      style.textContent = floatStyles;
      doc.head.append(style);
      const mount = doc.createElement('div');
      mount.className = 'corner-float-root';
      doc.body.append(mount);
      const closed = () => {
        if (pipWindow.current === floating) {
          pipWindow.current = null;
          setHost(null);
          removeCloseListener.current = null;
        }
      };
      floating.addEventListener('pagehide', closed, { once: true });
      removeCloseListener.current = () => floating?.removeEventListener('pagehide', closed);
      pipWindow.current = floating;
      setHost(mount);
    } catch {
      floating?.close();
      if (attempt === generation.current) setError('작은 창을 열지 못했어. 브라우저 설정을 확인하거나 이 화면에서 계속 이야기해줘.');
    } finally {
      if (attempt === generation.current) { openingRef.current = false; setOpening(false); }
    }
  };

  return <div className="browser-float-control">
    <button type="button" className="secondary-button browser-float-trigger" disabled={!supported || opening} aria-describedby={helpId} onClick={() => { if (host) close(); else void open(); }}>
      <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="3" /><rect x="9" y="9" width="7" height="6" rx="1.5" /></svg>
      {opening ? '작은 창을 여는 중' : host ? '작은 창 닫기' : '작은 창으로 띄우기'}
    </button>
    <p id={helpId} className="browser-float-hint">{supported ? '다른 앱 위에서도 함께 있어. 이 탭은 열어둬.' : '이 브라우저에서는 작은 창을 지원하지 않아. 이 화면에서 그대로 함께할 수 있어.'}</p>
    {error && <p className="browser-float-warning" role="alert">{error}</p>}
    {host && createPortal(<FloatContents {...props} room={room} onReturn={() => { window.focus(); close(); }} />, host)}
  </div>;
}
