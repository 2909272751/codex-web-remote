import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { CodexClient } from "./src/codex-client.mjs";
import { canAutoYieldToDesktop } from "./src/control-policy.mjs";
import { buildServerRequestResponse } from "./src/server-request.mjs";
import { TerminalSession } from "./src/terminal-session.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(process.env.CODEX_WEB_ENV_FILE ? path.resolve(process.env.CODEX_WEB_ENV_FILE) : path.join(root, ".env.local"));

const host = process.env.CODEX_WEB_HOST || "127.0.0.1";
const port = Number(process.env.CODEX_WEB_PORT || 18888);
const password = process.env.CODEX_WEB_PASSWORD;
const secureCookie = process.env.CODEX_WEB_SECURE_COOKIE === "1";
const sessionMs = Math.max(1, Number(process.env.CODEX_WEB_SESSION_HOURS || 24)) * 3600_000;
const dataDir = process.env.CODEX_WEB_DATA_DIR ? path.resolve(process.env.CODEX_WEB_DATA_DIR) : path.join(root, ".runtime-data");
const queueFile = path.join(dataDir, "queues.json");
const threadCacheFile = path.join(dataDir, "threads.json");
const threadSnapshotDir = path.join(dataDir, "thread-snapshots");
const sessionFile = path.join(dataDir, "sessions.json");
const projectFile = path.join(dataDir, "projects.json");
const controlAuditFile = path.join(dataDir, "control-audit.jsonl");
const accountUsageHistoryFile = path.join(dataDir, "account-usage-history.json");
const accountUsageSnapshotFile = path.join(dataDir, "account-usage-snapshot.json");
const updateRequestFile = process.env.CODEX_WEB_UPDATE_REQUEST_FILE ? path.resolve(process.env.CODEX_WEB_UPDATE_REQUEST_FILE) : "";
const launcherPath = process.env.CODEX_WEB_LAUNCHER_PATH ? path.resolve(process.env.CODEX_WEB_LAUNCHER_PATH) : "";
const updateApiUrl = process.env.CODEX_WEB_UPDATE_API || "https://api.github.com/repos/2909272751/codex-web-remote/releases/latest";
const updatePageUrl = process.env.CODEX_WEB_UPDATE_PAGE || "https://github.com/2909272751/codex-web-remote/releases/latest";
const currentVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0";
const sessionIndexFile = path.join(process.env.USERPROFILE || root, ".codex", "session_index.jsonl");
const sessionRoot = process.env.CODEX_WEB_SESSION_ROOT ? path.resolve(process.env.CODEX_WEB_SESSION_ROOT) : path.join(process.env.USERPROFILE || root, ".codex", "sessions");
const uploadDir = process.env.CODEX_WEB_UPLOAD_DIR ? path.resolve(process.env.CODEX_WEB_UPLOAD_DIR) : path.join(process.env.USERPROFILE || root, ".codex", "web-uploads");
const launcherSettingsFile = process.env.CODEX_WEB_SETTINGS_FILE
  ? path.resolve(process.env.CODEX_WEB_SETTINGS_FILE)
  : path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || root, "AppData", "Local"), "CodexWebRemote", "settings.json");
const testMode = process.env.CODEX_WEB_TEST_MODE === "1";
const testDesktopStateFile = testMode && process.env.CODEX_WEB_TEST_DESKTOP_STATE_FILE ? path.resolve(process.env.CODEX_WEB_TEST_DESKTOP_STATE_FILE) : "";
const testDropTurnCompleted = testMode && process.env.CODEX_WEB_TEST_DROP_TURN_COMPLETED === "1";
const defaultFullAccess = process.env.CODEX_WEB_DEFAULT_FULL_ACCESS !== "0";
let testDropTurnCompletedRemaining = testDropTurnCompleted ? 1 : 0;

process.on("unhandledRejection", (error) => {
  console.error("unhandled rejection", error);
});
process.on("uncaughtException", (error) => {
  console.error("uncaught exception", error);
});

if (!password || password.length < 8) {
  console.error("CODEX_WEB_PASSWORD must contain at least 8 characters.");
  process.exit(1);
}

await fsp.mkdir(dataDir, { recursive: true });
await fsp.mkdir(uploadDir, { recursive: true });
await fsp.mkdir(threadSnapshotDir, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "512kb" }));

const sessions = new Map(Object.entries(await loadJson(sessionFile, {})));
const attempts = new Map();
const sockets = new Set();
const uploads = new Map();
const queues = await loadJson(queueFile, {});
let projectStore = normalizeProjectStore(await loadJson(projectFile, { projects: [], hiddenPaths: [] }));
let accountUsageHistory = normalizeAccountUsageHistory(await loadJson(accountUsageHistoryFile, { samples: [] }));
let accountUsageSnapshot = await loadJson(accountUsageSnapshotFile, null);
const activeTurns = new Map();
const threadActivities = new Map();
const threadStatuses = new Map();
const threadSettings = new Map();
const threadTokenUsage = new Map();
const tokenUsageBaselines = new Map();
const turnPlans = new Map();
const turnDiffs = new Map();
const pendingApprovals = new Map();
const readonlyThreadCache = new Map();
const threadSnapshotCache = new Map();
const readonlyThreadRequests = new Map();
const desktopLiveFiles = new Map();
const desktopLivePending = new Map();
const desktopLiveSnapshotTimers = new Map();
const threadActivationRequests = new Map();
const queueWorkers = new Set();
const queueRetryTimers = new Map();
const threadSubmissions = new Set();
const codex = new CodexClient();
const terminal = new TerminalSession();
let terminalControllerToken = null;
let fullAccess = defaultFullAccess;
let mode = "desktop";
let transition = false;
let takeoverState = { phase: "idle", message: "", startedAt: 0, updatedAt: Date.now(), processes: [] };
let lastThreadId = null;
let resetCreditInFlight = false;
let updateCache = null;
let eventSeq = 0;
let desktopConflictCheckInFlight = false;
let desktopSessionWatcher = null;
let readonlyAccountUsageRequest = null;
let localSessionUsageCache = null;
let lastControlAudit = await loadLastJsonLine(controlAuditFile);
const eventBuffer = [];
const eventBufferLimit = 1_000;
const atomicJsonWrites = new Map();
const resolvedSessionRoot = path.resolve(sessionRoot);

setInterval(cleanup, 60_000).unref();
setInterval(() => broadcast({ type: "heartbeat", data: { at: Date.now() } }, false), 15_000).unref();
setInterval(() => { if (mode === "web" && codex.ready) for (const threadId of Object.keys(queues)) if (queues[threadId]?.length) scheduleQueue(threadId, 0); }, 3000).unref();
setInterval(() => { void reconcileDesktopConflict(); }, 5000).unref();
// Keep a lightweight account-level sample while the gateway is active. This is
// deliberately separate from per-turn token events, which only describe work
// that passed through this gateway.
setInterval(() => { if (mode === "web" && codex.ready) void sampleAccountUsage(); }, 15 * 60_000).unref();
setInterval(() => { if (mode === "desktop" && sockets.size) void pollDesktopLiveFiles(); }, 2_500).unref();
startDesktopLiveWatcher();

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});

app.post("/api/login", asyncRoute(async (req, res) => {
  const ip = clientIp(req);
  const state = attempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60_000 };
  if (state.resetAt <= Date.now()) Object.assign(state, { count: 0, resetAt: Date.now() + 15 * 60_000 });
  if (state.count >= 8) return res.status(429).json({ error: "尝试次数过多，请稍后再试" });
  if (!safeEqual(String(req.body?.password || ""), password)) {
    state.count += 1; attempts.set(ip, state);
    return res.status(401).json({ error: "密码错误" });
  }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(sessionKey(token), { expiresAt: Date.now() + sessionMs });
  await saveSessions();
  res.setHeader("Set-Cookie", cookieHeader(token));
  res.json({ ok: true, version: currentVersion });
}));

app.post("/api/logout", requireAuth, requireSameOrigin, asyncRoute(async (req, res) => {
  if (terminalControllerToken === req.sessionToken) { terminalControllerToken = null; broadcastState(); }
  sessions.delete(sessionKey(req.sessionToken));
  await saveSessions();
  res.setHeader("Set-Cookie", cookieHeader("", 0));
  res.json({ ok: true });
}));

app.get("/api/session", (req, res) => {
  const session = getSession(req);
  res.json({ authenticated: Boolean(session), codexReady: codex.ready, mode, version: currentVersion });
});

app.get("/api/control/status", requireAuth, asyncRoute(async (req, res) => {
  const desktop = await inspectDesktopProcesses();
  res.json({
    mode, transition, takeoverState, fullAccess, terminal: terminal.status(), desktopRunning: desktop.running, desktopProcesses: desktop.processes, codexReady: codex.ready,
    controller: mode === "web" || (mode === "terminal" && terminalControllerToken === req.sessionToken),
    controllerBusy: mode === "terminal" && Boolean(terminalControllerToken && terminalControllerToken !== req.sessionToken),
    sharedWebControl: mode === "web",
    webClientCount: sockets.size,
    activeTurns: Object.fromEntries(activeTurns),
    activities: Object.fromEntries(threadActivities),
    threadStatuses: Object.fromEntries(threadStatuses),
    threadSettings: Object.fromEntries(threadSettings),
    threadTokenUsage: Object.fromEntries(threadTokenUsage),
    turnPlans: Object.fromEntries(turnPlans),
    turnDiffs: Object.fromEntries(turnDiffs),
    pendingRequests: [...pendingApprovals.values()],
    queuedByThread: Object.fromEntries(Object.entries(queues).map(([id, list]) => [id, list.length])),
    queuedCount: Object.values(queues).reduce((sum, list) => sum + list.length, 0),
    lastThreadId, lastControlAudit,
  });
}));

app.post("/api/control/takeover", requireAuth, requireSameOrigin, asyncRoute(async (req, res) => {
  await recordControlAudit("takeover-requested", req, { force: Boolean(req.body?.force) });
  if (transition) return res.status(409).json({ error: "正在切换状态" });
  if (mode === "web" && codex.ready) {
    await recordControlAudit("takeover-shared", req);
    return res.json({ ok: true, alreadyControlled: true, shared: true });
  }
  transition = true; setTakeoverState("checking", "正在检查桌面 Codex");
  try {
    const desktop = await inspectDesktopProcesses();
    const activity = await inspectDesktopActivity(desktop);
    if (activity.running) {
      setTakeoverState("busy", "桌面 Codex 有任务正在运行，请稍后重试", desktop.processes);
      return res.status(409).json({ error: "桌面 Codex 有任务正在运行，请稍后重试", code: "DESKTOP_BUSY", activity });
    }
    await closeDesktop(true, true, desktop);
    setTakeoverState("starting", "正在启动 Web Codex 后端");
    await codex.start();
    setTakeoverState("verifying", "正在验证任务列表");
    const probe = await codex.request("thread/list", { limit: 1, sortKey: "recency_at", sortDirection: "desc", archived: false, modelProviders: [], sourceKinds: null });
    if (!probe || !Array.isArray(probe.data)) throw new Error("Codex 后端健康检查失败");
    terminalControllerToken = null;
    mode = "web";
    setTakeoverState("ready", "接管成功");
    await recordControlAudit("takeover-completed", req);
    res.json({ ok: true });
  } catch (error) {
    setTakeoverState("failed", error.message || "接管失败");
    mode = (await inspectDesktopProcesses()).running ? "desktop" : "available";
    await recordControlAudit("takeover-failed", req, { error: error.message || "接管失败" });
    throw error;
  } finally { transition = false; broadcastState(); }
}));

