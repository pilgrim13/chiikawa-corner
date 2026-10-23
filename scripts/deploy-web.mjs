// Build a web release away from the live directory and switch its HTML last.
// Express serves dist/ directly, so replacing dist during a build can break a live room.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const runtime = path.join(project, '.runtime');
const destination = path.join(project, 'dist');
await mkdir(runtime, { recursive: true });
const stage = await mkdtemp(path.join(runtime, 'web-stage-'));

async function copyAtomically(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function copyContents(source, target, root = false) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (root && entry.name === 'index.html') continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyContents(from, to);
    else if (entry.isFile()) await copyAtomically(from, to);
    else throw new Error(`Unexpected generated web asset: ${entry.name}`);
  }
}

try {
  execFileSync('npm', ['run', 'typecheck'], { cwd: project, stdio: 'inherit' });
  execFileSync('npx', ['vite', 'build', '--outDir', stage], { cwd: project, stdio: 'inherit' });
  const index = path.join(stage, 'index.html');
  if (!(await stat(index)).isFile()) throw new Error('Built website has no index.html');
  await mkdir(destination, { recursive: true });
  await copyContents(stage, destination, true);
  await copyAtomically(index, path.join(destination, 'index.html'));
  process.stdout.write('웹 화면을 새로 적용했어. 기존 서버와 방 연결은 유지돼.\n');
} finally {
  await rm(stage, { recursive: true, force: true });
}
