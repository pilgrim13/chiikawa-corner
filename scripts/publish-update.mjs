#!/usr/bin/env node
// Prepare a signed update feed locally. This tool never uploads or exports a private key.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = 'com.corner.chiikawa';
const MAX_ZIP_SIZE = 1024 * 1024 * 1024;
const usage = `사용법:
  node scripts/publish-update.mjs --app "release/mac-universal/Chiikawa Corner.app" \\
    --zip "release/Chiikawa-Corner-0.1.1-universal.zip" --version 0.1.1 \\
    --url "https://your-server/updates/Chiikawa-Corner-0.1.1-universal.zip" \\
    --notes "업데이트 내용" [--out release-feed]

ZIP이 없으면 검증한 앱으로 새로 만들고, 있으면 내부 앱까지 검증해.
결과는 --out의 latest.json과 ZIP이야. 네트워크 업로드는 하지 않아.
서명키는 현재 Mac의 Keychain에서만 사용해.`;

export function parseArgs(args) {
  const options = { out: path.join(projectRoot, 'release-feed'), notes: '' };
  const allowed = new Set(['app', 'zip', 'version', 'url', 'notes', 'notes-file', 'out']);
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (name === '--help' || name === '-h') return { help: true };
    if (!name.startsWith('--') || !allowed.has(name.slice(2)) || i + 1 >= args.length || args[i + 1].startsWith('--')) {
      throw new Error(`알 수 없거나 값이 없는 옵션: ${name}\n${usage}`);
    }
    const key = name.slice(2);
    if (Object.hasOwn(options, key) && !['out', 'notes'].includes(key)) throw new Error(`옵션이 중복됐어: ${name}`);
    options[key] = args[++i];
  }
  for (const key of ['app', 'zip', 'version', 'url']) if (!options[key]) throw new Error(`--${key} 값이 필요해.\n${usage}`);
  if (options['notes-file'] && options.notes) throw new Error('--notes와 --notes-file 중 하나만 사용해줘.');
  validateVersion(options.version);
  validateReleaseUrl(options.url);
  return options;
}

export function validateVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.split('.').some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error('버전은 0.1.1처럼 정수 3개의 정식 버전으로 지정해줘.');
  }
  return version;
}

export function validateReleaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('다운로드 URL이 올바르지 않아.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('다운로드 URL은 HTTPS여야 해. HTTP는 로컬 시험 주소만 허용해.');
  if (url.username || url.password || url.hash || url.search) throw new Error('다운로드 URL에는 인증정보·쿼리·fragment를 넣지 말아줘.');
  let filename;
  try { filename = decodeURIComponent(url.pathname.split('/').at(-1)); } catch { throw new Error('URL 파일 이름이 올바르지 않아.'); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(filename)) throw new Error('URL 마지막에는 영문·숫자·점·밑줄·하이픈으로 된 .zip 파일 이름이 필요해.');
  return { url: url.href, filename };
}

export function buildPayload({ version, url, size, sha256, releaseNotes = '' }) {
  validateVersion(version);
  const download = validateReleaseUrl(url);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ZIP_SIZE) throw new Error('ZIP 크기는 0보다 크고 1 GiB 이하여야 해.');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('SHA-256 값이 올바르지 않아.');
  if (typeof releaseNotes !== 'string' || releaseNotes.length > 6000) throw new Error('업데이트 설명은 6,000자 이하여야 해.');
  return { schema: 1, appId: APP_ID, version, platform: 'darwin', arch: 'universal', url: download.url, size, sha256, releaseNotes };
}

async function run(command, args, options = {}) {
  try { return await runFile(command, args, { maxBuffer: 8 * 1024 * 1024, timeout: 180_000, ...options }); }
  catch (error) {
    const detail = typeof error.stderr === 'string' ? error.stderr.trim().slice(-2500) : '';
    throw new Error(`${path.basename(command)} 실행 실패${detail ? `: ${detail}` : ''}`, { cause: error });
  }
}