app.post("/api/control/release", requireAuth, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  await recordControlAudit("release-requested", req);
  if (transition) return res.status(409).json({ error: "正在切换状态" });
  if (mode === "web" && (activeTurns.size || threadSubmissions.size)) return res.status(409).json({ error: "仍有任务正在运行或启动，请等待或中断" });
  const queued = Object.values(queues).reduce((sum, list) => sum + list.length, 0);
  if (queued && !req.body?.discardQueue) return res.status(409).json({ error: `还有 ${queued} 条排队消息` });
  transition = true; broadcastState();
  try {
    if (req.body?.discardQueue) { for (const key of Object.keys(queues)) delete queues[key]; await saveQueues(); }
    if (mode === "terminal") terminal.stop(); else await codex.stop();
    fullAccess = defaultFullAccess;
    mode = "desktop";
    terminalControllerToken = null;
    await launchDesktop(String(req.body?.threadId || lastThreadId || ""));
    await recordControlAudit("release-completed", req);
    res.json({ ok: true });
  } finally { transition = false; broadcastState(); }
}));

app.post("/api/terminal/start", requireAuth, requireSameOrigin, asyncRoute(async (req, res) => {
  if (transition) return res.status(409).json({ error: "正在切换状态" });
  if (terminalControllerToken && !isSessionTokenActive(terminalControllerToken)) terminalControllerToken = null;
  if (mode === "terminal" && terminalControllerToken && terminalControllerToken !== req.sessionToken) return res.status(409).json({ error: "另一个浏览器正在使用终端" });
  transition = true; setTakeoverState("checking", "正在检查桌面 Codex");
  try {
    const desktop = await inspectDesktopProcesses();
    const activity = await inspectDesktopActivity(desktop);
    if (activity.running) { setTakeoverState("busy", "桌面 Codex 有任务正在运行，请稍后重试", desktop.processes); return res.status(409).json({ error: "桌面 Codex 有任务正在运行，请稍后重试", code: "DESKTOP_BUSY", activity }); }
    await closeDesktop(true, true, desktop);
    if (codex.ready) await codex.stop();
    activeTurns.clear(); threadActivities.clear();
    setTakeoverState("starting", "正在启动官方 Codex CLI");
    terminalControllerToken = req.sessionToken; mode = "terminal";
    const selected = (await readThreadPreviews()).find((item) => item.id === String(req.body?.threadId || ""));
    terminal.start({ threadId: selected?.id || "", cwd: selected?.cwd || root, cols: Number(req.body?.cols || 120), rows: Number(req.body?.rows || 34) });
    setTakeoverState("ready", "Codex CLI 已连接"); res.json({ ok: true, terminal: terminal.status() });
  } catch (error) { setTakeoverState("failed", error.message); mode = (await inspectDesktopProcesses()).running ? "desktop" : "available"; throw error; }
  finally { transition = false; broadcastState(); }
}));

app.post("/api/control/full-access", requireAuth, requireController, requireSameOrigin, (req, res) => {
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "缺少权限模式" });
  fullAccess = req.body.enabled;
  broadcastState();
  res.json({ ok: true, fullAccess });
});

app.get("/api/status", requireAuth, (req, res) => res.json({ ready: codex.ready, mode, stderr: codex.stderrTail.slice(-10) }));

app.get("/api/update/status", requireAuth, asyncRoute(async (req, res) => {
  const force = String(req.query?.force || "") === "1";
  const release = await latestRelease(force);
  res.json({ currentVersion, ...release, updaterAvailable: Boolean(updateRequestFile) });
}));

app.post("/api/update/apply", requireAuth, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  if (!updateRequestFile) return res.status(409).json({ error: "当前不是 EXE 托盘版，无法一键更新" });
  if (activeTurns.size || threadSubmissions.size) return res.status(409).json({ error: "仍有任务正在运行或启动，请完成后再更新" });
  const queued = Object.values(queues).reduce((sum, list) => sum + list.length, 0);
  if (queued) return res.status(409).json({ error: `还有 ${queued} 条排队消息，请处理后再更新` });
  const release = await latestRelease(true);
  if (!release.updateAvailable) return res.status(409).json({ error: "当前已是最新版" });
  await atomicJson(updateRequestFile, { requestedAt: Date.now(), tagName: release.latestVersion });
  broadcast({ type: "hostUpdate", data: { phase: "requested", version: release.latestVersion } });
  res.status(202).json({ ok: true, version: release.latestVersion, message: "主机正在下载更新，服务稍后会自动重启" });
}));

app.get("/api/projects", requireAuth, asyncRoute(async (req, res) => {
  res.json({ data: await projectCatalog() });
}));

app.post("/api/projects", requireAuth, requireSameOrigin, asyncRoute(async (req, res) => {
  const requestedPath = String(req.body?.path || "").trim();
  if (!requestedPath || !path.isAbsolute(requestedPath)) return res.status(400).json({ error: "请输入这台电脑上的完整文件夹路径" });
  const target = normalizeProjectPath(requestedPath);
  let stat;
  try { stat = await fsp.stat(target); } catch { return res.status(404).json({ error: "找不到这个文件夹，请检查路径" }); }
  if (!stat.isDirectory()) return res.status(400).json({ error: "所选路径不是文件夹" });

  const key = projectPathKey(target);
  const requestedName = String(req.body?.name || "").trim().slice(0, 80);
  let project = projectStore.projects.find((item) => projectPathKey(item.path) === key);
  if (project) {
    if (requestedName) project.name = requestedName;
    project.updatedAt = Date.now();
  } else {
    project = { id: crypto.randomUUID(), name: requestedName || projectDisplayName(target), path: target, createdAt: Date.now(), updatedAt: Date.now() };
    projectStore.projects.unshift(project);
  }
  projectStore.hiddenPaths = projectStore.hiddenPaths.filter((item) => item !== key);
  await saveProjects();
  res.json({ project: { ...project, saved: true } });
}));

app.delete("/api/projects/:id", requireAuth, requireSameOrigin, asyncRoute(async (req, res) => {
  const catalog = await projectCatalog();
  const project = catalog.find((item) => item.id === req.params.id);
  if (!project) return res.status(404).json({ error: "找不到这个项目" });
  const key = projectPathKey(project.path);
  projectStore.projects = projectStore.projects.filter((item) => projectPathKey(item.path) !== key);
  if (!projectStore.hiddenPaths.includes(key)) projectStore.hiddenPaths.push(key);
  await saveProjects();
  res.json({ ok: true });
}));

