import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-thread-rename-'));
const cwd = path.join(temp, 'workspace');
const profile = path.join(temp, 'profile');
const codexHome = path.join(profile, '.codex');
const stateFile = path.join(temp, 'desktop-state.json');
const dataDir = path.join(temp, 'data');
const boundPort = net.createServer();
await new Promise((resolve) => boundPort.listen(0, '127.0.0.1', resolve));
const port = boundPort.address().port;
await new Promise((resolve) => boundPort.close(resolve));
const base = `http://127.0.0.1:${port}`;
const password = 'thread-rename-test-password';
let child = null;

async function request(pathname, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), origin: base, ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data, cookie: response.headers.get('set-cookie') || '' };
}

try {
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(path.join(dataDir, 'thread-snapshots'), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ running: true, processes: [{ pid: 999_997, parentPid: 1, name: 'ChatGPT.exe', executablePath: 'C:\\fixture\\ChatGPT.exe', startedAt: new Date(Date.now() + 3_600_000).toISOString() }] }), 'utf8');
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      USERPROFILE: profile,
      CODEX_HOME: codexHome,
      CODEX_WEB_HOST: '127.0.0.1',
      CODEX_WEB_PORT: String(port),
      CODEX_WEB_PASSWORD: password,
      CODEX_WEB_DATA_DIR: dataDir,
      CODEX_WEB_TEST_MODE: '1',
      CODEX_WEB_TEST_PERSIST_THREADS: '1',
      CODEX_WEB_TEST_DESKTOP_STATE_FILE: stateFile,
      CODEX_WEB_AUTO_PREPARE: '0',
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
  assert.ok(ready, `rename test gateway did not start: ${stderr.slice(-1200)}`);
  const login = await request('/api/login', { method: 'POST', body: { password } });
  const cookie = login.cookie.split(';')[0];
  const takeover = await request('/api/control/takeover', { method: 'POST', body: { force: false }, cookie });
  assert.equal(takeover.status, 200, JSON.stringify(takeover.data));
  const created = await request('/api/threads', { method: 'POST', body: { cwd }, cookie });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const threadId = created.data.thread?.id;
  assert.ok(threadId);
  const renamed = await request(`/api/threads/${encodeURIComponent(threadId)}/rename`, { method: 'POST', body: { name: 'Web 重命名测试' }, cookie });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  const list = await request('/api/threads?limit=100', { cookie });
  const row = (list.data.data || []).find((item) => item.id === threadId);
  assert.equal(row?.name, 'Web 重命名测试');
  assert.equal(row?.preview, 'Web 重命名测试');
  await request('/api/control/release', { method: 'POST', body: { discardQueue: true }, cookie });
  console.log('THREAD_RENAME_TEST_OK api=true appServer=true');
} finally {
  if (child && child.exitCode == null) {
    try { child.kill(); } catch { }
    await delay(500);
    if (child.exitCode == null) { try { child.kill('SIGKILL'); } catch { } }
  }
  if (temp.startsWith(path.join(os.tmpdir(), 'cwr-thread-rename-'))) await fs.rm(temp, { recursive: true, force: true });
}
