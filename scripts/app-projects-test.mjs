import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-app-projects-'));
const profile = path.join(temp, 'user');
const codexHome = path.join(profile, '.codex');
const dataDir = path.join(temp, 'data');
const projectPath = path.join(temp, 'workspace');
const extraPath = path.join(temp, 'temporary-thread-cwd');
const boundPort = net.createServer();
await new Promise((resolve) => boundPort.listen(0, '127.0.0.1', resolve));
const port = boundPort.address().port;
await new Promise((resolve) => boundPort.close(resolve));
const base = `http://127.0.0.1:${port}`;
const password = 'app-projects-test-password';
let child = null;

try {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(extraPath, { recursive: true });
  await fs.mkdir(path.join(dataDir, 'thread-snapshots'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'threads.json'), JSON.stringify([
    { id: 'thread-extra', name: '临时任务', preview: '临时任务', cwd: extraPath, updatedAt: Date.now() },
  ]), 'utf8');

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT NOT NULL, position INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)');
  db.exec('CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position))');
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run('project-1', '实用软件开发', '{}', 0, Date.now(), Date.now());
  db.prepare('INSERT INTO project_roots VALUES (?, ?, ?)').run('project-1', 0, projectPath);
  db.close();

  child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      USERPROFILE: profile,
      CODEX_WEB_HOST: '127.0.0.1',
      CODEX_WEB_PORT: String(port),
      CODEX_WEB_PASSWORD: password,
      CODEX_WEB_DATA_DIR: dataDir,
      CODEX_WEB_TEST_MODE: '1',
      CODEX_WEB_AUTO_PREPARE: '0',
      CODEX_WEB_TITLE_CACHE_MS: '0',
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    try { const response = await fetch(`${base}/api/session`); if (response.ok) { ready = true; break; } } catch { }
    await delay(100);
  }
  assert.ok(ready, `project test gateway did not start: ${stderr.slice(-1200)}`);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  const result = await (await fetch(`${base}/api/projects`, { headers: { cookie } })).json();
  assert.equal(result.data.length, 1, JSON.stringify(result));
  assert.equal(result.data[0].name, '实用软件开发');
  assert.equal(result.data[0].path, projectPath);
  assert.deepEqual(result.data[0].roots, [projectPath]);
  assert.equal(result.data[0].source, 'app');
  console.log('APP_PROJECTS_TEST_OK appOnly=true temporaryCwdHidden=true');
} finally {
  if (child && child.exitCode == null) {
    try { child.kill(); } catch { }
    await delay(500);
    if (child.exitCode == null) { try { child.kill('SIGKILL'); } catch { } }
  }
  if (temp.startsWith(path.join(os.tmpdir(), 'cwr-app-projects-'))) await fs.rm(temp, { recursive: true, force: true });
}
