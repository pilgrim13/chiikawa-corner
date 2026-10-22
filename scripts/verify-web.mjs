import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const site = process.env.WEB_URL || 'https://junnyeonglee-macmini.taile9e6e.ts.net/chiikawa/';
const screenshotDir = resolve(process.env.WEB_SCREENSHOT_DIR || '.runtime/web-verification');
const browser = await chromium.launch({ channel: process.env.WEB_BROWSER_CHANNEL || 'chrome', headless: true });
const hostContext = await browser.newContext({ viewport: { width: 1260, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
const host = await hostContext.newPage();
const guest = await guestContext.newPage();
host.setDefaultTimeout(30_000);
guest.setDefaultTimeout(30_000);
let hostCreated = false;
let result = 'failed';

async function leaveIfJoined(page) {
  const leave = page.getByRole('button', { name: '나가기', exact: true });
  if (await leave.count()) await leave.click({ timeout: 5_000 }).catch(() => {});
}

try {
  const response = await host.goto(site, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200, '웹 첫 화면이 열려야 해');
  await host.locator('.status-pill.online').waitFor();
  await host.locator('#nickname').fill('웹방장');
  await host.locator('[data-character="momonga"]').click();
  await host.getByRole('button', { name: '우리 방 만들기' }).click();
  const roomCode = await host.locator('.room-code strong').innerText();
  assert.match(roomCode, /^[A-Z2-9]{8}$/u);
  hostCreated = true;
  await host.getByRole('button', { name: /링크 초대/u }).click();
  const invitation = await host.evaluate(() => navigator.clipboard.readText());
  const invitationUrl = new URL(invitation);
  assert.equal(invitationUrl.searchParams.get('join'), roomCode);
  assert.match(invitationUrl.pathname, /\/chiikawa\/$/u);

  const guestResponse = await guest.goto(invitation, { waitUntil: 'domcontentloaded' });
  assert.equal(guestResponse?.status(), 200, '초대 링크가 열려야 해');
  await guest.locator('.status-pill.online').waitFor();
  assert.equal(await guest.locator('#invite-code').inputValue(), invitation, '초대 코드가 자동으로 채워져야 해');
  await guest.locator('#nickname').fill('웹손님');
  await guest.locator('[data-character="shisa"]').click();
  await guest.getByRole('button', { name: '친구 방에 노크하기' }).click();
  await host.locator('.pending-card').getByRole('button', { name: '들어와!' }).click();
  await guest.locator('.room-code strong').waitFor();
  assert.equal(await guest.locator('.room-code strong').innerText(), roomCode);
  assert.equal(await guest.locator('.browser-garden-pet').count(), 2, '웹 정원에 두 친구가 보여야 해');
  await guest.waitForFunction(() => [...document.querySelectorAll('.browser-garden-pet img')].every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
  const gardenImages = await guest.locator('.browser-garden-pet img').evaluateAll((images) => images.map((image) => image.getAttribute('src')));
  assert(gardenImages.some((source) => source?.includes('momonga.png')), '모몽가가 보여야 해');
  assert(gardenImages.some((source) => source?.includes('shisa.png')), '시사가 보여야 해');

  await guest.getByRole('textbox', { name: '친구에게 보낼 말' }).fill('웹에서도 안녕!');
  await guest.getByRole('button', { name: '메시지 보내기' }).click();
  await host.getByText('웹에서도 안녕!', { exact: true }).first().waitFor();
  await host.getByRole('textbox', { name: '친구에게 보낼 말' }).fill('같은 방에서 만나서 반가워!');
  await host.getByRole('button', { name: '메시지 보내기' }).click();
  await guest.getByText('같은 방에서 만나서 반가워!', { exact: true }).first().waitFor();

  await guest.reload({ waitUntil: 'domcontentloaded' });
  await guest.locator('.room-code strong').waitFor();
  assert.equal(await guest.locator('.room-code strong').innerText(), roomCode, '새로고침 후 원래 방에 돌아와야 해');
  await guest.locator('.message-bubble').filter({ hasText: '같은 방에서 만나서 반가워!' }).waitFor();
  await mkdir(screenshotDir, { recursive: true });
  await host.screenshot({ path: resolve(screenshotDir, 'web-desktop.png'), fullPage: true });
  await guest.screenshot({ path: resolve(screenshotDir, 'web-mobile.png'), fullPage: true });
  result = 'passed';
  console.log('PASS: 공개 웹에서 방 생성, 초대 링크, 승인, 새 캐릭터 그림, 양방향 채팅, 새로고침 재접속');
} catch (cause) {
  await mkdir(screenshotDir, { recursive: true });
  await Promise.allSettled([
    host.screenshot({ path: resolve(screenshotDir, 'web-failure-host.png'), fullPage: true }),
    guest.screenshot({ path: resolve(screenshotDir, 'web-failure-guest.png'), fullPage: true }),
  ]);
  console.error('방장 상태:', await host.locator('.status-pill, .error-banner, .notice-banner, .pending-card').allTextContents().catch(() => []));
  console.error('손님 상태:', await guest.locator('.status-pill, .error-banner, .notice-banner, .waiting-card').allTextContents().catch(() => []));
  throw cause;
} finally {
  await leaveIfJoined(guest);
  if (hostCreated) await leaveIfJoined(host);
  await browser.close();
  if (result !== 'passed') console.error('FAIL: 웹 통합 검증 실패. 테스트 방 정리를 시도했어.');
}