async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function hashFile(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function plistValue(plist, key) { return (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim(); }
function within(base, value) { return value === base || value.startsWith(`${base}${path.sep}`); }

async function verifyBundle(app, version) {
  app = await realpath(app);
  if (!app.endsWith('.app') || !(await stat(app)).isDirectory()) throw new Error('검증할 .app 폴더를 지정해줘.');
  const plist = path.join(app, 'Contents', 'Info.plist');
  const [appId, bundleVersion, executable] = await Promise.all([
    plistValue(plist, 'CFBundleIdentifier'), plistValue(plist, 'CFBundleShortVersionString'), plistValue(plist, 'CFBundleExecutable'),
  ]);
  if (appId !== APP_ID) throw new Error(`앱 ID가 ${APP_ID}와 다르기 때문에 배포하지 않았어.`);
  if (bundleVersion !== version) throw new Error(`앱 버전(${bundleVersion})과 요청한 버전(${version})이 달라.`);
  if (!executable || path.basename(executable) !== executable || /[\x00-\x1f]/.test(executable)) throw new Error('앱 실행파일 이름이 올바르지 않아.');
  const main = path.join(app, 'Contents', 'MacOS', executable);
  if (!within(app, await realpath(main))) throw new Error('앱 실행파일이 앱 폴더 바깥을 가리켜.');
  const archs = (await run('/usr/bin/lipo', ['-archs', main])).stdout.trim().split(/\s+/);
  if (!archs.includes('arm64') || !archs.includes('x86_64')) throw new Error('Apple Silicon·Intel을 모두 포함한 universal 앱이 필요해.');
  const framework = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework');
  const frameworkArchs = (await run('/usr/bin/lipo', ['-archs', framework])).stdout.trim().split(/\s+/);
  if (!frameworkArchs.includes('arm64') || !frameworkArchs.includes('x86_64')) throw new Error('Electron 실행 엔진도 Apple Silicon·Intel을 모두 포함해야 해.');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  // Every Mach-O slice has a different CDHash; compare both when reusing an archive.
  const hashes = {};
  for (const arch of ['arm64', 'x86_64']) {
    const output = await run('/usr/bin/codesign', ['-d', '--verbose=4', '--arch', arch, app]);
    const match = `${output.stdout}\n${output.stderr}`.match(/^CDHash=([a-f0-9]+)$/m);
    if (!match) throw new Error(`${arch} 코드 서명 해시를 읽지 못했어.`);
    hashes[arch] = match[1];
  }
  return hashes;
}

async function inspectArchive(zip, expectedRoot) {
  const names = (await run('/usr/bin/unzip', ['-Z', '-1', zip])).stdout.trimEnd().split('\n');
  const seen = new Set();
  for (const name of names) {
    const normalized = name.replace(/\/$/, '');
    if (!name || /[\\\x00-\x1f]/.test(name) || name.startsWith('/') || name.split('/').some((part) => part === '..' || part === '.') || seen.has(normalized)) throw new Error('ZIP에 안전하지 않거나 중복된 경로가 있어.');
    if (name !== `${expectedRoot}/` && !name.startsWith(`${expectedRoot}/`)) throw new Error('ZIP에는 지정한 앱 하나만 있어야 해. --zip에 새 경로를 주면 다시 만들 수 있어.');
    seen.add(normalized);
  }
  // Files must never be extracted through a symlink created earlier in the ZIP.
  const listing = (await run('/usr/bin/zipinfo', ['-l', zip])).stdout;
  const links = new Set();
  for (const line of listing.split('\n').filter((line) => line.startsWith('l'))) {
    const match = line.match(/^l.{9}\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (!match || !seen.has(match[1])) throw new Error('ZIP 심볼릭 링크 목록을 안전하게 읽지 못했어.');
    links.add(match[1]);
    const target = (await run('/usr/bin/unzip', ['-p', zip, match[1]], { maxBuffer: 8192 })).stdout;
    const resolved = path.posix.resolve('/', path.posix.dirname(match[1]), target);
    if (target.startsWith('/') || /[\\\x00-\x1f]/.test(target) || !resolved.startsWith(`/${expectedRoot}/`)) throw new Error('ZIP의 링크가 앱 폴더 바깥을 가리켜.');
  }
  for (const name of names) {
    let parent = path.posix.dirname(name.replace(/\/$/, ''));
    while (parent !== '.') { if (links.has(parent)) throw new Error('ZIP 파일 경로의 상위 폴더가 심볼릭 링크야.'); parent = path.posix.dirname(parent); }
  }
}

async function verifyLinks(app) {
  app = await realpath(app);
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const current = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(current);
        if (path.isAbsolute(target) || !within(app, await realpath(current))) throw new Error('앱 안의 링크가 앱 폴더 바깥을 가리켜.');
      } else if (entry.isDirectory()) await walk(current);
    }
  }
  await walk(app);
}

