import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import updater from '../electron/updater-core.cjs';

const { verifyManifest, compareVersions, inspectArchiveEntries, inspectSymlink } = updater;
const signingKeys = generateKeyPairSync('ed25519');
const publicKey = signingKeys.publicKey.export({ type: 'spki', format: 'pem' });
const currentVersion = '0.1.0';
const manifest = (overrides = {}) => ({
  schema: 1,
  appId: 'com.corner.chiikawa',
  platform: 'darwin',
  arch: 'universal',
  version: '0.2.0',
  url: 'https://updates.example.com/Chiikawa-Corner-0.2.0-universal.zip',
  size: 154_328,
  sha256: 'e1'.repeat(32),
  releaseNotes: '캐릭터가 더 편하게 걸어 다녀. 🐰',
  ...overrides,
});
function signBytes(bytes, privateKey = signingKeys.privateKey) {
  return { payload: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') };
}
function envelope(payload, privateKey = signingKeys.privateKey) {
  return signBytes(Buffer.from(JSON.stringify(payload), 'utf8'), privateKey);
}
function verify(payload, options = {}) {
  return verifyManifest(envelope(payload), publicKey, { currentVersion, ...options });
}

// These tests use an ephemeral keypair. No real release signing key or network
// endpoint is read, and no installed application or user data is modified.
test('updater accepts a valid signed manifest and preserves its authenticated metadata', () => {
  const expected = manifest();
  const result = verify(expected);
  for (const key of Object.keys(expected)) assert.deepEqual(result[key], expected[key], key);
  assert.doesNotThrow(() => verify(manifest({ releaseNotes: undefined })));
  assert.doesNotThrow(() => verify(manifest({ size: 1 })));
});

test('updater rejects payload tampering, signature tampering, and a different release signer', () => {
  const original = envelope(manifest());
  const tamperedPayload = Buffer.from(JSON.stringify(manifest({ url: 'https://attacker.example/replacement.zip' })), 'utf8').toString('base64');
  assert.throws(() => verifyManifest({ ...original, payload: tamperedPayload }, publicKey, { currentVersion }));
  const alteredSignature = Buffer.from(original.signature, 'base64');
  alteredSignature[0] ^= 0xff;
  assert.throws(() => verifyManifest({ ...original, signature: alteredSignature.toString('base64') }, publicKey, { currentVersion }));
  const unrelatedKey = generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => verifyManifest(envelope(manifest(), unrelatedKey), publicKey, { currentVersion }));
});

test('updater rejects malformed envelopes and signed data that is not a manifest object', () => {
  for (const invalid of [null, [], {}, { payload: 123, signature: 'x' }, { payload: '', signature: '' }]) {
    assert.throws(() => verifyManifest(invalid, publicKey, { currentVersion }));
  }
  for (const payload of [null, [], 'hello', 1]) assert.throws(() => verify(payload));
  for (const bytes of [Buffer.from('{not json'), Buffer.from([0xff, 0xfe])]) {
    assert.throws(() => verifyManifest(signBytes(bytes), publicKey, { currentVersion }));
  }
});

test('updater rejects incompatible or invalid metadata even when correctly signed', () => {
  const invalidChanges = [
    { schema: 2 }, { schema: '1' },
    { appId: 'com.somewhere.else' },
    { platform: 'win32' }, { arch: 'arm64' },
    { version: '0.2' }, { version: 'v0.2.0' }, { version: '0.2.0-beta.1' },
    { version: '' }, { version: 2 },
    { size: 0 }, { size: -1 }, { size: 1.5 }, { size: '154328' },
    { size: 1_200_000_000 },
    { sha256: 'a'.repeat(63) }, { sha256: 'z'.repeat(64) }, { sha256: null },
    { url: '/downloads/update.zip' }, { url: 'not a URL' },
    { url: 'file:///tmp/update.zip' }, { url: 'ftp://updates.example/update.zip' },
    { releaseNotes: { html: '<script>unexpected</script>' } },
  ];
  for (const change of invalidChanges) assert.throws(() => verify(manifest(change)), JSON.stringify(change));
});

