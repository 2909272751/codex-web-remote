import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-thread-title-'));
const profile = path.join(temp, 'user');
const codexHome = path.join(profile, '.codex');
const dataDir = path.join(temp, 'data');
const stateDb = path.join(codexHome, 'state_5.sqlite');
const boundPort = net.createServer();
await new Promise((resolve) => boundPort.listen(0, '127.0.0.1', resolve));
const port = boundPort.address().port;
await new Promise((resolve) => boundPort.close(resolve));
const base = `http://127.0.0.1:${port}`;
const password = 'thread-title-test-password';
let child = null;

try {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(path.join(dataDir, 'thread-snapshots'), { recursive: true });
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: 'thread-1', thread_name: 'Custom old name', updated_at: new Date().toISOString() }),
    JSON.stringify({ id: 'thread-1', thread_name: 'Stale legacy name', updated_at: new Date().toISOString() }),
  ].join('\n') + '\n', 'utf8');
  await fs.writeFile(path.join(dataDir, 'threads.json'), JSON.stringify([{ id: 'thread-1', preview: 'Old cache title', cwd: root }]), 'utf8');

  const db = new DatabaseSync(stateDb);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, updated_at_ms INTEGER)');
  db.prepare('INSERT INTO threads (id, name, title, updated_at_ms) VALUES (?, ?, ?, ?)').run('thread-1', null, 'App default title', Date.now());
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
      CODEX_WEB_SESSION_ROOT: path.join(codexHome, 'sessions'),
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
  assert.ok(ready, `title test gateway did not start: ${stderr.slice(-1200)}`);

  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  const previews = async () => (await (await fetch(`${base}/api/thread-previews`, { headers: { cookie } })).json()).data;

  const resetView = await previews();
  assert.equal(resetView.find((item) => item.id === 'thread-1')?.preview, 'App default title');

  const renameDb = new DatabaseSync(stateDb);
  renameDb.prepare('UPDATE threads SET name = ?, updated_at_ms = ? WHERE id = ?').run('Renamed in Desktop', Date.now(), 'thread-1');
  renameDb.close();

  const renamedView = await previews();
  assert.equal(renamedView.find((item) => item.id === 'thread-1')?.preview, 'Renamed in Desktop');
  console.log('THREAD_TITLE_TEST_OK resetUsesDefault=true renameUsesDesktopState=true');
} finally {
  if (child && child.exitCode == null) {
    try { child.kill(); } catch { }
    await delay(500);
    if (child.exitCode == null) { try { child.kill('SIGKILL'); } catch { } }
  }
  if (temp.startsWith(path.join(os.tmpdir(), 'cwr-thread-title-'))) await fs.rm(temp, { recursive: true, force: true });
}
