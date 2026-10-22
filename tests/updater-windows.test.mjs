import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createWindowsUpdater } = require('../electron/updater-windows.cjs');

test('Windows updater checks a signed feed, verifies the installer bytes, and rejects a substituted platform', async (t) => {
  const profile = await mkdtemp(path.join(tmpdir(), 'chiikawa-win-update-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const installer = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2048, 0x43)]);
  let payload, corrupt = false;
  const server = createServer((req, res) => {
    if (req.url === '/update.exe') return res.end(corrupt ? Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2048, 0x44)]) : installer);
    const raw = Buffer.from(JSON.stringify(payload));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ payload: raw.toString('base64'), signature: sign(null, raw, privateKey).toString('base64') }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  payload = { schema: 1, appId: 'com.corner.chiikawa', platform: 'win32', arch: 'x64', version: '0.3.1', url: `${base}/update.exe`, size: installer.length, sha256: createHash('sha256').update(installer).digest('hex'), releaseNotes: '새 친구들' };
  const app = { isPackaged: true, getVersion: () => '0.3.0', getPath: () => profile, quit: () => { throw new Error('Unexpected quit'); } };
  const config = { winFeedUrl: `${base}/win-latest.json`, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
  const updater = createWindowsUpdater({ app, platform: 'win32', testMode: true, config });
  assert.equal((await updater.check()).phase, 'available');
  corrupt = true;
  assert.equal((await updater.download()).phase, 'error');
  corrupt = false;
  assert.equal((await updater.download()).phase, 'ready');
  const wrong = createWindowsUpdater({ app, platform: 'win32', testMode: true, config });
  payload = { ...payload, platform: 'darwin' };
  assert.equal((await wrong.check()).phase, 'error');
});
