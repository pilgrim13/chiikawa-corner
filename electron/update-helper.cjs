// Runs with the installed Electron's embedded Node; no separate runtime needed.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const transactionFile = process.argv[2];
const tx = JSON.parse(fs.readFileSync(transactionFile, 'utf8'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child, swapped = false, completed = false, recovering = false;
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function journal(phase) { fs.writeFileSync(transactionFile, JSON.stringify({ ...tx, phase })); }
function result(ok, message) { fs.writeFileSync(tx.result, JSON.stringify({ ok, version: tx.version, message })); }
function launch(token) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CORNER_UPDATE_TOKEN;
  if (token) env.CORNER_UPDATE_TOKEN = token;
  const proc = spawn(path.join(tx.target, 'Contents/MacOS/Chiikawa Corner'), [], { detached: true, stdio: 'ignore', env });
  proc.on('error', () => {});
  proc.unref();
  return proc;
}
async function rollback(message) {
  if (completed || recovering) return;
  recovering = true;
  if (child?.pid && alive(child.pid)) { process.kill(child.pid, 'SIGTERM'); for (let i = 0; i < 30 && alive(child.pid); i++) await wait(100); if (alive(child.pid)) process.kill(child.pid, 'SIGKILL'); }
  if (swapped) execFileSync(tx.swap, [tx.target, tx.backup]);
  journal('rolled-back');
  result(false, message);
  if (swapped) launch();
  process.exit(1);
}
process.on('SIGTERM', () => rollback('업데이트가 중단되어 이전 버전으로 돌아왔어요.'));
process.on('uncaughtException', (error) => rollback(`앱 교체에 실패해 이전 버전으로 돌아왔어요. ${error.code || ''}`));
(async () => {
  journal('waiting');
  fs.writeFileSync(tx.started, 'ready');
  for (let i = 0; i < 300 && alive(tx.parentPid); i++) await wait(100);
  if (alive(tx.parentPid)) { result(false, '앱 종료를 기다리다 멈췄어요. 다시 시도해 주세요.'); process.exit(1); }
  journal('replacing');
  execFileSync(tx.swap, [tx.target, tx.staged]); swapped = true;
  journal('starting');
  child = launch(tx.token);
  for (let i = 0; i < 600; i++) {
    if (fs.existsSync(tx.ack)) {
      const ack = JSON.parse(fs.readFileSync(tx.ack, 'utf8'));
      if (ack.version === tx.version && ack.token === tx.token) {
        completed = true;
        result(true, `${tx.version} 업데이트를 적용했어요.`);
        journal('complete');
        fs.rmSync(tx.backup, { recursive: true, force: true });
        fs.rmSync(tx.ack, { force: true });
        fs.rmSync(tx.directory, { recursive: true, force: true });
        return;
      }
    }
    if (!child.pid || !alive(child.pid)) break;
    await wait(100);
  }
  await rollback('새 버전을 실행하지 못해 이전 버전으로 돌아왔어요.');
})().catch(() => rollback('앱 교체에 실패해 이전 버전으로 돌아왔어요.'));
