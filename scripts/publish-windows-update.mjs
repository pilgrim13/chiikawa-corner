#!/usr/bin/env node
// The signing key remains in this Mac's login Keychain. Run from its unlocked GUI session.
import { execFile } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--exe', '--version', '--url', '--notes'].includes(args[i]) || !args[i + 1]) throw new Error('사용법: --exe <Windows-setup.exe> --version X.Y.Z --url <HTTPS URL> --notes <설명>');
    options[args[i].slice(2)] = args[i + 1];
  }
  for (const key of ['exe', 'version', 'url', 'notes']) if (!options[key]) throw new Error(`--${key} 값이 필요해요.`);
  return options;
}
export async function publishWindowsUpdate({ exe, version, url, notes }) {
  if (process.platform !== 'darwin') throw new Error('서명키가 있는 Mac에서 실행해 주세요.');
  const { compareVersions, verifyManifest } = await import('../electron/updater-core.cjs');
  const appVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  if (version !== appVersion || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('앱과 동일한 정식 버전 번호가 필요해요.');
  const target = path.resolve(exe);
  if (!(await lstat(target)).isFile()) throw new Error('설치파일은 일반 파일이어야 해요.');
  const file = await readFile(target);
  if (file.length < 1024 || file.length > 1024 ** 3 || file.toString('ascii', 0, 2) !== 'MZ') throw new Error('Windows 설치파일이 아니거나 크기가 올바르지 않아요.');
  const address = new URL(url);
  if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(path.basename(address.pathname))) throw new Error('안전한 GitHub 설치파일 HTTPS 주소가 필요해요.');
  if (address.pathname.includes('/releases/latest/download/') || !path.basename(address.pathname).includes(version)) throw new Error('서명 목록에는 버전 번호가 들어간 고정 설치파일 URL이 필요해요.');
  if (typeof notes !== 'string' || notes.length > 6000) throw new Error('업데이트 설명은 6000자 이하여야 해요.');
  const payload = { schema: 1, appId: 'com.corner.chiikawa', version, platform: 'win32', arch: 'x64', url: address.href, size: file.length, sha256: createHash('sha256').update(file).digest('hex'), releaseNotes: notes };
  const raw = Buffer.from(JSON.stringify(payload));
  const payloadFile = path.join(tmpdir(), `chiikawa-win-payload-${process.pid}.json`);
  const signer = path.join(root, 'scripts/release-sign.swift');
  await writeFile(payloadFile, raw, { mode: 0o600 });
  let signature;
  try { signature = (await run('/usr/bin/swift', ['-suppress-warnings', '-module-cache-path', path.join(tmpdir(), 'chiikawa-swift-module-cache'), signer, 'sign', payloadFile], { timeout: 120000 })).stdout.trim(); }
  finally { await import('node:fs/promises').then(({ rm }) => rm(payloadFile, { force: true })); }
  const config = JSON.parse(await readFile(path.join(root, 'electron/update-config.json'), 'utf8'));
  if (!config.publicKey || !verify(null, raw, createPublicKey(config.publicKey), Buffer.from(signature, 'base64'))) throw new Error('앱에 고정한 공개키로 Windows 업데이트 서명을 확인할 수 없어요.');
  const output = path.join(root, 'release-feed');
  await mkdir(output, { recursive: true });
  const latest = path.join(output, 'win-latest.json');
  try {
    const current = verifyManifest(JSON.parse(await readFile(latest, 'utf8')), config.publicKey, { platform: 'win32', arch: 'x64' });
    const order = compareVersions(version, current.version);
    if (order < 0 || (order === 0 && current.sha256 !== payload.sha256)) throw new Error('이전 Windows 릴리스나 같은 버전의 다른 파일로 덮어쓰지 않아요.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const published = path.join(output, path.basename(address.pathname));
  try {
    if ((await stat(published)).size !== file.length || createHash('sha256').update(await readFile(published)).digest('hex') !== payload.sha256) throw new Error('배포 폴더에 다른 내용의 같은 파일이 있어요.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; await copyFile(target, published); }
  const staged = path.join(output, `.win-latest-${process.pid}.json`);
  await writeFile(staged, JSON.stringify({ payload: raw.toString('base64'), signature }, null, 2) + '\n', { mode: 0o600 });
  await rename(staged, latest);
  // Keep the README's stable one-click download separate from the immutable,
  // versioned URL in the signed manifest.
  const alias = path.join(output, 'Chiikawa-Corner-windows.exe');
  const stagedAlias = path.join(output, `.windows-alias-${process.pid}.exe`);
  try { await copyFile(published, stagedAlias); await rename(stagedAlias, alias); }
  finally { await rm(stagedAlias, { force: true }); }
  return { version, latest, exe: published, alias, sha256: payload.sha256, size: payload.size };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await publishWindowsUpdate(parse(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`Windows 업데이트 준비 실패: ${error.message}`); process.exitCode = 1; }
}
