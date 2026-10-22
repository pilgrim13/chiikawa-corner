import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import controller from '../electron/updater.cjs';

const { createUpdater } = controller;
const macOnly = { skip: process.platform !== 'darwin', timeout: 8000 };
const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
};

// Every test has an ephemeral signing key, loopback feed, and temporary userData.
// No real signing credentials, installed apps, or release archives are accessed.
async function fixture(t) {
  const userData = await mkdtemp(join(tmpdir(), 'corner-updater-controller-'));
  const keys = generateKeyPairSync('ed25519');
  const states = [];
  const hits = { feed: 0, archive: 0 };
  const archive = Buffer.from('test archive bytes; integrity tests must reject this before extraction');
  let quitCount = 0;
  let envelope;
  let feedResponder;
  let archiveResponder;
  const server = createServer((request, response) => {
    Promise.resolve().then(async () => {
      if (request.url === '/feed.json') {
        hits.feed += 1;
        if (feedResponder) return feedResponder(request, response);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(envelope));
      } else if (request.url === '/update.zip') {
        hits.archive += 1;
        if (archiveResponder) return archiveResponder(request, response);
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(archive);
      } else { response.writeHead(404); response.end(); }
    }).catch((error) => response.destroy(error));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(userData, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const updater = createUpdater({
    app: {
      isPackaged: true,
      getVersion: () => '0.2.0',
      getPath: (name) => { assert.equal(name, 'userData'); return userData; },
      quit: () => { quitCount += 1; throw new Error('An unverified update attempted to quit the running app'); },
    },
    config: { feedUrl: `${url}/feed.json`, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) },
    onState: (state) => states.push({ ...state }),
    testMode: true,
  });
  const publish = (changes = {}) => {
    const manifest = {
      schema: 1, appId: 'com.corner.chiikawa', platform: 'darwin', arch: 'universal',
      version: '0.3.0', url: `${url}/update.zip`, size: archive.length,
      sha256: createHash('sha256').update(archive).digest('hex'),
      releaseNotes: '산책이 더 부드러워졌어.\n친구들과 다시 만나자.', ...changes,
    };
    const payload = Buffer.from(JSON.stringify(manifest));
    envelope = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') };
    return manifest;
  };
  publish();
  return {
    updater, hits, states, archive, userData, publish,
    get quitCount() { return quitCount; },
    get envelope() { return envelope; },
    setEnvelope: (next) => { envelope = next; },
    setFeedResponder: (next) => { feedResponder = next; },
    setArchiveResponder: (next) => { archiveResponder = next; },
  };
}

async function assertNoInstall(f) {
  const before = f.updater.getState().phase;
  assert.equal((await f.updater.install()).phase, before);
  assert.equal(f.quitCount, 0, 'an unchecked or rejected update must never quit the running app');
  assert.equal(f.states.some((state) => ['ready', 'installing'].includes(state.phase)), false);
}

async function assertDownloadCleaned(f) {
  const files = await readdir(join(f.userData, 'updates'));
  assert.deepEqual(files, [], 'rejected downloads must not leave archives or staged bundles behind');
}

test('controller checks the signed HTTP feed and exposes an available release without downloading it', macOnly, async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.updater.getState(), { phase: 'idle', currentVersion: '0.2.0' });
  const state = await f.updater.check();
  assert.equal(state.phase, 'available');
  assert.equal(state.currentVersion, '0.2.0');
  assert.equal(state.latestVersion, '0.3.0');
  assert.match(state.releaseNotes, /산책/);
  assert.deepEqual(f.states.map((item) => item.phase), ['checking', 'available']);
  assert.deepEqual(f.hits, { feed: 1, archive: 0 });
  await assertNoInstall(f);
});

test('controller treats current and older signed versions as current and refuses their download', macOnly, async (t) => {
  for (const version of ['0.2.0', '0.1.9']) {
    await t.test(version, async (child) => {
      const f = await fixture(child);
      f.publish({ version });
      const state = await f.updater.check();
      assert.equal(state.phase, 'current');
      assert.equal(state.latestVersion, version);
      assert.equal((await f.updater.download()).phase, 'current');
      assert.deepEqual(f.hits, { feed: 1, archive: 0 });
      await assertNoInstall(f);
    });
  }
});