app.get("/api/directories", requireAuth, asyncRoute(async (req, res) => {
  const requestedPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (!requestedPath) {
    const roots = process.platform === "win32"
      ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`).filter((drive) => fs.existsSync(drive))
      : [path.parse(root).root];
    return res.json({ current: "", parent: null, entries: roots.map((item) => ({ name: item, path: item })) });
  }
  if (!path.isAbsolute(requestedPath)) return res.status(400).json({ error: "目录路径必须是完整路径" });
  const target = normalizeProjectPath(requestedPath);
  let stat;
  try { stat = await fsp.stat(target); } catch { return res.status(404).json({ error: "找不到这个目录" }); }
  if (!stat.isDirectory()) return res.status(400).json({ error: "所选路径不是目录" });
  let entries;
  try {
    entries = (await fsp.readdir(target, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }))
      .slice(0, 300)
      .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }));
  } catch { return res.status(403).json({ error: "没有权限读取这个目录" }); }
  const parent = path.dirname(target) === target ? "" : path.dirname(target);
  res.json({ current: target, parent, entries });
}));

app.get("/api/threads", requireAuth, requireWebMode, asyncRoute(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const result = await codex.request("thread/list", {
    limit, sortKey: "recency_at", sortDirection: "desc",
    archived: false, modelProviders: [], sourceKinds: null,
  });
  const liveThreads = result.data || [];
  await saveThreadCache(liveThreads);
  const merged = new Map((await readThreadPreviews()).map((thread) => [thread.id, thread]));
  for (const thread of liveThreads) {
    if (thread?.id) merged.set(thread.id, { ...merged.get(thread.id), ...thread });
  }
  const data = [...merged.values()].sort((left, right) => threadTime(right) - threadTime(left)).slice(0, limit);
  res.json({ ...result, data });
}));

app.post("/api/threads", requireAuth, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  const requestedPath = String(req.body?.cwd || "").trim();
  if (!requestedPath || !path.isAbsolute(requestedPath)) return res.status(400).json({ error: "请先选择一个项目文件夹" });
  const cwd = normalizeProjectPath(requestedPath);
  let stat;
  try { stat = await fsp.stat(cwd); } catch { return res.status(404).json({ error: "项目文件夹不存在，请重新添加" }); }
  if (!stat.isDirectory()) return res.status(400).json({ error: "项目路径不是文件夹" });
  const params = { cwd, ...(testMode ? { ephemeral: true } : {}), ...threadStartOverrides(req.body), ...threadPermissionOverrides() };
  const result = await codex.request("thread/start", params);
  if (result.thread?.id) { lastThreadId = result.thread.id; await mergeThreadCache(result.thread); }
  res.json(result);
}));

app.get("/api/models", requireAuth, requireWebMode, asyncRoute(async (req, res) => {
  res.json(await codex.request("model/list", { includeHidden: false }));
}));

app.get("/api/account/usage", requireAuth, asyncRoute(async (req, res) => {
  const accountKey = await currentAccountUsageKey();
  const bucket = setActiveUsageAccount(accountKey);
  const localSessionUsage = await readLocalSessionTokenUsage(accountKey, bucket);
  void atomicJson(accountUsageHistoryFile, accountUsageHistory).catch(() => {});
  if (mode === "web" && codex.ready) {
    const rateLimits = await codex.request("account/rateLimits/read", null);
    let usage = null;
    try { usage = await codex.request("account/usage/read", null); } catch { }
    if (usage) await recordAccountUsageSample(usage, accountKey);
    await saveAccountUsageSnapshot(rateLimits, usage);
    return res.json({ rateLimits, usage, history: accountScopedUsageHistory(accountKey, localSessionUsage), live: true, cachedAt: accountUsageSnapshot?.cachedAt || Date.now() });
  }
  if (!accountUsageSnapshot?.rateLimits) return res.status(409).json({ error: "尚无可显示的额度快照；首次接管后会自动保存，之后可在只读模式查看。" });
  res.json({ ...accountUsageSnapshot, history: accountScopedUsageHistory(accountKey, localSessionUsage), live: false });
}));

app.get("/api/accounts", requireAuth, asyncRoute(async (req, res) => {
  const result = await runAccountSwitcher(["--account-switch-list"]);
  res.json({ profiles: Array.isArray(result.profiles) ? result.profiles : [] });
}));

app.post("/api/accounts/activate", requireAuth, requireSameOrigin, asyncRoute(async (req, res) => {
  const profileId = String(req.body?.profileId || "");
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(profileId)) return res.status(400).json({ error: "\u8d26\u53f7\u6863\u6848\u6807\u8bc6\u65e0\u6548" });
  if (transition) return res.status(409).json({ error: "\u5f53\u524d\u6b63\u5728\u5207\u6362\u72b6\u6001\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5" });
  const queued = Object.values(queues).reduce((sum, list) => sum + list.length, 0);
  if (activeTurns.size || threadSubmissions.size || pendingApprovals.size || queued) return res.status(409).json({ error: "\u8bf7\u5148\u5b8c\u6210\u3001\u505c\u6b62\u6216\u6e05\u7a7a\u6b63\u5728\u8fd0\u884c\u7684\u4efb\u52a1\u3001\u5ba1\u6279\u548c\u6392\u961f\u6d88\u606f\uff0c\u518d\u5207\u6362\u8d26\u53f7" });
  const desktop = await inspectDesktopProcesses();
  const desktopActivity = await inspectDesktopActivity(desktop);
  if (desktopActivity.running) return res.status(409).json({ error: "\u684c\u9762 Codex \u6709\u4efb\u52a1\u6b63\u5728\u8fd0\u884c\uff0c\u8bf7\u7a0d\u540e\u518d\u5207\u6362\u8d26\u53f7", code: "DESKTOP_BUSY", activity: desktopActivity });
  transition = true;
  setTakeoverState("switching-account", "\u6b63\u5728\u5207\u6362\u8d26\u53f7\u5e76\u91cd\u542f Web Codex \u670d\u52a1\u2026", desktop.processes || []);
  broadcastState();
  try {
    await codex.stop().catch(() => {});
    if (desktop.running) {
      const closed = await closeDesktop(false, false, desktop);
      if (!closed.closed) throw httpError(409, "\u684c\u9762 Codex \u6682\u65f6\u65e0\u6cd5\u81ea\u52a8\u5173\u95ed\uff0c\u8bf7\u624b\u52a8\u5173\u95ed\u540e\u518d\u5207\u6362\u8d26\u53f7");
    }
    const result = await runAccountSwitcher(["--account-switch-activate", profileId]);
    accountUsageSnapshot = null;
    const previousAccountKey = accountUsageHistory.activeKey;
    const accountKey = await currentAccountUsageKey(profileId);
    if (previousAccountKey && previousAccountKey !== accountKey) closeUsagePeriod(previousAccountKey);
    const bucket = setActiveUsageAccount(accountKey);
    if (!bucket.resetAt) bucket.resetAt = Date.now();
    localSessionUsageCache = null;
    await Promise.all([
      fsp.rm(accountUsageSnapshotFile, { force: true }),
      atomicJson(accountUsageHistoryFile, accountUsageHistory),
    ]);
    await codex.start();
    setTakeoverState("ready", "\u8d26\u53f7\u5df2\u5207\u6362\uff0cWeb Codex \u5df2\u91cd\u65b0\u8fde\u63a5");
    await recordControlAudit("account-switched", req, { profileId });
    res.json({ ok: true, profile: result.profile || null, reconnectAfterMs: 4500 });
  } catch (error) {
    setTakeoverState("failed", error.message || "\u8d26\u53f7\u5207\u6362\u5931\u8d25");
    throw error;
  } finally {
    transition = false;
    broadcastState();
  }
}));
app.post("/api/account/rate-limit-reset", requireAuth, requireWebMode, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  if (resetCreditInFlight) return res.status(409).json({ error: "额度重置正在处理中，请勿重复提交" });
  resetCreditInFlight = true;
  try {
    const attempt = String(req.body?.idempotencyKey || "");
    const idempotencyKey = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(attempt) ? attempt : crypto.randomUUID();
    const creditId = req.body?.creditId ? String(req.body.creditId).slice(0, 200) : null;
    const result = await codex.request("account/rateLimitResetCredit/consume", { idempotencyKey, creditId });
    const rateLimits = await codex.request("account/rateLimits/read", null);
    res.json({ ...result, rateLimits });
  } finally { resetCreditInFlight = false; }
}));

app.get("/api/thread-previews", requireAuth, asyncRoute(async (req, res) => {
  res.json({ data: await readThreadPreviews() });
}));

app.get("/api/threads/:id/snapshot", requireAuth, asyncRoute(async (req, res) => {
  const cached = await readThreadSnapshot(req.params.id);
  const thread = cached?.thread || await readReadonlyThreadSingleFlight(req.params.id);
  if (!thread) return res.status(404).json({ error: "暂时没有该任务的本地快照" });
  if (!cached) void writeThreadSnapshot(thread).catch(() => {});
  res.json({ thread, cached: true, cachedAt: cached?.cachedAt || null, ...threadRuntimePayload(req.params.id) });
}));

app.get("/api/threads/:id", requireAuth, requireWebMode, asyncRoute(async (req, res) => {
  const result = await activateThread(req.params.id);
  lastThreadId = req.params.id;
  await mergeThreadCache(result.thread);
  syncThreadRuntime(result.thread);
  void writeThreadSnapshot(result.thread).catch(() => {});
  res.json({ ...result, ...threadRuntimePayload(req.params.id) });
}));

app.get("/api/thread-previews/:id", requireAuth, asyncRoute(async (req, res) => {
  const thread = await readReadonlyThread(req.params.id);
  if (!thread) return res.status(404).json({ error: "找不到该任务的本机会话记录" });
  res.json({ thread, readonly: true });
}));

app.post("/api/threads/:id/messages", requireAuth, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const modeRequested = String(req.body?.mode || "auto");
  const input = await buildInput(text, req.body?.attachmentIds || [], req.sessionToken);
  if (!input.length) return res.status(400).json({ error: "消息或附件不能为空" });
  const threadId = req.params.id;
  const activeTurnId = activeTurns.get(threadId);
  const submissionPending = threadSubmissions.has(threadId);
  lastThreadId = threadId;

  if (modeRequested === "queue" || (modeRequested === "auto" && (activeTurnId || submissionPending))) {
    const item = { id: crypto.randomUUID(), text, input, createdAt: Date.now(), settings: turnOverrides(req.body) };
    (queues[threadId] ||= []).push(item); await saveQueues(); broadcastQueue(threadId);
    if (!activeTurnId) scheduleQueue(threadId, 50);
    return res.json({ queued: true, item });
  }
  if (modeRequested === "steer") {
    if (!activeTurnId) return res.status(409).json({ error: "当前没有可引导的运行任务" });
    return res.json(await codex.request("turn/steer", {
      threadId, expectedTurnId: activeTurnId, input, clientUserMessageId: crypto.randomUUID(),
    }));
  }
  threadSubmissions.add(threadId);
  try {
    await resumeThread(threadId);
    const result = await codex.request("turn/start", { threadId, input, clientUserMessageId: crypto.randomUUID(), ...turnOverrides(req.body), ...turnPermissionOverrides() });
    if (result.turn?.id) activeTurns.set(threadId, result.turn.id);
    res.json(result);
  } finally {
    threadSubmissions.delete(threadId);
    if (!activeTurns.has(threadId) && queues[threadId]?.length) scheduleQueue(threadId, 50);
  }
}));

app.post("/api/threads/:id/interrupt", requireAuth, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  const turnId = activeTurns.get(req.params.id) || String(req.body?.turnId || "");
  if (!turnId) return res.status(409).json({ error: "没有正在运行的任务" });
  res.json(await codex.request("turn/interrupt", { threadId: req.params.id, turnId }));
}));

// Queue contents are local pending drafts. They are safe to inspect while the
// desktop owns Codex; only queue mutations still require Web control.
app.get("/api/threads/:id/queue", requireAuth, (req, res) => res.json({ data: queues[req.params.id] || [] }));
app.delete("/api/threads/:id/queue/:itemId", requireAuth, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  queues[req.params.id] = (queues[req.params.id] || []).filter((item) => item.id !== req.params.itemId);
  await saveQueues(); broadcastQueue(req.params.id); res.json({ ok: true });
}));
app.delete("/api/threads/:id/queue", requireAuth, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  delete queues[req.params.id]; await saveQueues(); broadcastQueue(req.params.id); res.json({ ok: true });
}));

app.post("/api/threads/:id/queue/:itemId/steer", requireAuth, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  const threadId = req.params.id;
  const activeTurnId = activeTurns.get(threadId);
  if (!activeTurnId) return res.status(409).json({ error: "当前没有可引导的运行任务" });
  const list = queues[threadId] || [];
  const item = list.find((entry) => entry.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: "排队消息不存在" });
  const result = await codex.request("turn/steer", { threadId, expectedTurnId: activeTurnId, input: item.input, clientUserMessageId: crypto.randomUUID() });
  queues[threadId] = list.filter((entry) => entry.id !== item.id);
  await saveQueues(); broadcastQueue(threadId); res.json(result);
}));

app.post("/api/uploads", requireAuth, requireSameOrigin, express.raw({ type: "application/octet-stream", limit: "50mb" }), asyncRoute(async (req, res) => {
  const originalName = sanitizeFileName(safeDecodeURIComponent(String(req.query.name || "attachment")));
  const mime = String(req.query.type || "application/octet-stream").slice(0, 120);
  const isImage = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "\u65e0\u6cd5\u8bfb\u53d6\u4e0a\u4f20\u5185\u5bb9" });
  if (!isImage && /\.(exe|dll|msi|bat|cmd|com|scr|ps1)$/i.test(originalName)) return res.status(400).json({ error: "\u4e0d\u5141\u8bb8\u4e0a\u4f20\u53ef\u6267\u884c\u6587\u4ef6" });
  const id = crypto.randomUUID();
  const diskName = `${id}-${originalName}`;
  const filePath = path.join(uploadDir, diskName);
  await fsp.writeFile(filePath, req.body, { flag: "wx" });
  const item = { id, name: originalName, mime, size: req.body.length, path: filePath, isImage, createdAt: Date.now(), owner: req.sessionToken };
  uploads.set(id, item);
  res.json({ id, name: originalName, mime, size: item.size, isImage, localPath: filePath, previewUrl: isImage ? `/api/uploads/${id}` : null });
}));

app.get("/api/uploads/:id", requireAuth, asyncRoute(async (req, res) => {
  const item = uploads.get(req.params.id);
  if (!item || item.owner !== req.sessionToken || !item.isImage) return res.status(404).end();
  res.type(item.mime);
  fs.createReadStream(item.path).on("error", () => {
    if (!res.headersSent) res.status(404).end();
    else res.destroy();
  }).pipe(res);
}));

app.delete("/api/uploads/:id", requireAuth, requireSameOrigin, asyncRoute(async (req, res) => {
  const item = uploads.get(req.params.id);
  if (item?.owner === req.sessionToken) { uploads.delete(req.params.id); await fsp.rm(item.path, { force: true }); }
  res.json({ ok: true });
}));

app.post("/api/server-requests/:id", requireAuth, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  const response = respondToPendingRequest(req.params.id, req.body || {});
  res.json({ ok: true, response });
}));

app.post("/api/test/server-request", requireAuth, requireSameOrigin, asyncRoute(async (req, res) => {
  if (!testMode) return res.status(404).json({ error: "Not found" });
  const method = String(req.body?.method || "").slice(0, 160);
  if (!method) return res.status(400).json({ error: "method is required" });
  const data = {
    id: `test-${crypto.randomUUID()}`,
    method,
    params: req.body?.params && typeof req.body.params === "object" ? req.body.params : {},
    testSynthetic: true,
  };
  pendingApprovals.set(String(data.id), data);
  if (data.params?.threadId) setThreadActivity(data.params.threadId, "approval", requestActivityLabel(data.method));
  broadcast({ type: "serverRequest", data });
  res.json({ ok: true, request: data });
}));

app.post("/api/approvals/:id", requireAuth, requireController, requireSameOrigin, asyncRoute(async (req, res) => {
  const response = respondToPendingRequest(req.params.id, { decision: req.body?.decision });
  res.json({ ok: true, response });
}));

app.use(express.static(path.join(root, "public"), {
  index: "index.html",
  maxAge: 0,
  etag: false,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate"),
}));
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.type === "entity.too.large" ? 413 : (Number(error.status) || Number(error.statusCode) || 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.type === "entity.too.large" ? "文件太大" : (error.message || "服务器错误") });
});

const server = app.listen(port, host, async () => {
  mode = await isDesktopRunning() ? "desktop" : "available";
  console.log(`Codex Web Remote: http://${host}:${port} (${mode})`);
});

const wss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!getSession(req)) return socket.destroy();
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/events") return wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  if (pathname === "/terminal-events") return terminalWss.handleUpgrade(req, socket, head, (ws) => terminalWss.emit("connection", ws, req));
  socket.destroy();
});
wss.on("connection", (ws, req) => {
  sockets.add(ws);
  broadcastState();
  const requestUrl = new URL(req.url || "/events", "http://localhost");
  const since = Math.max(0, Number(requestUrl.searchParams.get("since") || 0) || 0);
  const oldest = eventBuffer[0]?.seq ?? (eventSeq + 1);
  const replayAvailable = since === 0 || (since <= eventSeq && since >= oldest - 1);
  safeWsSend(ws, { type: "hello", data: { eventSeq, replayAvailable, oldestEventSeq: oldest } });
  if (replayAvailable && since > 0) for (const event of eventBuffer) if (event.seq > since) safeWsSend(ws, event);
  ws.on("error", () => { sockets.delete(ws); });
  ws.on("close", () => { sockets.delete(ws); broadcastState(); });
});
terminalWss.on("connection", (ws, req) => {
  if (terminalControllerToken !== req.sessionToken || mode !== "terminal") return ws.close(1008, "No terminal control");
  if (terminal.buffer) safeWsSend(ws, { type: "data", data: terminal.buffer });
  safeWsSend(ws, { type: "status", data: terminal.status() });
  ws.on("error", () => {});
  ws.on("message", (raw) => { try { const message = JSON.parse(String(raw)); if (message.type === "input") terminal.write(message.data); if (message.type === "resize") terminal.resize(Number(message.cols), Number(message.rows)); } catch { } });
});
terminal.on("data", (data) => { for (const ws of terminalWss.clients) safeWsSend(ws, { type: "data", data }); });
terminal.on("exit", (data) => { for (const ws of terminalWss.clients) safeWsSend(ws, { type: "exit", data }); });

