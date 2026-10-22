import { useEffect, useRef, useState } from 'react';
import type { UpdateState } from '../shared/protocol';

type UpdateAction = 'check' | 'download' | 'install';
const BROWSER_STATE: UpdateState = {
  phase: 'unsupported', currentVersion: '',
  message: '업데이트는 설치된 Mac 앱에서 할 수 있어. 브라우저에서는 새로고침하면 최신 화면을 볼 수 있어.',
};
const phaseCopy: Record<UpdateState['phase'], { title: string; detail: string }> = {
  idle: { title: '새 소식이 있을까?', detail: '새 버전이 있는지 확인해볼까?' },
  checking: { title: '새 버전을 찾고 있어', detail: '조금만 기다려줘.' },
  current: { title: '지금 최신 버전이야', detail: '친구들과 계속 편하게 놀면 돼.' },
  available: { title: '새 버전이 도착했어', detail: '달라진 내용을 확인하고 업데이트해줘.' },
  downloading: { title: '새 버전을 가져오는 중', detail: '이 창을 닫아도 다운로드는 계속돼.' },
  verifying: { title: '마지막으로 확인하는 중', detail: '다운로드한 파일이 온전한지 확인하고 있어.' },
  ready: { title: '업데이트 준비가 끝났어', detail: '아래 버튼을 누르면 앱이 잠깐 닫혔다가 새 버전으로 열려.' },
  installing: { title: '새 버전으로 다시 만날게', detail: '앱을 다시 여는 중이야. 잠깐만 기다려줘.' },
  error: { title: '업데이트를 마치지 못했어', detail: '인터넷 연결을 확인한 뒤 다시 시도해줘.' },
  unsupported: { title: '설치형 앱에서 업데이트', detail: '설치된 Mac 앱에서 업데이트를 확인할 수 있어.' },
};

function UpdateIcon({ spinning = false }: { spinning?: boolean }) {
  return <svg className={spinning ? 'update-icon spinning' : 'update-icon'} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" /></svg>;
}