test('updater HTTPS policy permits HTTP only for an explicitly enabled loopback test feed', () => {
  for (const url of [
    'http://127.0.0.1:47831/update.zip',
    'http://localhost:47831/update.zip',
    'http://[::1]:47831/update.zip',
  ]) {
    assert.throws(() => verify(manifest({ url })), url);
    assert.equal(verify(manifest({ url }), { allowHttp: true }).url, url);
  }
  for (const url of [
    'http://updates.example.com/update.zip',
    'http://127.0.0.1.attacker.example/update.zip',
    'http://localhost.attacker.example/update.zip',
    'http://192.168.1.5/update.zip',
  ]) assert.throws(() => verify(manifest({ url }), { allowHttp: true }), url);
});

test('updater version comparison is numerical and identical/older signed manifests remain readable', () => {
  for (const [left, right, expected] of [
    ['0.1.0', '0.1.0', 0],
    ['0.1.1', '0.1.0', 1],
    ['0.1.0', '0.1.1', -1],
    ['1.10.0', '1.9.99', 1],
    ['2.0.0', '1.99.99', 1],
    ['10.0.0', '2.0.0', 1],
    ['1.0.9', '1.0.10', -1],
  ]) assert.equal(Math.sign(compareVersions(left, right)), expected, `${left} vs ${right}`);
  assert.equal(verify(manifest({ version: currentVersion })).version, currentVersion);
  assert.equal(verify(manifest({ version: '0.0.9' })).version, '0.0.9');
});

test('updater accepts normal app bundle paths including Electron framework paths and spaces', () => {
  const entries = [
    'Chiikawa Corner.app/',
    'Chiikawa Corner.app/Contents/',
    'Chiikawa Corner.app/Contents/Info.plist',
    'Chiikawa Corner.app/Contents/MacOS/Chiikawa Corner',
    'Chiikawa Corner.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
    'Chiikawa Corner.app/Contents/Frameworks/Electron Framework.framework/Versions/Current',
    'Chiikawa Corner.app/Contents/Frameworks/Chiikawa Corner Helper (Renderer).app/Contents/MacOS/Chiikawa Corner Helper (Renderer)',
    'Chiikawa Corner.app/Contents/Resources/app.asar',
    'Chiikawa Corner.app/Contents/Resources/characters/치이카와.png',
  ];
  assert.doesNotThrow(() => inspectArchiveEntries(entries));
});

test('updater rejects absolute, traversing, Windows-style, and unexpected archive paths', () => {
  const valid = 'Chiikawa Corner.app/Contents/Info.plist';
  const invalidPaths = [
    '/Chiikawa Corner.app/Contents/Info.plist',
    '../Chiikawa Corner.app/Contents/Info.plist',
    './Chiikawa Corner.app/Contents/Info.plist',
    'Chiikawa Corner.app/../outside',
    'Chiikawa Corner.app/Contents/../Info.plist',
    'Chiikawa Corner.app/Contents/../../outside',
    'Chiikawa Corner.app\\Contents\\Info.plist',
    'C:/Chiikawa Corner.app/Contents/Info.plist',
    'Another.app/Contents/Info.plist',
    'Chiikawa Corner.app.old/Contents/Info.plist',
    '__MACOSX/._Chiikawa Corner.app',
    'Chiikawa Corner.app/Contents/bad\u0000name',
    '',
  ];
  for (const path of invalidPaths) assert.throws(() => inspectArchiveEntries([valid, path]), JSON.stringify(path));
  for (const entries of [[], null, {}, 'Chiikawa Corner.app/', [valid, null]]) {
    assert.throws(() => inspectArchiveEntries(entries));
  }
});

test('updater permits Electron framework links while rejecting links outside the app', () => {
  const framework = 'Chiikawa Corner.app/Contents/Frameworks/Electron Framework.framework';
  assert.doesNotThrow(() => inspectSymlink(`${framework}/Versions/Current`, 'A'));
  assert.doesNotThrow(() => inspectSymlink(`${framework}/Electron Framework`, 'Versions/Current/Electron Framework'));
  for (const target of ['/tmp/elsewhere', '../../../../../../outside', '..\\..\\outside', '', 'A\u0000B']) {
    assert.throws(() => inspectSymlink(`${framework}/Versions/Current`, target), JSON.stringify(target));
  }
});
