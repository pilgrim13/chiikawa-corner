import assert from 'node:assert/strict';
import test from 'node:test';
import { petAction, petActivity, SLEEP_AFTER_MS } from '../src/petActivity.ts';

const joinedAt = 1_000_000;
const member = { id: 'friend', nickname: '친구', character: 'chiikawa', color: '#fff', online: true, joinedAt };
const message = (sentAt) => ({ id: 'chat', memberId: member.id, nickname: member.nickname, character: member.character, text: '안녕', sentAt });

test('a pet sleeps at exactly ten minutes and a new chat wakes it', () => {
  assert.equal(petActivity(member, joinedAt + SLEEP_AFTER_MS - 1).sleeping, false);
  const idle = petActivity(member, joinedAt + SLEEP_AFTER_MS);
  assert.equal(idle.sleeping, true);
  assert.equal(idle.sleepLabel, '아직 채팅 안 함 · 10분');

  const chatted = { ...member, lastChatAt: joinedAt + SLEEP_AFTER_MS + 1, hasChatted: true };
  assert.equal(petActivity(chatted, joinedAt + SLEEP_AFTER_MS + 1).sleeping, false);
  assert.equal(petActivity(chatted, chatted.lastChatAt + SLEEP_AFTER_MS).sleepLabel, '마지막 채팅 10분 전');
});

test('message history keeps older server snapshots awake until ten minutes after chat', () => {
  const recent = message(joinedAt + 9 * 60_000);
  assert.equal(petActivity(member, joinedAt + 18 * 60_000, recent).sleeping, false);
  assert.equal(petActivity(member, joinedAt + 19 * 60_000, recent).sleepLabel, '마지막 채팅 10분 전');
  assert.equal(petActivity({ ...member, hasChatted: false }, joinedAt + 19 * 60_000, recent).hasChatted, true);
});

test('server activity timestamp remains authoritative after history is trimmed', () => {
  const chatted = { ...member, lastChatAt: joinedAt + 30 * 60_000, hasChatted: true };
  assert.equal(petActivity(chatted, joinedAt + 39 * 60_000).sleeping, false);
  assert.equal(petActivity(chatted, joinedAt + 40 * 60_000).sleeping, true);
});

test('pets cycle playful actions and sleep or chat take priority', () => {
  const sequence = new Set(Array.from({ length: 6 }, (_, index) => petAction(member.id, index * 7_000, false)));
  assert.equal(sequence.size, 6);
  assert.equal(petAction(member.id, 7_000, true, true), 'sleep');
  assert.equal(petAction(member.id, 7_000, false, true), 'chat');
});
