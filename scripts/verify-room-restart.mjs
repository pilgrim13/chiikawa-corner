// Browser-level proof that a relay restart keeps the room, code, history, and sessions.
// Run against an isolated build: WEB_DIST=/path/to/staged-dist node scripts/verify-room-restart.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createRoomServer } from '../server/index.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'chiikawa-room-restart-'));
const staticDir = path.resolve(process.env.WEB_DIST || 'dist');
const stateFile = path.join(temporary, 'rooms.json');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let relay;
let browser;
try {
  relay = createRoomServer({ stateFile, staticDir });
  const { port } = await relay.listen(0);
  const address = `http://127.0.0.1:${port}/`;
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  const errors = [];
  for (const page of [host, guest]) page.on('pageerror', (error) => errors.push(error.message));

  await host.goto(address);
  await host.getByText('연결되었어', { exact: true }).waitFor();
  await host.getByLabel('닉네임', { exact: true }).fill('복구방장');
  await host.getByRole('button', { name: '우리 방 만들기' }).click();
  await host.locator('.room-code strong').waitFor();
  const code = (await host.locator('.room-code strong').textContent()).trim();
  await guest.goto(address);
  await guest.getByLabel('닉네임', { exact: true }).fill('복구친구');
  await guest.getByRole('tab', { name: '초대받았어요' }).click();
  await guest.getByLabel('초대 코드 · 초대 링크 · 초대장').fill(code);
  await guest.getByRole('button', { name: '코드로 바로 입장' }).click();
  await guest.getByLabel('친구에게 보낼 말').waitFor();
  const firstMessage = '다시 켜도 이 말이 남아야 해';
  await host.getByLabel('친구에게 보낼 말').fill(firstMessage);
  await host.getByRole('button', { name: '메시지 보내기' }).click();
  await guest.locator('.message-bubble').filter({ hasText: firstMessage }).waitFor();

  await relay.close();
  relay = createRoomServer({ stateFile, staticDir });
  await relay.listen(port);
  for (const page of [host, guest]) {
    await page.getByLabel('친구에게 보낼 말').waitFor({ state: 'visible', timeout: 25_000 });
    await page.locator('.message-bubble').filter({ hasText: firstMessage }).waitFor({ timeout: 25_000 });
    await page.waitForFunction((expected) => document.querySelector('.room-code strong')?.textContent === expected, code, { timeout: 25_000 });
  }
  const secondMessage = '이어서 채팅도 돼';
  await guest.getByLabel('친구에게 보낼 말').fill(secondMessage);
  await guest.getByRole('button', { name: '메시지 보내기' }).click();
  await host.locator('.message-bubble').filter({ hasText: secondMessage }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['same room code', 'two automatic session resumes', 'chat history after relay restart', 'new chat after relay restart'], pageErrors: errors }));
} finally {
  await browser?.close();
  await relay?.close();
  await rm(temporary, { recursive: true, force: true });
}
