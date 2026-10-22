const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { APP_NAME, compareVersions, verifyManifest, validateUrl, inspectArchiveEntries, inspectSymlink } = require('./updater-core.cjs');

async function request(url, { allowHttp = false, timeout = 30000 } = {}) {
  let next = url;
  const signal = AbortSignal.timeout(timeout);
  for (let i = 0; i < 5; i++) {
    validateUrl(next, allowHttp);
    const response = await fetch(next, { redirect: 'manual', signal, cache: 'no-store' });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      next = new URL(response.headers.get('location'), next).href;
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`업데이트 서버에 연결하지 못했어요. (${response.status})`); }
    return response;
  }
  throw new Error('업데이트 주소가 너무 여러 번 바뀌었어요.');
}
async function readSmall(response) {
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 48000) throw new Error('업데이트 정보가 너무 커요.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function verifyBundle(bundle, version) {
  const plist = path.join(bundle, 'Contents/Info.plist');
  for (const [key, expected] of [['CFBundleIdentifier', 'com.corner.chiikawa'], ['CFBundleShortVersionString', version], ['CFBundleExecutable', 'Chiikawa Corner']]) {
    const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
    if (stdout.trim() !== expected) throw new Error('업데이트 앱의 정보가 일치하지 않아요.');
  }
  const { stdout } = await run('/usr/bin/lipo', ['-archs', path.join(bundle, 'Contents/MacOS/Chiikawa Corner')]);
  if (!stdout.includes('arm64') || !stdout.includes('x86_64')) throw new Error('모든 Mac을 지원하는 업데이트가 아니에요.');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120000 });
}
async function verifyLinks(root) {
  const realRoot = await fsp.realpath(root);
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const real = await fsp.realpath(item);
        if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) throw new Error('앱 바깥을 가리키는 링크가 있어요.');
      } else if (entry.isDirectory()) await walk(item);
      else if (!entry.isFile()) throw new Error('지원하지 않는 업데이트 파일이에요.');
    }
  }
  await walk(realRoot);
}
async function extractArchive(archive, destination, version) {
  const { stdout } = await run('/usr/bin/unzip', ['-Z1', archive], { maxBuffer: 32 * 1024 * 1024 });
  const entries = stdout.trimEnd().split('\n');
  inspectArchiveEntries(entries);
  const listing = await run('/usr/bin/zipinfo', ['-l', archive], { maxBuffer: 32 * 1024 * 1024 });
  const links = new Set();
  for (const line of listing.stdout.split('\n')) {
    if (!line.startsWith('l')) continue;
    const offset = line.indexOf(APP_NAME);
    if (offset < 0) throw new Error('업데이트 링크 경로를 읽을 수 없어요.');
    const entry = line.slice(offset);
    if (!entries.includes(entry)) throw new Error('업데이트 링크 목록이 일치하지 않아요.');
    links.add(entry);
    const { stdout: target } = await run('/usr/bin/unzip', ['-p', archive, entry], { maxBuffer: 4096 });
    inspectSymlink(entry, target);
  }
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.replace(/\/$/, ''));
    while (parent !== '.') {
      if (links.has(parent)) throw new Error('업데이트 파일의 상위 경로에 링크가 있어요.');
      parent = path.posix.dirname(parent);
    }
  }
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  await run('/usr/bin/ditto', ['-x', '-k', archive, destination], { timeout: 120000 });
  const bundle = path.join(destination, APP_NAME);
  await verifyLinks(bundle);
  await verifyBundle(bundle, version);
  return bundle;
}
function createUpdater({ app, config, onState, testMode = false, resourcesPath = process.resourcesPath }) {
  const cache = path.join(app.getPath('userData'), 'updates');
  const resultFile = path.join(cache, 'last-install.json');
  const currentVersion = app.getVersion();
  let state = { phase: process.platform === 'darwin' && app.isPackaged ? 'idle' : 'unsupported', currentVersion };
  let busy = false, manifest, readyBundle, downloadDirectory;
  try { const previous = JSON.parse(fs.readFileSync(resultFile)); state.message = previous.message; if (!previous.ok) state.phase = 'error'; } catch {}
  function emit(patch) { state = { ...state, ...patch }; onState?.(state); return state; }
  function failure(error) {
    const message = /fetch failed|timeout|aborted/i.test(error.message) ? '업데이트 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' : error.message;
    return emit({ phase: 'error', message, progress: undefined });
  }
  async function check() {
    if (busy || state.phase === 'ready') return state;
    if (!app.isPackaged || process.platform !== 'darwin') return emit({ phase: 'unsupported', message: '설치한 Mac 앱에서 업데이트할 수 있어요.' });
    busy = true;
    emit({ phase: 'checking', message: undefined, progress: undefined });
    try {
      const envelope = await readSmall(await request(config.feedUrl, { allowHttp: testMode }));
      manifest = verifyManifest(envelope, config.publicKey, { currentVersion, allowHttp: testMode });
      return emit({ phase: compareVersions(manifest.version, currentVersion) > 0 ? 'available' : 'current', latestVersion: manifest.version, releaseNotes: manifest.releaseNotes });
    } catch (error) { manifest = undefined; return failure(error); }
    finally { busy = false; }
  }
  async function download() {
    if (busy || state.phase === 'ready') return state;
    if (!manifest || compareVersions(manifest.version, currentVersion) <= 0) return state;
    busy = true;
    emit({ phase: 'downloading', progress: 0, message: undefined });
    try {
      await fsp.mkdir(cache, { recursive: true, mode: 0o700 });
      if (downloadDirectory) await fsp.rm(downloadDirectory, { recursive: true, force: true });
      downloadDirectory = await fsp.mkdtemp(path.join(cache, 'download-'));
      const archive = path.join(downloadDirectory, 'update.zip');
      const response = await request(manifest.url, { allowHttp: testMode, timeout: 10 * 60 * 1000 });
      const handle = await fsp.open(archive, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      let received = 0, lastProgress = -1;
      try {
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > manifest.size) throw new Error('업데이트 파일의 크기가 일치하지 않아요.');
          hash.update(chunk); await handle.write(chunk);
          const progress = Math.floor(received / manifest.size * 100);
          if (progress !== lastProgress) { lastProgress = progress; emit({ progress }); }
        }
      } finally { await handle.close(); }
      if (received !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('업데이트 파일이 손상됐어요. 다시 다운로드해 주세요.');
      emit({ phase: 'verifying', progress: 100 });
      readyBundle = await extractArchive(archive, path.join(downloadDirectory, 'unpacked'), manifest.version);
      await fsp.rm(archive);
      return emit({ phase: 'ready', message: '준비됐어요. 재시작하면 새 버전이 적용돼요.' });
    } catch (error) {
      readyBundle = undefined;
      if (downloadDirectory) await fsp.rm(downloadDirectory, { recursive: true, force: true }).catch(() => {});
      return failure(error);
    } finally { busy = false; }
  }
  async function install() {
    if (busy || !readyBundle || !['ready', 'error'].includes(state.phase)) return state;
    busy = true;
    let transactionDirectory;
    try {
      const target = path.resolve(resourcesPath, '../..');
      const parent = path.dirname(target);
      const allowed = ['/Applications', path.join(os.homedir(), 'Applications')];
      if (path.basename(target) !== APP_NAME || (!testMode && !allowed.includes(parent)) || await fsp.realpath(target) !== target) throw new Error('앱을 응용 프로그램 폴더로 옮겨 실행한 다음 다시 시도해 주세요.');
      await fsp.access(parent, fs.constants.W_OK);
      emit({ phase: 'installing', message: '앱을 교체할 준비를 하고 있어요.' });
      transactionDirectory = await fsp.mkdtemp(path.join(parent, '.chiikawa-update-'));
      const staged = path.join(transactionDirectory, 'new.app');
      await run('/usr/bin/ditto', [readyBundle, staged], { timeout: 120000 });
      await verifyBundle(staged, manifest.version);
      const token = crypto.randomBytes(24).toString('hex');
      const helper = path.join(cache, `helper-${token}.cjs`);
      await fsp.copyFile(path.join(__dirname, 'update-helper.cjs'), helper);
      const swap = path.join(cache, `swap-${token}`);
      const swapSource = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'swap-bundles');
      await fsp.copyFile(swapSource, swap);
      await fsp.chmod(swap, 0o700);
      const tx = {
        directory: transactionDirectory, target, staged, backup: staged, swap,
        version: manifest.version, token, parentPid: process.pid,
        ack: path.join(cache, `${token}.ready`), started: path.join(cache, `${token}.started`), result: resultFile,
      };
      const transactionFile = path.join(transactionDirectory, 'transaction.json');
      await fsp.writeFile(transactionFile, JSON.stringify(tx), { mode: 0o600 });
      const log = fs.openSync(path.join(cache, 'install.log'), 'a', 0o600);
      const child = spawn(process.execPath, [helper, transactionFile], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      let spawnError;
      child.on('error', (error) => { spawnError = error; });
      child.unref(); fs.closeSync(log);
      for (let i = 0; i < 100 && !fs.existsSync(tx.started) && !spawnError; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      if (spawnError || !fs.existsSync(tx.started)) throw new Error('업데이트 설치를 시작하지 못했어요. 다시 시도해 주세요.');
      emit({ message: '새 버전으로 재시작하고 있어요.' });
      setTimeout(() => app.quit(), 300);
      return state;
    } catch (error) {
      if (transactionDirectory) await fsp.rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
      return failure(error.code === 'EACCES' ? new Error('응용 프로그램 폴더에 쓰기 권한이 없어요. 사용자 응용 프로그램 폴더로 옮겨 주세요.') : error);
    } finally { busy = false; }
  }
  return { getState: () => state, check, download, install };
}
function acknowledgeUpdate(app) {
  const token = process.env.CORNER_UPDATE_TOKEN;
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return;
  const cache = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const ack = path.join(cache, `${token}.ready`);
  fs.writeFileSync(`${ack}.tmp`, JSON.stringify({ version: app.getVersion(), token }), { mode: 0o600 });
  fs.renameSync(`${ack}.tmp`, ack);
  delete process.env.CORNER_UPDATE_TOKEN;
}
module.exports = { createUpdater, acknowledgeUpdate, extractArchive, verifyBundle, request };
