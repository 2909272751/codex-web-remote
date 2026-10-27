import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { ThreadViews } from '../src/thread-view.mjs';
import { mergeItems, readRoute } from '../public/workspace-cache.js';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-experience-'));
const port = Number(process.env.CODEX_WEB_EXPERIENCE_PORT || 18991);
const base = `http://127.0.0.1:${port}`;
const id = 'aaaaaaaa-1111-4111-8111-111111111111';
const childId = 'bbbbbbbb-2222-4222-8222-222222222222';
const sessionRoot = path.join(temp, 'sessions'); await fs.mkdir(sessionRoot);
const record = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const sessionPath = path.join(sessionRoot, `rollout-${id}.jsonl`);
let content = record('session_meta', { id, cwd: root }) + record('turn_context', { turn_id: 'history', model: 'test-model', cwd: root });
for (let i = 0; i < 2400; i++) content += record('response_item', { id: `message-${i}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `历史 ${i}\n` + '这是用于长历史分页的内容。'.repeat(100) }] });
content += record('response_item', { id: 'tool-long', type: 'function_call', call_id: 'tool-long', name: 'shell_command', arguments: JSON.stringify({ command: 'Get-ChildItem', workdir: root }) });
content += record('response_item', { type: 'function_call_output', call_id: 'tool-long', output: 'command output\n'.repeat(100000) });
content += record('event_msg', { type: 'subAgentActivity', agentThreadId: childId, kind: 'started', agentPath: '测试子智能体', model: 'test-worker' });
await fs.writeFile(sessionPath, content);
await fs.writeFile(path.join(sessionRoot, `rollout-${childId}.jsonl`), record('session_meta', { id: childId, cwd: root, parent_thread_id: id }) + record('turn_context', { turn_id: 'child', model: 'test-worker' }) + record('event_msg', { type: 'agent_message', message: '子智能体的真实保存内容' }));
await fs.mkdir(path.join(temp, '.codex')); await fs.writeFile(path.join(temp, '.codex', 'session_index.jsonl'), record('', {}).slice(0, 0) + JSON.stringify({ id, thread_name: '长历史验收任务', updated_at: new Date().toISOString() }) + '\n');
await fs.writeFile(path.join(temp, 'desktop.json'), JSON.stringify({ running: false, processes: [] }));
const fakeSource = `import readline from 'node:readline'; import fs from 'node:fs';
if(process.argv.includes('--version')){ console.log('codex-cli 0.146.0-test'); process.exit(0); }
let currentTurn=null;const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}if(m.id===undefined)return;const p=m.params||{};const thread={id:p.threadId||'${id}',cwd:${JSON.stringify(root)},model:'test-model',preview:'长历史验收任务',turns:[],status:{type:currentTurn?'active':'idle'}};
let r={};if(m.method==='initialize')r={userAgent:'qa'};if(m.method==='model/list')r={data:[{id:'test-model',model:'test-model',displayName:'Test Model',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}]};if(m.method==='thread/list')r={data:[thread]};if(['thread/read','thread/resume','thread/start'].includes(m.method))r={thread};
if(m.method==='turn/start'){fs.appendFileSync(${JSON.stringify(path.join(temp, 'turn-calls.jsonl'))},JSON.stringify(p)+'\\n');currentTurn='qa-'+Date.now();r={turn:{id:currentTurn,status:'inProgress',items:[]}};setTimeout(()=>{send({method:'turn/started',params:{threadId:p.threadId,turn:{id:currentTurn}}});send({method:'item/completed',params:{threadId:p.threadId,item:{id:p.clientUserMessageId,type:'userMessage',content:p.input}}});},30);setTimeout(()=>{const turn={id:currentTurn,status:'completed',items:[{id:'answer-'+currentTurn,type:'agentMessage',text:'## 已收到\\n任务完成。'}]};currentTurn=null;send({method:'turn/completed',params:{threadId:p.threadId,turn}})},900)}
send({id:m.id,result:r})});`;
await fs.writeFile(path.join(temp, 'fake.mjs'), fakeSource);
await fs.writeFile(path.join(temp, 'fake.cmd'), `@echo off\r\n"${process.execPath}" "${path.join(temp, 'fake.mjs')}" %*\r\n`);
const child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, env: { ...process.env, USERPROFILE: temp, CODEX_WEB_PORT: String(port), CODEX_WEB_HOST: '127.0.0.1', CODEX_WEB_PASSWORD: 'experience-test-only', CODEX_WEB_CODEX_PATH: path.join(temp, 'fake.cmd'), CODEX_WEB_DATA_DIR: path.join(temp, 'data'), CODEX_WEB_SESSION_ROOT: sessionRoot, CODEX_WEB_UPLOAD_DIR: path.join(temp, 'uploads'), CODEX_WEB_SETTINGS_FILE: path.join(temp, 'settings.json'), CODEX_WEB_FRP_DATA_ROOT: path.join(temp, 'frp'), CODEX_WEB_TEST_MODE: '1', CODEX_WEB_TEST_DESKTOP_STATE_FILE: path.join(temp, 'desktop.json'), CODEX_WEB_AUTO_PREPARE: '0', CODEX_WEB_BROWSER_MCP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
let cookie = '';
const request = async (url, body, method = 'GET') => {
  const r = await fetch(`${base}${url}`, { method, headers: { Cookie: cookie, Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); return { status: r.status, data: JSON.parse(text || '{}'), bytes: Buffer.byteLength(text), cookie: r.headers.get('set-cookie') };
};
try {
  assert.deepEqual(readRoute('#task=a&project=b'), { threadId: 'a', projectId: 'b' });
  assert.deepEqual(mergeItems([{ id: 'a', text: 'old' }], [{ id: 'a', text: 'new' }, { id: 'b' }]), [{ id: 'a', text: 'new' }, { id: 'b' }]);
  for (let i = 0; i < 100; i++) { try { await fetch(`${base}/api/session`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const login = await request('/api/login', { password: 'experience-test-only' }, 'POST'); cookie = String(login.cookie).split(';')[0]; assert.equal(login.status, 200);
  const at = performance.now(); const page = await request(`/api/v2/threads/${id}/view?limit=60`); const pageMs = Math.round(performance.now() - at);
  assert.equal(page.status, 200); assert.equal(page.data.page.hasMore, true); assert(page.bytes < 300000, `page too large ${page.bytes}`); assert(page.data.thread.turns.flatMap(t => t.items).length <= 60);
  const earlier = await request(`/api/v2/threads/${id}/view?limit=60&before=${page.data.page.before}`); assert.equal(earlier.status, 200); assert(Number(earlier.data.page.before) < Number(page.data.page.before));
  const tool = page.data.thread.turns.flatMap(t => t.items).find(i => i.id === 'tool-long'); assert(tool.detailUrl); const detail = await request(tool.detailUrl); assert(detail.data.item.aggregatedOutput.length > 1000000);
  const ids = page.data.thread.turns.flatMap(t => t.items).map(i => i.id);
  await fs.appendFile(sessionPath, record('event_msg', { type: 'agent_message', message: '增量测试消息' }));
  const next = await request(`/api/v2/threads/${id}/view?limit=60`); assert(next.data.thread.turns.flatMap(t => t.items).some(i => i.text === '增量测试消息')); assert(next.data.thread.turns.flatMap(t => t.items).some(i => ids.includes(i.id)));
  const agents = await request(`/api/v2/threads/${id}/agents`); assert(agents.data.data.some(a => a.id === childId)); const agent = await request(`/api/v2/threads/${childId}/view`); assert(JSON.stringify(agent.data).includes('子智能体的真实保存内容'));
  const imageViews = new ThreadViews(); const image = imageViews.page({ id, turns: [{ id: 'imgturn', items: [{ id: 'img', type: 'mcpToolCall', result: { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(1000000).toString('base64') }] } }] }] }); assert(JSON.stringify(image).length < 3000); assert.equal(imageViews.assets.size, 1);
  const takeover = await request('/api/control/takeover', { force: false }, 'POST'); assert.equal(takeover.status, 200, JSON.stringify(takeover.data));
  const messageId = 'test-fixed-message-1111'; const payload = { text: '隔离测试提示', mode: 'auto', clientMessageId: messageId };
  const sent = await request(`/api/threads/${id}/messages`, payload, 'POST'); assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const again = await request(`/api/threads/${id}/messages`, payload, 'POST'); assert.deepEqual(sent.data, again.data);
  const conflict = await request(`/api/threads/${id}/messages`, { ...payload, text: '不同内容' }, 'POST'); assert.equal(conflict.status, 409);
  const calls = (await fs.readFile(path.join(temp, 'turn-calls.jsonl'), 'utf8')).trim().split('\n'); assert.equal(calls.length, 1);
  const receipt = await request(`/api/threads/${id}/submissions/${messageId}`); assert.equal(receipt.data.status, 'accepted');
  const uploadResponse = await fetch(`${base}/api/uploads?name=queue-test.txt&type=text%2Fplain`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('attachment fixture') });
  assert.equal(uploadResponse.status, 200); const upload = await uploadResponse.json();
  const queued = await request(`/api/threads/${id}/messages`, { text: '排队一', mode: 'queue', clientMessageId: 'test-queued-message-2222', attachmentIds: [upload.id] }, 'POST'); assert.equal(queued.data.queued, true);
  const edit = await request(`/api/threads/${id}/queue/${queued.data.item.id}`, { text: '排队已编辑' }, 'PATCH'); assert.equal(edit.status, 200);
  assert(edit.data.item.input[0].text.includes('queue-test.txt'), 'queue edit dropped its attachment');
  const ws = new WebSocket(`${base.replace('http', 'ws')}/events?since=0`, { headers: { Cookie: cookie } }); const events = []; ws.on('message', b => events.push(JSON.parse(b))); await once(ws, 'open'); await new Promise(r => setTimeout(r, 1600)); ws.close(); assert(events.find(e => e.type === 'hello')?.data.epoch); assert.equal(events[0].type, 'hello');
  const afterQueue = await request(`/api/threads/${id}/queue`); assert.equal(afterQueue.data.data.length, 0, 'queue did not continue');
  const queueCall = (await fs.readFile(path.join(temp, 'turn-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(queueCall.clientUserMessageId, queued.data.item.id); assert(queueCall.input[0].text.includes('queue-test.txt'));
  console.log(JSON.stringify({ result: 'EXPERIENCE_TEST_OK', sourceBytes: Buffer.byteLength(content), pageBytes: page.bytes, pageMs, pagination: true, incremental: true, details: true, agents: true, idempotent: true, queue: true, epoch: true }));
  if (process.argv.includes('--serve')) { console.log(`QA_UI_READY ${base}`); await new Promise(() => {}); }
} catch (error) { console.error(log.slice(-6000)); throw error; }
finally { child.kill(); await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 3000))]); }