test('controller rejects a tampered feed, clears its download permission, and can retry a valid feed', macOnly, async (t) => {
  const f = await fixture(t);
  await f.updater.check();
  const signature = Buffer.from(f.envelope.signature, 'base64');
  signature[0] ^= 0xff;
  f.setEnvelope({ ...f.envelope, signature: signature.toString('base64') });
  const failed = await f.updater.check();
  assert.equal(failed.phase, 'error');
  assert.match(failed.message, /서명/);
  assert.equal((await f.updater.download()).phase, 'error');
  assert.equal(f.hits.archive, 0);
  await assertNoInstall(f);
  f.publish({ version: '0.3.1' });
  const retried = await f.updater.check();
  assert.equal(retried.phase, 'available');
  assert.equal(retried.latestVersion, '0.3.1');
  assert.equal(retried.message, undefined);
});

test('controller recovers from an HTTP error and a broken network response on explicit retry', macOnly, async (t) => {
  const f = await fixture(t);
  f.setFeedResponder((_request, response) => { response.writeHead(503); response.end('unavailable'); });
  const unavailable = await f.updater.check();
  assert.equal(unavailable.phase, 'error');
  assert.match(unavailable.message, /503/);
  f.setFeedResponder((_request, response) => response.destroy());
  const interrupted = await f.updater.check();
  assert.equal(interrupted.phase, 'error');
  assert.match(interrupted.message, /연결/);
  await assertNoInstall(f);
  f.setFeedResponder(undefined);
  const recovered = await f.updater.check();
  assert.equal(recovered.phase, 'available');
  assert.equal(recovered.message, undefined);
  assert.equal(f.hits.archive, 0);
});

test('controller rejects a downloaded SHA mismatch before extraction, cleans it up, and never quits', macOnly, async (t) => {
  const f = await fixture(t);
  f.publish({ sha256: '0'.repeat(64) });
  await f.updater.check();
  const state = await f.updater.download();
  assert.equal(state.phase, 'error');
  assert.match(state.message, /손상/);
  assert.equal(f.states.some((item) => item.phase === 'verifying'), false);
  assert.equal(f.hits.archive, 1);
  await assertDownloadCleaned(f);
  await assertNoInstall(f);
  // A fresh user retry makes a new request rather than treating the prior error as busy.
  assert.equal((await f.updater.download()).phase, 'error');
  assert.equal(f.hits.archive, 2);
  await assertDownloadCleaned(f);
});

test('controller rejects truncated and oversized downloads and leaves the running app intact', macOnly, async (t) => {
  for (const adjustment of [-1, 1]) {
    await t.test(adjustment < 0 ? 'oversized body' : 'truncated body', async (child) => {
      const f = await fixture(child);
      f.publish({ size: f.archive.length + adjustment });
      await f.updater.check();
      const state = await f.updater.download();
      assert.equal(state.phase, 'error');
      assert.match(state.message, adjustment < 0 ? /크기/ : /손상/);
      assert.equal(state.progress, undefined);
      assert.equal(f.states.some((item) => item.phase === 'verifying'), false);
      await assertDownloadCleaned(f);
      await assertNoInstall(f);
    });
  }
});

test('controller coalesces concurrent checks and rejects duplicate download/install work while busy', macOnly, async (t) => {
  const f = await fixture(t);
  f.publish({ sha256: '0'.repeat(64) });
  const feedSeen = deferred(), feedRelease = deferred();
  const archiveSeen = deferred(), archiveRelease = deferred();
  t.after(() => { feedRelease.resolve(); archiveRelease.resolve(); });
  f.setFeedResponder(async (_request, response) => {
    feedSeen.resolve(); await feedRelease.promise;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(f.envelope));
  });
  const firstCheck = f.updater.check();
  await feedSeen.promise;
  assert.equal((await f.updater.check()).phase, 'checking');
  assert.equal((await f.updater.download()).phase, 'checking');
  assert.equal((await f.updater.install()).phase, 'checking');
  assert.deepEqual(f.hits, { feed: 1, archive: 0 });
  feedRelease.resolve();
  assert.equal((await firstCheck).phase, 'available');
  f.setArchiveResponder(async (_request, response) => {
    archiveSeen.resolve(); await archiveRelease.promise;
    response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(f.archive);
  });
  const firstDownload = f.updater.download();
  await archiveSeen.promise;
  assert.equal((await f.updater.download()).phase, 'downloading');
  assert.equal((await f.updater.check()).phase, 'downloading');
  assert.equal((await f.updater.install()).phase, 'downloading');
  assert.deepEqual(f.hits, { feed: 1, archive: 1 });
  archiveRelease.resolve();
  assert.equal((await firstDownload).phase, 'error');
  await assertNoInstall(f);
  await assertDownloadCleaned(f);
});
