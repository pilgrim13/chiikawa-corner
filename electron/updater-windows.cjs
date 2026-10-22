const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { compareVersions, verifyManifest } = require('./updater-core.cjs');
const { request } = require('./updater.cjs');

async function readManifest(response) {
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 48000) throw new Error('업데이트 정보가 너무 커요.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createWindowsUpdater({ app, config, onState, testMode = false, platform = process.platform }) {
  const cache = path.join(app.getPath('userData'), 'updates');
  const currentVersion = app.getVersion();
  let state = { phase: platform === 'win32' && app.isPackaged ? 'idle' : 'unsupported', currentVersion };
  let busy = false, manifest, installer, downloadDirectory;
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(cache, 'last-install.json'), 'utf8'));
    state.message = previous.message;
    if (!previous.ok) state.phase = 'error';
  } catch {}
  const emit = (patch) => { state = { ...state, ...patch }; onState?.(state); return state; };
  const failure = (error) => emit({ phase: 'error', progress: undefined, message: /fetch failed|timeout|aborted/i.test(error.message) ? '업데이트 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' : error.message });

  async function check() {
    if (busy || state.phase === 'ready') return state;
    if (platform !== 'win32' || !app.isPackaged) return emit({ phase: 'unsupported', message: '설치한 Windows 앱에서 업데이트할 수 있어요.' });
    busy = true;
    emit({ phase: 'checking', message: undefined, progress: undefined });
    try {
      const envelope = await readManifest(await request(config.winFeedUrl, { allowHttp: testMode }));
      manifest = verifyManifest(envelope, config.publicKey, { currentVersion, allowHttp: testMode, platform: 'win32', arch: 'x64' });
      return emit({ phase: compareVersions(manifest.version, currentVersion) > 0 ? 'available' : 'current', latestVersion: manifest.version, releaseNotes: manifest.releaseNotes });
    } catch (error) { manifest = undefined; installer = undefined; return failure(error); }
    finally { busy = false; }
  }

  async function download() {
    if (busy || state.phase === 'ready') return state;
    if (!manifest || compareVersions(manifest.version, currentVersion) <= 0) return state;
    busy = true;
    emit({ phase: 'downloading', message: undefined, progress: 0 });
    try {
      await fsp.mkdir(cache, { recursive: true, mode: 0o700 });
      if (downloadDirectory) await fsp.rm(downloadDirectory, { recursive: true, force: true });
      downloadDirectory = await fsp.mkdtemp(path.join(cache, 'download-'));
      const file = path.join(downloadDirectory, 'update.exe');
      const response = await request(manifest.url, { allowHttp: testMode, timeout: 10 * 60 * 1000 });
      const handle = await fsp.open(file, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      let received = 0, lastProgress = -1;
      try {
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > manifest.size) throw new Error('업데이트 파일의 크기가 일치하지 않아요.');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            if (bytesWritten < 1) throw new Error('업데이트 파일을 저장하지 못했어요.');
            offset += bytesWritten;
          }
          const progress = Math.floor(received / manifest.size * 100);
          if (progress !== lastProgress) { lastProgress = progress; emit({ progress }); }
        }
      } finally { await handle.close(); }
      if (received !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('업데이트 파일이 손상됐어요. 다시 다운로드해 주세요.');
      emit({ phase: 'verifying', progress: 100 });
      const peek = await fsp.open(file, 'r');
      const signature = Buffer.alloc(2);
      try { await peek.read(signature, 0, 2, 0); } finally { await peek.close(); }
      if (signature.toString('ascii') !== 'MZ') throw new Error('Windows 설치파일 형식이 아니에요.');
      installer = file;
      return emit({ phase: 'ready', message: '준비됐어요. 재시작하면 새 버전이 적용돼요.' });
    } catch (error) {
      installer = undefined;
      if (downloadDirectory) await fsp.rm(downloadDirectory, { recursive: true, force: true }).catch(() => {});
      return failure(error);
    } finally { busy = false; }
  }

  async function install() {
    if (busy || !installer || !['ready', 'error'].includes(state.phase)) return state;
    busy = true;
    try {
      // Hash once more just before launching an installer from user-writable cache.
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(installer)) hash.update(chunk);
      if (hash.digest('hex') !== manifest.sha256) throw new Error('설치파일이 바뀌었어요. 다시 다운로드해 주세요.');
      const token = crypto.randomBytes(24).toString('hex');
      // PowerShell is a separate system executable. Keeping the old Electron
      // binary alive as a helper would prevent NSIS from replacing it.
      const helper = path.join(cache, `win-helper-${token}.ps1`);
      await fsp.copyFile(path.join(__dirname, 'update-windows-helper.ps1'), helper);
      const tx = {
        parentPid: process.pid, installer, version: manifest.version, token, target: process.execPath,
        sha256: manifest.sha256, size: manifest.size,
        started: path.join(cache, `${token}.started`), ack: path.join(cache, `${token}.ready`),
        result: path.join(cache, 'last-install.json'),
      };
      const transactionFile = path.join(cache, `win-transaction-${token}.json`);
      await fsp.writeFile(transactionFile, JSON.stringify(tx), { mode: 0o600 });
      emit({ phase: 'installing', message: '앱을 재시작해 새 버전을 설치할게요.' });
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, transactionFile], {
        detached: true, windowsHide: true, stdio: 'ignore', env: process.env,
      });
      let spawnError;
      child.on('error', (error) => { spawnError = error; });
      child.unref();
      for (let i = 0; i < 300 && !fs.existsSync(tx.started) && !spawnError; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      if (spawnError || !fs.existsSync(tx.started)) throw new Error('업데이트 설치를 시작하지 못했어요. 다시 시도해 주세요.');
      setTimeout(() => app.quit(), 300);
      return state;
    } catch (error) { return failure(error); }
    finally { busy = false; }
  }
  return { getState: () => state, check, download, install };
}

module.exports = { createWindowsUpdater };
