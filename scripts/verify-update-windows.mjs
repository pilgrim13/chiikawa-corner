import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createRoomServer } from '../server/index.mjs';

assert.equal(process.platform, 'win32', 'Run this updater E2E on a real Windows runner');
assert.ok(process.env.CORNER_EXECUTABLE, 'CORNER_EXECUTABLE must point to the NSIS-installed bootstrap');
assert.ok(process.env.CORNER_UPDATE_INSTALLER, 'CORNER_UPDATE_INSTALLER must point to the final NSIS EXE');
const executable = path.resolve(process.env.CORNER_EXECUTABLE);
const installer = path.resolve(process.env.CORNER_UPDATE_INSTALLER);
const nextVersion = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const bootstrapVersion = process.env.CORNER_BOOTSTRAP_VERSION || '0.2.9';
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = path.resolve('test-results');
await fs.mkdir(results, { recursive: true });
await fs.access(executable);
const installerInfo = await fs.stat(installer);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'corner-windows-update-'));
const userData = path.join(temporary, 'profile');
const resultFile = path.join(userData, 'updates/last-install.json');
const configFile = path.join(temporary, 'update-config.json');
const relay = createRoomServer();
const keys = generateKeyPairSync('ed25519');
const hash = createHash('sha256');
for await (const chunk of createReadStream(installer)) hash.update(chunk);
const sha256 = hash.digest('hex');
let envelope;
const feed = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/win-latest.json') {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(envelope));
  } else if (request.url === '/update.exe') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': installerInfo.size });
    const stream = createReadStream(installer);
    stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
  } else { response.writeHead(404); response.end(); }
});
let application, browser, panel, debugUrl, diagnostics = '', installStarted = false;
const ownedPids = new Set();
const errors = [];
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function waitFor(action, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await action();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`${label} timed out`);
}
async function processPath(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).Path`], { timeout: 10000 });
  return path.normalize(stdout.trim()).toLowerCase();
}
async function browserPid(candidate) {
  const session = await candidate.newBrowserCDPSession();
  try {
    const info = await session.send('SystemInfo.getProcessInfo');
    const pid = Number(info.processInfo.find((item) => item.type === 'browser')?.id);
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    assert.equal(await processPath(pid), path.normalize(executable).toLowerCase(), 'Only this test installation may be controlled');
    ownedPids.add(pid);
    return pid;
  } finally { await session.detach().catch(() => {}); }
}
async function connectPanel(expectedPid) {
  let candidate;
  return waitFor(async () => {
    try {
      if (!candidate?.isConnected()) candidate = await chromium.connectOverCDP(debugUrl, { timeout: 1500 });
      const pid = await browserPid(candidate);
      if (expectedPid !== undefined) assert.equal(pid, expectedPid);
      const page = candidate.contexts().flatMap((context) => context.pages()).find((item) => item.url().includes('view=panel'));
      if (!page) return false;
      await page.locator('.app-shell').waitFor({ timeout: 1500 });
      page.setDefaultTimeout(30000);
      page.on('pageerror', (error) => errors.push(error.message));
      return { browser: candidate, panel: page, pid };
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
      return false;
    }
  }, 'connect to installed Windows application', 45000);
}
async function stopTestApp() {
  try {
    const candidate = browser?.isConnected() ? browser : await chromium.connectOverCDP(debugUrl, { timeout: 1500 });
    await browserPid(candidate);
  } catch {}
  for (const pid of ownedPids) {
    // Recheck path before termination: never kill another app or a reused PID.
    try { if (await processPath(pid) === path.normalize(executable).toLowerCase()) process.kill(pid, 'SIGTERM'); } catch {}
  }
  await sleep(700);
}
try {
  await relay.listen(0, '127.0.0.1');
  const serverUrl = `http://127.0.0.1:${relay.httpServer.address().port}`;
  const feedPort = await listen(feed);
  const probe = net.createServer(); const debugPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  debugUrl = `http://127.0.0.1:${debugPort}`;
  const payload = Buffer.from(JSON.stringify({ schema: 1, appId: 'com.corner.chiikawa', platform: 'win32', arch: 'x64', version: nextVersion, url: `http://127.0.0.1:${feedPort}/update.exe`, size: installerInfo.size, sha256, releaseNotes: 'Windows 실제 설치·재시작·프로필 보존 검증' }));
  envelope = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') };
  await fs.writeFile(configFile, JSON.stringify({ winFeedUrl: `http://127.0.0.1:${feedPort}/win-latest.json`, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }));
  const env = { ...process.env, CORNER_TEST: '1', CORNER_USER_DATA: userData, CORNER_SERVER_URL: serverUrl, CORNER_UPDATE_CONFIG: configFile, CORNER_TEST_DEBUG_PORT: String(debugPort) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.CORNER_DEV_URL; delete env.CORNER_HEADLESS; delete env.CORNER_UPDATE_TOKEN;
  application = spawn(executable, [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  ownedPids.add(application.pid);
  application.on('error', (error) => { diagnostics += `${error.message}\n`; });
  for (const stream of [application.stdout, application.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
  ({ browser, panel } = await connectPanel(application.pid));
  assert.equal((await panel.evaluate(() => window.corner.getConfig())).version, bootstrapVersion);
  console.log(`Windows update: installed bootstrap ${bootstrapVersion} started`);
  const proof = randomUUID();
  await panel.locator('.status-pill.online').waitFor();
  await panel.locator('#nickname').fill('윈도우업데이트');
  await panel.locator('.character-option[data-character="hachiware"]').click();
  await panel.evaluate((value) => localStorage.setItem('corner.windows-update-proof', value), proof);
  await panel.getByRole('button', { name: '우리 방 만들기', exact: true }).click();
  await panel.locator('.room-code').waitFor();
  const message = '업데이트 뒤에도 같은 방에서 만나!';
  await panel.getByRole('textbox', { name: '친구에게 보낼 말' }).fill(message);
  await panel.getByRole('button', { name: '메시지 보내기' }).click();
  await panel.locator('.message-list').getByText(message, { exact: true }).waitFor();
  const sessionBefore = await panel.evaluate((url) => JSON.parse(localStorage.getItem(`corner.session:${url}`)), serverUrl);
  assert.ok(sessionBefore?.token && sessionBefore?.memberId);
  await panel.getByRole('button', { name: '업데이트', exact: true }).click();
  await panel.getByRole('button', { name: '업데이트 확인', exact: true }).click();
  await panel.getByRole('heading', { name: '새 버전이 도착했어', exact: true }).waitFor();
  await panel.getByRole('button', { name: '업데이트 다운로드', exact: true }).click();
  await waitFor(async () => {
    const state = await panel.evaluate(() => window.corner.getUpdateState());
    if (state.phase === 'error') throw new Error(state.message);
    return state.phase === 'ready';
  }, 'signed installer download');
  await panel.getByRole('heading', { name: '업데이트 준비가 끝났어', exact: true }).waitFor();
  await panel.screenshot({ path: path.join(results, 'windows-update-before.png') });
  console.log('Windows update: verified installer downloaded; applying');
  installStarted = true;
  await panel.getByRole('button', { name: '재시작하고 적용', exact: true }).click();
  const report = await waitFor(async () => {
    let value;
    try { value = JSON.parse(await fs.readFile(resultFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    if (!value.ok) throw new Error(value.message || 'Windows installer failed');
    return value;
  }, 'Windows install and UI-ready acknowledgement', 180000);
  assert.equal(report.version, nextVersion);
  ({ browser, panel } = await connectPanel());
  assert.notEqual(await browserPid(browser), application.pid);
  const installedConfig = await panel.evaluate(() => window.corner.getConfig());
  assert.equal(installedConfig.version, nextVersion);
  assert.equal(installedConfig.platform, 'win32');
  await panel.locator('.room-code').waitFor();
  await panel.locator('.message-list').getByText(message, { exact: true }).waitFor();
  const preserved = await panel.evaluate((url) => ({ proof: localStorage.getItem('corner.windows-update-proof'), profile: JSON.parse(localStorage.getItem('corner.profile')), session: JSON.parse(localStorage.getItem(`corner.session:${url}`)) }), serverUrl);
  assert.equal(preserved.proof, proof);
  assert.equal(preserved.profile.nickname, '윈도우업데이트');
  assert.equal(preserved.profile.character, 'hachiware');
  assert.ok(preserved.session.roomId === sessionBefore.roomId && preserved.session.memberId === sessionBefore.memberId && preserved.session.token === sessionBefore.token, 'The private room session must survive installation');
  await panel.getByRole('button', { name: '업데이트', exact: true }).click();
  await panel.getByRole('button', { name: '업데이트 확인', exact: true }).click();
  await panel.getByRole('heading', { name: '지금 최신 버전이야', exact: true }).waitFor();
  await panel.screenshot({ path: path.join(results, 'windows-update-after.png') });
  await panel.getByRole('button', { name: '업데이트 창 닫기' }).click();
  await panel.getByRole('button', { name: '나가기', exact: true }).click();
  assert.deepEqual(errors, []);
  const summary = { ok: true, from: bootstrapVersion, to: nextVersion, checks: ['NSIS-installed bootstrap', 'Ed25519 manifest and EXE SHA256', 'in-app download and install buttons', 'silent NSIS replacement', 'new process and UI acknowledgement', 'nickname/character/localStorage preserved', 'same room and chat restored', 'final version current check'] };
  await fs.writeFile(path.join(results, 'windows-update-e2e.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(`Windows updater E2E failed: ${error.message}`);
  if (diagnostics) console.error(diagnostics.slice(-6000));
  if (panel && !panel.isClosed()) await panel.screenshot({ path: path.join(results, 'windows-update-failure.png') }).catch(() => {});
  throw error;
} finally {
  await stopTestApp();
  feed.closeAllConnections(); await new Promise((resolve) => feed.close(resolve));
  await relay.close();
  // A failed in-flight helper may still need its fixture. The disposable CI
  // runner cleans that up; do not delete files beneath an active installer.
  const completed = await fs.access(resultFile).then(() => true, () => false);
  if (!installStarted || completed) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
  else console.error(`Isolated unfinished updater fixture: ${temporary}`);
}
