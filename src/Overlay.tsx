import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, Member, OverlayState, RoomSnapshot } from '../shared/protocol';
import { characterAsset, characterSleepAsset } from './characters';
import { petAction, petActivity, type PetAction } from './petActivity';

const emptyState: OverlayState = { room: null, memberId: null, size: 1, quiet: false };
function hashId(value: string): number { return [...value].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7); }

export function DesktopPreview({ room, quiet = false }: { room: RoomSnapshot; quiet?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);
  return <div className="preview-scene" aria-label="바탕화면 미리보기">
    <span className="preview-caption">MY LITTLE DESKTOP</span>
    <div className="preview-sun" aria-hidden="true" />
    <div className="preview-floor" />
    {room.members.slice(0, 8).map((member, index) => {
      const latest = room.messages.filter((message) => message.memberId === member.id && message.kind !== 'system').at(-1);
      const activity = petActivity(member, now, latest);
      const speaking = !quiet && Boolean(latest && now - latest.sentAt < 9000);
      const action = petAction(member.id, now, activity.sleeping, speaking);
      return <div key={member.id} className={`preview-pet${activity.sleeping ? ' is-sleeping' : ''}`} data-action={action} style={{ left: `${8 + (index / Math.max(room.members.length - 1, 1)) * 72}%`, animationDelay: `${-index * 1.7}s` }}>
        {speaking && latest && <div className="preview-bubble">{latest.text}</div>}
        {activity.sleeping && <span className="pet-sleep-symbol" aria-hidden="true">zZ</span>}
        <img className={`character-image pet-action-${action}`} src={activity.sleeping ? characterSleepAsset(member.character) : characterAsset(member.character)} alt="" />
        <span className="pet-label">{member.nickname}{!member.online && ' · 잠시 자리 비움'}</span>
        {activity.sleeping && <span className="preview-idle" title={activity.sleepLabel}>{activity.sleepLabel}</span>}
      </div>;
    })}
  </div>;
}

function Pet({ member, index, count, size, message, reducedMotion, sleeping, sleepLabel, action }: { member: Member; index: number; count: number; size: number; message?: ChatMessage; reducedMotion: boolean; sleeping: boolean; sleepLabel: string; action: PetAction }) {
  const ref = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const motion = useRef({ elapsed: 0, previousTime: 0 });
  const [showMessage, setShowMessage] = useState(false);
  useEffect(() => () => window.corner?.setMousePassthrough(true), []);
  useEffect(() => {
    if (!message) { setShowMessage(false); return; }
    const remaining = Math.max(0, message.sentAt + 9000 - Date.now());
    setShowMessage(remaining > 0);
    const timer = window.setTimeout(() => setShowMessage(false), remaining);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    let frame = 0;
    let lastFrame = 0;
    const seed = hashId(member.id) % 100;
    const draw = (time: number) => {
      if (time - lastFrame > 40) {
        lastFrame = time;
        const width = window.innerWidth;
        const height = window.innerHeight;
        const spriteSize = 128 * size;
        const laneWidth = width / Math.max(count, 1);
        const safeMargin = Math.min(90, width / 8);
        const delta = motion.current.previousTime ? Math.min(time - motion.current.previousTime, 120) : 0;
        motion.current.previousTime = time;
        if (!reducedMotion && !showMessage && (action === 'stroll' || action === 'hop' || action === 'peek')) motion.current.elapsed += delta;
        const progress = reducedMotion ? 0 : Math.sin(motion.current.elapsed / 11000 + seed);
        const center = laneWidth * (index + .5);
        const x = Math.max(safeMargin, Math.min(width - spriteSize - safeMargin, center - spriteSize / 2 + progress * Math.min(laneWidth * .23, 90)));
        const bounce = reducedMotion || showMessage || sleeping ? 0 : Math.abs(Math.sin(time / 260 + seed)) * (action === 'hop' ? 8 : action === 'stroll' ? 2 : 0);
        const y = Math.max(20, height - spriteSize - 15 - bounce);
        if (ref.current) ref.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (imageRef.current) imageRef.current.style.transform = `scaleX(${!reducedMotion && Math.cos(motion.current.elapsed / 11000 + seed) < 0 ? -1 : 1})`;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [member.id, index, count, size, showMessage, reducedMotion, action, sleeping]);
  return <button ref={ref} className={`desktop-pet${sleeping ? ' is-sleeping' : ''}`} style={{ width: 128 * size, height: 128 * size, opacity: member.online ? 1 : .55 }}
    aria-label={sleeping ? `${member.nickname}: ${sleepLabel}. 채팅 열기` : `${member.nickname}의 채팅 열기`} onClick={() => window.corner?.openPanel()}
    onMouseEnter={() => window.corner?.setMousePassthrough(false)} onMouseLeave={() => window.corner?.setMousePassthrough(true)}>
    {showMessage && message && <span className="speech-bubble">{message.text}</span>}
    {sleeping && <span className="pet-sleep-symbol" aria-hidden="true">zZ</span>}
    <img ref={imageRef} className={`pet-image pet-action-${action}`} src={sleeping ? characterSleepAsset(member.character) : characterAsset(member.character)} alt="" draggable={false} />
    <span className="pet-label" style={{ borderColor: member.color }}>{member.nickname}</span>
    {sleeping && <span className="desktop-idle" title={sleepLabel}>{sleepLabel}</span>}
  </button>;
}
export function Overlay() {
  const [state, setState] = useState<OverlayState>(emptyState);
  const [now, setNow] = useState(Date.now);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    const dispose = window.corner?.onOverlay(setState);
    window.corner?.setMousePassthrough(true);
    return dispose;
  }, []);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);
  return <div className="overlay-stage">{state.room?.members.map((member, index) => {
    const latest = state.room!.messages.filter((message) => message.memberId === member.id && message.kind !== 'system').at(-1);
    const activity = petActivity(member, now, latest);
    const speaking = !state.quiet && Boolean(latest && now - latest.sentAt < 9000);
    return <Pet key={member.id} member={member} index={index} count={state.room!.members.length} size={state.size} reducedMotion={reducedMotion}
      message={state.quiet ? undefined : latest} sleeping={activity.sleeping} sleepLabel={activity.sleepLabel}
      action={petAction(member.id, now, activity.sleeping, speaking)} />;
  })}</div>;
}
