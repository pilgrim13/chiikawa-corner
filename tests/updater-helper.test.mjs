import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperPath = path.join(project, 'electron/update-helper.cjs');
const swapPath = path.join(project, 'electron/swap-bundles');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function readJson(filename) { return JSON.parse(await fs.readFile(filename, 'utf8')); }
async function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${description}`);
}
async function fileExists(filename) {
  try { await fs.access(filename); return true; } catch { return false; }
}
function finished(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
async function exitedParentPid() {
  const parent = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await finished(parent);
  return parent.pid;
}

async function fixture(t, mode = 'ack') {
  await fs.access(swapPath, fsConstants.X_OK);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'corner-update-test-'));
  const applications = path.join(directory, 'Applications');
  const userData = path.join(directory, 'user-data');
  const cache = path.join(userData, 'updates');
  await fs.mkdir(applications, { recursive: true });
  await fs.mkdir(cache, { recursive: true });
  const transactionDirectory = await fs.mkdtemp(path.join(applications, '.chiikawa-update-'));
  const launcher = path.join(directory, 'fake-launcher.cjs');
  await fs.writeFile(launcher, `
const fs = require('node:fs');
const path = require('node:path');
const label = process.argv[2];
const directory = process.env.CORNER_HELPER_TEST_DIR;
fs.writeFileSync(path.join(directory, label + '-launched.json'), JSON.stringify({
  pid: process.pid,
  label,
  token: process.env.CORNER_UPDATE_TOKEN || null,
  runtimeFlag: process.env.ELECTRON_RUN_AS_NODE || null,
}));
if (label === 'new' && process.env.CORNER_HELPER_TEST_MODE === 'exit') process.exit(7);
if (label === 'new') {
  const token = process.env.CORNER_UPDATE_TOKEN;
  const ack = path.join(directory, 'user-data', 'updates', token + '.ready');
  const body = {
    version: process.env.CORNER_HELPER_TEST_MODE === 'wrong-version' ? '0.0.1' : '0.2.0',
    token: process.env.CORNER_HELPER_TEST_MODE === 'wrong-token' ? '0'.repeat(48) : token,
  };
  fs.writeFileSync(ack + '.tmp', JSON.stringify(body));
  fs.renameSync(ack + '.tmp', ack);
  if (process.env.CORNER_HELPER_TEST_MODE !== 'ack') setTimeout(() => process.exit(8), 150);
}
setInterval(() => {}, 1000);
`);
  async function makeBundle(destination, label) {
    await fs.mkdir(path.join(destination, 'Contents/MacOS'), { recursive: true });
    await fs.writeFile(path.join(destination, 'version.txt'), label);
    await fs.writeFile(path.join(destination, 'Contents/MacOS/Chiikawa Corner'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(launcher)} ${shellQuote(label)}\n`, { mode: 0o755 });
  }
  const target = path.join(applications, 'Chiikawa Corner.app');
  const staged = path.join(transactionDirectory, 'new.app');
  await makeBundle(target, 'old');
  await makeBundle(staged, 'new');
  const preferences = path.join(userData, 'preferences.json');
  const preferenceContents = JSON.stringify({ nickname: '그대로 둘 이름', size: 1.2, quiet: true });
  await fs.writeFile(preferences, preferenceContents);
  const token = randomBytes(24).toString('hex');
  const tx = {
    directory: transactionDirectory,
    target,
    staged,
    backup: staged,
    swap: swapPath,
    version: '0.2.0',
    token,
    parentPid: await exitedParentPid(),
    ack: path.join(cache, `${token}.ready`),
    started: path.join(cache, `${token}.started`),
    result: path.join(cache, 'last-install.json'),
  };
  const transactionFile = path.join(transactionDirectory, 'transaction.json');
  await fs.writeFile(transactionFile, JSON.stringify(tx));
  let helper;
  t.after(async () => {
    if (helper?.exitCode === null && helper?.signalCode === null) {
      helper.kill('SIGKILL');
      await sleep(30);
    }
    // Only terminate the fake applications created by this isolated fixture.
    for (const label of ['old', 'new']) {
      try {
        const marker = await readJson(path.join(directory, `${label}-launched.json`));
        process.kill(marker.pid, 'SIGKILL');
      } catch { /* It may already have exited or never have been launched. */ }
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory, transactionFile, tx,
    async assertPreferencesPreserved() { assert.equal(await fs.readFile(preferences, 'utf8'), preferenceContents); },
    async execute() {
      helper = spawn(process.execPath, [helperPath, transactionFile], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CORNER_UPDATE_TOKEN: 'stale-parent-token', CORNER_HELPER_TEST_DIR: directory, CORNER_HELPER_TEST_MODE: mode },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let diagnostics = '';
      helper.stdout.on('data', (chunk) => { diagnostics += chunk.toString(); });
      helper.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
      const completion = finished(helper);
      const timeout = setTimeout(() => helper.kill('SIGKILL'), 6000);
      const status = await completion;
      clearTimeout(timeout);
      assert.notEqual(status.signal, 'SIGKILL', `Helper timed out: ${diagnostics}`);
      return { ...status, diagnostics };
    },
  };
}

const macOnly = { skip: process.platform !== 'darwin' };

test('update helper swaps the bundle, checks the new app acknowledgement, and preserves user data', macOnly, async (t) => {
  const f = await fixture(t);
  const result = await f.execute();
  assert.equal(result.code, 0, result.diagnostics);
  assert.equal(await fs.readFile(path.join(f.tx.target, 'version.txt'), 'utf8'), 'new');
  const report = await readJson(f.tx.result);
  assert.equal(report.ok, true);
  assert.equal(report.version, '0.2.0');
  const launched = await readJson(path.join(f.directory, 'new-launched.json'));
  assert.equal(launched.token, f.tx.token);
  assert.equal(launched.runtimeFlag, null, 'ELECTRON_RUN_AS_NODE must not reach the normal app');
  assert.equal(await fileExists(f.tx.directory), false, 'old backup should be cleaned only after acknowledgement');
  assert.equal(await fileExists(f.tx.ack), false);
  assert.equal(await fileExists(path.join(f.directory, 'old-launched.json')), false);
  await f.assertPreferencesPreserved();
});

test('update helper restores and relaunches the original bundle if the replacement exits before acknowledgement', macOnly, async (t) => {
  const f = await fixture(t, 'exit');
  const result = await f.execute();
  assert.equal(result.code, 1, result.diagnostics);
  assert.equal(await fs.readFile(path.join(f.tx.target, 'version.txt'), 'utf8'), 'old');
  const report = await readJson(f.tx.result);
  assert.equal(report.ok, false);
  await waitFor(() => fileExists(path.join(f.directory, 'old-launched.json')), 'previous app relaunch');
  const launched = await readJson(path.join(f.directory, 'old-launched.json'));
  assert.equal(launched.token, null, 'failed update credentials must not reach the rollback app');
  assert.equal(launched.runtimeFlag, null);
  await f.assertPreferencesPreserved();
});

test('update helper does not accept an acknowledgement for a different version or transaction', macOnly, async (t) => {
  for (const mode of ['wrong-version', 'wrong-token']) {
    const f = await fixture(t, mode);
    const result = await f.execute();
    assert.equal(result.code, 1, `${mode}: ${result.diagnostics}`);
    assert.equal(await fs.readFile(path.join(f.tx.target, 'version.txt'), 'utf8'), 'old');
    assert.equal((await readJson(f.tx.result)).ok, false);
    await waitFor(() => fileExists(path.join(f.directory, 'old-launched.json')), `${mode}: previous app relaunch`);
    await f.assertPreferencesPreserved();
  }
});

test('update helper leaves the installed app intact when the initial native swap fails', macOnly, async (t) => {
  const f = await fixture(t);
  await fs.rm(f.tx.staged, { recursive: true });
  const result = await f.execute();
  assert.equal(result.code, 1, result.diagnostics);
  assert.equal(await fs.readFile(path.join(f.tx.target, 'version.txt'), 'utf8'), 'old');
  assert.equal((await readJson(f.tx.result)).ok, false);
  assert.equal(await fileExists(path.join(f.directory, 'new-launched.json')), false);
  await f.assertPreferencesPreserved();
});