function compareVersions(left, right) {
  validateVersion(left); validateVersion(right);
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

export async function publish(options) {
  if (process.platform !== 'darwin') throw new Error('배포 서명은 프로젝트 Keychain이 있는 Mac에서 실행해줘.');
  const app = await realpath(path.resolve(options.app));
  const zip = path.resolve(options.zip);
  const output = path.resolve(options.out);
  const download = validateReleaseUrl(options.url);
  const releaseNotes = options['notes-file'] ? await readFile(path.resolve(options['notes-file']), 'utf8') : options.notes;
  const expectedHashes = await verifyBundle(app, options.version);
  await verifyLinks(app);
  const work = await mkdtemp(path.join(tmpdir(), 'chiikawa-publish-'));
  let generatedZip = false;
  try {
    if (!await exists(zip)) {
      await mkdir(path.dirname(zip), { recursive: true });
      // Temporary ZIP avoids leaving a half-written release artifact on failure.
      const temporaryZip = path.join(work, 'release.zip');
      await run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', app, temporaryZip]);
      await copyFile(temporaryZip, zip, constants.COPYFILE_EXCL);
      generatedZip = true;
    }
    if (!(await lstat(zip)).isFile()) throw new Error('ZIP 경로는 심볼릭 링크가 아닌 일반 파일이어야 해.');
    // Validate and sign a private snapshot so a concurrent build cannot swap the ZIP.
    const verifiedZip = path.join(work, 'verified-release.zip');
    await copyFile(zip, verifiedZip, constants.COPYFILE_EXCL);
    const size = (await stat(verifiedZip)).size;
    if (size <= 0 || size > MAX_ZIP_SIZE) throw new Error('ZIP 크기는 0보다 크고 1 GiB 이하여야 해.');
    await inspectArchive(verifiedZip, path.basename(app));
    const unpack = path.join(work, 'unpacked');
    await mkdir(unpack);
    await run('/usr/bin/ditto', ['-x', '-k', verifiedZip, unpack]);
    const unpackedApp = path.join(unpack, path.basename(app));
    await verifyLinks(unpackedApp);
    const actualHashes = await verifyBundle(unpackedApp, options.version);
    if (JSON.stringify(expectedHashes) !== JSON.stringify(actualHashes)) throw new Error('ZIP 안의 앱 서명이 지정한 앱과 달라. 새 --zip 경로로 다시 만들어줘.');

    const payload = buildPayload({ version: options.version, url: download.url, size, sha256: await hashFile(verifiedZip), releaseNotes });
    const payloadBytes = Buffer.from(JSON.stringify(payload));
    const payloadPath = path.join(work, 'payload.json');
    await writeFile(payloadPath, payloadBytes, { mode: 0o600 });
    const signer = path.join(projectRoot, 'scripts', 'release-sign.swift');
    const swiftArgs = ['-suppress-warnings', '-module-cache-path', path.join(tmpdir(), 'chiikawa-swift-module-cache'), signer];
    const signature = (await run('/usr/bin/swift', [...swiftArgs, 'sign', payloadPath])).stdout.trim();
    const publicKey = (await run('/usr/bin/swift', [...swiftArgs, 'public'])).stdout;
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || !verify(null, payloadBytes, createPublicKey(publicKey), Buffer.from(signature, 'base64'))) throw new Error('생성한 업데이트 서명을 검증하지 못했어. 배포 목록을 변경하지 않았어.');

    await mkdir(output, { recursive: true });
    const latest = path.join(output, 'latest.json');
    if (await exists(latest)) {
      if (!(await lstat(latest)).isFile()) throw new Error('기존 latest.json이 일반 파일이 아니어서 변경하지 않았어.');
      let previous;
      try { previous = JSON.parse(Buffer.from(JSON.parse(await readFile(latest, 'utf8')).payload, 'base64').toString('utf8')); }
      catch { throw new Error('기존 latest.json을 해석하지 못했어. 덮어쓰지 않았어.'); }
      const order = compareVersions(payload.version, previous.version);
      if (order < 0 || (order === 0 && previous.sha256 !== payload.sha256)) throw new Error('기존 배포보다 새 버전 번호를 사용해줘. 같은 버전의 다른 파일은 덮어쓰지 않아.');
    }
    const publishedZip = path.join(output, download.filename);
    if (await exists(publishedZip)) {
      if (!(await lstat(publishedZip)).isFile() || await hashFile(publishedZip) !== payload.sha256) throw new Error('배포 폴더에 다른 내용의 같은 ZIP 이름이 있어. 덮어쓰지 않았어.');
    } else await copyFile(verifiedZip, publishedZip, constants.COPYFILE_EXCL);
    const envelope = { payload: payloadBytes.toString('base64'), signature };
    const temporaryLatest = path.join(output, `.latest-${process.pid}-${Date.now()}.json`);
    try { await writeFile(temporaryLatest, `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx' }); await rename(temporaryLatest, latest); }
    finally { await rm(temporaryLatest, { force: true }); }
    return { version: payload.version, latest, zip: publishedZip, sha256: payload.sha256, size, generatedZip };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage);
    else console.log(JSON.stringify(await publish(options), null, 2));
  } catch (error) {
    console.error(`업데이트 준비 실패: ${error.message}`);
    process.exitCode = 1;
  }
}
