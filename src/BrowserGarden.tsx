import { useEffect, useState } from 'react';
import type { RoomSnapshot } from '../shared/protocol';
import { characterAsset, characterSleepAsset } from './characters';
import { petAction, petActivity } from './petActivity';

type Props = { room: RoomSnapshot; quiet: boolean; size: number };

/** A little shared place to wander when the browser cannot draw on the desktop. */
export function BrowserGarden({ room, quiet, size }: Props) {
  const [drift, setDrift] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now);
  const members = room.members.slice(0, 8);
  const columns = Math.min(4, Math.max(1, members.length));

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => {
      setDrift((current) => {
        const next = { ...current };
        const ids = members.filter((member) => !petActivity(member, Date.now(), room.messages.filter((message) => message.memberId === member.id && message.kind !== 'system').at(-1)).sleeping).map((member) => member.id);
        if (ids.length) {
          const id = ids[Math.floor(Math.random() * ids.length)];
          next[id] = Math.round((Math.random() - .5) * 42);
        }
        return next;
      });
    }, 2800);
    return () => window.clearInterval(timer);
  }, [room.members, room.messages]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return <div className="browser-garden" aria-label="브라우저 모퉁이에서 산책하는 친구들">
    <div className="browser-garden-sky" aria-hidden="true"><span className="browser-garden-sun" /><span className="browser-garden-cloud browser-garden-cloud-one" /><span className="browser-garden-cloud browser-garden-cloud-two" /></div>
    <span className="browser-garden-caption">OUR LITTLE GARDEN <span>친구들이 탭 안에서 산책 중</span></span>
    <div className="browser-garden-hill browser-garden-hill-back" aria-hidden="true" />
    <div className="browser-garden-hill browser-garden-hill-front" aria-hidden="true" />
    {members.map((member, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const rowCount = Math.min(columns, members.length - row * columns);
      const left = ((column + .5) / rowCount) * 100;
      const message = room.messages.filter((item) => item.memberId === member.id && item.kind !== 'system').at(-1);
      const showMessage = !quiet && message && message.sentAt + 9000 > now;
      const activity = petActivity(member, now, message);
      const action = petAction(member.id, now, activity.sleeping, Boolean(showMessage));
      const offset = drift[member.id] || 0;
      const scale = Math.max(.7, Math.min(1.5, size)) * (row === 0 && members.length > 4 ? .86 : 1);
      return <div className={`browser-garden-pet ${row === 0 && members.length > 4 ? 'back-row' : ''} ${activity.sleeping ? 'is-sleeping' : ''}`} key={member.id}
        style={{ left: `${left}%`, bottom: row === 0 && members.length > 4 ? '101px' : '18px', transform: `translateX(calc(-50% + ${offset}px))`, opacity: member.online ? 1 : .55, zIndex: row + 2 }}>
        {showMessage && <span className="browser-garden-bubble">{message.text}</span>}
        {activity.sleeping && <span className="pet-sleep-symbol" aria-hidden="true">zZ</span>}
        <img src={activity.sleeping ? characterSleepAsset(member.character) : characterAsset(member.character)} alt="" className={`browser-garden-image pet-action-${action}`} style={{ width: `${96 * scale}px`, height: `${96 * scale}px`, transform: `scaleX(${offset < 0 ? -1 : 1})` }} draggable={false} />
        <span className="browser-garden-name">{member.nickname}{member.online ? '' : ' · 자리 비움'}</span>
        {activity.sleeping && <span className="browser-garden-idle" title={activity.sleepLabel}>{activity.sleepLabel}</span>}
      </div>;
    })}
    <span className="browser-garden-grass browser-garden-grass-one" aria-hidden="true">✿</span><span className="browser-garden-grass browser-garden-grass-two" aria-hidden="true">✿</span>
  </div>;
}
