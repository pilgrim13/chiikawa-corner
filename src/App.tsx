import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage, Profile, RoomSnapshot } from '../shared/protocol';
import { CHARACTERS, characterAsset, characterName } from './characters';
import { DesktopPreview } from './Overlay';
import { BrowserGarden } from './BrowserGarden';
import { BrowserFloat } from './BrowserFloat';
import { UpdatePanel } from './UpdatePanel';
import { CharacterPicker } from './CharacterPicker';
import { normalizeServer, parseInvitation, useRoom } from './useRoom';

function readProfile(): Profile {
  try {
    const value = JSON.parse(localStorage.getItem('corner.profile') || 'null');
    if (value && typeof value.nickname === 'string' && CHARACTERS.some((character) => character.id === value.character)) return value;
  } catch { /* A corrupt preference can safely use the default. */ }
  return { nickname: '', character: 'chiikawa' };
}
const formatTime = (time: number) => new Date(time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
const makeId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function parseRoomInvitation(raw: string): { code: string; endpoint?: string } {
  try {
    const link = new URL(raw.trim());
    const code = link.searchParams.get('join');
    if (code && ['https:', 'http:'].includes(link.protocol)) return { code: code.replace(/[^a-z0-9]/gi, '').toUpperCase(), endpoint: normalizeServer(`${link.origin}${link.pathname}`) };
  } catch { /* A plain code or the original three-part invitation is also valid. */ }
  return parseInvitation(raw);
}
function invitationFromUrl(): string {
  if (location.protocol === 'file:') return '';
  const code = new URLSearchParams(location.search).get('join');
  return code ? location.href : '';
}
function createDemo(profile: Profile): RoomSnapshot {
  const now = Date.now();
  return {
    id: 'demo', code: 'DEMO', name: '우리의 작은 모퉁이', hostId: 'demo-me', locked: false, pending: [],
    members: [
      { id: 'demo-me', ...profile, nickname: profile.nickname || '나', color: '#e8aa8a', online: true, joinedAt: now },
      { id: 'demo-friend1', nickname: '하루 (체험)', character: 'hachiware', color: '#b9d5de', online: true, joinedAt: now },
      { id: 'demo-friend2', nickname: '우쨔 (체험)', character: 'usagi', color: '#e7dca0', online: true, joinedAt: now },
    ],
    messages: [
      { id: 'demo-welcome', memberId: 'demo-friend1', nickname: '하루 (체험)', character: 'hachiware', text: '어서 와! 여긴 우리만의 작은 모퉁이야 🌿', sentAt: now - 3000 },
      { id: 'demo-hello', memberId: 'demo-friend2', nickname: '우쨔 (체험)', character: 'usagi', text: '우라야하! ✨', sentAt: now - 1000 },
    ],
  };
}
function Icon({ name, size = 18 }: { name: 'chat' | 'copy' | 'arrow' | 'spark' | 'leaf' | 'close' | 'settings'; size?: number }) {
  const paths = {
    chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-4 3v-9.5A7.5 7.5 0 0 1 9.5 5H13" /><path d="M17 2v7m-3.5-3.5h7" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="3" /><path d="M15 8V5a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h3" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /></>,
    leaf: <><path d="M20 3C9 1 2 8 5 15s16 5 15-12Z" /><path d="M3 22 15 9" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function App() {
  const [profile, setProfile] = useState<Profile>(readProfile);
  const [endpoint, setEndpoint] = useState('');
  const [serverDraft, setServerDraft] = useState('');
  const [desktop, setDesktop] = useState(Boolean(window.corner));
  const [desktopPlatform, setDesktopPlatform] = useState('');
  const [roomTab, setRoomTab] = useState<'create' | 'join'>(() => invitationFromUrl() ? 'join' : 'create');
  const [invitation, setInvitation] = useState(invitationFromUrl);
  const [queuedJoin, setQueuedJoin] = useState<{ endpoint: string; code: string; profile: Profile } | null>(null);
  const [demoRoom, setDemoRoom] = useState<RoomSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [size, setSize] = useState(() => Number(localStorage.getItem('corner.size')) || 1);
  const [quiet, setQuiet] = useState(false);
  const [overlayHidden, setOverlayHidden] = useState(false);
  const [toast, setToast] = useState('');
  const [connectionDelayed, setConnectionDelayed] = useState(false);
  const [displays, setDisplays] = useState<{id: number; label: string}[]>([]);
  const [selectedDisplay, setSelectedDisplay] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLTextAreaElement>(null);
  const retryId = useRef<{text: string; id: string} | null>(null);
  const composing = useRef(false);
  const demoTimers = useRef<number[]>([]);
  const network = useRoom(endpoint);
  const activeRoom = demoRoom || network.room;
  const memberId = demoRoom ? 'demo-me' : network.session?.memberId || null;
  const isHost = Boolean(activeRoom && activeRoom.hostId === memberId);
  const isDemo = Boolean(demoRoom);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const browserEndpoint = /^\/chiikawa(?:\/|$)/.test(location.pathname) ? `${location.origin}/chiikawa` : location.origin;
      let fallback = import.meta.env.VITE_SERVER_URL || (location.protocol === 'file:' ? 'http://127.0.0.1:47831' : browserEndpoint);
      if (window.corner) {
        try { const config = await window.corner.getConfig(); fallback = config.serverUrl || fallback; if (!cancelled) { setDesktop(config.isDesktop); setDesktopPlatform(config.platform || ''); } }
        catch { /* The web app can still use the environment URL. */ }
      }
      let saved = localStorage.getItem('corner.server') || fallback;
      try { saved = normalizeServer(saved); } catch { saved = fallback; }
      if ((/^https:\/\/[^/]+\.trycloudflare\.com\/?$/i.test(saved)
          || (browserEndpoint !== location.origin && saved === location.origin))
        && fallback !== saved
        && !localStorage.getItem(`corner.session:${saved}`)
        && !localStorage.getItem(`corner.leave:${saved}`)) {
        saved = fallback;
        localStorage.setItem('corner.server', saved);
      }
      if (!cancelled) { setEndpoint(saved); setServerDraft(saved); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('mac-desktop-document', desktop && desktopPlatform === 'darwin');
    return () => document.documentElement.classList.remove('mac-desktop-document');
  }, [desktop, desktopPlatform]);
  useEffect(() => {
    document.documentElement.classList.toggle('browser-document', !desktop);
    return () => document.documentElement.classList.remove('browser-document');
  }, [desktop]);
  useEffect(() => {
    setConnectionDelayed(false);
    if (network.connected || !endpoint) return;
    const timer = window.setTimeout(() => setConnectionDelayed(true), 8000);
    return () => window.clearTimeout(timer);
  }, [endpoint, network.connected]);
  useEffect(() => { localStorage.setItem('corner.profile', JSON.stringify(profile)); }, [profile]);
  useEffect(() => { localStorage.setItem('corner.size', String(size)); }, [size]);
  useEffect(() => {
    window.corner?.setOverlay({ room: activeRoom, memberId, size, quiet });
  }, [activeRoom, memberId, size, quiet]);
  useEffect(() => {
    if (!queuedJoin || !network.connected || network.connectedEndpoint !== queuedJoin.endpoint) return;
    const queued = queuedJoin; setQueuedJoin(null); void network.join(queued.code, queued.profile);
  }, [queuedJoin, network.connected, network.connectedEndpoint]);
  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [activeRoom?.messages.length]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200); return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (activeRoom && window.corner) window.corner.getDisplays().then(setDisplays).catch(() => {});
  }, [Boolean(activeRoom)]);
  useEffect(() => () => demoTimers.current.forEach(window.clearTimeout), []);

  const validatedProfile = (): Profile | null => {
    const nickname = profile.nickname.trim();
    if (!nickname) { network.setError('친구들이 부를 닉네임을 먼저 적어줘.'); document.getElementById('nickname')?.focus(); return null; }
    if (nickname.length > 16) { network.setError('닉네임은 16자 안으로 적어줘.'); return null; }
    return { ...profile, nickname };
  };
  const changeEndpoint = (value: string) => { const next = normalizeServer(value); localStorage.setItem('corner.server', next); setServerDraft(next); setEndpoint(next); return next; };
  const joinRoom = async (event: FormEvent) => {
    event.preventDefault(); const validProfile = validatedProfile(); if (!validProfile) return;
    try {
      const parsed = parseRoomInvitation(invitation);
      if (parsed.code.length !== 8) { network.setError('8자리 초대 코드, 초대장 또는 초대 링크를 확인해줘.'); return; }
      network.setError('');
      const target = parsed.endpoint && parsed.endpoint !== endpoint ? changeEndpoint(parsed.endpoint) : endpoint;
      if (!target) { network.setError('서버 주소를 확인한 뒤 다시 눌러줘.'); return; }
      if (!network.connected || network.connectedEndpoint !== target) setQueuedJoin({ endpoint: target, code: parsed.code, profile: validProfile });
      else await network.join(parsed.code, validProfile);
    } catch (cause) { network.setError(cause instanceof Error ? cause.message : '초대장을 다시 확인해줘.'); }
  };
  const copy = async (text: string, message: string) => {
    try { if (window.corner) await window.corner.copyText(text); else await navigator.clipboard.writeText(text); setToast(message); }
    catch { network.setError('클립보드에 복사하지 못했어. 보이는 코드를 직접 복사해줘.'); }
  };
  const leaveRoom = async () => {
    if (isDemo) { demoTimers.current.forEach(window.clearTimeout); demoTimers.current = []; setDemoRoom(null); }
    else await network.leave();
    setDraft(''); retryId.current = null;
  };
  const sendText = async (text: string, clientId: string = makeId()): Promise<boolean> => {
    text = text.trim();
    if (!text || !activeRoom) return false;
    if (text.length > 200) { network.setError('말풍선은 200자까지 보낼 수 있어.'); return false; }
    if (demoRoom) {
      const message: ChatMessage = { id: makeId(), memberId: 'demo-me', nickname: profile.nickname || '나', character: profile.character, text, sentAt: Date.now() };
      setDemoRoom((room) => room && { ...room, messages: [...room.messages, message].slice(-100) });
      const timer = window.setTimeout(() => {
        setDemoRoom((room) => room && { ...room, messages: [...room.messages, { id: makeId(), memberId: 'demo-friend1', nickname: '하루 (체험)', character: 'hachiware' as const, text: '응응! 친구와는 이렇게 이야기할 수 있어 ☁️', sentAt: Date.now() }].slice(-100) });
      }, 1800); demoTimers.current.push(timer);
      return true;
    }
    return network.send(text, clientId);
  };
  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault(); const text = draft.trim(); if (!text || sending || !activeRoom) return;
    setSending(true);
    const clientId = retryId.current?.text === text ? retryId.current.id : makeId();
    retryId.current = { text, id: clientId };
    const sent = await sendText(text, clientId);
    if (sent) { setDraft(''); retryId.current = null; }
    setSending(false); chatRef.current?.focus();
  };
  const startDemo = () => { network.setError(''); network.setNotice(''); setDemoRoom(createDemo(profile)); };
  const status = isDemo ? '혼자 체험 중' : network.connected ? '연결되었어' : connectionDelayed ? '연결 확인 필요' : '서버 연결 중';
  const webLink = activeRoom && !isDemo && endpoint ? (() => { const link = new URL(`${endpoint.replace(/\/$/, '')}/`); link.searchParams.set('join', activeRoom.code); return link.toString(); })() : '';

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); if (activeRoom) setToast('방에서 나가면 첫 화면으로 돌아가.'); }}>
        <span className="brand-mark"><Icon name="leaf" size={23} /></span>
        <span>치이카와 모퉁이<small>A LITTLE PLACE TOGETHER</small></span>
      </a>
      <div className="header-actions"><span className={`status-pill ${network.connected && !isDemo ? 'online' : ''}`}><i />{status}</span><UpdatePanel desktop={desktop} /><span className="prototype-label">{desktopPlatform === 'win32' ? 'WINDOWS APP' : desktopPlatform === 'darwin' ? 'MAC APP' : 'WEB'}</span></div>
    </header>

    {(network.error || network.notice) && <div className={network.error ? 'error-banner' : 'notice-banner'} role={network.error ? 'alert' : 'status'}>
      <span>{network.error || network.notice}</span><button className="subtle-button" aria-label="알림 닫기" onClick={() => { network.setError(''); network.setNotice(''); }}><Icon name="close" size={16} /></button>
    </div>}

    {connectionDelayed && !isDemo && !network.error && <div className="notice-banner" role="status">서버에 연결하지 못했어. 인터넷과 연결 설정을 확인해줘. 연결되면 자동으로 다시 이어져.</div>}

    {!activeRoom ? <>
      <section className="hero">
        <div className="hero-copy"><span className="eyebrow"><Icon name="spark" size={14} /> {desktop ? 'YOUR DESKTOP, A LITTLE HAPPIER' : 'YOUR BROWSER, A LITTLE HAPPIER'}</span><h1>각자의 하루,<br /><em>같은 모퉁이.</em></h1><p>할 일을 하는 동안에도, 좋아하는 친구들은 곁에.<br />작은 캐릭터와 말풍선으로 느슨하게 함께 있어.</p><div className="hero-meta"><span>작은 친구들</span><span>우리만의 방</span><span>{desktop ? '바탕화면 위의 수다' : '브라우저 속 작은 산책'}</span></div></div>
        <div className="hero-art" aria-hidden="true"><span className="hero-art-note">오늘도 같이 있을까?</span><img className="hero-character hero-character-main" src={characterAsset('chiikawa')} alt="" /><img className="hero-character hero-character-friend" src={characterAsset('hachiware')} alt="" /><span className="hero-spark">✧</span><span className="hero-ground" /></div>
      </section>
      {network.pending || queuedJoin ? <section className="waiting-card"><img src={characterAsset(profile.character)} alt={characterName(profile.character)} /><span className="eyebrow">KNOCK, KNOCK</span><h2>{queuedJoin ? '친구의 서버에 연결하는 중' : '방 문을 똑똑 두드렸어'}</h2><p>{queuedJoin ? '초대장에 적힌 주소로 찾아가는 중이야.' : '방장이 입장을 허락하면 바로 만나게 돼.'}</p><button className="secondary-button" onClick={() => { setQueuedJoin(null); void network.leave(); }}>요청 취소</button></section> : <div className="onboarding-grid">
        <section className="profile-panel">
          <div className="section-heading"><span className="step-number">01</span><div><h2>오늘의 나는 누구?</h2><p>친구들이 알아볼 이름과 캐릭터를 골라줘.</p></div></div>
          <label className="field" htmlFor="nickname">닉네임<input id="nickname" value={profile.nickname} onChange={(event) => setProfile({ ...profile, nickname: event.target.value })} maxLength={16} placeholder="어떻게 불러주면 될까?" autoComplete="nickname" /></label>
          <CharacterPicker selected={profile.character} onSelect={(character) => setProfile({ ...profile, character })} />
        </section>
        <section className="room-panel">
          <div className="section-heading"><span className="step-number">02</span><div><h2>우리, 어디서 만날까?</h2><p>방 하나면 충분해. 최대 8명이 함께할 수 있어.</p></div></div>
          <div className="room-tabs" role="tablist" aria-label="방 참여 방법"><button className={`tab ${roomTab === 'create' ? 'active' : ''}`} role="tab" aria-selected={roomTab === 'create'} onClick={() => setRoomTab('create')}>새 방 만들기</button><button className={`tab ${roomTab === 'join' ? 'active' : ''}`} role="tab" aria-selected={roomTab === 'join'} onClick={() => setRoomTab('join')}>초대받았어요</button></div>
          {roomTab === 'create' ? <div className="create-room-content"><div className="room-illustration" aria-hidden="true"><Icon name="chat" size={32} /><span>작은 방, 큰 수다</span></div><p>방을 만들고 8자리 코드를 친구에게 보내줘.<br />코드를 입력하면 바로 같은 방에서 만날 수 있어.</p><button className="primary-button" disabled={network.busy || !network.connected} onClick={() => { const valid = validatedProfile(); if (valid) void network.create(valid); }}>우리 방 만들기<Icon name="arrow" /></button></div> : <form className="join-form" onSubmit={joinRoom}><label className="field" htmlFor="invite-code">초대 코드 · 초대 링크 · 초대장<input id="invite-code" value={invitation} onChange={(event) => setInvitation(event.target.value)} placeholder="K7MP-4H2Q 또는 친구가 보낸 링크" maxLength={500} autoComplete="off" spellCheck={false} /></label><p>브라우저와 앱에서 같은 8자리 코드를 쓸 수 있어.<br />초대장이나 링크는 서버 주소도 알아서 맞춰줘.</p><button className="primary-button" disabled={network.busy || !invitation.trim()}>코드로 바로 입장<Icon name="arrow" /></button></form>}
          <details className="advanced-settings"><summary><Icon name="settings" size={14} /> 연결 설정</summary><label className="field" htmlFor="server-url">서버 주소<input id="server-url" type="url" value={serverDraft} onChange={(event) => setServerDraft(event.target.value)} spellCheck={false} /></label><p>같은 방에 들어가는 친구들은 같은 서버를 사용해. 전체 초대장을 받으면 자동으로 설정돼.</p><button className="secondary-button" onClick={() => { try { changeEndpoint(serverDraft); network.setError(''); setToast('서버 주소를 적용했어.'); } catch (cause) { network.setError((cause as Error).message); } }}>주소 적용</button></details>
        </section>
      </div>}
      {!network.pending && !queuedJoin && <div className="onboarding-actions"><span>아직 친구가 안 왔어도 괜찮아.</span><button className="subtle-button" onClick={startDemo}>먼저 혼자 둘러보기 <Icon name="arrow" size={15} /></button></div>}
      <footer className="app-footer"><span>귀여운 건 같이 보면 더 귀여우니까.</span><span>{desktop ? `${desktopPlatform === 'win32' ? 'Windows' : desktopPlatform === 'darwin' ? 'macOS' : '데스크톱'} 바탕화면 친구` : '브라우저에서도 같은 방 · 탭 안의 작은 정원'}</span></footer>
    </> : <>
      {isDemo && <div className="demo-banner"><Icon name="spark" /><span><strong>혼자 둘러보기</strong> · 하루와 우쨔는 체험용 친구야. 실제로 연결된 사람은 없어.</span><button className="subtle-button" onClick={leaveRoom}>체험 마치기</button></div>}
      <section className="room-header"><div><span className="eyebrow">OUR LITTLE CORNER</span><h1>{isDemo ? '우리의 작은 모퉁이' : activeRoom.name || '우리의 작은 모퉁이'}</h1><p>{activeRoom.members.filter((member) => member.online).length}명의 작은 친구가 함께 있어{!isDemo && activeRoom.locked ? ' · 지금은 입장 잠금 중' : '.'}</p></div><div className="room-header-actions">{!isDemo && <><button className="room-code" title="초대 코드 복사" onClick={() => void copy(activeRoom.code, '초대 코드를 복사했어.')}><span>초대 코드</span><strong>{activeRoom.code}</strong><Icon name="copy" size={16} /></button><button className="primary-button" onClick={() => void copy(desktop ? `치이카와 모퉁이 | ${endpoint} | ${activeRoom.code}` : webLink, desktop ? '초대장을 복사했어. 친구에게 보내줘!' : '웹 초대 링크를 복사했어. 친구에게 보내줘!')}>{desktop ? '친구 초대' : '링크 초대'} <Icon name="copy" size={16} /></button><button className="subtle-button" onClick={() => void copy(desktop ? webLink : `치이카와 모퉁이 | ${endpoint} | ${activeRoom.code}`, desktop ? '웹 초대 링크를 복사했어.' : '앱에서도 쓸 수 있는 초대장을 복사했어.')}>{desktop ? '웹 링크' : '앱 초대장'}</button></>}{!isDemo && <button className="subtle-button" onClick={leaveRoom}>나가기</button>}</div></section>
      <div className="room-layout"><main className="room-main">
        {desktop ? <DesktopPreview room={activeRoom} quiet={quiet} /> : <BrowserGarden room={activeRoom} quiet={quiet} size={size} />}
        {!desktop && <div className="browser-float-bar"><div><strong>탭 밖의 작은 모퉁이</strong><span>지원하는 브라우저에서는 다른 창을 보는 동안에도 친구들과 수다 떨어.</span></div><BrowserFloat room={activeRoom} memberId={memberId} connected={isDemo || network.connected} quiet={quiet} onSend={sendText} /></div>}
        <div className="conversation-heading"><span><Icon name="chat" size={17} /> 모퉁이의 수다</span><small>최근 대화 100개 · 방이 끝나면 사라져</small></div>
        <div className="message-list" ref={messagesRef} role="log" aria-live="polite" aria-label="대화 기록">
          {!activeRoom.messages.length && <div className="chat-empty"><Icon name="leaf" size={28} /><p>아직 조용한 모퉁이네.<br />첫 인사를 건네볼까?</p></div>}
          {activeRoom.messages.map((message) => <div key={message.id} className={`message ${message.memberId === memberId ? 'own' : ''} ${message.kind === 'system' ? 'system' : ''}`}>{message.kind === 'system' ? <span>{message.text}</span> : <><img className="message-avatar" src={characterAsset(message.character)} alt="" /><div className="message-body"><div className="message-meta"><strong>{message.nickname}{message.memberId === memberId ? ' · 나' : ''}</strong><time dateTime={new Date(message.sentAt).toISOString()}>{formatTime(message.sentAt)}</time></div><div className="message-bubble">{message.text}</div></div></>}</div>)}
        </div>
        <form className="composer" onSubmit={sendMessage}><textarea ref={chatRef} value={draft} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void sendMessage(); } }} maxLength={200} rows={2} aria-label="친구에게 보낼 말" placeholder={network.connected || isDemo ? '오늘은 어떤 하루였어?' : '연결을 다시 기다리는 중… 입력한 글은 남아 있어.'} /><div className="composer-meta"><span>Enter로 보내기 · Shift + Enter로 줄바꿈</span><span>{draft.length}/200</span><button type="submit" className="primary-button" disabled={!draft.trim() || sending || (!isDemo && !network.connected)} aria-label="메시지 보내기">{sending ? '보내는 중' : '보내기'}<Icon name="arrow" size={16} /></button></div></form>
      </main><aside className="room-sidebar">
        <section><div className="section-heading"><h2>함께 있는 친구들 <span className="count-badge">{activeRoom.members.length}</span></h2></div><div className="member-list">{activeRoom.members.map((member) => <div className="member-row" key={member.id}><img className="member-avatar" src={characterAsset(member.character)} alt="" /><div className="member-info"><strong>{member.nickname}{member.id === memberId && <small>나</small>}</strong><span>{member.id === activeRoom.hostId ? '방장 · ' : ''}{member.online ? characterName(member.character) : '잠시 자리 비움'}</span></div><span className={`member-status ${member.online ? 'online' : ''}`} title={member.online ? '접속 중' : '오프라인'} />{isHost && !isDemo && member.id !== memberId && <details className="member-actions"><summary aria-label={`${member.nickname} 관리`}>···</summary><button className="subtle-button" disabled={network.busy || !member.online} onClick={() => void network.act('room:transfer', { memberId: member.id })}>방장 넘기기</button><button className="danger-button" disabled={network.busy} onClick={() => void network.act('room:kick', { memberId: member.id }).then((result) => { if (result) setToast('친구를 내보냈어. 초대 코드도 새로 바꿨어.'); })}>방에서 내보내기</button></details>}</div>)}</div></section>
        {isHost && !isDemo && activeRoom.pending.length > 0 && <section className="pending-section"><h3>똑똑! 친구가 왔어 <span className="count-badge">{activeRoom.pending.length}</span></h3>{activeRoom.pending.map((request) => <div className="pending-card" key={request.id}><img className="member-avatar" src={characterAsset(request.character)} alt="" /><strong>{request.nickname}</strong><div><button className="primary-button" disabled={network.busy} onClick={() => void network.act('room:approve', { requestId: request.id })}>들어와!</button><button className="subtle-button" disabled={network.busy} onClick={() => void network.act('room:reject', { requestId: request.id })}>거절</button></div></div>)}</section>}
        <section className="settings-panel"><div className="section-heading"><h2>{desktop ? '내 바탕화면' : '내 작은 정원'}</h2><Icon name="settings" size={17} /></div><label className="settings-row"><span>조용히 함께 있기<small>말풍선 숨기기 · 대화는 기록에 남아</small></span><input type="checkbox" checked={quiet} onChange={(event) => setQuiet(event.target.checked)} /></label><label className="settings-row size-setting"><span>친구들 크기<small>{Math.round(size * 100)}%</small></span><input type="range" min="0.7" max="1.5" step="0.1" value={size} onChange={(event) => setSize(Number(event.target.value))} aria-label="캐릭터 크기" /></label>{desktop && <><label className="settings-row"><span>바탕화면 친구 숨기기</span><input type="checkbox" checked={overlayHidden} onChange={async () => { try { const visible = await window.corner!.toggleOverlay(); setOverlayHidden(!visible); } catch { network.setError('바탕화면 표시를 바꾸지 못했어.'); } }} /></label>{displays.length > 1 && <label className="field" htmlFor="display-select">친구들이 놀 모니터<select id="display-select" value={selectedDisplay} onChange={async (event) => { const value = event.target.value; try { await window.corner!.selectDisplay(Number(value)); setSelectedDisplay(value); } catch { network.setError('모니터를 바꾸지 못했어.'); } }}><option value="" disabled>기본 모니터</option>{displays.map((display) => <option value={display.id} key={display.id}>{display.label}</option>)}</select></label>}<button className="secondary-button" onClick={() => window.corner?.hidePanel()}>창 접고 바탕화면에서 만나기</button><p className="settings-hint">캐릭터를 누르면 대화창이 다시 열려.<br />{desktopPlatform === 'win32' ? '작업표시줄의 트레이 아이콘에서도 열 수 있어.' : '메뉴바 아이콘에서도 열 수 있어.'}<span className="settings-shortcut">빠르게 열기 <kbd>{desktopPlatform === 'win32' ? 'Ctrl+Shift+Space' : '⌘⇧Space'}</kbd></span></p></>}{!desktop && <p className="settings-hint">친구들이 이 탭 안에서 산책해. 작은 창으로 꺼내두면 다른 탭을 볼 때도 함께할 수 있어. 바탕화면 전체에 띄우려면 설치 앱을 사용해줘.</p>}</section>
        {isHost && !isDemo && <details className="settings-panel room-controls"><summary>방장 설정</summary><label className="settings-row"><span>새로운 입장 잠그기</span><input type="checkbox" checked={activeRoom.locked} disabled={network.busy} onChange={(event) => void network.act('room:lock', { locked: event.target.checked })} /></label><button className="secondary-button" disabled={network.busy} onClick={() => void network.act('room:rotate-code', {}).then((result) => { if (result) setToast('새 초대 코드로 바꿨어. 이전 코드는 사용할 수 없어.'); })}>초대 코드 새로 만들기</button></details>}
      </aside></div>
    </>}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}