codex.on("notification", (data) => {
  const { method, params } = data;
  const threadId = params?.threadId || params?.thread?.id || params?.turn?.threadId || params?.turn?.thread_id;
  const dropTurnCompleted = method === "turn/completed" && testDropTurnCompletedRemaining > 0;
  if (dropTurnCompleted) testDropTurnCompletedRemaining -= 1;
  if (method === "serverRequest/resolved" && params?.requestId != null) pendingApprovals.delete(String(params.requestId));
  if (method === "thread/settings/updated" && threadId && params.threadSettings) threadSettings.set(threadId, params.threadSettings);
  if (method === "thread/tokenUsage/updated" && threadId && params.tokenUsage) {
    threadTokenUsage.set(threadId, params.tokenUsage);
    void recordObservedTokenUsage(threadId, params.tokenUsage).catch((error) => console.error(`token usage record failed: ${error.message}`));
  }
  if (method === "turn/plan/updated" && threadId) turnPlans.set(threadId, { turnId: params.turnId, plan: params.plan || [], explanation: params.explanation || "" });
  if (method === "turn/diff/updated" && threadId) turnDiffs.set(threadId, { turnId: params.turnId, diff: params.diff || "" });
  if (method === "thread/status/changed" && threadId && params.status) {
    threadStatuses.set(threadId, params.status);
    applyOfficialThreadStatus(threadId, params.status);
  }
  if (method === "turn/started" && threadId && params.turn?.id) {
    activeTurns.set(threadId, params.turn.id);
    turnPlans.delete(threadId);
    turnDiffs.delete(threadId);
    setThreadActivity(threadId, "thinking", "正在思考");
  }
  if (method === "item/started" && threadId) {
    const item = params.item || {};
    const labels = { reasoning: ["thinking", "正在思考"], commandExecution: ["command", "正在执行命令"], fileChange: ["file", "正在修改文件"], webSearch: ["search", "正在搜索"], mcpToolCall: ["tool", "正在调用工具"], dynamicToolCall: ["tool", "正在调用工具"], imageGeneration: ["image", "正在生成图片"] };
    const [phase, label] = labels[item.type] || ["working", "正在处理"];
    const detail = item.type === "commandExecution" ? String(item.command || "").replace(/\s+/g, " ").slice(0, 100) : "";
    setThreadActivity(threadId, phase, label, detail);
  }
  if (method === "item/agentMessage/delta" && threadId) setThreadActivity(threadId, "responding", "正在生成回复");
  if (method === "item/completed" && threadId && activeTurns.has(threadId)) setThreadActivity(threadId, "working", "正在处理");
  if (method === "turn/completed" && threadId && !dropTurnCompleted) {
    activeTurns.delete(threadId);
    threadActivities.delete(threadId);
    threadStatuses.set(threadId, { type: "idle" });
    void mergeThreadSnapshotTurn(threadId, params.turn).catch(() => {});
    scheduleQueue(threadId, 120);
  }
  broadcast({ type: "notification", data });
});
codex.on("serverRequest", handleServerRequest);
codex.on("stderr", (chunk) => {
  const message = String(chunk).trimEnd();
  if (message) console.error(`[codex app-server] ${message}`);
});
codex.on("status", (data) => { broadcast({ type: "status", data }); if (data.ready && mode === "web") for (const threadId of Object.keys(queues)) scheduleQueue(threadId, 100); });

async function processQueue(threadId) {
  if (queueWorkers.has(threadId) || threadSubmissions.has(threadId) || mode !== "web" || !codex.ready || !(queues[threadId]?.length)) return;
  queueWorkers.add(threadId);
  threadSubmissions.add(threadId);
  const item = queues[threadId][0];
  try {
    if (activeTurns.has(threadId)) {
      const stillActive = await verifyThreadActive(threadId);
      if (stillActive) return;
      activeTurns.delete(threadId);
      threadActivities.delete(threadId);
      broadcastState();
    }
    setThreadActivity(threadId, "queue", "正在发送下一条排队消息");
    await resumeThread(threadId);
    const result = await codex.request("turn/start", { threadId, input: item.input, clientUserMessageId: crypto.randomUUID(), ...(item.settings || {}), ...turnPermissionOverrides() });
    if (!result.turn?.id) throw new Error("Codex 未返回新任务 ID");
    activeTurns.set(threadId, result.turn.id);
    queues[threadId] = (queues[threadId] || []).filter((entry) => entry.id !== item.id);
    if (!queues[threadId].length) delete queues[threadId];
    await saveQueues(); broadcastQueue(threadId);
  } catch (error) {
    threadActivities.delete(threadId);
    broadcast({ type: "queueError", data: { threadId, error: error.message, retrying: true } });
    scheduleQueue(threadId, 2500);
  } finally {
    queueWorkers.delete(threadId);
    threadSubmissions.delete(threadId);
  }
}

function scheduleQueue(threadId, delayMs = 100) {
  if (!threadId || queueRetryTimers.has(threadId)) return;
  const timer = setTimeout(() => {
    queueRetryTimers.delete(threadId);
    void processQueue(threadId);
  }, delayMs);
  timer.unref();
  queueRetryTimers.set(threadId, timer);
}

function threadRuntimePayload(threadId) {
  return {
    threadSettings: threadSettings.get(threadId) || null,
    tokenUsage: threadTokenUsage.get(threadId) || null,
    turnPlan: turnPlans.get(threadId) || null,
    turnDiff: turnDiffs.get(threadId) || null,
    pendingRequests: [...pendingApprovals.values()].filter((item) => item.params?.threadId === threadId),
  };
}

async function activateThread(threadId) {
  if (threadActivationRequests.has(threadId)) return threadActivationRequests.get(threadId);
  const request = (async () => {
    const result = await resumeThread(threadId, { recoverEmpty: true })
      || await codex.request("thread/read", { threadId, includeTurns: !testMode });
    if (!result?.thread) throw new Error("Codex 未返回任务内容");
    return result;
  })().finally(() => threadActivationRequests.delete(threadId));
  threadActivationRequests.set(threadId, request);
  return request;
}

async function resumeThread(threadId, { recoverEmpty = false } = {}) {
  try {
    const result = await codex.request("thread/resume", { threadId, ...(testMode ? { excludeTurns: true } : {}), ...threadPermissionOverrides() });
    syncThreadRuntime(result?.thread);
    return result;
  }
  catch (error) {
    if (/not materialized yet|includeTurns is unavailable before first user message/i.test(error.message)) {
      const result = await codex.request("thread/read", { threadId, includeTurns: false });
      syncThreadRuntime(result?.thread);
      return result;
    }
    if (recoverEmpty && /thread not loaded|no rollout found|thread not found/i.test(error.message)) {
      try {
        const result = await codex.request("thread/read", { threadId, includeTurns: false });
        syncThreadRuntime(result?.thread);
        return result;
      } catch { }
      const recovered = await recoverEmptyThread(threadId);
      if (recovered) return recovered;
    }
    if (/no rollout found/i.test(error.message)) return null;
    throw error;
  }
}

function threadSnapshotFile(threadId) { return path.join(threadSnapshotDir, `${crypto.createHash("sha256").update(String(threadId)).digest("hex")}.json`); }
function rememberThreadSnapshot(threadId, value) {
  threadSnapshotCache.delete(threadId); threadSnapshotCache.set(threadId, value);
  while (threadSnapshotCache.size > 10) threadSnapshotCache.delete(threadSnapshotCache.keys().next().value);
}
async function readThreadSnapshot(threadId) {
  if (threadSnapshotCache.has(threadId)) { const value = threadSnapshotCache.get(threadId); rememberThreadSnapshot(threadId, value); return value; }
  const value = await loadJson(threadSnapshotFile(threadId), null);
  if (!value?.thread?.id) return null;
  rememberThreadSnapshot(threadId, value); return value;
}
async function writeThreadSnapshot(thread) {
  if (!thread?.id || !Array.isArray(thread.turns)) return;
  const value = { cachedAt: Date.now(), thread };
  rememberThreadSnapshot(thread.id, value);
  await atomicJson(threadSnapshotFile(thread.id), value);
}
async function mergeThreadSnapshotTurn(threadId, turn) {
  if (!threadId || !turn) return;
  const cached = await readThreadSnapshot(threadId);
  if (!cached?.thread) return;
  const turns = [...(cached.thread.turns || [])];
  const index = turn.id ? turns.findIndex((item) => item.id === turn.id) : -1;
  if (index >= 0) turns[index] = turn; else turns.push(turn);
  await writeThreadSnapshot({ ...cached.thread, turns, status: { type: "idle" }, recencyAt: Date.now() });
}

async function recoverEmptyThread(threadId) {
  const cachedThreads = await loadJson(threadCacheFile, []);
  const cached = cachedThreads.find((thread) => thread?.id === threadId);
  if (!cached?.cwd || !/^(未命名任务|untitled|)$/i.test(String(cached.preview || ""))) return null;
  let stat;
  try { stat = await fsp.stat(cached.cwd); } catch { return null; }
  if (!stat.isDirectory()) return null;
  const replacement = await codex.request("thread/start", { cwd: normalizeProjectPath(cached.cwd), ...(testMode ? { ephemeral: true } : {}), ...threadPermissionOverrides() });
  if (!replacement.thread?.id) return null;
  const nextCache = cachedThreads.filter((thread) => thread?.id !== threadId);
  nextCache.unshift(normalizeThread(replacement.thread));
  await atomicJson(threadCacheFile, nextCache.sort((left, right) => threadTime(right) - threadTime(left)).slice(0, 100));
  lastThreadId = replacement.thread.id;
  return { ...replacement, replacedThreadId: threadId };
}

async function verifyThreadActive(threadId) {
  try {
    const result = await codex.request("thread/read", { threadId, includeTurns: false });
    const status = result?.thread?.status;
    return status?.type === "active" || status === "active";
  } catch (error) {
    broadcast({ type: "queueError", data: { threadId, error: `无法核对任务状态：${error.message}`, retrying: true } });
    return true;
  }
}

async function buildInput(text, attachmentIds, ownerToken = "") {
  if (text.length > 50_000) throw httpError(400, "\u6d88\u606f\u8fc7\u957f");
  const input = [];
  let message = text;
  for (const id of attachmentIds.slice(0, 10)) {
    const item = uploads.get(String(id));
    if (!item || item.owner !== ownerToken) throw httpError(400, "\u9644\u4ef6\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u4e0a\u4f20");
    if (item.isImage) input.push({ type: "localImage", path: item.path });
    else message += `${message ? "\n\n" : ""}\u9644\u4ef6\uff1a${item.name}\n\u672c\u673a\u8def\u5f84\uff1a${item.path}\n\u8bf7\u6309\u7528\u6237\u8981\u6c42\u8bfb\u53d6\u6b64\u9644\u4ef6\u3002`;
  }
  if (message.trim()) input.unshift({ type: "text", text: message.trim() });
  return input;
}
async function saveQueues() { await atomicJson(queueFile, queues); }

async function readThreadPreviews() {
  const merged = new Map();
  for (const thread of await loadJson(threadCacheFile, [])) if (thread?.id) merged.set(thread.id, normalizeThread(thread));
  try {
    const lines = (await fsp.readFile(sessionIndexFile, "utf8")).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!item.id) continue;
        const previous = merged.get(item.id) || {};
        merged.set(item.id, normalizeThread({ ...previous, id: item.id, preview: item.thread_name || previous.preview, updatedAt: item.updated_at || previous.updatedAt }));
      } catch { }
    }
  } catch { }
  return [...merged.values()].sort((a, b) => threadTime(b) - threadTime(a)).slice(0, 100);
}

