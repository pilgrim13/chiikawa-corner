import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, parseArgs, validateReleaseUrl, validateVersion } from './publish-update.mjs';

test('only an explicit complete release can be prepared', () => {
  assert.throws(() => parseArgs([]), /--app/);
  assert.throws(() => parseArgs(['--signer', '/tmp/other-signer']), /알 수 없/);
  const options = parseArgs(['--app', 'release/Chiikawa Corner.app', '--zip', 'release/release.zip', '--version', '0.1.1', '--url', 'https://example.com/releases/0.1.1.zip', '--notes', '한글 업데이트']);
  assert.equal(options.version, '0.1.1');
  assert.equal(options.notes, '한글 업데이트');
});

test('version rejects ambiguous, prerelease, and overflowing values', () => {
  for (const invalid of ['01.2.3', '1.2', '1.2.3-beta', '../1.2.3', '9007199254740992.0.0', '', null]) assert.throws(() => validateVersion(invalid));
  assert.equal(validateVersion('1.20.300'), '1.20.300');
});

test('release downloads require HTTPS with no embedded credential or unsafe filename', () => {
  for (const invalid of ['http://example.com/release.zip', 'https://user:password@example.com/release.zip', 'file:///tmp/release.zip', 'https://example.com/%2E%2E%2Foutside.zip', 'https://example.com/release.zip?token=secret', 'https://example.com/release.zip#fragment', 'https://example.com/app.dmg']) assert.throws(() => validateReleaseUrl(invalid));
  assert.equal(validateReleaseUrl('https://example.com/updates/Chiikawa-0.1.1.zip').filename, 'Chiikawa-0.1.1.zip');
  assert.equal(validateReleaseUrl('http://127.0.0.1:47831/release.zip').filename, 'release.zip');
});

test('payload binds version, platform, architecture, exact ZIP bytes, and notes', () => {
  const payload = buildPayload({ version: '0.1.1', url: 'https://example.com/update.zip', size: 123, sha256: 'a'.repeat(64), releaseNotes: '말풍선 개선\n친구들과 만나기' });
  assert.deepEqual(payload, { schema: 1, appId: 'com.corner.chiikawa', version: '0.1.1', platform: 'darwin', arch: 'universal', url: 'https://example.com/update.zip', size: 123, sha256: 'a'.repeat(64), releaseNotes: '말풍선 개선\n친구들과 만나기' });
  assert.deepEqual(JSON.parse(Buffer.from(Buffer.from(JSON.stringify(payload)).toString('base64'), 'base64')), payload);
});

test('payload rejects missing integrity fields and unreasonable downloads', () => {
  const good = { version: '0.1.1', url: 'https://example.com/update.zip', size: 123, sha256: 'a'.repeat(64) };
  for (const size of [0, -1, 1.5, Infinity, 1024 ** 3 + 1]) assert.throws(() => buildPayload({ ...good, size }));
  for (const sha256 of ['', 'a'.repeat(63), 'Z'.repeat(64), null]) assert.throws(() => buildPayload({ ...good, sha256 }));
  assert.throws(() => buildPayload({ ...good, releaseNotes: '가'.repeat(6001) }));
});
