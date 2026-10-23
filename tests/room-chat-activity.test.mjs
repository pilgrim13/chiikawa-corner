import assert from 'node:assert/strict';
import test from 'node:test';
import { petActivity } from '../src/petActivity.ts';
import { recordChatMessage, retainRecentActivity } from '../src/useRoom.ts';

const joinedAt = 1_000_000;
const member = (id) => ({ id, nickname: id, character: 'chiikawa', color: '#fff', online: true, joinedAt });
const room = () => ({ id: 'room-1', code: 'ABC23456', name: 'test', hostId: 'a', locked: false, pending: [], members: [member('a'), member('b')], messages: [] });
const chat = (id, memberId, sentAt) => ({ id, memberId, nickname: memberId, character: 'chiikawa', text: id, sentAt, kind: 'chat' });

test('chat events retain each member activity after their message scrolls out of history', () => {
  const lastA = joinedAt + 5 * 60_000;
  let current = recordChatMessage(room(), chat('a-chat', 'a', lastA));
  for (let index = 0; index < 100; index++) {
    current = recordChatMessage(current, chat(`b-${index}`, 'b', joinedAt + 6 * 60_000 + index * 100));
  }
  assert.equal(current.messages.length, 100);
  assert.equal(current.messages.some((message) => message.memberId === 'a'), false);
  assert.equal(current.members[0].lastChatAt, lastA);
  assert.equal(current.members[0].hasChatted, true);
  assert.equal(petActivity(current.members[0], lastA + 9 * 60_000).sleeping, false);
  assert.equal(petActivity(current.members[0], lastA + 10 * 60_000).sleepLabel, '마지막 채팅 10분 전');
});

test('duplicate ACKs, older events, and stale reconnect snapshots never rewind activity', () => {
  const newest = chat('new', 'a', joinedAt + 20 * 60_000);
  const older = chat('old', 'a', joinedAt + 8 * 60_000);
  const afterEvent = recordChatMessage(room(), newest);
  assert.equal(recordChatMessage(afterEvent, newest), afterEvent);
  const afterLateAck = recordChatMessage(afterEvent, older);
  assert.equal(afterLateAck.members[0].lastChatAt, newest.sentAt);

  const stale = room();
  stale.messages = [older];
  const afterSnapshot = retainRecentActivity(stale, afterLateAck);
  assert.equal(afterSnapshot.members[0].lastChatAt, newest.sentAt);
  assert.equal(afterSnapshot.members[0].hasChatted, true);
  assert.equal(petActivity(afterSnapshot.members[0], newest.sentAt + 9 * 60_000).sleeping, false);

  const anotherRoom = { ...stale, id: 'room-2' };
  assert.equal(retainRecentActivity(anotherRoom, afterLateAck), anotherRoom);
});

test('system messages do not count as a member chat', () => {
  const system = { ...chat('system', 'a', joinedAt + 60_000), kind: 'system' };
  const next = recordChatMessage(room(), system);
  assert.equal(next.members[0].hasChatted, undefined);
  assert.equal(next.members[0].lastChatAt, undefined);
});