async function readReadonlyThread(threadId) {
  const preview = (await readThreadPreviews()).find((item) => item.id === threadId);
  const file = await findSessionFile(threadId);
  if (!file) return null;
  const stat = await fsp.stat(file);
  const cached = readonlyThreadCache.get(threadId);
  if (cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs) return cached.thread;

  const turns = [];
  const turnMap = new Map();
  let currentTurnId = null;
  let cwd = preview?.cwd || "";
  let model = "";
  const responseCallItems = new Map();
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const ensureTurn = (id) => {
    const key = id || currentTurnId || `readonly-${turns.length}`;
    if (!turnMap.has(key)) { const turn = { id: key, items: [] }; turnMap.set(key, turn); turns.push(turn); }
    return turnMap.get(key);
  };
  for await (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.payload || {};
    if (record.type === "session_meta") cwd ||= payload.cwd || "";
    if (record.type === "turn_context") {
      currentTurnId = payload.turn_id || currentTurnId;
      cwd = payload.cwd || cwd;
      model = payload.model || model;
      ensureTurn(currentTurnId);
      continue;
    }
    if (record.type === "response_item") {
      appendReadonlyResponseItem(ensureTurn(currentTurnId), payload, responseCallItems);
      continue;
    }
    if (record.type !== "event_msg") continue;
    if (payload.type === "task_started") { currentTurnId = payload.turn_id || currentTurnId; ensureTurn(currentTurnId); continue; }
    const turn = ensureTurn(payload.turn_id || currentTurnId);
    if (payload.type === "user_message") appendReadonlyItem(turn, { type: "userMessage", content: [{ type: "text", text: payload.message || "" }] });
    else if (payload.type === "agent_message") appendReadonlyItem(turn, { type: "agentMessage", text: payload.message || "", phase: payload.phase });
    else if (payload.type === "agent_reasoning") appendReadonlyItem(turn, { type: "reasoning", summary: payload.text || "", status: "completed" });
  }
  const thread = { id: threadId, preview: preview?.preview || "未命名任务", cwd, model, turns };
  readonlyThreadCache.set(threadId, { size: stat.size, mtimeMs: stat.mtimeMs, thread });
  return thread;
}

function readReadonlyThreadSingleFlight(threadId) {
  if (readonlyThreadRequests.has(threadId)) return readonlyThreadRequests.get(threadId);
  const request = readReadonlyThread(threadId).finally(() => readonlyThreadRequests.delete(threadId));
  readonlyThreadRequests.set(threadId, request);
  return request;
}

function appendReadonlyItem(turn, item) {
  if (!turn || !item?.type) return null;
  if (item.id && turn.items.some((entry) => String(entry.id || "") === String(item.id))) return null;
  const previous = turn.items.at(-1);
  if (item.type === "agentMessage" && previous?.type === "agentMessage" && String(previous.text || "") === String(item.text || "")) return previous;
  if (item.type === "reasoning" && previous?.type === "reasoning" && String(previous.summary || "") === String(item.summary || "")) return previous;
  turn.items.push(item);
  return item;
}

function appendReadonlyResponseItem(turn, payload = {}, callItems = new Map()) {
  const id = String(payload.id || payload.call_id || crypto.randomUUID());
  if (payload.type === "message" && payload.role === "assistant") {
    const text = responseContentText(payload);
    if (text) appendReadonlyItem(turn, { id, type: "agentMessage", text, phase: payload.phase });
    return;
  }
  if (payload.type === "reasoning") {
    const summary = responseReasoningText(payload);
    if (summary) appendReadonlyItem(turn, { id, type: "reasoning", summary, status: "completed" });
    return;
  }
  if (payload.type === "function_call") {
    const args = parseMaybeJson(payload.arguments);
    const item = payload.name === "shell_command"
      ? { id, type: "commandExecution", command: args.command || args.cmd || String(payload.arguments || payload.name || ""), cwd: args.workdir || args.cwd || "", status: "inProgress", aggregatedOutput: "" }
      : { id, type: "dynamicToolCall", namespace: "desktop", tool: payload.name || "tool", arguments: args, status: "inProgress", contentItems: [] };
    appendReadonlyItem(turn, item);
    if (payload.call_id) callItems.set(String(payload.call_id), item);
    return;
  }
  if (payload.type === "function_call_output") {
    const item = payload.call_id ? callItems.get(String(payload.call_id)) : null;
    const output = String(payload.output || "");
    if (item?.type === "commandExecution") {
      item.status = "completed";
      item.aggregatedOutput = output || item.aggregatedOutput || "";
    } else if (item?.type === "dynamicToolCall") {
      item.status = "completed";
      item.contentItems = output ? [{ type: "text", text: output }] : item.contentItems || [];
    } else if (output) {
      appendReadonlyItem(turn, { id, type: "dynamicToolCall", namespace: "desktop", tool: "output", status: "completed", contentItems: [{ type: "text", text: output }] });
    }
  }
}

function responseContentText(payload = {}) {
  return (Array.isArray(payload.content) ? payload.content : [])
    .map((entry) => entry?.text || entry?.output_text || "")
    .filter(Boolean)
    .join("\n");
}

function responseReasoningText(payload = {}) {
  if (typeof payload.text === "string") return payload.text;
  if (Array.isArray(payload.summary)) return payload.summary.map((entry) => entry?.text || entry?.summary || "").filter(Boolean).join("\n");
  return "";
}

function parseMaybeJson(value) {
  if (!value || typeof value !== "string") return value && typeof value === "object" ? value : {};
  try { return JSON.parse(value); } catch { return { raw: value }; }
}

async function findSessionFile(threadId) {
  const suffix = `${threadId}.jsonl`;
  const stack = [sessionRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.endsWith(suffix)) return target;
    }
  }
  return null;
}

// Desktop Codex writes its conversation to JSONL while it is running.  Watch
// those append-only files and forward only newly appended records; repeatedly
// reparsing a multi-megabyte session on every token would make the Web UI slow.
function startDesktopLiveWatcher() {
  if (desktopSessionWatcher || testMode) return;
  try {
    desktopSessionWatcher = fs.watch(sessionRoot, { recursive: true }, (_event, name) => {
      const relative = Buffer.isBuffer(name) ? name.toString("utf8") : String(name || "");
      if (!relative.endsWith(".jsonl")) return;
      queueDesktopLiveFile(resolveSessionFile(relative));
    });
    desktopSessionWatcher.on("error", () => { try { desktopSessionWatcher?.close(); } catch { } desktopSessionWatcher = null; });
    void primeDesktopLiveFiles();
  } catch {
    // A later desktop launch may create the directory; retrying is cheap and
    // avoids making the gateway startup depend on Codex having run before.
    setTimeout(startDesktopLiveWatcher, 5_000).unref();
  }
}

async function primeDesktopLiveFiles() {
  const files = [];
  const stack = [sessionRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try { files.push({ file: target, mtimeMs: (await fsp.stat(target)).mtimeMs }); } catch { }
      }
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  await Promise.all(files.slice(0, 12).map(({ file }) => initializeDesktopLiveFile(file)));
}

async function pollDesktopLiveFiles() {
  const files = [];
  const stack = [sessionRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try { files.push({ file: target, mtimeMs: (await fsp.stat(target)).mtimeMs }); } catch { }
      }
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  await Promise.all(files.slice(0, 4).map(({ file }) => syncDesktopLiveFile(file)));
}

function queueDesktopLiveFile(file) {
  if (mode !== "desktop" || !sockets.size || !isSessionFile(file)) return;
  clearTimeout(desktopLivePending.get(file));
  desktopLivePending.set(file, setTimeout(() => {
    desktopLivePending.delete(file);
    void syncDesktopLiveFile(file);
  }, 120));
}

async function initializeDesktopLiveFile(file) {
  const stat = await fsp.stat(file);
  const state = { offset: stat.size, carry: "", threadId: sessionThreadId(file), turnId: "", lastAgent: "", lastReasoning: "", touchedAt: Date.now() };
  desktopLiveFiles.set(file, state);
  // Establish text baselines from a small tail so desktop records that repeat
  // the accumulated answer become a delta rather than duplicated Web text.
  const bytes = Math.min(stat.size, 192 * 1024);
  if (!bytes) return state;
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, stat.size - bytes);
    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      try { updateDesktopLiveBaseline(state, JSON.parse(line)); } catch { }
    }
  } finally { await handle.close(); }
  return state;
}

async function syncDesktopLiveFile(file) {
  let stat;
  try { stat = await fsp.stat(file); } catch { return; }
  let state = desktopLiveFiles.get(file);
  if (!state) {
    state = await initializeDesktopLiveFile(file);
    const thread = state.threadId ? await readReadonlyThread(state.threadId) : null;
    if (thread) broadcast({ type: "desktopLive", data: { threadId: state.threadId, kind: "snapshot", thread } });
    return;
  }
  if (stat.size < state.offset) { state = await initializeDesktopLiveFile(file); return; }
  const length = stat.size - state.offset;
  if (!length) return;
  const readLength = Math.min(length, 2 * 1024 * 1024);
  // In the unlikely event of a very large missed write, retain the newest part
  // and resync from the on-disk snapshot when the turn completes.
  const start = length > readLength ? stat.size - readLength : state.offset;
  const handle = await fsp.open(file, "r");
  let text;
  try {
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, start);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  state.offset = stat.size;
  state.touchedAt = Date.now();
  const lines = `${start > state.offset - length ? "" : state.carry}${text}`.split(/\r?\n/);
  state.carry = lines.pop() || "";
  let sawRecord = false;
  for (const line of lines) {
    try { sawRecord = forwardDesktopLiveRecord(state, JSON.parse(line)) || sawRecord; } catch { }
  }
  if (sawRecord) scheduleDesktopLiveSnapshot(state.threadId);
}

function sessionThreadId(file) {
  const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || "";
}

function resolveSessionFile(file) {
  if (!file) return "";
  const resolved = path.resolve(path.isAbsolute(file) ? file : path.join(sessionRoot, file));
  return isSessionFile(resolved) ? resolved : "";
}

function isSessionFile(file) {
  if (!file || !String(file).endsWith(".jsonl")) return false;
  const resolved = path.resolve(file);
  const rootKey = `${resolvedSessionRoot.toLowerCase()}${path.sep}`;
  const fileKey = resolved.toLowerCase();
  return fileKey === resolvedSessionRoot.toLowerCase() || fileKey.startsWith(rootKey);
}

function scheduleDesktopLiveSnapshot(threadId, delayMs = 900) {
  if (mode !== "desktop" || !sockets.size || !threadId) return;
  clearTimeout(desktopLiveSnapshotTimers.get(threadId));
  const timer = setTimeout(async () => {
    desktopLiveSnapshotTimers.delete(threadId);
    if (mode !== "desktop" || !sockets.size) return;
    try {
      const thread = await readReadonlyThreadSingleFlight(threadId);
      if (thread) {
        void writeThreadSnapshot(thread).catch(() => {});
        broadcast({ type: "desktopLive", data: { threadId, kind: "snapshot", thread } });
      }
    } catch { }
  }, delayMs);
  timer.unref();
  desktopLiveSnapshotTimers.set(threadId, timer);
}

function updateDesktopLiveBaseline(state, record) {
  const payload = record?.payload || {};
  if (record?.type === "response_item") {
    if (payload.type === "message" && payload.role === "assistant") state.lastAgent = responseContentText(payload) || state.lastAgent;
    return;
  }
  if (record?.type !== "event_msg") return;
  if (payload.type === "task_started") state.turnId = payload.turn_id || state.turnId;
  if (payload.type === "agent_message") state.lastAgent = String(payload.message || state.lastAgent);
  if (payload.type === "agent_reasoning") state.lastReasoning = String(payload.text || state.lastReasoning);
}

function desktopTextDelta(state, field, value) {
  const next = String(value || "");
  const previous = String(state[field] || "");
  state[field] = next;
  if (!next || next === previous) return "";
  return next.startsWith(previous) ? next.slice(previous.length) : (previous ? `\n${next}` : next);
}

