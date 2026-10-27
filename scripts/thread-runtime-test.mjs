import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-thread-runtime-'));
const profile = path.join(temp, 'user');
const codexHome = path.join(profile, '.codex');
const sessionRoot = path.join(codexHome, 'sessions', '2026', '10', '20');
const threadId = '019f0000-0000-7000-8000-000000000001';
const sessionFile = path.join(sessionRoot, `rollout-2026-10-20T20-00-00-${threadId}.jsonl`);
const dataDir = path.join(temp, 'data');
const boundPort = net.createServer();
await new Promise((resolve) => boundPort.listen(0, '127.0.0.1', resolve));
const port = boundPort.address().port;
await new Promise((resolve) => boundPort.close(resolve));
const base = `http://127.0.0.1:${port}`;
const password = 'thread-runtime-test-password';
let child = null;

try {
  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.mkdir(path.join(dataDir, 'thread-snapshots'), { recursive: true });
  const records = [
    { type: 'session_meta', payload: { cwd: 'C:\\work', model: 'gpt-test-model' } },
    { type: 'turn_context', payload: { turn_id: 'turn-1', cwd: 'C:\\work', model: 'gpt-test-model', effort: 'high', summary: 'auto', multi_agent_mode: 'explicitRequestOnly', multi_agent_version: 'v2' } },
    { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'event_msg', payload: { type: 'agent_reasoning', text: '这是可折叠的思考摘要' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '回复内容' } },
    { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ];
  await fs.writeFile(sessionFile, records.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({ id: threadId, thread_name: '重命名后的任务', updated_at: new Date().toISOString() }) + '\n', 'utf8');

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
  assert.ok(ready, `runtime test gateway did not start: ${stderr.slice(-1200)}`);

  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const view = await (await fetch(`${base}/api/v2/threads/${threadId}/view?limit=20`, { headers: { cookie } })).json();
  assert.equal(view.thread.preview, '重命名后的任务');
  assert.equal(view.threadSettings?.model, 'gpt-test-model');
  assert.equal(view.threadSettings?.effort, 'high');
  assert.equal(view.threadSettings?.summary, 'auto');
  assert.equal(view.threadSettings?.multiAgentMode, 'explicitRequestOnly');
  const items = view.thread.turns.flatMap((turn) => turn.items || []);
  assert.ok(items.some((item) => item.type === 'reasoning' && String(item.summary).includes('可折叠')));
  console.log('THREAD_RUNTIME_TEST_OK title=true settings=true reasoning=true');
} finally {
  if (child && child.exitCode == null) {
    try { child.kill(); } catch { }
    await delay(500);
    if (child.exitCode == null) { try { child.kill('SIGKILL'); } catch { } }
  }
  if (temp.startsWith(path.join(os.tmpdir(), 'cwr-thread-runtime-'))) await fs.rm(temp, { recursive: true, force: true });
}
