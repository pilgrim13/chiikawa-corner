// Real browser rendering of the ten-minute sleep boundary in web and desktop views.
// WEB_DIST=/path/to/staged-dist node scripts/verify-sleep-ui.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createRoomServer } from '../server/index.mjs';

const staticDir = path.resolve(process.env.WEB_DIST || 'dist');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const relay = createRoomServer({ staticDir });
let browser;
try {
  const { url } = await relay.listen(0);
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const errors = [];
  const web = await browser.newPage();
  web.on('pageerror', (error) => errors.push(error.message));
  await web.goto(url);
  await web.getByText('연결되었어', { exact: true }).waitFor();
  await web.getByLabel('닉네임', { exact: true }).fill('졸린친구');
  await web.getByRole('button', { name: '우리 방 만들기' }).click();
  await web.locator('.browser-garden-pet').waitFor();
  await web.evaluate(() => {
    const actualNow = Date.now.bind(Date);
    window.__sleepTestOffset = 11 * 60_000;
    Date.now = () => actualNow() + window.__sleepTestOffset;
  });
  await web.locator('.browser-garden-pet.is-sleeping').waitFor({ timeout: 4_000 });
  await web.getByText('아직 채팅 안 함 · 11분').waitFor();
  assert.match(await web.locator('.browser-garden-pet img').getAttribute('src'), /chiikawa-sleep\.png$/u);
  await web.waitForFunction(() => { const image = document.querySelector('.browser-garden-pet.is-sleeping img'); return image?.complete && image.naturalWidth > 0; });
  await web.evaluate(() => { window.__sleepTestOffset = 0; });
  await web.getByLabel('친구에게 보낼 말').fill('일어났어!');
  await web.getByRole('button', { name: '메시지 보내기' }).click();
  await web.locator('.browser-garden-pet:not(.is-sleeping)').waitFor({ timeout: 4_000 });
  assert.match(await web.locator('.browser-garden-pet img').getAttribute('src'), /chiikawa\.png$/u);

  const overlay = await browser.newPage();
  overlay.on('pageerror', (error) => errors.push(error.message));
  await overlay.addInitScript(() => {
    window.corner = { onOverlay: (callback) => { window.__overlayTest = callback; return () => {}; }, setMousePassthrough: () => {}, openPanel: () => {} };
  });
  await overlay.goto(`${url}/?view=overlay`);
  await overlay.waitForFunction(() => typeof window.__overlayTest === 'function');
  await overlay.evaluate(() => {
    const lastChatAt = Date.now() - 11 * 60_000;
    window.__overlayTest({ room: {
      id: 'sleep-test', code: 'SLEEPTEST', name: 'sleep test', hostId: 'friend', locked: false, pending: [],
      members: [{ id: 'friend', nickname: '졸린친구', character: 'chiikawa', color: '#ebc5c3', online: true, joinedAt: lastChatAt - 60_000, lastChatAt, hasChatted: true }],
      messages: [],
    }, memberId: 'friend', size: 1, quiet: false });
  });
  await overlay.locator('.desktop-pet.is-sleeping').waitFor();
  await overlay.getByText('마지막 채팅 11분 전').waitFor();
  assert.match(await overlay.locator('.desktop-pet img').getAttribute('src'), /chiikawa-sleep\.png$/u);
  await overlay.waitForFunction(() => { const image = document.querySelector('.desktop-pet.is-sleeping img'); return image?.complete && image.naturalWidth > 0; });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['web sleep after ten minutes', 'small idle label', 'sleeping art', 'wake after chat', 'desktop sleep and idle label'], pageErrors: errors }));
} finally {
  await browser?.close();
  await relay.close();
}