function forwardDesktopLiveRecord(state, record) {
  if (mode !== "desktop" || !state.threadId) return false;
  if (record?.type === "response_item") return forwardDesktopResponseItem(state, record.payload || {});
  if (record?.type !== "event_msg") return false;
  const payload = record.payload || {};
  const turnId = payload.turn_id || state.turnId || `desktop-${state.threadId}`;
  if (payload.type === "task_started") {
    state.turnId = payload.turn_id || turnId;
    broadcast({ type: "desktopLive", data: { threadId: state.threadId, kind: "turnStarted", turnId: state.turnId } });
    return true;
  }
  if (payload.type === "user_message") {
    broadcast({ type: "desktopLive", data: { threadId: state.threadId, kind: "user", itemId: `desktop:${turnId}:user`, text: String(payload.message || "") } });
    return true;
  }
  if (payload.type === "agent_reasoning") {
    const delta = desktopTextDelta(state, "lastReasoning", payload.text);
    if (delta) broadcast({ type: "desktopLive", data: { threadId: state.threadId, kind: "reasoning", itemId: `desktop:${turnId}:reasoning`, delta } });
    return true;
  }
  if (payload.type === "agent_message") {
    const delta = desktopTextDelta(state, "lastAgent", payload.message);
    if (delta) broadcast({ type: "desktopLive", data: { threadId: state.threadId, kind: "agent", itemId: `desktop:${turnId}:agent`, delta } });
    return true;
  }
  if (payload.type === "task_complete") {
    state.turnId = "";
    broadcast({ type: "desktopLive", data: { threadId: state.threadId, kind: "turnCompleted", turnId } });
    return true;
  }
  return false;
}

function forwardDesktopResponseItem(state, payload = {}) {
  const turnId = state.turnId || `desktop-${state.threadId}`;
  if (payload.type === "message" && payload.role === "assistant") {
    const delta = desktopTextDelta(state, "lastAgent", responseContentText(payload));
    if (delta) broadcast({ type: "desktopLive", data: { threadId: state.threadId, kind: "agent", itemId: `desktop:${turnId}:agent`, delta } });
    return true;
  }
  if (payload.type === "reasoning") {
    broadcast({ type: "desktopLive", data: { threadId: state.threadId, kind: "activity", phase: "thinking", label: "桌面 App 正在思考" } });
    return true;
  }
  if (payload.type === "function_call") {
    const label = payload.name === "shell_command" ? "桌面 App 正在执行命令" : "桌面 App 正在调用工具";
    broadcast({ type: "desktopLive", data: { threadId: state.threadId, kind: "activity", phase: payload.name === "shell_command" ? "command" : "tool", label } });
    return true;
  }
  if (payload.type === "function_call_output") {
    broadcast({ type: "desktopLive", data: { threadId: state.threadId, kind: "activity", phase: "working", label: "桌面 App 输出已更新" } });
    return true;
  }
  return false;
}

function normalizeThread(thread) {
  return { id: thread.id, preview: thread.preview || thread.thread_name || "未命名任务", cwd: thread.cwd || "", recencyAt: thread.recencyAt, updatedAt: thread.updatedAt || thread.updated_at, createdAt: thread.createdAt };
}

function normalizeProjectStore(value) {
  const source = Array.isArray(value) ? { projects: value, hiddenPaths: [] } : (value || {});
  const projects = [];
  const seen = new Set();
  for (const item of Array.isArray(source.projects) ? source.projects : []) {
    if (!item?.path || !path.isAbsolute(String(item.path))) continue;
    const projectPath = normalizeProjectPath(item.path);
    const key = projectPathKey(projectPath);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push({
      id: String(item.id || crypto.randomUUID()),
      name: String(item.name || projectDisplayName(projectPath)).slice(0, 80),
      path: projectPath,
      createdAt: Number(item.createdAt || Date.now()),
      updatedAt: Number(item.updatedAt || item.createdAt || Date.now()),
    });
  }
  return { projects, hiddenPaths: [...new Set((Array.isArray(source.hiddenPaths) ? source.hiddenPaths : []).map((item) => String(item)))].slice(0, 500) };
}

function normalizeProjectPath(value) {
  const resolved = path.resolve(String(value || ""));
  const rootPath = path.parse(resolved).root;
  return resolved === rootPath ? rootPath : resolved.replace(/[\\/]+$/, "");
}

