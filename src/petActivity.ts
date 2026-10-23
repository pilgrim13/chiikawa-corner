import type { ChatMessage, Member } from '../shared/protocol';

export const SLEEP_AFTER_MS = 10 * 60 * 1000;
export type PetAction = 'stroll' | 'hop' | 'wave' | 'twirl' | 'peek' | 'bob' | 'chat' | 'sleep';

const actions: readonly PetAction[] = ['stroll', 'hop', 'wave', 'twirl', 'peek', 'bob'];

function hashId(value: string): number {
  return [...value].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 7);
}

/** The server timestamp survives reconnects; a recent message keeps older servers compatible. */
export function petActivity(member: Member, now: number, latest?: ChatMessage) {
  const joinedAt = Number.isFinite(member.joinedAt) ? member.joinedAt : now;
  const serverAt = Number.isFinite(member.lastChatAt) ? member.lastChatAt! : joinedAt;
  const messageAt = latest && Number.isFinite(latest.sentAt) ? latest.sentAt : joinedAt;
  const lastChatAt = Math.max(joinedAt, serverAt, messageAt);
  const idleMs = Math.max(0, now - lastChatAt);
  const minutes = Math.floor(idleMs / 60_000);
  const sleeping = idleMs >= SLEEP_AFTER_MS;
  const hasChatted = member.hasChatted === true || Boolean(latest) || serverAt > joinedAt;
  const sleepLabel = hasChatted ? `마지막 채팅 ${minutes}분 전` : `아직 채팅 안 함 · ${minutes}분`;
  return { sleeping, minutes, hasChatted, lastChatAt, sleepLabel };
}

/** A small shared action cycle makes pets feel active without sending extra network events. */
export function petAction(id: string, now: number, sleeping: boolean, speaking = false): PetAction {
  if (sleeping) return 'sleep';
  if (speaking) return 'chat';
  const seed = hashId(id);
  const slot = Math.floor((now + (seed % 8) * 1_000) / 7_000);
  return actions[(slot + seed) % actions.length];
}
