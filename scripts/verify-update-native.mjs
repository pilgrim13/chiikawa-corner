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
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

const run = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const bootstrap = path.resolve(process.env.BOOTSTRAP_APP || path.join(project, '.runtime/update-bootstrap/Chiikawa Corner.app'));
const nextVersion = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')).version;
const archive = path.resolve(process.env.UPDATE_ZIP || path.join(project, `release/Chiikawa-Corner-${nextVersion}-universal.zip`));
const fromVersion = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(bootstrap, 'Contents/Info.plist')])).stdout.trim();
const chatServer = 'http://127.0.0.1:47831';
const timeout = 120_000;
const results = path.join(project, 'test-results');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = async (file) => fs.access(file).then(() => true, () => false);
async function waitFor(action, label, ms = timeout) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result; } catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function unusedPort() {
  const server = net.createServer(); const port = await listen(server);
  await new Promise((resolve) => server.close(resolve)); return port;
}
async function browserPid(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const info = await session.send('SystemInfo.getProcessInfo');
    const pid = Number(info.processInfo.find((process) => process.type === 'browser')?.id);
    assert.ok(Number.isSafeInteger(pid) && pid > 1, 'CDP must identify its browser process');
    return pid;
  } finally { await session.detach().catch(() => {}); }
}

assert.equal(process.platform, 'darwin', 'This test requires macOS');
await fs.access(bootstrap);
const archiveInfo = await fs.stat(archive);
assert.ok(archiveInfo.size > 0 && archiveInfo.size <= 1024 ** 3);
await fs.mkdir(results, { recursive: true });
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'corner-native-update-')));
const installDirectory = path.join(temporary, 'install');
const target = path.join(installDirectory, 'Chiikawa Corner.app');
const executable = path.join(target, 'Contents/MacOS/Chiikawa Corner');
const userData = path.join(temporary, 'profile');
const resultFile = path.join(userData, 'updates/last-install.json');
const debugPort = await unusedPort();
const debugUrl = `http://127.0.0.1:${debugPort}`;
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const sha256 = hash.digest('hex');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
let signedEnvelope;
const feedServer = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET' && request.url === '/latest.json') {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(signedEnvelope));
  } else if (request.method === 'GET' && request.url === '/update.zip') {
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archiveInfo.size });
    const stream = createReadStream(archive); stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy()); stream.pipe(response);
  } else { response.writeHead(404); response.end(); }
});
let application, browser, panel, installAttempted = false, succeeded = false, diagnostics = '';
const ownedPids = new Set();
const pageErrors = [];
async function connectPanel(expectedPid) {
  let candidate;
  return waitFor(async () => {
    if (!candidate?.isConnected()) candidate = await chromium.connectOverCDP(debugUrl, { timeout: 2000 });
    const pid = await browserPid(candidate);
    if (expectedPid !== undefined) assert.equal(pid, expectedPid, 'Only the spawned test app may be controlled');
    const { stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
    assert.equal(await fs.realpath(stdout.trim()), await fs.realpath(executable), 'CDP process must run the isolated test bundle');
    ownedPids.add(pid);
    const page = candidate.contexts().flatMap((context) => context.pages()).find((item) => item.url().includes('view=panel'));
    if (!page) return false;
    await page.locator('.app-shell').waitFor({ timeout: 2000 });
    page.setDefaultTimeout(timeout);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    return { browser: candidate, panel: page, pid };
  }, 'connect packaged test panel', 35_000);
}
async function stopKnownApp() {
  try {
    const candidate = browser?.isConnected() ? browser : await chromium.connectOverCDP(debugUrl, { timeout: 1000 });
    const pid = await browserPid(candidate);
    const { stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
    if (await fs.realpath(stdout.trim()) === await fs.realpath(executable)) ownedPids.add(pid);
  } catch { /* App may already have terminated. */ }
  for (const pid of ownedPids) {
    // Never use a process-name kill. Each PID belongs to this test's spawned app
    // or was verified against its private temporary bundle through CDP + ps.
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  await sleep(400);
}
try {
  const feedPort = await listen(feedServer);
  const payload = Buffer.from(JSON.stringify({ schema: 1, appId: 'com.corner.chiikawa', platform: 'darwin', arch: 'universal', version: nextVersion, url: `http://127.0.0.1:${feedPort}/update.zip`, size: archiveInfo.size, sha256, releaseNotes: '실제 설치·재시작·설정 보존 검증' }), 'utf8');
  signedEnvelope = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
  const configFile = path.join(temporary, 'update-config.json');
  await fs.writeFile(configFile, JSON.stringify({ feedUrl: `http://127.0.0.1:${feedPort}/latest.json`, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }), { mode: 0o600 });
  await fs.mkdir(installDirectory, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await run('/usr/bin/ditto', [bootstrap, target], { timeout });
  // A pre-existing standalone relay survives the old app's exit. If there is
  // none, the app may start its own relay; this run then checks profile only.
  const persistentRelay = await fetch(`${chatServer}/health`, { signal: AbortSignal.timeout(1200) }).then((response) => response.ok, () => false);
  const env = { ...process.env, CORNER_TEST: '1', CORNER_USER_DATA: userData, CORNER_UPDATE_CONFIG: configFile, CORNER_SERVER_URL: chatServer, CORNER_TEST_DEBUG_PORT: String(debugPort) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CORNER_DEV_URL;
  delete env.CORNER_UPDATE_TOKEN;
  delete env.CORNER_HEADLESS;
  application = spawn(executable, [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  ownedPids.add(application.pid);
  application.on('error', (error) => { diagnostics += `${error.message}\n`; });
  for (const stream of [application.stdout, application.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-16000); });
  ({ browser, panel } = await connectPanel(application.pid));
  assert.equal((await panel.evaluate(() => window.corner.getConfig())).version, fromVersion);
  console.log(`Native update: bootstrap ${fromVersion} started`);
  const nickname = '업데이트검증';
  const proof = randomUUID();
  await panel.locator('#nickname').fill(nickname);
  await panel.locator('.character-option').nth(1).click();
  await panel.evaluate((value) => localStorage.setItem('corner.update-native-proof', value), proof);
  await panel.waitForFunction((name) => JSON.parse(localStorage.getItem('corner.profile') || '{}').nickname === name, nickname);
  let roomBefore;
  const chatText = '업데이트 뒤에도 이 대화가 남아 있어야 해';
  if (persistentRelay) {
    await panel.locator('.status-pill.online').waitFor();
    await panel.getByRole('button', { name: '우리 방 만들기', exact: true }).click();
    await panel.locator('.room-code').waitFor();
    await panel.getByRole('textbox', { name: '친구에게 보낼 말' }).fill(chatText);
    await panel.getByRole('button', { name: '메시지 보내기' }).click();
    await panel.locator('.message-list').getByText(chatText, { exact: true }).waitFor();
    roomBefore = await panel.evaluate((server) => JSON.parse(localStorage.getItem(`corner.session:${server}`)), chatServer);
    assert.ok(roomBefore?.roomId && roomBefore?.memberId, 'Room credentials should be stored before restart');
  }
  await panel.getByRole('button', { name: '업데이트', exact: true }).click();
  await panel.getByRole('button', { name: '업데이트 확인', exact: true }).click();
  await panel.getByRole('heading', { name: '새 버전이 도착했어', exact: true }).waitFor();
  assert.equal((await panel.evaluate(() => window.corner.getUpdateState())).latestVersion, nextVersion);
  await panel.getByRole('button', { name: '업데이트 다운로드', exact: true }).click();
  await waitFor(async () => {
    const state = await panel.evaluate(() => window.corner.getUpdateState());
    if (state.phase === 'error') throw new Error(state.message || 'Download failed');
    return state.phase === 'ready';
  }, 'download and verify update', timeout);
  await panel.getByRole('heading', { name: '업데이트 준비가 끝났어', exact: true }).waitFor();
  await panel.screenshot({ path: path.join(results, 'update-native-before.png') });
  console.log('Native update: signed ZIP downloaded and verified; installing');
  installAttempted = true;
  await panel.getByRole('button', { name: '재시작하고 적용', exact: true }).click();
  const report = await waitFor(async () => {
    if (!await exists(resultFile)) return false;
    const value = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    if (!value.ok) throw new Error(value.message || 'Helper rolled back');
    return value;
  }, 'installed version acknowledgement', timeout);
  assert.equal(report.version, nextVersion);
  ({ browser, panel } = await connectPanel());
  const installedPid = await browserPid(browser);
  assert.notEqual(installedPid, application.pid, 'Restart must launch a new app process');
  assert.equal((await panel.evaluate(() => window.corner.getConfig())).version, nextVersion);
  const preserved = await panel.evaluate(() => ({ proof: localStorage.getItem('corner.update-native-proof'), profile: JSON.parse(localStorage.getItem('corner.profile') || '{}') }));
  assert.equal(preserved.proof, proof);
  assert.equal(preserved.profile.nickname, nickname);
  assert.equal(preserved.profile.character, 'hachiware');
  if (roomBefore) {
    await panel.locator('.room-code').waitFor();
    await panel.locator('.message-list').getByText(chatText, { exact: true }).waitFor();
    const after = await panel.evaluate((server) => JSON.parse(localStorage.getItem(`corner.session:${server}`)), chatServer);
    assert.ok(after.roomId === roomBefore.roomId && after.memberId === roomBefore.memberId && after.token === roomBefore.token, 'The same private room session must resume');
  }
  await panel.getByRole('button', { name: '업데이트', exact: true }).click();
  await panel.getByRole('button', { name: '업데이트 확인', exact: true }).click();
  await panel.getByRole('heading', { name: '지금 최신 버전이야', exact: true }).waitFor();
  await panel.screenshot({ path: path.join(results, 'update-native-after.png') });
  assert.deepEqual(pageErrors, []);
  if (roomBefore) {
    await panel.getByRole('button', { name: '업데이트 창 닫기' }).click();
    await panel.getByRole('button', { name: '나가기', exact: true }).click();
  }
  succeeded = true;
  console.log(JSON.stringify({ ok: true, from: fromVersion, to: nextVersion, checks: ['packaged bootstrap startup', 'signed full ZIP download', 'native bundle swap', 'new process + UI-ready acknowledgement', 'nickname/character/localStorage preserved', ...(roomBefore ? ['live room + messages resumed'] : [])], roomResume: roomBefore ? 'passed' : 'not run: no persistent relay before app launch', screenshots: ['update-native-before.png', 'update-native-after.png'] }, null, 2));
} catch (error) {
  console.error(`Native update test failed: ${error.message}`);
  if (diagnostics) console.error(diagnostics.slice(-6000));
  throw error;
} finally {
  await stopKnownApp();
  // If the helper was still awaiting a failed replacement, let it roll back
  // before removing this test's private install directory.
  if (installAttempted && !await exists(resultFile)) {
    await waitFor(() => exists(resultFile), 'helper cleanup result', 5000).catch(() => {});
    await stopKnownApp();
  }
  feedServer.closeAllConnections();
  await new Promise((resolve) => feedServer.close(resolve));
  const pending = await fs.readdir(installDirectory).catch(() => []);
  if (succeeded || !pending.some((name) => name.startsWith('.chiikawa-update-')) || await exists(resultFile)) {
    await fs.rm(temporary, { recursive: true, force: true });
  } else {
    console.error(`Isolated failed-update fixture retained for recovery: ${temporary}`);
  }
}