function projectPathKey(value) {
  const normalized = normalizeProjectPath(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function projectDisplayName(value) {
  const normalized = normalizeProjectPath(value);
  return path.basename(normalized) || normalized;
}

async function projectCatalog() {
  const byPath = new Map();
  for (const project of projectStore.projects) byPath.set(projectPathKey(project.path), { ...project, saved: true });
  const hidden = new Set(projectStore.hiddenPaths);
  for (const thread of await readThreadPreviews()) {
    if (!thread?.cwd || !path.isAbsolute(String(thread.cwd))) continue;
    const projectPath = normalizeProjectPath(thread.cwd);
    const key = projectPathKey(projectPath);
    if (hidden.has(key) || byPath.has(key)) continue;
    byPath.set(key, {
      id: `history-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
      name: projectDisplayName(projectPath),
      path: projectPath,
      createdAt: 0,
      updatedAt: Number(threadTime(thread) || 0),
      saved: false,
    });
  }
  return [...byPath.values()].sort((left, right) => Number(right.saved) - Number(left.saved) || right.updatedAt - left.updatedAt || left.name.localeCompare(right.name, "zh-CN"));
}

async function saveProjects() { await atomicJson(projectFile, projectStore); }

function emptyUsageBucket(resetAt = 0) {
  return { resetAt: Math.max(0, Number(resetAt || 0)), samples: [], observed: [], periods: [] };
}
function normalizeUsageBucket(value) {
  const samples = Array.isArray(value?.samples) ? value.samples : [];
  const observed = Array.isArray(value?.observed) ? value.observed : [];
  const periods = Array.isArray(value?.periods) ? value.periods : [];
  return {
    resetAt: Math.max(0, Number(value?.resetAt || 0)),
    samples: samples.filter((item) => Number.isFinite(Number(item?.at)) && typeof item?.day === "string" && Number.isFinite(Number(item?.tokens))).slice(-2_000),
    observed: observed.filter((item) => Number.isFinite(Number(item?.at))).map((item) => ({ at: Number(item.at), input: Math.max(0, Number(item.input || 0)), output: Math.max(0, Number(item.output || 0)), cached: Math.max(0, Number(item.cached || 0)) })).slice(-20_000),
    periods: periods.filter((item) => Number.isFinite(Number(item?.from))).map((item) => ({ from: Math.max(0, Number(item.from)), to: Math.max(0, Number(item.to || 0)) })).slice(-300),
  };
}
function safeUsageAccountKey(value) {
  return String(value || "default").replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 120) || "default";
}
function normalizeAccountUsageHistory(value) {
  const legacy = normalizeUsageBucket(value);
  const accounts = {};
  if (value?.accounts && typeof value.accounts === "object") {
    for (const [key, bucket] of Object.entries(value.accounts)) accounts[safeUsageAccountKey(key)] = normalizeUsageBucket(bucket);
  }
  if (!Object.keys(accounts).length && (legacy.resetAt || legacy.samples.length || legacy.observed.length)) accounts.default = legacy;
  const activeKey = safeUsageAccountKey(value?.activeKey || Object.keys(accounts)[0] || "default");
  return { activeKey, accounts, resetAt: legacy.resetAt, samples: legacy.samples, observed: legacy.observed };
}
function currentUsageBucket(accountKey = accountUsageHistory.activeKey || "default") {
  const key = safeUsageAccountKey(accountKey);
  if (!accountUsageHistory.accounts || typeof accountUsageHistory.accounts !== "object") accountUsageHistory.accounts = {};
  if (!accountUsageHistory.accounts[key]) accountUsageHistory.accounts[key] = emptyUsageBucket();
  accountUsageHistory.activeKey = key;
  const bucket = accountUsageHistory.accounts[key];
  if (!Array.isArray(bucket.samples)) bucket.samples = [];
  if (!Array.isArray(bucket.observed)) bucket.observed = [];
  if (!Array.isArray(bucket.periods)) bucket.periods = [];
  accountUsageHistory.resetAt = bucket.resetAt;
  accountUsageHistory.samples = bucket.samples;
  accountUsageHistory.observed = bucket.observed;
  return bucket;
}
function openUsagePeriod(accountKey, at = Date.now()) {
  const bucket = currentUsageBucket(accountKey);
  const last = bucket.periods.at(-1);
  const existingStart = Math.max(0, Number(bucket.resetAt || 0));
  if (last && !last.to) {
    if (!bucket.observed.length && !bucket.samples.length && last.from > existingStart) last.from = existingStart;
    return bucket;
  }
  bucket.periods.push({ from: bucket.periods.length ? at : (existingStart || at), to: 0 });
  bucket.periods = bucket.periods.slice(-300);
  return bucket;
}
function closeUsagePeriod(accountKey, at = Date.now()) {
  const bucket = currentUsageBucket(accountKey);
  const last = bucket.periods.at(-1);
  if (last && !last.to) last.to = Math.max(last.from, at);
  return bucket;
}
function setActiveUsageAccount(accountKey) {
  const key = safeUsageAccountKey(accountKey);
  const previous = accountUsageHistory.activeKey;
  if (previous && previous !== key) closeUsagePeriod(previous);
  return openUsagePeriod(key);
}
function accountScopedUsageHistory(accountKey, localSessions) {
  const key = safeUsageAccountKey(accountKey);
  const bucket = currentUsageBucket(key);
  return { ...accountUsageHistory, activeKey: key, resetAt: bucket.resetAt, samples: bucket.samples, observed: bucket.observed, localSessions };
}
async function currentAccountUsageKey(profileHint = "") {
  const codexRoot = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(process.env.USERPROFILE || root, ".codex");
  const profile = safeUsageAccountKey(profileHint);
  if (profile && profile !== "default") return `profile:${profile}`;
  for (const file of [
    path.join(codexRoot, "account-switcher", "index.json"),
    path.join(codexRoot, "accounts", "index.json"),
  ]) {
    try {
      const index = JSON.parse(await fsp.readFile(file, "utf8"));
      const active = index?.activeProfileId || index?.active || index?.currentProfileId;
      if (typeof active === "string" && active.trim()) return `profile:${safeUsageAccountKey(active)}`;
    } catch { }
  }
  try {
    const auth = await fsp.readFile(path.join(codexRoot, "auth.json"));
    return `auth:${crypto.createHash("sha256").update(auth).digest("hex").slice(0, 16)}`;
  } catch { return "default"; }
}
async function recordAccountUsageSample(usage, accountKey = accountUsageHistory.activeKey || "default") {
  const buckets = Array.isArray(usage?.dailyUsageBuckets) ? usage.dailyUsageBuckets : [];
  const today = new Date().toISOString().slice(0, 10);
  const tokens = Number(buckets.find((item) => item?.startDate === today)?.tokens);
  if (!Number.isFinite(tokens)) return;
  const bucket = currentUsageBucket(accountKey);
  const last = bucket.samples.at(-1);
  if (last?.day === today && last.tokens === tokens && Date.now() - last.at < 15 * 60_000) return;
  bucket.samples.push({ at: Date.now(), day: today, tokens });
  bucket.samples = bucket.samples.filter((item) => item.at >= Date.now() - 45 * 86400_000).slice(-2_000);
  currentUsageBucket(accountKey);
  await atomicJson(accountUsageHistoryFile, accountUsageHistory);
}
async function saveAccountUsageSnapshot(rateLimits, usage) {
  accountUsageSnapshot = { rateLimits, usage, cachedAt: Date.now() };
  await atomicJson(accountUsageSnapshotFile, accountUsageSnapshot);
}
function tokenValue(value, keys) {
  const queue = [value]; const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of keys) { const candidate = current[key]; if (Number.isFinite(Number(candidate))) return Math.max(0, Number(candidate)); }
    for (const child of Object.values(current)) if (child && typeof child === "object") queue.push(child);
  }
  return 0;
}
function tokenBreakdown(usage) {
  const input = tokenValue(usage, ["inputTokens", "input_tokens", "inputTokenCount"]);
  const output = tokenValue(usage, ["outputTokens", "output_tokens", "outputTokenCount"]);
  const cached = tokenValue(usage, ["cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens"]);
  return { input, output, cached };
}
async function recordObservedTokenUsage(threadId, usage) {
  const next = tokenBreakdown(usage); const previous = tokenUsageBaselines.get(threadId);
  tokenUsageBaselines.set(threadId, next);
  if (!previous) return;
  const delta = { input: Math.max(0, next.input - previous.input), output: Math.max(0, next.output - previous.output), cached: Math.max(0, next.cached - previous.cached) };
  if (!delta.input && !delta.output && !delta.cached) return;
  const accountKey = await currentAccountUsageKey();
  const bucket = setActiveUsageAccount(accountKey);
  bucket.observed.push({ at: Date.now(), ...delta });
  bucket.observed = bucket.observed.filter((item) => item.at >= Date.now() - 45 * 86400_000).slice(-20_000);
  currentUsageBucket(accountKey);
  await atomicJson(accountUsageHistoryFile, accountUsageHistory);
}
function usageRangesForBucket(bucket, fallbackResetAt) {
  const periods = Array.isArray(bucket?.periods) ? bucket.periods.filter((item) => Number.isFinite(Number(item?.from))) : [];
  if (periods.length) return periods.map((item) => ({ from: Math.max(0, Number(item.from)), to: Math.max(0, Number(item.to || 0)) }));
  return [{ from: Math.max(0, Number(fallbackResetAt || 0)), to: 0 }];
}
function timestampInUsageRanges(at, ranges) {
  if (!Number.isFinite(Number(at)) || !ranges.length) return true;
  return ranges.some((range) => at >= range.from && (!range.to || at <= range.to));
}
async function readLocalSessionTokenUsage(accountKey = "default", bucket = null) {
  const key = safeUsageAccountKey(accountKey);
  const effectiveResetAt = bucket?.resetAt || await localUsageResetFallback();
  const ranges = usageRangesForBucket(bucket, effectiveResetAt);
  const rangeKey = ranges.map((range) => `${Math.floor(range.from)}-${Math.floor(range.to || 0)}`).join(",");
  const scanFrom = Math.min(...ranges.map((range) => range.from).filter(Number.isFinite), effectiveResetAt || 0);
  const cacheKey = `${key}:${rangeKey}:${await newestSessionMtime()}`;
  if (localSessionUsageCache?.key === cacheKey && Date.now() - localSessionUsageCache.at < 60_000) return localSessionUsageCache.value;
  const items = [];
  const stack = [sessionRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        let stat;
        try { stat = await fsp.stat(target); } catch { continue; }
        if (stat.mtimeMs >= scanFrom) items.push({ file: target, mtimeMs: stat.mtimeMs });
      }
    }
  }
  const records = [];
  for (const item of items.sort((left, right) => left.mtimeMs - right.mtimeMs).slice(-80)) await collectSessionTokenUsage(item.file, ranges, records);
  const value = { accountKey: key, resetAt: effectiveResetAt, ranges, records: records.slice(-20_000) };
  localSessionUsageCache = { key: cacheKey, at: Date.now(), value };
  return value;
}
async function collectSessionTokenUsage(file, ranges, records) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== "event_msg" || record.payload?.type !== "token_count") continue;
    const at = Date.parse(record.timestamp || "") || 0;
    if (at && !timestampInUsageRanges(at, ranges)) continue;
    const last = record.payload?.info?.last_token_usage || record.payload?.info?.lastTokenUsage;
    const breakdown = tokenBreakdown(last);
    if (!breakdown.input && !breakdown.output && !breakdown.cached) continue;
    records.push({ at: at || Date.now(), ...breakdown });
  }
}
async function localUsageResetFallback() {
  try {
    const stat = await fsp.stat(accountUsageHistoryFile);
    return stat.size <= 64 ? stat.mtimeMs : 0;
  } catch { return 0; }
}
async function newestSessionMtime() {
  let newest = 0;
  const stack = [sessionRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try { newest = Math.max(newest, (await fsp.stat(target)).mtimeMs); } catch { }
      }
    }
  }
  return Math.floor(newest);
}
async function sampleAccountUsage() {
  try {
    const accountKey = await currentAccountUsageKey();
    const usage = await codex.request("account/usage/read", null);
    if (usage) await recordAccountUsageSample(usage, accountKey);
  } catch { /* Account metrics are optional and must never disturb a task. */ }
}

function threadTime(thread) {
  const value = thread.recencyAt || thread.updatedAt || thread.createdAt || 0;
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  return Date.parse(value) || 0;
}

async function saveThreadCache(threads) {
  const existing = await readThreadPreviews();
  const merged = new Map(existing.map((thread) => [thread.id, thread]));
  for (const thread of threads) if (thread?.id) merged.set(thread.id, normalizeThread({ ...merged.get(thread.id), ...thread }));
  await atomicJson(threadCacheFile, [...merged.values()].sort((a, b) => threadTime(b) - threadTime(a)).slice(0, 100));
}

async function mergeThreadCache(thread) { if (thread?.id) await saveThreadCache([thread]); }
function broadcastQueue(threadId) { broadcast({ type: "queue", data: { threadId, items: queues[threadId] || [] } }); }
function broadcastState() { broadcast({ type: "control", data: { mode, transition, takeoverState, fullAccess, ready: codex.ready, webClientCount: sockets.size, sharedWebControl: mode === "web" } }); }
function broadcast(message, record = true) {
  const event = record ? { ...message, seq: ++eventSeq, at: Date.now() } : message;
  if (record) {
    eventBuffer.push(event);
    if (eventBuffer.length > eventBufferLimit) eventBuffer.splice(0, eventBuffer.length - eventBufferLimit);
  }
  for (const ws of sockets) safeWsSend(ws, event);
}
function safeWsSend(ws, message) {
  if (ws.readyState !== 1) return false;
  try {
    ws.send(typeof message === "string" ? message : JSON.stringify(message));
    return true;
  } catch (error) {
    console.error(`websocket send failed: ${error.message}`);
    try { ws.close(); } catch { }
    return false;
  }
}

function handleServerRequest(data) {
  if (data.method === "currentTime/read") {
    codex.respondToServerRequest(data.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    return;
  }
  if (data.method === "item/tool/call") {
    codex.respondToServerRequest(data.id, { success: false, contentItems: [{ type: "inputText", text: "Codex Web Remote 没有注册此客户端动态工具。" }] });
    return;
  }
  pendingApprovals.set(String(data.id), data);
  if (data.params?.threadId) setThreadActivity(data.params.threadId, "approval", requestActivityLabel(data.method));
  broadcast({ type: "serverRequest", data });
}

function requestActivityLabel(method) {
  if (method === "item/tool/requestUserInput") return "等待你回答问题";
  if (method === "mcpServer/elicitation/request") return "等待你填写工具表单";
  if (method === "item/permissions/requestApproval") return "等待你批准权限";
  return "等待你批准";
}

function respondToPendingRequest(id, payload) {
  const key = String(id);
  const request = pendingApprovals.get(key);
  if (!request) throw new Error("交互请求已结束或不存在");
  const response = buildServerRequestResponse(request, payload);
  if (!request.testSynthetic) codex.respondToServerRequest(key, response);
  pendingApprovals.delete(key);
  broadcast({ type: "serverRequestResolved", data: { requestId: key, threadId: request.params?.threadId || null } });
  return response;
}

function setTakeoverState(phase, message, processes = []) {
  const now = Date.now();
  takeoverState = { phase, message, startedAt: takeoverState.phase === phase ? takeoverState.startedAt : now, updatedAt: now, processes };
  broadcastState();
}

function setThreadActivity(threadId, phase, label, detail = "") {
  const previous = threadActivities.get(threadId);
  const now = Date.now();
  const activity = { phase, label, detail, since: previous?.phase === phase ? previous.since : now, updatedAt: now };
  threadActivities.set(threadId, activity);
  broadcast({ type: "activity", data: { threadId, activity } });
}

function threadPermissionOverrides() { return fullAccess ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}; }
function turnPermissionOverrides() { return fullAccess ? { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } : {}; }
function threadStartOverrides(value = {}) {
  const result = {};
  if (value.model) result.model = String(value.model).slice(0, 120);
  if (["none", "friendly", "pragmatic"].includes(value.personality)) result.personality = value.personality;
  if (value.serviceTier) result.serviceTier = String(value.serviceTier).slice(0, 40);
  return result;
}

function turnOverrides(value = {}) {
  const result = threadStartOverrides(value);
  if (value.effort) result.effort = String(value.effort).slice(0, 30);
  if (["auto", "concise", "detailed", "none"].includes(value.summary)) result.summary = value.summary;
  if (["none", "friendly", "pragmatic"].includes(value.personality)) result.personality = value.personality;
  if (value.serviceTier) result.serviceTier = String(value.serviceTier).slice(0, 40);
  return result;
}

function syncThreadRuntime(thread) {
  if (!thread?.id) return;
  if (thread.status) {
    threadStatuses.set(thread.id, thread.status);
    applyOfficialThreadStatus(thread.id, thread.status);
  }
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const active = [...turns].reverse().find((turn) => turn?.status === "inProgress");
  if (active?.id) activeTurns.set(thread.id, active.id);
}

function applyOfficialThreadStatus(threadId, status) {
  if (!threadId || !status) return;
  const type = typeof status === "string" ? status : status.type;
  const flags = new Set(Array.isArray(status.activeFlags) ? status.activeFlags : []);
  if (type === "idle") {
    activeTurns.delete(threadId);
    threadActivities.delete(threadId);
    return;
  }
  if (type === "systemError") return setThreadActivity(threadId, "error", "Codex 运行异常");
  if (type !== "active") return;
  if (flags.has("waitingOnApproval")) return setThreadActivity(threadId, "approval", "等待你批准");
  if (flags.has("waitingOnUserInput")) return setThreadActivity(threadId, "input", "等待你输入");
  if (!threadActivities.has(threadId)) setThreadActivity(threadId, "working", "正在处理");
}

async function reconcileDesktopConflict() {
  if (desktopConflictCheckInFlight || transition || !new Set(["web", "terminal"]).has(mode)) return;
  desktopConflictCheckInFlight = true;
  let ownsTransition = false;
  try {
    const desktop = await inspectDesktopProcesses();
    if (!desktop.running) {
      if (mode === "web" && takeoverState.phase === "desktop-conflict") {
        setTakeoverState("ready", "桌面 App 已关闭，Web 继续运行");
        broadcastState();
      }
      return;
    }
    if (mode === "terminal") {
      await closeDesktop(true).catch((error) => broadcast({ type: "terminalConflict", data: { error: error.message } }));
      return;
    }

    const queuedCount = Object.values(queues).reduce((sum, list) => sum + list.length, 0);
    const canYield = canAutoYieldToDesktop({
      activeTurnCount: activeTurns.size,
      submissionCount: threadSubmissions.size,
      queuedCount,
      pendingRequestCount: pendingApprovals.size,
    });
    if (!canYield) {
      if (takeoverState.phase !== "desktop-conflict") {
        setTakeoverState("desktop-conflict", "桌面 App 已启动；Web 任务完成后将自动让路", desktop.processes);
        await recordControlAudit("desktop-detected-web-busy", null, { processes: desktop.processes.length, queuedCount });
        broadcastState();
      }
      return;
    }

    transition = true;
    ownsTransition = true;
    setTakeoverState("yielding", "检测到桌面 App，Web 正在自动让路", desktop.processes);
    broadcastState();
    await codex.stop();
    fullAccess = defaultFullAccess;
    terminalControllerToken = null;
    mode = "desktop";
    setTakeoverState("ready", "已自动让路给桌面 App", desktop.processes);
    await recordControlAudit("auto-yield-to-desktop", null, { processes: desktop.processes.length });
  } catch (error) {
    if (!codex.ready) mode = "desktop";
    setTakeoverState("failed", `自动让路失败：${error.message}`);
    await recordControlAudit("auto-yield-failed", null, { error: error.message });
  } finally {
    if (ownsTransition) {
      transition = false;
      broadcastState();
    }
    desktopConflictCheckInFlight = false;
  }
}

async function recordControlAudit(action, req = null, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    action,
    mode,
    clientIp: req ? clientIp(req) : "gateway",
    userAgent: req ? String(req.get("user-agent") || "").slice(0, 240) : "",
    ...details,
  };
  lastControlAudit = entry;
  console.log(`control-audit ${JSON.stringify(entry)}`);
  try { await fsp.appendFile(controlAuditFile, `${JSON.stringify(entry)}\n`, "utf8"); } catch (error) { console.error(`control-audit write failed: ${error.message}`); }
  return entry;
}

async function loadLastJsonLine(file) {
  try {
    const lines = (await fsp.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
    return lines.length ? JSON.parse(lines.at(-1)) : null;
  } catch { return null; }
}

async function inspectDesktopProcesses() {
  if (testMode) {
    if (!testDesktopStateFile) return { running: false, processes: [] };
    const state = await loadJson(testDesktopStateFile, { running: false, processes: [] });
    return { running: Boolean(state.running), processes: Array.isArray(state.processes) ? state.processes : [] };
  }
  const script = `
$ErrorActionPreference='SilentlyContinue'
$roots=@(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -ExpandProperty InstallLocation)
$items=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object {
  $exe=[string]$_.ExecutablePath; $cmd=[string]$_.CommandLine
  ($exe -match 'OpenAI\\.Codex_|OpenAI.Codex_') -or ($cmd -match 'OpenAI\\.Codex_|OpenAI.Codex_') -or ($roots | Where-Object { $exe.StartsWith($_,[System.StringComparison]::OrdinalIgnoreCase) -or $cmd.IndexOf($_,[System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
} | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; [pscustomobject]@{ pid=$_.ProcessId; parentPid=$_.ParentProcessId; name=$_.Name; main=([string]$_.CommandLine -notmatch '--type='); startedAt=if($p){$p.StartTime.ToUniversalTime().ToString('o')}else{$null}; command=([string]$_.CommandLine).Substring(0,[Math]::Min(180,([string]$_.CommandLine).Length)) } })
[pscustomobject]@{ running=($items.Count -gt 0); processes=$items } | ConvertTo-Json -Depth 4 -Compress`;
  try {
    const value = JSON.parse((await runPowerShell(script)).trim() || "{}");
    return { running: Boolean(value.running), processes: Array.isArray(value.processes) ? value.processes : (value.processes ? [value.processes] : []) };
  } catch (error) { throw new Error(`无法检查 Codex 桌面进程：${error.message}`); }
}

async function isDesktopRunning() { return (await inspectDesktopProcesses()).running; }

async function inspectDesktopActivity(desktop = null) {
  desktop ||= await inspectDesktopProcesses();
  if (!desktop.running) return { running: false };
  const processStartedAt = Math.min(...desktop.processes.map((item) => Date.parse(item.startedAt)).filter(Number.isFinite));
  const files = [];
  const stack = [sessionRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try { const stat = await fsp.stat(target); if (!Number.isFinite(processStartedAt) || stat.mtimeMs >= processStartedAt - 10_000) files.push({ target, mtimeMs: stat.mtimeMs }); } catch { }
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(0, 12)) {
    let lifecycle = null;
    const lines = readline.createInterface({ input: fs.createReadStream(file.target, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== "event_msg" || !new Set(["task_started", "task_complete"]).has(record.payload?.type)) continue;
      const at = Date.parse(record.timestamp);
      if (Number.isFinite(processStartedAt) && Number.isFinite(at) && at < processStartedAt - 10_000) continue;
      lifecycle = { type: record.payload.type, turnId: record.payload.turn_id, timestamp: record.timestamp, file: file.target };
    }
    if (lifecycle?.type === "task_started") return { running: true, ...lifecycle };
  }
  return { running: false };
}

async function closeDesktop(force, immediate = false, initialSnapshot = null) {
  if (testMode) return { closed: true, processes: [] };
  let snapshot = initialSnapshot || await inspectDesktopProcesses();
  if (!snapshot.running) return { closed: true, processes: [] };
  if (!immediate) {
    setTakeoverState("closing", `正在正常关闭桌面 Codex（${snapshot.processes.length} 个进程）`, snapshot.processes);
    const ids = snapshot.processes.map((item) => Number(item.pid)).filter(Number.isInteger);
    await runPowerShell(`$ids=@(${ids.join(",")}); Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | ForEach-Object {[void]$_.CloseMainWindow()}`);
    for (let i = 0; i < 16; i++) { await delay(500); snapshot = await inspectDesktopProcesses(); if (!snapshot.running) return { closed: true, processes: [] }; }
  }
  if (!force) return { closed: false, processes: snapshot.processes };
  setTakeoverState("killing", `已确认空闲，正在强制结束 ${snapshot.processes.length} 个 Codex 进程`, snapshot.processes);
  const killIds = snapshot.processes.map((item) => Number(item.pid)).filter(Number.isInteger);
  if (killIds.length) await runPowerShell(`$ids=@(${killIds.join(",")}); foreach($processId in $ids){ & taskkill.exe /PID $processId /T /F 2>$null | Out-Null }; Get-Process -Id $ids -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0`);
  for (let i = 0; i < 10; i++) { await delay(400); snapshot = await inspectDesktopProcesses(); if (!snapshot.running) return { closed: true, processes: [] }; }
  throw new Error(`仍有 ${snapshot.processes.length} 个 Codex 进程无法关闭`);
}

async function launchDesktop(threadId) {
  if (testMode) return;
  const target = threadId ? `codex://threads/${threadId}` : "codex://threads/new";
  await runPowerShell(`Start-Process '${target.replaceAll("'", "''")}'`);
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function runAccountSwitcher(args) {
  if (!launcherPath || !fs.existsSync(launcherPath)) return Promise.reject(new Error("账号切换仅在已安装的 Windows 版网关中可用"));
  return new Promise((resolve, reject) => execFile(launcherPath, args, { windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
    let result = null;
    try { result = JSON.parse(String(stdout || "{}")); } catch { /* fall through to safe generic error */ }
    if (error || !result?.ok) return reject(new Error(result?.error || "账号切换工具执行失败"));
    resolve(result);
  }));
}

async function latestRelease(force = false) {
  if (!force && updateCache && Date.now() - updateCache.checkedAt < 6 * 3600_000) return updateCache.value;
  const response = await fetch(updateApiUrl, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `CodexWebRemote/${currentVersion}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) return cacheLatestRelease(await latestReleaseFromPublicPage());
    throw new Error(`GitHub 更新检查失败：HTTP ${response.status}`);
  }
  const data = await response.json();
  const latestVersion = String(data.tag_name || "").replace(/^v/i, "");
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const hasSetup = assets.some((asset) => /CodexWebRemote-Setup-.*-win-x64\.exe$/i.test(String(asset.name || "")));
  const hasHash = assets.some((asset) => /CodexWebRemote-Setup-.*-win-x64\.exe\.sha256$/i.test(String(asset.name || "")));
  const value = {
    latestVersion,
    releaseUrl: String(data.html_url || ""),
    publishedAt: data.published_at || null,
    updateAvailable: !data.draft && !data.prerelease && hasSetup && hasHash && compareVersions(latestVersion, currentVersion) > 0,
  };
  return cacheLatestRelease(value);
}

async function latestReleaseFromPublicPage() {
  const response = await fetch(updatePageUrl, { redirect: "follow", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`GitHub 更新检查失败：HTTP ${response.status}`);
  const releaseUrl = String(response.url || updatePageUrl);
  const match = releaseUrl.match(/\/releases\/tag\/v?([^/?#]+)/i);
  const latestVersion = match ? decodeURIComponent(match[1]) : "";
  if (!isReleaseVersion(latestVersion)) throw new Error("GitHub 更新检查失败：无法识别最新发布版本");
  return {
    latestVersion,
    releaseUrl,
    publishedAt: null,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    fallback: "public-release-page",
  };
}

function isReleaseVersion(value) {
  return /^\d+(?:\.\d+){1,3}(?:[-+].*)?$/i.test(String(value || ""));
}

function cacheLatestRelease(value) {
  updateCache = { checkedAt: Date.now(), value };
  return value;
}

function compareVersions(left, right) {
  const parse = (value) => String(value || "0").replace(/^v/i, "").split(/[+-]/)[0].split(".").map((part) => Number(part) || 0);
  const a = parse(left), b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie || "").codex_web_session;
  const session = token && sessions.get(sessionKey(token));
  if (!session || session.expiresAt <= Date.now()) return null;
  req.sessionToken = token; return session;
}
function isSessionTokenActive(token) {
  const session = token && sessions.get(sessionKey(token));
  return Boolean(session && session.expiresAt > Date.now());
}
function requireAuth(req, res, next) { if (!getSession(req)) return res.status(401).json({ error: "未登录" }); next(); }
function requireWebMode(req, res, next) { if (mode !== "web" || !codex.ready) return res.status(409).json({ error: "请先接管 Codex" }); next(); }
function requireController(req, res, next) {
  if (mode === "web" && codex.ready) return next();
  if (mode === "terminal" && terminalControllerToken === req.sessionToken) return next();
  return res.status(409).json({ error: "当前浏览器没有控制权" });
}
function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin; const expectedHost = req.headers["x-forwarded-host"] || req.headers.host;
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== expectedHost && !allowedPublicOriginHosts().has(originHost)) return res.status(403).json({ error: "来源校验失败" });
    } catch { return res.status(403).json({ error: "来源校验失败" }); }
  }
  next();
}

function allowedPublicOriginHosts() {
  const hosts = new Set();
  for (const value of String(process.env.CODEX_WEB_PUBLIC_URL || "").split(/[,\s]+/)) addUrlHost(hosts, value);
  try {
    const settings = JSON.parse(fs.readFileSync(launcherSettingsFile, "utf8"));
    addUrlHost(hosts, settings.PublicUrl);
  } catch { }
  return hosts;
}

function addUrlHost(hosts, value) {
  if (!value || typeof value !== "string") return;
  try { hosts.add(new URL(value.trim()).host); } catch { }
}

function cookieHeader(token, ageSeconds = Math.floor(sessionMs / 1000)) { return `codex_web_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ageSeconds}${secureCookie ? "; Secure" : ""}`; }
function parseCookies(header) { return Object.fromEntries(header.split(";").map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key]) => key)); }
function sessionKey(token) { return crypto.createHash("sha256").update(String(token || "")).digest("hex"); }
async function saveSessions() { await atomicJson(sessionFile, Object.fromEntries(sessions)); }
function safeEqual(a, b) { return crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest()); }
function clientIp(req) { return req.socket.remoteAddress || "unknown"; }
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function safeDecodeURIComponent(value) { try { return decodeURIComponent(value); } catch { return value; } }
function sanitizeFileName(name) { return path.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "attachment"; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function loadJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; } }
function atomicJson(file, value) {
  const previous = atomicJsonWrites.get(file) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(value, null, 2));
    try {
      for (let attempt = 0; ; attempt += 1) {
        try { await fsp.rename(temp, file); break; }
        catch (error) {
          if (!(["EPERM", "EACCES", "EEXIST"].includes(error.code)) || attempt >= 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EEXIST"].includes(error.code)) throw error;
      await fsp.copyFile(temp, file);
      await fsp.unlink(temp).catch(() => {});
    }
  });
  atomicJsonWrites.set(file, write);
  return write.finally(() => { if (atomicJsonWrites.get(file) === write) atomicJsonWrites.delete(file); });
}
async function cleanup() {
  const now = Date.now();
  let sessionsChanged = false;
  for (const [token, session] of sessions) if (session.expiresAt <= now) { sessions.delete(token); sessionsChanged = true; }
  if (sessionsChanged) await saveSessions();
  for (const [ip, state] of attempts) if (state.resetAt <= now) attempts.delete(ip);
  for (const [id, item] of uploads) if (item.createdAt < now - 7 * 86400_000) { uploads.delete(id); await fsp.rm(item.path, { force: true }).catch(() => {}); }
}
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("="); if (at < 1) continue;
    const key = line.slice(0, at).trim(); let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
