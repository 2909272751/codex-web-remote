import { execFile } from 'node:child_process';

function guardError(code, message) { return Object.assign(new Error(message), { code, status: 409 }); }
const pidOf = (p) => Number(p.pid ?? p.ProcessId);
const parentOf = (p) => Number(p.parentPid ?? p.ParentProcessId);
const started = (p) => Date.parse(p.startedAt ?? p.createdAt ?? p.CreationDate);
const nameOf = (p) => String(p.name ?? p.Name ?? '').toLowerCase();
const pathOf = (p) => String(p.executablePath ?? p.ExecutablePath ?? '').toLowerCase();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// process.kill(pid, 0) is the cheapest Windows liveness probe. EPERM means the
// process exists but belongs to another identity, which still counts as alive.
export function processIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

// Polling the exact PIDs is both faster and more accurate than re-reading the
// whole desktop process tree after every kill. The caller still performs one
// final full probe to catch a newly spawned process.
export async function waitForProcessesExit(pids, { timeoutMs = 5_000, intervalMs = 80 } = {}) {
  const unique = [...new Set((pids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!unique.length) return { exited: true, alive: [] };
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const alive = unique.filter(processIsAlive);
    if (!alive.length) return { exited: true, alive: [] };
    if (Date.now() >= deadline) return { exited: false, alive };
    await delay(Math.max(20, intervalMs));
  }
}

export function desktopLifecycleIsFresh({ timestamp, fileMtimeMs, processStartedAt, checkedAt = Date.now(), freshnessMs = 120_000 }) {
  const eventAt = Date.parse(timestamp);
  const fileFresh = checkedAt - fileMtimeMs <= freshnessMs;
  // A long-running turn is still active while its rollout keeps changing.
  // Only use event age when the owning desktop start time is unavailable.
  const eventFresh = !Number.isFinite(eventAt) || (Number.isFinite(processStartedAt)
    ? eventAt >= processStartedAt - 10_000 : checkedAt - eventAt <= freshnessMs);
  return fileFresh && eventFresh;
}

// Pure planning is shared by production and real-process regression tests.
// A PID is never treated as an identity without its name/path/start time.
export function planDesktopTermination({ processes, desktopProcesses, selfPid = process.pid }) {
  const byId = new Map(processes.map(p => [pidOf(p), p]));
  if (!byId.has(selfPid)) throw guardError('WEB_PROCESS_GUARD_UNAVAILABLE', '无法确认 Web 网关身份，已取消关闭桌面；请从托盘独立重启 Web 服务');
  const isChild = (child, parent) => {
    const c = started(child), p = started(parent);
    return parentOf(child) === pidOf(parent) && (!Number.isFinite(c) || !Number.isFinite(p) || p <= c);
  };
  const ancestry = []; let at = byId.get(selfPid); const visited = new Set();
  while (at && !visited.has(pidOf(at))) {
    visited.add(pidOf(at)); ancestry.push(pidOf(at));
    const parent = byId.get(parentOf(at)); at = parent && isChild(at, parent) ? parent : null;
  }
  const roots = [];
  for (const expected of desktopProcesses) {
    const actual = byId.get(pidOf(expected)); if (!actual) continue;
    if (nameOf(expected) !== nameOf(actual) || (pathOf(expected) && pathOf(expected) !== pathOf(actual)) ||
        (Number.isFinite(started(expected)) && started(expected) !== started(actual))) {
      throw guardError('DESKTOP_PROCESS_CHANGED', '桌面进程已变化，已取消关闭；请稍后重试接管');
    }
    roots.push(actual);
  }
  if (roots.some(p => ancestry.includes(pidOf(p)))) {
    throw guardError('WEB_HOSTED_BY_DESKTOP', 'Web 服务依附于桌面 Codex，关闭桌面会中断网页；已安全取消接管，请从开始菜单或托盘独立重启 Web 服务');
  }
  const targets = new Map();
  const collect = (p, depth) => {
    if (targets.has(pidOf(p))) return;
    targets.set(pidOf(p), { ...p, depth });
    for (const child of processes) if (pidOf(child) !== pidOf(p) && isChild(child, p)) collect(child, depth + 1);
  };
  roots.forEach(p => collect(p, 0));
  if (ancestry.some(id => targets.has(id))) throw guardError('WEB_HOSTED_BY_DESKTOP', '关闭目标包含 Web 服务自身，已取消接管');
  if ([...targets.values()].some(p => !Number.isFinite(started(p)))) throw guardError('WEB_PROCESS_GUARD_UNAVAILABLE', '无法核验目标进程启动时间，已安全取消接管');
  return { ancestry, roots: roots.map(pidOf), targets: [...targets.values()].sort((a, b) => b.depth - a.depth).map(p => ({
    pid: pidOf(p), parentPid: parentOf(p), name: p.name ?? p.Name, executablePath: p.executablePath ?? p.ExecutablePath ?? '',
    startedAt: new Date(started(p)).toISOString(),
  })) };
}

export function runWindowsScript(script, { timeout = 20_000 } = {}) {
  const wrapped = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); try { & { ${script}\n } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')],
    { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(-2000))); else resolve(String(stdout).trim());
    }));
}

export async function readWindowsProcessTable() {
  const output = await runWindowsScript(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
@(Get-CimInstance Win32_Process | ForEach-Object { $stamp=$null; if($_.CreationDate){$stamp=$_.CreationDate.ToUniversalTime().ToString('o')}; [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=$_.Name; executablePath=$_.ExecutablePath; startedAt=$stamp } }) | ConvertTo-Json -Depth 3 -Compress`);
  const value = JSON.parse(output || '[]'); return Array.isArray(value) ? value : [value];
}

export async function terminateDesktopProcesses(desktopProcesses, { selfPid = process.pid, onPlan = () => {} } = {}) {
  const plan = planDesktopTermination({ processes: await readWindowsProcessTable(), desktopProcesses, selfPid });
  await onPlan(plan);
  if (!plan.targets.length) return plan;
  const encoded = Buffer.from(JSON.stringify(plan.targets)).toString('base64');
  // Revalidate EVERY target before touching ANY target. Never use taskkill /T:
  // it follows PID ancestry without our identity/protected-process checks.
  // One process-table query keeps the safety check without paying for a CIM
  // round trip per target (desktop Codex can have 10-20 child processes).
  await runWindowsScript(`$ErrorActionPreference='Stop'
$targets=ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))
$wanted=@($targets | ForEach-Object { [int]$_.pid })
$actualById=@{}
foreach($actual in @(Get-CimInstance Win32_Process | Where-Object { $wanted -contains [int]$_.ProcessId })){
  $actualById[[int]$actual.ProcessId]=$actual
}
$checked=@()
foreach($target in $targets){
  $actual=$actualById[[int]$target.pid]
  if(-not $actual){continue}
  # JSON timestamps are compared at millisecond precision, matching JS Dates.
  $sameStart=[Math]::Abs((([datetime]$actual.CreationDate).ToUniversalTime()-([datetime]$target.startedAt).ToUniversalTime()).TotalMilliseconds) -lt 1
  if($actual.Name -ine $target.name -or ($target.executablePath -and $actual.ExecutablePath -ine $target.executablePath) -or -not $sameStart){throw 'Process identity changed; no processes were terminated.'}
  $checked+=[int]$target.pid
}
if($checked.Count -gt 0){Stop-Process -Id $checked -Force -ErrorAction SilentlyContinue}
'closed'`);
  return plan;
}
