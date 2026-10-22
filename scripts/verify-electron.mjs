import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const userData = await fs.mkdtemp(path.join(results, 'native-profile-'));
const env = { ...process.env, CORNER_TEST: '1', CORNER_USER_DATA: userData, CORNER_SERVER_URL: process.env.TEST_SERVER_URL || 'http://127.0.0.1:47831' };
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  ...(process.env.CORNER_EXECUTABLE ? { executablePath: process.env.CORNER_EXECUTABLE, args: [] } : { args: [root] }),
  env, timeout: 30000,
});
try {
  let panel;
  for (let i = 0; i < 50; i++) {
    panel = application.windows().find((page) => page.url().includes('view=panel'));
    if (panel) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(panel, 'Panel window opens');
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.getByText('각자의 하루,', { exact: false }).waitFor();
  await panel.locator('.status-pill.online').waitFor({ timeout: 20000 });
  await panel.screenshot({ path: path.join(results, 'mac-onboarding.png') });
  await panel.locator('#nickname').fill('맥테스트');
  await panel.getByRole('button', { name: '우리 방 만들기' }).click();
  await panel.locator('.room-code').waitFor();
  const overlay = application.windows().find((page) => page.url().includes('view=overlay'));
  assert.ok(overlay, 'Overlay window exists');
  await overlay.locator('.desktop-pet').waitFor();
  assert.equal(await overlay.locator('.desktop-pet').count(), 1);
  const windowState = await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('view=overlay'));
    return { visible: w.isVisible(), focusable: w.isFocusable(), onTop: w.isAlwaysOnTop(), bounds: w.getBounds(), background: w.getBackgroundColor() };
  });
  assert.equal(windowState.visible, true);
  assert.equal(windowState.focusable, false);
  assert.equal(windowState.onTop, true);
  const background = await overlay.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.ok(background === 'rgba(0, 0, 0, 0)' || background === 'transparent', background);
  await panel.getByRole('textbox', { name: '친구에게 보낼 말' }).fill('맥 바탕화면 말풍선 테스트!');
  await panel.getByRole('button', { name: '메시지 보내기' }).click();
  await overlay.getByText('맥 바탕화면 말풍선 테스트!', { exact: true }).waitFor();
  await panel.screenshot({ path: path.join(results, 'mac-room.png') });
  await overlay.screenshot({ path: path.join(results, 'mac-overlay.png'), omitBackground: true });
  await panel.getByRole('button', { name: '창 접고 바탕화면에서 만나기' }).click();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=panel')).isVisible()), false);
  await overlay.evaluate(() => window.corner.openPanel());
  await panel.waitForFunction(() => document.visibilityState === 'visible');
  await panel.getByRole('button', { name: '나가기', exact: true }).click();
  await panel.locator('#nickname').waitFor();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=overlay')).isVisible()), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['native startup', 'bundled assets', 'live room creation', 'transparent non-focusable overlay', 'desktop speech bubble', 'hide/reopen panel', 'leave hides overlay'], windowState, screenshots: ['mac-onboarding.png', 'mac-room.png', 'mac-overlay.png'] }, null, 2));
} finally {
  await application.close();
  await fs.rm(userData, { recursive: true, force: true });
}
