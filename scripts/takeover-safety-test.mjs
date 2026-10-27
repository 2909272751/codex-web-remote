import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { planDesktopTermination, readWindowsProcessTable, terminateDesktopProcesses, desktopLifecycleIsFresh } from '../src/windows-process-control.mjs';

const now = Date.now();
assert(desktopLifecycleIsFresh({ timestamp: new Date(now - 900_000).toISOString(), processStartedAt: now - 1800_000, fileMtimeMs: now, checkedAt: now }), 'active long turns must not be killed');
assert(!desktopLifecycleIsFresh({ timestamp: new Date(now - 900_000).toISOString(), processStartedAt: now - 1800_000, fileMtimeMs: now - 900_000, checkedAt: now }), 'quiet stale markers must not block forever');
assert(!desktopLifecycleIsFresh({ timestamp: new Date(now - 900_000).toISOString(), processStartedAt: NaN, fileMtimeMs: now, checkedAt: now }), 'unknown owner still needs a recent timestamp');
const p = (pid, parentPid, name = 'node.exe', offset = 0) => ({ pid, parentPid, name, executablePath: `C:\\fixture\\${name}`, startedAt: new Date(now + offset).toISOString() });
const tree = [p(1, 0, 'shell.exe', -100), p(2, 1, 'ChatGPT.exe', -90), p(3, 2, 'node.exe', -80), p(4, 3, 'node.exe', -70), p(5, 1, 'node.exe', -60)];
assert.throws(() => planDesktopTermination({ processes: tree, desktopProcesses: [tree[1]], selfPid: 4 }), e => e.code === 'WEB_HOSTED_BY_DESKTOP');
assert.deepEqual(planDesktopTermination({ processes: tree, desktopProcesses: [tree[1]], selfPid: 5 }).targets.map(p => p.pid), [4, 3, 2]);
assert.throws(() => planDesktopTermination({ processes: tree, desktopProcesses: [{ ...tree[1], startedAt: new Date(now - 5000).toISOString() }], selfPid: 5 }), e => e.code === 'DESKTOP_PROCESS_CHANGED');
// Reused parent PID must not make an older independent service a descendant.
const reused = [p(2, 1, 'ChatGPT.exe', 50), p(3, 2, 'node.exe', -50), p(5, 1, 'node.exe', -100)];
assert.deepEqual(planDesktopTermination({ processes: reused, desktopProcesses: [reused[0]], selfPid: 3 }).targets.map(p => p.pid), [2]);
if (process.platform !== 'win32') { console.log('TAKEOVER_SAFETY_PURE_OK windows=skipped'); process.exit(0); }

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-process-safety-'));
const fixture = path.join(root, 'scripts', 'fixtures', 'desktop-process-fixture.mjs');
const stateFile = path.join(temp, 'tree.json');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = async (check, ms = 15000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { const value = await check().catch(() => false); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw new Error('Fixture timed out'); };
const readState = file => fs.readFile(file, 'utf8').then(JSON.parse);
let desktop, host, jobState;
try {
  desktop = spawn(process.execPath, [fixture, stateFile], { windowsHide: true, stdio: 'ignore' });
  const state = await wait(() => readState(stateFile)); await wait(() => readState(`${stateFile}.child`));
  const table = await readWindowsProcessTable(); const snapshot = table.find(p => p.pid === state.pid); assert(snapshot);
  await assert.rejects(terminateDesktopProcesses([snapshot], { selfPid: state.childPid }), e => e.code === 'WEB_HOSTED_BY_DESKTOP');
  assert(alive(state.pid) && alive(state.childPid), 'unsafe refusal killed a fixture');
  const closed = await terminateDesktopProcesses([snapshot]); assert(closed.targets.some(p => p.pid === state.childPid));
  await wait(async () => !alive(state.pid) && !alive(state.childPid)); desktop = null;

  const jobFile = path.join(temp, 'job.json'); let hostError = '';
  host = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-File',path.join(root,'scripts','fixtures','kill-on-close-host.ps1'),'-Node',process.execPath,'-Fixture',fixture,'-Helper',path.join(root,'scripts','start-independent.ps1'),'-StateFile',jobFile], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  host.stderr.on('data', b => { hostError += b; });
  try { jobState = await wait(() => readState(jobFile), 25000); } catch (e) { throw new Error(`${e.message}: ${hostError}`); }
  assert(alive(jobState.normalPid) && alive(jobState.independentPid));
  // Kill only our disposable host. Windows Job cleanup, not a mocked kill,
  // must terminate its normal child but preserve the broker-launched child.
  process.kill(jobState.hostPid); await wait(async () => !alive(jobState.normalPid));
  assert(alive(jobState.independentPid), 'independent process died with its host Job');
  const after = await readWindowsProcessTable(); const independent = after.find(p => p.pid === jobState.independentPid);
  const plan = planDesktopTermination({ processes: after, desktopProcesses: [independent] });
  assert(!plan.ancestry.includes(jobState.hostPid));
  await terminateDesktopProcesses([independent]);
  console.log(JSON.stringify({ result: 'TAKEOVER_SAFETY_TEST_OK', unsafeAncestorRefused: true, exactTreeClosed: true, pidReuseSafe: true, realKillOnCloseJob: true, independentChildSurvived: true, broker: jobState.broker, sessionId: jobState.sessionId }));
} finally {
  if (desktop && alive(desktop.pid)) { const table = await readWindowsProcessTable(); await terminateDesktopProcesses(table.filter(p => p.pid === desktop.pid)).catch(() => {}); }
  if (host && alive(host.pid)) process.kill(host.pid);
  if (jobState && alive(jobState.independentPid)) { const table = await readWindowsProcessTable(); await terminateDesktopProcesses(table.filter(p => p.pid === jobState.independentPid)).catch(() => {}); }
  // Only this test-created, absolute temp directory is removed.
  if (temp.startsWith(path.join(os.tmpdir(), 'cwr-process-safety-'))) await fs.rm(temp, { recursive: true, force: true });
}