export function UpdatePanel({ desktop }: { desktop: boolean }) {
  const api = window.corner;
  const supported = desktop && typeof api?.getUpdateState === 'function' && typeof api.onUpdateState === 'function';
  const [state, setState] = useState<UpdateState>(() => supported ? { phase: 'idle', currentVersion: '' } : BROWSER_STATE);
  const [open, setOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastAction = useRef<UpdateAction>('check');
  const actionLock = useRef(false);
  const alive = useRef(true);
  const revision = useRef(0);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    if (!supported || !api) { setState(BROWSER_STATE); return () => { disposed = true; alive.current = false; }; }
    const initialRevision = revision.current;
    const unsubscribe = api.onUpdateState((next) => {
      if (disposed) return;
      revision.current += 1;
      setState(next);
    });
    api.getUpdateState().then((next) => {
      if (!disposed && revision.current === initialRevision) setState(next);
    }).catch(() => {
      if (!disposed && revision.current === initialRevision) setState((previous) => ({ ...previous, phase: 'error', message: '업데이트 상태를 불러오지 못했어. 다시 확인해줘.' }));
    });
    return () => { disposed = true; alive.current = false; unsubscribe(); };
  }, [supported, api]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) { dialog.showModal(); closeRef.current?.focus(); }
    if (!open && dialog.open) { dialog.close(); triggerRef.current?.focus(); }
  }, [open]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog?.open && !dialog.contains(document.activeElement)) closeRef.current?.focus();
  }, [open, state.phase]);

  const busy = actionPending || ['checking', 'downloading', 'verifying', 'installing'].includes(state.phase);
  const hasUpdate = ['available', 'ready'].includes(state.phase);
  const percent = typeof state.progress === 'number' && Number.isFinite(state.progress) ? Math.round(Math.min(100, Math.max(0, state.progress))) : undefined;
  const copy = phaseCopy[state.phase];
  const invoke = async (action: UpdateAction) => {
    if (!supported || !api || busy || actionLock.current) return;
    actionLock.current = true; lastAction.current = action; setActionPending(true);
    const optimisticPhase = action === 'check' ? 'checking' : action === 'download' ? 'downloading' : 'installing';
    setState((previous) => ({ ...previous, phase: optimisticPhase, message: undefined, ...(action === 'download' ? { progress: 0 } : {}) }));
    try {
      const next = action === 'check' ? await api.checkForUpdate() : action === 'download' ? await api.downloadUpdate() : await api.installUpdate();
      if (alive.current) setState(next);
    } catch {
      if (alive.current) setState((previous) => ({ ...previous, phase: 'error', message: action === 'install' ? '업데이트를 적용하지 못했어. 다시 눌러 시도해줘.' : '업데이트를 가져오지 못했어. 인터넷 연결을 확인하고 다시 시도해줘.' }));
    } finally { actionLock.current = false; if (alive.current) setActionPending(false); }
  };

  return <>
    <button ref={triggerRef} type="button" className={`subtle-button update-button ${hasUpdate ? 'has-update' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-controls="app-update-dialog" aria-label={hasUpdate ? '업데이트: 새 버전이 있어' : '업데이트'} onClick={() => setOpen(true)}>
      <UpdateIcon spinning={busy} /><span>업데이트</span>{hasUpdate && <i className="update-dot" aria-hidden="true" />}
    </button>
    <dialog ref={dialogRef} id="app-update-dialog" className="update-dialog" aria-labelledby="update-dialog-title" aria-describedby="update-dialog-description" onCancel={(event) => { event.preventDefault(); setOpen(false); }} onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((control) => control.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }} onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="update-dialog-content">
        <div className="update-dialog-heading"><span className="eyebrow">A FRESH LITTLE CORNER</span><button ref={closeRef} type="button" className="subtle-button update-close" aria-label="업데이트 창 닫기" onClick={() => setOpen(false)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button></div>
        <div className={`update-symbol ${state.phase === 'current' ? 'is-current' : ''}`} aria-hidden="true"><UpdateIcon spinning={busy} /></div>
        <div className="update-status" role={state.phase === 'error' ? 'alert' : 'status'} aria-live="polite"><h2 id="update-dialog-title">{copy.title}</h2><p id="update-dialog-description">{state.message || copy.detail}</p></div>
        <dl className="update-versions"><div><dt>현재 버전</dt><dd>{state.currentVersion ? `v${state.currentVersion}` : supported ? '확인 중' : '브라우저 미리보기'}</dd></div>{state.latestVersion && <div><dt>새 버전</dt><dd>v{state.latestVersion}</dd></div>}</dl>
        {(state.phase === 'downloading' || state.phase === 'verifying') && <div className="update-progress"><div><span>{state.phase === 'verifying' ? '파일 확인 중' : '다운로드 중'}</span><strong>{state.phase === 'verifying' ? '100%' : percent === undefined ? '준비 중' : `${percent}%`}</strong></div><progress aria-label={state.phase === 'verifying' ? '업데이트 파일 확인' : '업데이트 다운로드'} max={100} value={state.phase === 'verifying' ? 100 : percent} /></div>}
        {state.releaseNotes && <section className="update-release-notes" aria-label="업데이트 내용"><h3>이번에 달라진 점</h3><p>{state.releaseNotes}</p></section>}
        {state.phase === 'ready' && <p className="update-restart-note">쓰던 메시지는 먼저 보내줘. 준비되면 재시작하면 돼.</p>}
        <div className="update-actions">
          {supported && ['idle', 'current'].includes(state.phase) && <button type="button" className="primary-button" disabled={busy} onClick={() => void invoke('check')}>업데이트 확인</button>}
          {supported && state.phase === 'available' && <><button type="button" className="secondary-button" disabled={busy} onClick={() => void invoke('check')}>다시 확인</button><button type="button" className="primary-button" disabled={busy} onClick={() => void invoke('download')}>업데이트 다운로드</button></>}
          {supported && state.phase === 'ready' && <><button type="button" className="secondary-button" onClick={() => setOpen(false)}>나중에 할게</button><button type="button" className="primary-button" disabled={busy} onClick={() => void invoke('install')}>재시작하고 적용</button></>}
          {supported && state.phase === 'error' && <button type="button" className="primary-button" disabled={busy} onClick={() => void invoke(lastAction.current)}>{lastAction.current === 'install' ? '재시작하고 다시 적용' : '다시 시도'}</button>}
          {busy && <button type="button" className="primary-button" disabled><UpdateIcon spinning />{state.phase === 'checking' ? '확인하는 중' : state.phase === 'installing' ? '다시 여는 중' : '업데이트 준비 중'}</button>}
          {state.phase === 'unsupported' && <button type="button" className="primary-button" onClick={() => setOpen(false)}>알겠어</button>}
        </div>
      </div>
    </dialog>
  </>;
}
