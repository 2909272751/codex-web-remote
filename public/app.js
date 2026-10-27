import {
  appendReasoningDelta,
  createReasoningState,
  ensureReasoningPart,
  mergeCompletedReasoning,
  reasoningTextFromItem,
  visibleReasoningText,
} from "./reasoning-state.js";
import {
  appendCommandOutput,
  appendPlanDelta,
  appendTerminalInput,
  appendToolProgress,
  timelineItemNode,
  turnDiffNode,
  turnPlanNode,
} from "./timeline.js";
import { renderMarkdown } from './markdown.js';
import { cacheView, restoreView, readRoute, writeRoute, clientMessageId, mergeItems } from './workspace-cache.js';
import { projectMatchesThread, threadTimestamp } from './project-utils.js';

const $ = (id) => document.getElementById(id);
const HISTORY_BATCH_SIZE = 80;
const HISTORY_DOM_LIMIT = 120;
const THREAD_VIEW_LIMIT = 8;
const REMEMBER_PASSWORD_KEY = "codex-web-remember-password";
const LAST_OPENED_PROJECT_KEY = "codex-web-last-opened-project-id";
const inflightLoads = new Map();
const prefetchThreads = new Set();
const uploadTransfers = new Map();
const workspaceAttachments = new Map();
const outbox = new Map();
let viewThreadId = null;
let projectDefaultApplied = false;
let pageCursor = null;
let pageLoading = false;
let latestRefreshTimer;
let streamEpoch = '';
let draftTimer = 0;
const state = { threads: [], threadListStatus: "loading", threadListError: "", projects: [], selectedProjectId: null, projectsLoaded: false, directory: null, createAfterProject: false, models: [], current: null, currentSettings: null, threadStatus: null, tokenUsage: null, pendingThreadId: null, threadViews: new Map(), threadOpenController: null, threadSyncing: false, socket: null, socketConnected: false, socketEverConnected: false, reconnectTimer: null, reconnectStableTimer: null, activeTurnId: null, activity: null, control: null, attachments: [], queue: [], reasoningStreams: new Map(), itemNodes: new Map(), historyItems: [], historyVisibleStart: 0, historyVisibleEnd: 0, streamActions: [], reasoningDirty: new Set(), streamFrame: 0, scrollFrame: 0, followTail: true, viewportFrame: 0, controlRefreshTimer: 0, controlRefreshResources: false, usage: null, resetAttemptId: null, usageRefreshTimer: null, pendingRequests: [], lastEventSeq: 0, syncing: false, eventBacklog: [], reconnectCount: 0, lastInboundAt: 0, lastRttMs: 0, pingTimer: null, stallToastAt: 0, prepareTimer: 0, prepareStartedAt: 0, prepareToastAt: 0, preparePollAt: 0, prepareAuto: false, controlTransition: false, pendingTakeover: false, takeoverStartedAt: 0, update: null, updateLoaded: false };
syncViewportHeight();
window.addEventListener("resize", scheduleViewportSync, { passive: true });
window.addEventListener("orientationchange", scheduleViewportSync, { passive: true });
window.visualViewport?.addEventListener("resize", scheduleViewportSync, { passive: true });
window.visualViewport?.addEventListener("scroll", scheduleViewportSync, { passive: true });
restoreOutbox(); boot();
setInterval(() => { if (!document.hidden && state.activity) renderActivity(); }, 1000);
// The Desktop App can rename tasks without changing Web control state.  Keep
// the visible sidebar current even on systems where filesystem watching is
// delayed by sync software or antivirus.
setInterval(() => {
  if (document.hidden || !state.control) return;
  const refresh = state.control.mode === "web" && state.control.controller ? loadThreads() : loadThreadPreviews();
  refresh.catch(() => {});
}, 8000);
// A half-open socket (mobile NAT rebinding, Wi-Fi handoff) never fires onclose.
// The gateway heartbeats every 25s, so 45s of silence means two were lost.
setInterval(checkSocketHealth, 5000);

function readTheme() {
  try { return localStorage.getItem("codex-web-theme") || "system"; } catch { return "system"; }
}
function applyTheme(theme = "system") {
  const value = ["light", "dark", "system"].includes(theme) ? theme : "system";
  const dark = value === "dark" || (value === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const button = $("themeMenuBtn");
  if (!button) return;
  const icon = button.querySelector("span");
  if (icon) icon.textContent = value === "dark" ? "☾" : value === "light" ? "☀" : "◐";
  const text = icon?.nextSibling;
  if (text) text.textContent = ` 外观：${value === "dark" ? "深色模式" : value === "light" ? "浅色模式" : "跟随系统"}`;
}
function toggleTheme() {
  const current = readTheme();
  const next = current === "system" ? "dark" : current === "dark" ? "light" : "system";
  try { localStorage.setItem("codex-web-theme", next); } catch {}
  applyTheme(next);
}
applyTheme(readTheme());
window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener("change", () => { if (readTheme() === "system") applyTheme("system"); });

async function boot() {
  const session = await api("/api/session", { allow401: true });
  setWebVersion(session?.version);
  if (!session?.authenticated) return showLogin();
  showApp(); connectEvents(); await refreshControl(); await restoreLastThread();
}

$("loginForm").addEventListener("submit", async (event) => { event.preventDefault(); $("loginError").textContent = ""; try { const login = await api("/api/login", { method: "POST", body: { password: $("password").value } }); setWebVersion(login?.version); saveRememberedPassword(); showApp(); connectEvents(); await refreshControl(); await restoreLastThread(); } catch (error) { $("loginError").textContent = error.message; } });
$("logoutBtn").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); location.reload(); });
$("accountMenuBtn").addEventListener("click", (event) => { event.stopPropagation(); toggleAccountMenu(); });
$("usageMenuBtn").addEventListener("click", openUsage);
$("updateCheckBtn").addEventListener("click", checkForUpdates);
$("switchAccountMenuBtn").addEventListener("click", switchAccount);
$("themeMenuBtn").addEventListener("click", toggleTheme);
$("usageCloseBtn").addEventListener("click", closeUsage);
$("usageModal").addEventListener("click", (event) => { if (event.target === $("usageModal")) closeUsage(); });
$("resetLimitBtn").addEventListener("click", resetRateLimit);
$("updateNowBtn").addEventListener("click", applyHostUpdate);
document.addEventListener("click", (event) => { if (!event.target.closest(".sidebar-footer")) closeAccountMenu(); });
$("refreshBtn").addEventListener("click", () => state.control?.mode === "web" ? loadThreads() : loadThreadPreviews());
$("search").addEventListener("input", scheduleThreadRender);
$("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("open"));
$("menuBtn").addEventListener("click", () => $("sidebarBackdrop").classList.toggle("open", $("sidebar").classList.contains("open")));
$("sidebarBackdrop").addEventListener("click", closeSidebar);
$("sidebarCloseBtn").addEventListener("click", closeSidebar);
$("mobileToolsBtn").addEventListener("click", toggleComposerTools);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeProjectModal(); closeSidebar(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { renderActivity(); reconnectIfStale(20_000); } });
window.addEventListener("online", () => { reconnectIfStale(20_000); });
window.addEventListener("offline", () => { state.socketConnected = false; renderActivity(); });
$("composer").addEventListener("submit", sendMessage);
$("messageInput").addEventListener("input", handleComposerInput);
$("messageInput").addEventListener("keydown", (event) => { if (event.isComposing || event.keyCode === 229) return; if (event.key === "Enter" && !event.shiftKey && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); $("composer").requestSubmit(); } });
$("messageInput").addEventListener("paste", handlePaste);
$("messageInput").addEventListener("focus", () => setComposerKeyboardActive(true));
$("messageInput").addEventListener("blur", () => setComposerKeyboardActive(false));
$("composer").addEventListener("dragover", (event) => { event.preventDefault(); });
$("composer").addEventListener("drop", (event) => { event.preventDefault(); addFiles(event.dataTransfer.files); });
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", () => { addFiles($("fileInput").files); $("fileInput").value = ""; });
$("takeoverBtn").addEventListener("click", takeover);
$("recoverBtn")?.addEventListener("click", recoverBackend);
$("reconnectBtn")?.addEventListener("click", forceReconnect);
$("fullAccessBtn").addEventListener("click", toggleFullAccess);
$("permissionShortcut").addEventListener("click", toggleFullAccess);
$("newThreadBtn").addEventListener("click", createThread);
$("addProjectBtn").addEventListener("click", () => openProjectModal(false));
$("projectCloseBtn").addEventListener("click", closeProjectModal);
$("projectCancelBtn").addEventListener("click", closeProjectModal);
$("projectModal").addEventListener("click", (event) => { if (event.target === $("projectModal")) closeProjectModal(); });
$("projectForm").addEventListener("submit", saveProject);
$("projectBrowseBtn").addEventListener("click", () => loadDirectory($("projectPath").value.trim()));
$("directoryUpBtn").addEventListener("click", () => loadDirectory(state.directory?.parent || ""));
$("directorySelectBtn").addEventListener("click", selectCurrentDirectory);
$("modelSelect").addEventListener("change", () => { renderEfforts(); updateComposer(); });
$("summarySelect").addEventListener("change", updateComposer);
$("releaseBtn").addEventListener("click", releaseControl);
$("interruptBtn").addEventListener("click", interruptTurn);
$("clearQueueBtn").addEventListener("click", clearQueue);
$("messages").addEventListener("scroll", updateFollowTail, { passive: true });
$("messages").addEventListener('scroll', () => { if (!state.threadSyncing && Date.now() > (state.historyWindowReadyAt || 0) && !state.followTail && $('messages').scrollTop < 90 && pageCursor && !pageLoading && state.historyVisibleStart === 0) renderEarlierHistory(); }, { passive: true });
$("newMessagesBtn").addEventListener("click", () => { state.followTail = true; renderHistory([], { reset: false }); scrollBottom(true); });
$('activityPanelToggle')?.addEventListener('click', () => toggleActivityPanel());
$('activityPanelClose')?.addEventListener('click', () => toggleActivityPanel(false));
window.addEventListener("beforeunload", saveDraft);
window.addEventListener('popstate', () => { const route = readRoute(); if (route.threadId && route.threadId !== state.current?.id) openThread(route.threadId, { route: false }); else if (!route.threadId) { saveDraft(); closeSidebar(); $('sidebar').classList.add('open'); $('sidebarBackdrop').classList.add('open'); } });
document.addEventListener('click', (event) => { const button = event.target.closest('[data-agent-thread]'); if (button) openAgent(button.dataset.agentThread); });

function showLogin() { restoreRememberedPassword(); $("loginView").classList.remove("hidden"); $("appView").classList.add("hidden"); }
function showApp() { $("loginView").classList.add("hidden"); $("appView").classList.remove("hidden"); }
function setWebVersion(version) { const label = $("webVersion"); if (label) label.textContent = version ? `v${version}` : "v--"; }
function restoreRememberedPassword() {
  try {
    const saved = localStorage.getItem(REMEMBER_PASSWORD_KEY) || "";
    $("password").value = saved;
    $("rememberPassword").checked = Boolean(saved);
  } catch { }
}
function saveRememberedPassword() {
  try {
    if ($("rememberPassword").checked) localStorage.setItem(REMEMBER_PASSWORD_KEY, $("password").value);
    else localStorage.removeItem(REMEMBER_PASSWORD_KEY);
  } catch { }
}
function syncViewportHeight() {
  const layoutHeight = window.innerHeight;
  const visualHeight = window.visualViewport?.height;
  // Some mobile browsers briefly retain the previous visual viewport after a
  // rotation/resize. Never let that stale value make the app taller than the
  // current layout viewport, otherwise the composer falls below the screen.
  const appHeight = Math.min(layoutHeight, Number.isFinite(visualHeight) ? visualHeight : layoutHeight);
  document.documentElement.style.setProperty("--app-height", `${Math.round(appHeight)}px`);
}
function scheduleViewportSync() { if (state.viewportFrame) return; state.viewportFrame = requestAnimationFrame(() => { state.viewportFrame = 0; syncViewportHeight(); }); }
function setComposerKeyboardActive(active) {
  document.documentElement.classList.toggle("keyboard-active", Boolean(active));
  scheduleViewportSync();
  if (active) setTimeout(() => { scrollBottom(); $("messageInput")?.scrollIntoView({ block: "nearest" }); }, 80);
}
function closeSidebar() { $("sidebar").classList.remove("open"); $("sidebarBackdrop").classList.remove("open"); }
function toggleComposerTools() { const open = $("composerSettings").classList.toggle("open"); document.querySelector(".chat-shell")?.classList.toggle("tools-open", open); }
function toggleAccountMenu() { const open = $("accountMenu").classList.toggle("hidden") === false; $("accountMenuBtn").setAttribute("aria-expanded", String(open)); }
function closeAccountMenu() { $("accountMenu").classList.add("hidden"); $("accountMenuBtn").setAttribute("aria-expanded", "false"); }

async function refreshControl({ reloadResources = true } = {}) {
  state.control = await api("/api/control/status");
  state.pendingRequests = Array.isArray(state.control.pendingRequests) ? state.control.pendingRequests : [];
  renderControl();
  if (state.current?.id && state.control.activities?.[state.current.id]) setActivity(state.control.activities[state.current.id]);
  if (!reloadResources) return;
  const work = [];
  if (!state.projectsLoaded) work.push(loadProjects().catch((error) => toast(`项目列表：${error.message}`)));
  work.push(state.control.mode === "web" && state.control.controller ? loadThreads() : loadThreadPreviews());
  if (state.control.mode === "web" && !state.models.length) work.push(loadModels().catch((error) => toast(`模型列表：${error.message}`)));
  if (!state.updateLoaded) work.push(loadUpdateStatus());
  await Promise.all(work);
  ensureDefaultProjectSelection();
}

function scheduleControlRefresh(reloadResources = false) {
  state.controlRefreshResources ||= reloadResources;
  clearTimeout(state.controlRefreshTimer);
  state.controlRefreshTimer = setTimeout(() => {
    const shouldReload = state.controlRefreshResources;
    state.controlRefreshResources = false;
    refreshControl({ reloadResources: shouldReload }).catch(() => {});
  }, 80);
}

async function loadUpdateStatus({ force = false } = {}) {
  state.updateLoaded = true;
  try {
    state.update = await api(`/api/update/status${force ? "?force=1" : ""}`);
    setWebVersion(state.update.currentVersion);
    const available = Boolean(state.update.updateAvailable);
    $("updateBanner").classList.toggle("hidden", !available || !state.socketConnected);
    if (!available) return;
    $("updateTitle").textContent = `发现新版本 v${state.update.latestVersion}`;
    $("updateDetail").textContent = `当前 v${state.update.currentVersion}；更新会在后台校验并无感替换文件，服务仅短暂重启。`;
    $("updateReleaseLink").href = state.update.releaseUrl || "#";
    $("updateNowBtn").disabled = !state.update.updaterAvailable || state.control?.mode !== "web";
    $("updateNowBtn").textContent = state.update.updaterAvailable ? "立即更新" : "请在主机更新";
  } catch (error) {
    state.updateLoaded = false;
  }
}

async function applyHostUpdate() {
  if (!state.update?.updateAvailable) return;
  if (!confirm(`无感更新到 v${state.update.latestVersion}？更新包校验完成后，服务会短暂断开并自动恢复，不会弹出安装窗口。`)) return;
  const button = $("updateNowBtn");
  button.disabled = true;
  button.textContent = "正在准备…";
  try {
    const result = await api("/api/update/apply", { method: "POST", body: {} });
    $("updateDetail").textContent = result.message || "主机正在下载并校验更新，稍后会自动重启。";
    toast("已通知主机更新，请保持页面打开，服务会自动重连");
  } catch (error) {
    button.disabled = false;
    button.textContent = "立即更新";
    toast(error.message);
  }
}

function renderControl() {
  const c = state.control || {};
  const backendDown = !c.codexReady;
  const preparing = Boolean(c.transition);
  const ownsBackend = c.mode === "web" || c.mode === "terminal";
  const readonly = c.mode !== "web" || backendDown;
  document.documentElement.classList.toggle("readonly-mode", readonly);
  $("statusDot").classList.toggle("ready", c.mode === "web" && c.codexReady);
  // Only "already in control with a ready backend" hides the button, and while
  // preparing the banner carries the progress; every other state (web+backend
  // down, available+ready, desktop running) keeps an escape hatch.
  $("takeoverBtn").classList.toggle("hidden", preparing || (c.mode === "web" && c.codexReady));
  // Recovery only applies to a backend this browser already controls; in
  // desktop/available the correct action is taking over, not recovering.
  $("recoverBtn")?.classList.toggle("hidden", !backendDown || !ownsBackend);
  renderPrepareState();
  // "Codex 已就绪" is only for an automatic preparation this tab watched finish
  // (control events are merged shallowly, so remember auto from the episode);
  // a manual takeover keeps its existing toast.
  if (preparing) state.prepareAuto = state.prepareAuto || c.takeoverState?.auto === true;
  else {
    if (state.controlTransition && c.codexReady && c.mode === "web" && (c.takeoverState?.auto === true || state.prepareAuto) && Date.now() - Number(state.prepareToastAt || 0) > 30_000) { state.prepareToastAt = Date.now(); toast("Codex 已就绪"); }
    if (state.pendingTakeover) {
      if (c.mode === "web" && c.codexReady) {
        const seconds = state.takeoverStartedAt ? Math.max(0.1, (Date.now() - state.takeoverStartedAt) / 1000).toFixed(1) : "";
        toast(seconds ? `接管完成 · 用时 ${seconds} 秒` : "接管完成");
        state.pendingTakeover = false;
        state.takeoverStartedAt = 0;
      } else if (c.takeoverState?.phase === "failed") {
        toast(`接管失败：${c.takeoverState.message || "请重试"}`);
        state.pendingTakeover = false;
        state.takeoverStartedAt = 0;
      }
    }
    state.prepareAuto = false;
  }
  state.controlTransition = preparing;
  $("releaseBtn").classList.toggle("hidden", c.mode !== "web" || !c.controller);
  $("fullAccessBtn").classList.toggle("hidden", c.mode !== "web" || !c.controller);
  $("fullAccessBtn").classList.toggle("enabled", Boolean(c.fullAccess));
  $("fullAccessBtn").textContent = c.fullAccess ? "完全访问：已开启" : "标准权限";
  $("fullAccessBtn").disabled = Boolean(c.transition);
  $("permissionShortcut").textContent = c.fullAccess ? "♧ 完全访问" : "♧ 标准权限";
  $("permissionShortcut").classList.toggle("enabled", Boolean(c.fullAccess));
  $("takeoverBtn").disabled = preparing || c.controllerBusy;
  $("takeoverBtn").textContent = preparing ? "正在准备…" : c.takeoverState?.phase === "failed" ? "重试接管" : c.takeoverState?.phase === "busy" ? "桌面任务运行中" : "接管 Codex";
  const activeCount = Object.keys(c.activeTurns || {}).length;
  const queuedCount = Number(c.queuedCount || 0);
  const clientCount = Number(c.webClientCount || 0);
  const browserMeta = c.browser?.verified ? "浏览器：正在使用" : (c.browser?.configured ? "浏览器：已配置" : (c.browser?.message ? `浏览器：${c.browser.message}` : "浏览器：等待接管"));
  const runtimeMeta = c.runtime?.selected ? `Codex ${c.runtime.selected.version}` : "Codex 后端待选择";
  $("controlMeta").textContent = c.mode === "web" ? `共享控制 · ${Math.max(1, clientCount)} 个 Web 端在线 · ${runtimeMeta} · ${browserMeta}${activeCount ? ` · ${activeCount} 个任务运行中` : ""}${queuedCount ? ` · ${queuedCount} 条排队` : ""}` : (c.desktopRunning ? `${c.desktopProcesses?.length || 0} 个桌面进程 · 仅可只读浏览` : "可安全接管");
  if (state.update?.updateAvailable) $("updateNowBtn").disabled = !state.update.updaterAvailable || c.mode !== "web";
  const labels = { desktop: '桌面端正在使用 · 只读跟随', available: '已连接 · 等待后端就绪', web: '已连接 · 可发送' };
  // Waiting for the automatic preparation must not read as "you have to take
  // over"; only a running desktop App needs a manual decision from the user.
  const pendingPrepare = c.mode !== "web" && backendDown && !c.desktopRunning;
  $("controlText").textContent = preparing ? (c.takeoverState?.message || "正在准备 Codex…") : (c.takeoverState?.phase === "failed" ? `接管失败：${c.takeoverState.message}` : (pendingPrepare ? "正在准备 Codex 后端…" : (labels[c.mode] || c.mode)));
  const canControl = c.mode === "web" && c.controller;
  // Reading and drafting are safe in read-only mode.  Keep the draft locally
  // while takeover finishes; only the action that changes Codex stays locked.
  $("messageInput").disabled = !state.current;
  $("sendMode").disabled = !canControl || !state.current;
  $("attachBtn").disabled = !state.current;
  $("sendBtn").disabled = !canControl || !state.current;
  $("permissionShortcut").disabled = !canControl;
  $("newThreadBtn").disabled = !canControl;
  if (c.mode !== "web" && !state.pendingThreadId && !state.current) $("messages").replaceChildren(emptyNode(preparing ? "正在准备 Codex，完成后即可开始对话" : c.desktopRunning ? "左侧可只读查看任务；接管后可以继续对话和操作" : "Codex 后端正在准备；就绪后即可开始对话"));
  if (state.current?.id && c.mode === "web") {
    const settings = c.threadSettings?.[state.current.id];
    if (settings && settings !== state.currentSettings) { state.currentSettings = settings; applyThreadSettings(settings); }
    if (c.threadTokenUsage?.[state.current.id]) state.tokenUsage = c.threadTokenUsage[state.current.id];
    const restored = c.activities?.[state.current.id];
    const running = c.activeTurns?.[state.current.id];
    state.activeTurnId = running || null;
    if (restored) setActivity(restored);
    else if (running && !state.activity) setActivity({ phase: "working", label: "正在处理", since: Date.now() });
    else if (!running) setActivity(null);
    if (c.threadStatuses?.[state.current.id]) applyThreadStatus(c.threadStatuses[state.current.id]);
    renderRuntimeCards(c.turnPlans?.[state.current.id], c.turnDiffs?.[state.current.id], { onlyMissing: true });
  }
  if (c.mode !== "web") { state.activeTurnId = null; setActivity(null); }
  renderInteraction();
  updateComposer();
}

async function takeover() {
  $("takeoverBtn").disabled = true; toast("正在检查任务状态并安全切换…");
  state.pendingTakeover = true;
  state.takeoverStartedAt = Date.now();
  let result = null;
  try { result = await api("/api/control/takeover", { method: "POST", body: { force: false }, timeout: 60000 }); }
  catch (error) {
    if (error.message.includes("强制接管") && confirm("桌面 Codex 仍有后台进程。强制接管可能丢失尚未发送的输入，是否继续？")) {
      try { await api("/api/control/takeover", { method: "POST", body: { force: true }, timeout: 60000 }); }
      catch (forceError) { state.pendingTakeover = false; state.takeoverStartedAt = 0; toast(forceError.message); await refreshControl().catch(() => {}); return; }
    }
    else {
      // A tunnel/client timeout does not cancel the server-side takeover. Keep
      // the banner alive so the user can see it finish instead of retrying into
      // a transition lock.
      if (error.name === "AbortError") { toast("接管仍在后台进行，请稍候…"); await refreshControl().catch(() => {}); return; }
      state.pendingTakeover = false;
      state.takeoverStartedAt = 0;
      toast(error.message);
      await refreshControl().catch(() => {});
      return;
    }
  }
  if (result?.alreadyControlled) {
    state.pendingTakeover = false;
    state.takeoverStartedAt = 0;
    toast("已经在共享控制中，可以直接发送");
    await refreshControl();
    return;
  }
  const pending = state.pendingThreadId;
  await refreshControl();
  if (pending && state.threads.some((thread) => thread.id === pending)) await openThread(pending);
  if (state.pendingTakeover && !state.control?.transition) { state.pendingTakeover = false; state.takeoverStartedAt = 0; }
}

// P1-1: when the Codex backend is down the Web shell must still offer a way
// back in, otherwise a wedged backend leaves the phone with no entry point.
async function recoverBackend() {
  const button = $("recoverBtn");
  if (button) { button.disabled = true; button.textContent = "正在恢复…"; }
  try {
    await api("/api/control/recover", { method: "POST", body: {} });
    toast("正在重启 Codex 后端…");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await refreshControl({ reloadResources: false }).catch(() => {});
      if (state.control?.codexReady) { toast("Codex 后端已恢复"); await resyncAfterGap(); return; }
    }
    toast("等待后端恢复超时，请在主机上检查 Codex");
  } catch (error) { toast(error.message); }
  finally { if (button) { button.disabled = false; button.textContent = "恢复后端"; } }
}

async function toggleFullAccess() {
  const enabled = !state.control?.fullAccess;
  const message = enabled
    ? "开启后，Codex 可以访问工作区外的文件和网络，并且不再逐项请求批准。是否开启完全访问？"
    : "切换到标准权限后，敏感命令、工作区外写入和网络访问可能需要逐项批准。是否切换？";
  if (!confirm(message)) return;
  try { await api("/api/control/full-access", { method: "POST", body: { enabled } }); await refreshControl(); toast(enabled ? "完全访问已开启，下一条消息开始生效" : "已切换到标准权限"); }
  catch (error) { toast(error.message); }
}

async function releaseControl() {
  try { await api("/api/control/release", { method: "POST", body: { threadId: state.current?.id, discardQueue: false } }); toast("已释放，正在打开桌面 App"); await refreshControl(); }
  catch (error) {
    if (error.message.includes("排队消息") && confirm(`${error.message}。清空队列并释放吗？`)) { await api("/api/control/release", { method: "POST", body: { threadId: state.current?.id, discardQueue: true } }); await refreshControl(); }
    else toast(error.message);
  }
}

async function loadThreadIndex(url, key) {
  return singleFlight(key, async () => {
    if (!state.threads.length) {
      state.threadListStatus = "loading";
      state.threadListError = "";
      renderThreads();
    }
    try {
      const result = await api(url);
      state.threads = Array.isArray(result.data) ? result.data : [];
      state.threadListStatus = "ready";
      state.threadListError = "";
      renderThreads();
    } catch (error) {
      state.threadListStatus = state.threads.length ? "ready" : "error";
      state.threadListError = error?.message || "任务列表加载失败";
      renderThreads();
    }
  });
}
async function loadThreads() { return loadThreadIndex("/api/threads", "threads"); }
async function loadThreadPreviews() { return loadThreadIndex("/api/thread-previews", "thread-previews"); }
async function loadProjects(preferredId = null) {
  const result = await api("/api/projects");
  state.projects = Array.isArray(result.data) ? result.data : [];
  const validProjectId = (id) => Boolean(id) && state.projects.some((project) => project.id === id);
  if (!state.projectsLoaded || preferredId !== null) {
    if (preferredId !== null) {
      state.selectedProjectId = validProjectId(preferredId) ? preferredId : "";
      projectDefaultApplied = validProjectId(preferredId);
    } else {
      const currentMatch = state.current?.cwd ? state.projects.find((project) => projectMatchesThread(project, state.current.cwd)) : null;
      const routeProject = readRoute().projectId;
      state.selectedProjectId = [routeProject, currentMatch?.id, readLastOpenedProjectPreference(), readProjectPreference(), state.projects[0]?.id]
        .find((id) => validProjectId(id)) || "";
      projectDefaultApplied = false;
    }
    state.projectsLoaded = true;
  } else if (state.selectedProjectId && !state.projects.some((project) => project.id === state.selectedProjectId)) {
    state.selectedProjectId = "";
    projectDefaultApplied = false;
  }
  if (projectDefaultApplied && state.selectedProjectId) rememberLastOpenedProject(state.selectedProjectId);
  if (projectDefaultApplied) writeProjectPreference(state.selectedProjectId);
  renderProjects(); renderThreads();
}
async function loadModels() { return singleFlight("models", async () => { const result = await api("/api/models"); state.models = result.data || []; renderModels(); }); }
function currentModelValue() { return state.currentSettings?.model || state.current?.model || $("modelSelect").value || state.models[0]?.model || state.models[0]?.id || ""; }
function renderModels() {
  const select = $("modelSelect"); const current = currentModelValue(); const options = [];
  for (const model of state.models) { const value = model.model || model.id; if (value) options.push(new Option(model.displayName || model.name || value, value)); }
  if (current && !options.some((item) => item.value === current)) options.unshift(new Option(current, current));
  if (!options.length) options.push(new Option(current || "模型加载中…", current));
  select.replaceChildren(...options); select.value = options.some((item) => item.value === current) ? current : options[0].value; renderEfforts();
}
function renderEfforts() {
  const select = $("effortSelect"); const model = state.models.find((item) => (item.model || item.id) === $("modelSelect").value); const values = (model?.supportedReasoningEfforts || []).map((item) => typeof item === "string" ? item : (item.reasoningEffort || item.effort || item.value)).filter(Boolean);
  const labels = { none: "无思考", minimal: "极轻", low: "轻度", medium: "中等", high: "较深", xhigh: "深度", max: "最深", ultra: "Ultra" };
  const current = state.currentSettings?.effort || select.value || model?.defaultReasoningEffort || model?.default_reasoning_effort || (values.includes("medium") ? "medium" : values[0] || "");
  const options = values.map((value) => new Option(labels[value] || value, value));
  if (current && !options.some((item) => item.value === current)) options.unshift(new Option(labels[current] || current, current));
  if (!options.length) options.push(new Option(current ? (labels[current] || current) : "强度加载中…", current));
  select.replaceChildren(...options); select.value = options.some((item) => item.value === current) ? current : options[0].value;
}

async function createThread(cwdOverride = "") {
  if (state.control?.mode !== "web") return toast("请先接管 Codex");
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  const cwd = typeof cwdOverride === "string" && cwdOverride ? cwdOverride : (project?.path || state.current?.cwd || "");
  if (!cwd) { state.createAfterProject = true; openProjectModal(true); return toast("先添加或选择一个项目文件夹"); }
  $("newThreadBtn").disabled = true;
  try {
    const result = await api("/api/threads", { method: "POST", body: { cwd, model: $("modelSelect").value, effort: $("effortSelect").value } });
    await loadThreads();
    if (result.thread?.id && !state.threads.some((thread) => thread.id === result.thread.id)) { state.threads.unshift(result.thread); renderThreads(); }
    await openThread(result.thread.id); $("messageInput").focus(); toast(`已在 ${project?.name || folderName(cwd)} 中创建任务`);
  } catch (error) { toast(error.message); }
  finally { $("newThreadBtn").disabled = state.control?.mode !== "web"; }
}

function renderProjects() {
  const nodes = [];
  const all = document.createElement("button");
  all.type = "button"; all.className = `project-all${state.selectedProjectId === "" ? " active" : ""}`; all.textContent = "所有项目";
  all.addEventListener("click", () => selectProject("")); nodes.push(all);
  for (const project of state.projects) {
    const item = document.createElement("div"); item.className = `project-item${state.selectedProjectId === project.id ? " active" : ""}`;
    const choose = document.createElement("button"); choose.type = "button"; choose.className = "project-choose"; choose.title = project.path;
    const icon = document.createElement("span"); icon.textContent = "▱";
    const copy = document.createElement("span"); const name = document.createElement("strong"); name.textContent = project.name; const projectPath = document.createElement("small"); projectPath.textContent = project.path; copy.append(name, projectPath); choose.append(icon, copy);
    choose.addEventListener("click", () => selectProject(project.id));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "project-remove"; remove.textContent = "×"; remove.title = "从列表移除"; remove.setAttribute("aria-label", `移除 ${project.name}`); remove.addEventListener("click", () => removeProject(project));
    item.append(choose, remove); nodes.push(item);
  }
  $("projectList").replaceChildren(...nodes);
}

function selectProject(id) {
  state.selectedProjectId = id;
  projectDefaultApplied = true;
  if (id) rememberLastOpenedProject(id);
  writeProjectPreference(id);
  writeRoute(state.current?.id, id);
  renderProjects();
  renderThreads();
}

async function removeProject(project) {
  if (!confirm(`从 Web 项目列表移除“${project.name}”？电脑里的文件和对话记录不会删除。`)) return;
  try { await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" }); await loadProjects(state.selectedProjectId === project.id ? "" : state.selectedProjectId); toast("已从项目列表移除，文件未删除"); }
  catch (error) { toast(error.message); }
}

function threadTitle(thread = {}) {
  return String(thread.name || thread.preview || thread.title || '未命名任务');
}

function syncCurrentThreadTitle() {
  const id = state.current?.id;
  if (!id) return;
  const thread = state.threads.find((item) => item.id === id);
  const title = threadTitle(thread || state.current);
  if (!title) return;
  if (state.current?.preview !== title) state.current = { ...state.current, name: title, preview: title };
  const cached = state.threadViews.get(id);
  if (cached?.result?.thread) {
    cached.result.thread = { ...cached.result.thread, name: title, preview: title };
    void cacheView(id, cached);
  }
  if ($('chatTitle').textContent !== title) $('chatTitle').textContent = title;
}

function renderThreads() {
  for (const thread of state.threads) {
    const title = threadTitle(thread);
    if (!title || title === thread.preview) continue;
    if (!thread.messagePreview && thread.preview) thread.messagePreview = thread.preview;
    thread.name = thread.name || title;
    thread.preview = title;
  }
  syncCurrentThreadTitle();
  return renderThreadsLegacy();
}

function renderThreadsLegacy() {
  const query = $("search").value.trim().toLowerCase();
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  const list = state.threads
    .filter((thread) => (!project || projectMatchesThread(project, thread.cwd)) && `${thread.preview || thread.id} ${thread.cwd || ""}`.toLowerCase().includes(query))
    .sort((left, right) => threadTimestamp(right) - threadTimestamp(left));
  const signature = JSON.stringify([query, state.selectedProjectId, state.current?.id, state.pendingThreadId, state.threadListStatus, state.threadListError, list.map((thread) => [thread.id, thread.preview, threadTimestamp(thread), !!state.control?.activeTurns?.[thread.id]])]);
  if (state.threadListSignature === signature) return;
  state.threadListSignature = signature;
  const nodes = list.map((thread) => {
    const row = document.createElement("div"); row.className = `thread-row${(state.current?.id || state.pendingThreadId) === thread.id ? " active" : ""}`;
    const b = document.createElement("button"); b.className = "thread"; b.type = "button";
    const head = document.createElement("div"); head.className = "thread-head"; const title = document.createElement("strong"); title.textContent = thread.preview || "未命名任务"; head.append(title);
    if (state.control?.activeTurns?.[thread.id]) { const live = document.createElement("i"); live.className = "thread-live"; live.title = "正在运行"; head.append(live); }
    const queued = Number(state.control?.queuedByThread?.[thread.id] || 0);
    if (queued) { const badge = document.createElement("b"); badge.className = "thread-queue"; badge.textContent = queued; badge.title = `${queued} 条排队消息`; head.append(badge); }
    const meta = document.createElement("small"); meta.textContent = formatDate(threadTimestamp(thread)); b.append(head, meta);
    b.addEventListener("pointerenter", () => prefetchThreadSnapshot(thread)); b.addEventListener("touchstart", () => prefetchThreadSnapshot(thread), { passive: true }); b.addEventListener("focus", () => prefetchThreadSnapshot(thread)); b.addEventListener("click", () => state.control?.mode === "web" ? openThread(thread.id) : previewThread(thread));
    const actions = document.createElement("button"); actions.type = "button"; actions.className = "thread-actions"; actions.textContent = "⋯"; actions.title = state.control?.mode === "web" ? "重命名、归档或删除任务" : "接管 Codex 后可管理任务"; actions.setAttribute("aria-label", actions.title); actions.disabled = state.control?.mode !== "web"; actions.addEventListener("click", (event) => { event.stopPropagation(); openThreadActions(thread, actions); });
    row.append(b, actions); return row;
  });
  if (!nodes.length) {
    const empty = document.createElement("div"); empty.className = "thread-list-empty";
    if (state.threadListStatus === "loading") empty.textContent = "正在读取任务…";
    else if (state.threadListStatus === "error") empty.textContent = state.threadListError ? `任务列表加载失败：${state.threadListError}` : "任务列表加载失败，将自动重试";
    else empty.textContent = project ? "这个项目还没有任务" : "暂无任务";
    nodes.push(empty);
  }
  $("threadList").replaceChildren(...nodes);
}
let threadRenderFrame = 0;
function scheduleThreadRender() { if (threadRenderFrame) return; threadRenderFrame = requestAnimationFrame(() => { threadRenderFrame = 0; renderThreads(); }); }

function openProjectModal(createAfter = false) {
  state.createAfterProject = createAfter;
  const selected = state.projects.find((item) => item.id === state.selectedProjectId);
  $("projectName").value = "";
  $("projectPath").value = selected?.path || state.current?.cwd || "";
  $("projectError").textContent = "";
  $("projectModal").classList.remove("hidden"); document.body.classList.add("modal-open");
  loadDirectory($("projectPath").value.trim()).catch(() => {});
  setTimeout(() => ($("projectPath").value ? $("projectName") : $("projectPath")).focus(), 0);
}

function hideProjectModal() { $("projectModal").classList.add("hidden"); document.body.classList.remove("modal-open"); }
function closeProjectModal() { if ($("projectModal").classList.contains("hidden")) return; state.createAfterProject = false; hideProjectModal(); }

async function saveProject(event) {
  event.preventDefault();
  const pathValue = $("projectPath").value.trim();
  if (!pathValue) { $("projectError").textContent = "请选择或输入项目文件夹"; return; }
  const button = $("projectSaveBtn"); button.disabled = true; button.textContent = "正在添加…"; $("projectError").textContent = "";
  try {
    const result = await api("/api/projects", { method: "POST", body: { path: pathValue, name: $("projectName").value.trim() } });
    const createAfter = state.createAfterProject; state.createAfterProject = false; hideProjectModal();
    await loadProjects(result.project.id); closeSidebar(); toast(`已添加项目：${result.project.name}`);
    if (createAfter) await createThread(result.project.path);
  } catch (error) { $("projectError").textContent = error.message; }
  finally { button.disabled = false; button.textContent = "添加并使用"; }
}

async function loadDirectory(directoryPath = "") {
  $("directoryBrowser").classList.remove("hidden");
  $("directoryCurrent").textContent = "正在读取…"; $("directoryList").replaceChildren(); $("projectError").textContent = "";
  try {
    const query = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : "";
    state.directory = await api(`/api/directories${query}`);
    $("directoryCurrent").textContent = state.directory.current || "选择磁盘";
    $("directoryUpBtn").disabled = !state.directory.current;
    $("directorySelectBtn").disabled = !state.directory.current;
    const nodes = state.directory.entries.map((entry) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "directory-entry"; button.title = entry.path;
      const icon = document.createElement("span"); icon.textContent = state.directory.current ? "▱" : "▣";
      const name = document.createElement("strong"); name.textContent = entry.name; button.append(icon, name); button.addEventListener("click", () => loadDirectory(entry.path)); return button;
    });
    if (!nodes.length) { const empty = document.createElement("p"); empty.className = "directory-empty"; empty.textContent = "这个目录没有子文件夹，可直接选择当前目录"; nodes.push(empty); }
    $("directoryList").replaceChildren(...nodes);
  } catch (error) { state.directory = null; $("directoryCurrent").textContent = "无法读取"; $("directoryUpBtn").disabled = true; $("directorySelectBtn").disabled = true; $("projectError").textContent = error.message; }
}

function selectCurrentDirectory() {
  if (!state.directory?.current) return;
  $("projectPath").value = state.directory.current;
  if (!$("projectName").value) $("projectName").value = folderName(state.directory.current);
}

function projectForThread(thread) {
  return state.projects.find((project) => projectMatchesThread(project, thread?.cwd)) || null;
}
function mostRecentProjectId() {
  let bestId = '';
  let bestAt = -1;
  for (const thread of state.threads) {
    const project = projectForThread(thread);
    const at = threadTimestamp(thread);
    if (project && at > bestAt) { bestId = project.id; bestAt = at; }
  }
  if (bestId) return bestId;
  return [...state.projects]
    .sort((a, b) => threadTimestamp(b) - threadTimestamp(a))[0]?.id || '';
}
function ensureDefaultProjectSelection() {
  if (projectDefaultApplied || !state.projects.length) return;
  const valid = (id) => Boolean(id) && state.projects.some((project) => project.id === id);
  const route = readRoute();
  const routeThread = state.threads.find((thread) => thread.id === route.threadId)
    || state.threads.find((thread) => thread.id === readLastThreadPreference());
  const threadProject = projectForThread(routeThread) || projectForThread(state.current);
  const chosen = [route.projectId, threadProject?.id, readLastOpenedProjectPreference(), mostRecentProjectId(), state.projects[0]?.id]
    .find((id) => valid(id));
  if (!chosen) return;
  state.selectedProjectId = chosen;
  projectDefaultApplied = true;
  rememberLastOpenedProject(chosen);
  writeProjectPreference(chosen);
  renderProjects();
  renderThreads();
}
function folderName(value) { const parts = String(value || "").replace(/[\\/]+$/, "").split(/[\\/]/); return parts.at(-1) || value; }
function readProjectPreference() { try { const value = localStorage.getItem("codex-web-project-id"); return value === "__all__" ? "" : value; } catch { return null; } }
function writeProjectPreference(value) { try { localStorage.setItem("codex-web-project-id", value || "__all__"); } catch { } }
function readLastOpenedProjectPreference() { try { return localStorage.getItem(LAST_OPENED_PROJECT_KEY) || ""; } catch { return ""; } }
function rememberLastOpenedProject(id) { if (!id) return; try { localStorage.setItem(LAST_OPENED_PROJECT_KEY, id); } catch { } }
function readLastThreadPreference() { try { return localStorage.getItem("codex-web-last-thread") || ""; } catch { return ""; } }
function writeLastThreadPreference(id) { try { if (id) localStorage.setItem("codex-web-last-thread", id); } catch { } }
async function restoreLastThread() {
  const route = readRoute();
  const id = route.threadId || readLastThreadPreference();
  if (!id || state.current?.id === id) return;
  const preview = state.threads.find((thread) => thread.id === id);
  if (!preview && !route.threadId) return;
  await openThread(id, { route: false });
}

async function previewThread(thread) { return openThread(thread.id); }

async function renameThread(thread = state.current) {
  const id = thread?.id;
  if (!id) return;
  if (state.control?.mode !== 'web' || !state.control?.controller) return toast('请先接管 Codex，再修改任务名称');
  const value = prompt('输入新的任务名称', threadTitle(thread));
  if (value === null) return;
  const name = value.trim();
  if (name.length > 200) return toast('任务名称不能超过 200 个字符');
  try {
    const result = await api(`/api/threads/${encodeURIComponent(id)}/rename`, { method: 'POST', body: { name } });
    const next = name || threadTitle(result.thread) || threadTitle(thread);
    state.threads = state.threads.map((thread) => thread.id === id ? { ...thread, name: next, preview: next } : thread);
    if (state.current?.id === id) {
      state.current = { ...state.current, name: next, preview: next };
      $('chatTitle').textContent = next;
    }
    renderThreads();
    toast('任务名称已更新');
  } catch (error) { toast(error.message); }
}

function renameCurrentThread() { return renameThread(state.current); }

let threadActionMenu = null;

function closeThreadActionMenu() {
  if (!threadActionMenu) return;
  threadActionMenu.remove();
  threadActionMenu = null;
  document.removeEventListener('pointerdown', onThreadMenuOutside, true);
  document.removeEventListener('keydown', onThreadMenuKey, true);
  window.removeEventListener('resize', closeThreadActionMenu);
  window.removeEventListener('scroll', closeThreadActionMenu, true);
}
function onThreadMenuOutside(event) { if (threadActionMenu && !threadActionMenu.contains(event.target)) closeThreadActionMenu(); }
function onThreadMenuKey(event) { if (event.key === 'Escape') closeThreadActionMenu(); }
function threadMenuButton(label, className, disabled, hint, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className || '';
  button.textContent = label;
  button.disabled = Boolean(disabled);
  button.setAttribute('role', 'menuitem');
  if (hint) button.title = hint;
  if (!disabled) button.addEventListener('click', (event) => { event.stopPropagation(); handler(); });
  return button;
}
function openThreadActions(thread, anchor) {
  if (state.control?.mode !== 'web') return toast('请先接管 Codex 才能管理任务');
  closeThreadActionMenu();
  const running = Boolean(state.control?.activeTurns?.[thread.id]);
  const queued = Number(state.control?.queuedByThread?.[thread.id] || 0);
  const blockedHint = running ? '任务正在运行，暂时不能归档或删除' : '任务还有排队消息，请先清空队列';
  const menu = document.createElement('div');
  menu.className = 'thread-action-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '任务操作');
  menu.append(
    threadMenuButton('✎ 重命名', '', false, '', () => { closeThreadActionMenu(); void renameThread(thread); }),
    threadMenuButton('归档任务', '', running || queued, blockedHint, () => {
      closeThreadActionMenu();
      if (confirm(`归档“${threadTitle(thread)}”？\n归档后会从桌面 App 和 Web 的当前任务列表移除，可在以后恢复。`)) void removeThread(thread, 'archive');
    }),
    threadMenuButton('永久删除', 'danger', running || queued, blockedHint, () => {
      closeThreadActionMenu();
      if (confirm(`永久删除“${threadTitle(thread)}”？\n\n这会删除桌面 App 和 Web 中的同一份对话记录，无法恢复。`)) void removeThread(thread, 'delete');
    }),
  );
  document.body.append(menu);
  threadActionMenu = menu;
  const rect = anchor?.getBoundingClientRect?.() || { right: window.innerWidth - 12, bottom: 80, top: 40 };
  const left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth));
  let top = rect.bottom + 6;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - menu.offsetHeight - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  setTimeout(() => document.addEventListener('pointerdown', onThreadMenuOutside, true), 0);
  document.addEventListener('keydown', onThreadMenuKey, true);
  window.addEventListener('resize', closeThreadActionMenu);
  window.addEventListener('scroll', closeThreadActionMenu, true);
}

async function removeThread(thread, action) {
  const threadId = thread.id;
  try {
    const url = `/api/threads/${encodeURIComponent(threadId)}${action === "archive" ? "/archive" : ""}`;
    await api(url, { method: action === "archive" ? "POST" : "DELETE", body: {} });
    state.threads = state.threads.filter((item) => item.id !== threadId);
    state.threadViews.delete(threadId);
    if (state.current?.id === threadId) { state.current = null; state.pendingThreadId = null; state.queue = []; $("messages").replaceChildren(emptyNode("任务已移除")); $("chatTitle").textContent = "选择一个任务"; $("chatMeta").textContent = "任务已从桌面 App 与 Web 同步移除"; }
    renderThreads(); renderQueue(); updateComposer();
    toast(action === "archive" ? "任务已归档，并已同步到桌面 App" : "任务已永久删除，并已同步到桌面 App");
  } catch (error) { toast(error.message); }
}

async function checkForUpdates() {
  const button = $("updateCheckBtn");
  button.disabled = true;
  button.textContent = "正在检查…";
  try {
    await loadUpdateStatus({ force: true });
    if (state.update?.updateAvailable) toast(`发现新版本 v${state.update.latestVersion}`);
    else toast(`当前已是最新版 v${state.update?.currentVersion || "--"}`);
  } catch (error) {
    toast(error.message || "检查更新失败");
  } finally {
    button.disabled = false;
    button.innerHTML = "<span>↻</span> 检查更新";
  }
}
async function prefetchThreadSnapshot(thread) {
  const id = thread?.id;
  if (!id || state.threadViews.has(id) || prefetchThreads.has(id)) return;
  prefetchThreads.add(id);
  try {
    const result = await api(`/api/v2/threads/${encodeURIComponent(id)}/view?limit=60`);
    if (result?.thread?.id) rememberThreadView(id, result, null);
  } catch { }
  finally { prefetchThreads.delete(id); }
}

async function openThread(id, { route = true } = {}) {
  if (state.current?.id === id && !state.threadSyncing) { closeSidebar(); return; }
  saveDraft();
  saveCurrentThreadView();
  if (state.current?.id) workspaceAttachments.set(state.current.id, state.attachments);
  state.threadOpenController?.abort();
  const controller = new AbortController(); state.threadOpenController = controller;
  const descriptor = state.threads.find((thread) => thread.id === id) || { id, preview: "Codex 任务", cwd: "" };
  state.pendingThreadId = id; state.threadSyncing = true; state.current = { ...descriptor, turns: [] }; state.queue = [];
  let savedAttachments = []; try { savedAttachments = JSON.parse(localStorage.getItem(`codex-web-attachments:${id}`) || '[]'); } catch { }
  state.attachments = workspaceAttachments.get(id) || savedAttachments; renderAttachments(); restoreDraft(id);
  if (route) writeRoute(id, state.selectedProjectId);
  $("chatTitle").textContent = descriptor.preview || "Codex 任务"; $("chatMeta").textContent = `${descriptor.cwd || id} · 正在同步 Codex`;
  if (viewThreadId !== id) $('messages').replaceChildren(emptyNode('正在读取最新对话…'));
  renderThreads(); renderQueue(); closeSidebar(); updateComposer();

  let cachedView = readThreadView(id);
  if (!cachedView) { cachedView = await Promise.race([restoreView(id), new Promise((resolve) => setTimeout(() => resolve(null), 150))]); if (state.threadOpenController !== controller) return; }
  if (cachedView) applyThreadResult(cachedView.result, id, { syncing: true, restoreScroll: cachedView.followTail === false ? cachedView.scrollTop : null });
  try {
    const syncController = new AbortController();
    const stopSync = () => syncController.abort();
    controller.signal.addEventListener("abort", stopSync, { once: true });
    const syncTimer = setTimeout(() => syncController.abort(), 10_000);
    let result;
    try {
      try { result = await api(`/api/v2/threads/${encodeURIComponent(id)}/view?limit=60`, { signal: syncController.signal }); }
      catch (error) {
        if (error.status !== 404 || state.control?.mode !== 'web' || !state.control?.controller) throw error;
        // Only a Web owner may recover an empty, non-persisted task. Ordinary
        // history reads never resume a task or interfere with the desktop.
        result = await api(`/api/threads/${encodeURIComponent(id)}`, { signal: syncController.signal });
      }
    } finally {
      clearTimeout(syncTimer);
      controller.signal.removeEventListener("abort", stopSync);
    }
    if (state.threadOpenController !== controller) return;
    const actualId = result.thread?.id || id;
    if (result.replacedThreadId) {
      state.threads = state.threads.filter((thread) => thread.id !== result.replacedThreadId && thread.id !== actualId);
      state.threads.unshift(result.thread); toast("空任务已恢复，可以继续输入");
      writeRoute(actualId, state.selectedProjectId, true);
    }
    const restoreScroll = state.followTail ? null : $("messages").scrollTop;
    applyThreadResult(result, actualId, { syncing: false, restoreScroll });
    if (result.replacedThreadId) { clearDraft(result.replacedThreadId); saveDraft(); renderAttachments(); workspaceAttachments.set(actualId, state.attachments); }
    renderThreads(); loadQueue().catch(() => {}); updateComposer();
  } catch (error) {
    if (state.threadOpenController !== controller) return;
    if (state.current?.id === id && state.current?.turns?.length) {
      state.pendingThreadId = null;
      state.threadSyncing = false;
      $("chatMeta").textContent = `${descriptor.cwd || id} · 已显示本地快照；同步失败，可重试或继续发送`;
      renderThreads(); updateComposer();
      toast(`任务同步失败：${error.message}`);
      return;
    }
    state.pendingThreadId = null; state.threadSyncing = false;
    $("chatMeta").textContent = `${descriptor.cwd || id} · 同步失败，可点击任务重试`;
    renderThreads(); updateComposer(); toast(error.message);
  } finally { if (state.threadOpenController === controller) { state.threadSyncing = false; state.pendingThreadId = null; updateComposer(); } }
}


function applyThreadResult(result, id = result.thread?.id, { syncing = false, restoreScroll = null } = {}) {
  const changedThread = viewThreadId !== id;
  state.current = result.thread;
  writeLastThreadPreference(id);
  const openedProject = projectForThread(result.thread);
  if (openedProject) rememberLastOpenedProject(openedProject.id);
  state.threadSyncing = syncing;
  if (changedThread) { state.queue = []; renderQueue(); }
  const inferredSettings = {
    model: result.thread?.model || '',
    effort: result.thread?.reasoningEffort || result.thread?.reasoning_effort || result.thread?.effort || '',
    summary: result.thread?.summary || '',
  };
  state.currentSettings = result.threadSettings || state.control?.threadSettings?.[id] || (Object.values(inferredSettings).some(Boolean) ? inferredSettings : null);
  state.threadStatus = result.thread?.status || state.control?.threadStatuses?.[id] || null;
  state.tokenUsage = result.tokenUsage || state.control?.threadTokenUsage?.[id] || null;
  state.pendingRequests = mergePendingRequests(state.control?.pendingRequests || [], result.pendingRequests || []);
  state.pendingThreadId = null;
  if (result.page) pageCursor = !changedThread && !state.followTail && pageCursor != null ? String(Math.min(Number(pageCursor), Number(result.page.before ?? pageCursor))) : result.page.before;
  else if (changedThread) pageCursor = null;
  // openThread restored this draft before the request. Do not overwrite input
  // typed while the snapshot was loading (including recovered empty tasks).
  if (changedThread) { state.followTail = !Number.isFinite(restoreScroll); renderModels(); }
  applyThreadSettings(state.currentSettings);
  state.activeTurnId = state.control?.mode === 'web' ? (Object.hasOwn(result, 'activeTurnId') ? result.activeTurnId : state.control?.activeTurns?.[id] || null) : result.thread.status?.type === 'active' ? result.thread.turns?.at(-1)?.id || null : null;
  setActivity(state.control?.activities?.[id] || (state.activeTurnId ? { phase: "working", label: "正在处理", since: Date.now() } : null));
  $("chatTitle").textContent = result.thread.preview || "Codex 任务"; $("chatMeta").textContent = `${result.thread.cwd || id}${syncing ? " · 已显示缓存，正在同步" : ""}`;
  renderHistory(result.thread.turns || [], { restoreScroll, reset: changedThread });
  viewThreadId = id;
  renderRuntimeCards(result.turnPlan || state.control?.turnPlans?.[id], result.turnDiff || state.control?.turnDiffs?.[id]);
  renderInteraction(); rememberThreadView(id, currentViewResult(result), restoreScroll ?? $("messages").scrollTop); updateComposer();
  renderOutbox(); renderActivityPanel();
}

function renderHistory(turns, { restoreScroll = null, reset = viewThreadId !== state.current?.id } = {}) {
  const incoming = turns.flatMap((turn) => (turn.items || []).map((item, index) => ({ ...item, id: item.id || `${turn.id}:${index}`, turnId: turn.id })));
  for (const item of incoming) if (item.type === 'userMessage') removeMatchingLocalUserEcho(textFromContent(item.content), item);
  if (reset) { resetMessageCaches(); state.historyItems = incoming; $('messages').replaceChildren(); state.historyWindowReadyAt = Date.now() + 300; }
  else state.historyItems = mergeItems(state.historyItems, incoming);
  if (!reset && !state.followTail) {
    for (const item of incoming) { const node = findItemNode(item.id); if (node) patchHistoryNode(node, item); }
    refreshHistoryNavigation(); return;
  }
  state.historyVisibleStart = Math.max(0, state.historyItems.length - (Number.isFinite(restoreScroll) ? HISTORY_DOM_LIMIT : HISTORY_BATCH_SIZE));
  state.historyVisibleEnd = state.historyItems.length;
  const nodes = state.historyItems.slice(state.historyVisibleStart, state.historyVisibleEnd).map((item, offset) => {
    const old = findItemNode(item.id); const node = old ? patchHistoryNode(old, item) : historyItemNode(item, state.historyVisibleStart + offset);
    if (node) node.dataset.historyIndex = String(state.historyVisibleStart + offset); return node;
  }).filter(Boolean);
  const more = historyMoreNode();
  const messages = $('messages');
  const keep = new Set(nodes);
  for (const child of [...messages.children]) if (!keep.has(child) && child.dataset.localUser !== 'true') child.remove();
  if (more) messages.prepend(more);
  for (const node of nodes) messages.append(node);
  if (!nodes.length && !messages.children.length) messages.append(emptyNode('这个任务暂时没有可显示的消息'));
  if (Number.isFinite(restoreScroll)) requestAnimationFrame(() => { $("messages").scrollTop = restoreScroll; updateFollowTail(); });
  else scrollBottom(true);
}
function patchHistoryNode(old, item) {
  const fingerprint = JSON.stringify(item);
  if (old.dataset.fingerprint === fingerprint) return old;
  const open = old.tagName === 'DETAILS' ? old.open : null;
  const node = historyItemNode(item); node.dataset.fingerprint = fingerprint;
  if (open != null) node.open = open;
  old.replaceWith(node); state.itemNodes.set(String(item.id), node); return node;
}
function historyItemNode(item, index = -1) { const node = itemNode(item, { lazy: true }); if (!node) return null; node.classList.add("history-item"); node.dataset.fingerprint = JSON.stringify(item); if (index >= 0) node.dataset.historyIndex = String(index); if (item.id) { node.dataset.itemId = item.id; state.itemNodes.set(String(item.id), node); } return node; }
function historyMoreNode() {
  if (!state.historyVisibleStart && !pageCursor) return null;
  const button = document.createElement("button"); button.type = "button"; button.className = "history-more"; button.textContent = `加载更早的 ${state.historyVisibleStart} 条内容`;
  button.textContent = pageLoading ? '正在读取更早内容…' : '向上滚动，自动加载更早内容'; button.disabled = pageLoading;
  button.addEventListener("click", renderEarlierHistory); return button;
}
function historyLaterNode() {
  if (state.historyVisibleEnd >= state.historyItems.length) return null;
  const button = document.createElement("button"); button.type = "button"; button.className = "history-more history-later"; button.textContent = `返回较新的 ${state.historyItems.length - state.historyVisibleEnd} 条内容`;
  button.addEventListener("click", renderLaterHistory); return button;
}
function refreshHistoryNavigation() {
  const messages = $("messages");
  messages.querySelector(":scope > .history-more:not(.history-later)")?.remove();
  messages.querySelector(":scope > .history-later")?.remove();
  const first = messages.querySelector(":scope > .history-item");
  const more = historyMoreNode(); if (more) messages.insertBefore(more, first || messages.firstChild);
  const later = historyLaterNode(); if (later) messages.append(later);
}
function trimHistoryWindow(edge) {
  const count = state.historyVisibleEnd - state.historyVisibleStart;
  if (count <= HISTORY_DOM_LIMIT) return;
  const removeCount = count - HISTORY_DOM_LIMIT;
  if (edge === "newer") {
    const cutoff = state.historyVisibleEnd - removeCount;
    for (const node of $("messages").querySelectorAll(":scope > .history-item")) if (Number(node.dataset.historyIndex) >= cutoff) node.remove();
    state.historyVisibleEnd = cutoff;
  } else {
    const cutoff = state.historyVisibleStart + removeCount;
    for (const node of $("messages").querySelectorAll(":scope > .history-item")) if (Number(node.dataset.historyIndex) < cutoff) node.remove();
    state.historyVisibleStart = cutoff;
  }
}
async function renderEarlierHistory() {
  if (pageLoading) return;
  if (state.historyVisibleStart === 0 && pageCursor && state.current?.id) {
    pageLoading = true; const id = state.current.id;
    try {
      const result = await api(`/api/v2/threads/${encodeURIComponent(id)}/view?limit=60&before=${encodeURIComponent(pageCursor)}`);
      if (state.current?.id !== id) return;
      const previousCount = state.historyItems.length;
      const incoming = result.thread.turns.flatMap((turn) => turn.items.map((item) => ({ ...item, turnId: turn.id })));
      state.historyItems = mergeItems(state.historyItems, incoming, true);
      state.historyVisibleStart += state.historyItems.length - previousCount;
      state.historyVisibleEnd += state.historyItems.length - previousCount;
      pageCursor = result.page.before;
    } catch (error) { toast(`更早内容读取失败：${error.message}`); return; }
    finally { pageLoading = false; }
  }
  const messages = $("messages"); const previousHeight = messages.scrollHeight; const previousTop = messages.scrollTop;
  const nextStart = Math.max(0, state.historyVisibleStart - HISTORY_BATCH_SIZE);
  const nodes = state.historyItems.slice(nextStart, state.historyVisibleStart).map((item, offset) => historyItemNode(item, nextStart + offset)).filter(Boolean);
  state.historyVisibleStart = nextStart;
  messages.querySelector(":scope > .history-more")?.remove();
  const anchor = messages.firstChild;
  const fragment = document.createDocumentFragment(); const more = historyMoreNode(); if (more) fragment.append(more); for (const node of nodes) fragment.append(node);
  messages.insertBefore(fragment, anchor);
  trimHistoryWindow("newer");
  refreshHistoryNavigation();
  requestAnimationFrame(() => { messages.scrollTop = previousTop + messages.scrollHeight - previousHeight; updateFollowTail(); });
}
function renderLaterHistory() {
  const messages = $("messages"); const previousHeight = messages.scrollHeight; const previousTop = messages.scrollTop;
  const previousEnd = state.historyVisibleEnd;
  const nextEnd = Math.min(state.historyItems.length, previousEnd + HISTORY_BATCH_SIZE);
  const nodes = state.historyItems.slice(previousEnd, nextEnd).map((item, offset) => historyItemNode(item, previousEnd + offset)).filter(Boolean);
  state.historyVisibleEnd = nextEnd;
  messages.querySelector(":scope > .history-later")?.remove();
  const fragment = document.createDocumentFragment(); for (const node of nodes) fragment.append(node); messages.append(fragment);
  trimHistoryWindow("older");
  refreshHistoryNavigation();
  requestAnimationFrame(() => { messages.scrollTop = Math.max(0, previousTop - (previousHeight - messages.scrollHeight)); updateFollowTail(); });
}
function itemNode(item, { lazy = false } = {}) {
  let node;
  if (item.type === 'userMessage') {
    node = messageNode('user', textFromContent(item.content));
    for (const part of item.content || []) { const src = part.imageUrl || part.image_url || (part.type === 'image' ? part.url : ''); if (typeof src === 'string' && src.startsWith('/api/')) { const img = document.createElement('img'); img.src = src; img.alt = '上传的图片'; img.loading = 'lazy'; img.className = 'timeline-tool-image'; node.append(img); } }
  } else if (item.type === 'agentMessage') node = messageNode('assistant', item.text || '');
  else if (item.type === 'reasoning') { const stream = createReasoningState(item); if (item.id) state.reasoningStreams.set(item.id, stream); node = reasoningNode(item, stream); }
  else return timelineItemNode(item, { lazy });
  if (item.detailUrl) {
    const load = document.createElement('button'); load.type = 'button'; load.className = 'timeline-load-detail'; load.textContent = '展开完整内容';
    load.onclick = async () => { load.disabled = true; load.textContent = '正在读取…'; try { const result = await api(item.detailUrl); const full = itemNode(result.item); full.dataset.itemId = item.id; full.dataset.fingerprint = JSON.stringify(item); node.replaceWith(full); state.itemNodes.set(String(item.id), full); } catch (error) { load.disabled = false; load.textContent = `读取失败，重试：${error.message}`; } };
    node.append(load);
  }
  return node;
}
function messageNode(role, text, pre = false) { const wrap = document.createElement("article"); wrap.className = `message ${role}`; wrap.dataset.rawText = text; const label = document.createElement("div"); label.className = "role"; label.textContent = role === "user" ? "你" : "Codex"; const content = document.createElement(pre ? "pre" : "div"); content.className = 'message-content'; if (role === 'assistant' && !pre) renderMarkdown(content, text); else content.textContent = text; wrap.append(label, content); return wrap; }
function reasoningNode(item = {}, stream = createReasoningState(item)) {
  const box = document.createElement("details");
  box.className = "message reasoning";
  box.open = false;
  const title = document.createElement("summary");
  const content = document.createElement("div");
  content.className = "reasoning-content";
  box.append(title, content);
  updateReasoningNode(box, stream);
  return box;
}
function reasoningContentHasSelection(content) {
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  return content.contains(selection.anchorNode) || content.contains(selection.focusNode);
}
function updateReasoningNode(node, stream) {
  const working = stream.status === "inProgress";
  const summary = node.querySelector("summary");
  const content = node.querySelector(".reasoning-content");
  const text = visibleReasoningText(stream) || (working ? "正在思考…" : "未提供推理摘要");
  summary.textContent = working ? "正在思考" : "思考过程";
  node.dataset.status = working ? "inProgress" : stream.status || "completed";
  if (content && !reasoningContentHasSelection(content) && content.textContent !== text) content.textContent = text;
}
function reasoningText(item = {}) { return reasoningTextFromItem(item); }
function emptyNode(text) { const node = document.createElement("div"); node.className = "empty"; node.textContent = text; return node; }

function renderRuntimeCards(plan, diff, { onlyMissing = false } = {}) {
  const planId = String(plan?.turnId || "current"); const diffId = String(diff?.turnId || "current");
  if (plan && (!onlyMissing || !$("messages").querySelector(`[data-turn-plan="${CSS.escape(planId)}"]`))) upsertTurnCard("plan", plan);
  if (diff?.diff && (!onlyMissing || !$("messages").querySelector(`[data-turn-diff="${CSS.escape(diffId)}"]`))) upsertTurnCard("diff", diff);
}
function upsertTurnCard(type, payload) {
  clearEmptyMessages();
  const turnId = String(payload.turnId || "current");
  const selector = type === "plan" ? `[data-turn-plan="${CSS.escape(turnId)}"]` : `[data-turn-diff="${CSS.escape(turnId)}"]`;
  const old = $("messages").querySelector(selector); const fresh = type === "plan" ? turnPlanNode(payload) : turnDiffNode(payload, { lazy: true });
  if (old) old.replaceWith(fresh); else $("messages").append(fresh);
  scrollBottom();
}
function upsertItem(item) {
  if (!item?.id) return null;
  const index = state.historyItems.findIndex((entry) => entry.id === item.id);
  if (index >= 0) state.historyItems[index] = { ...state.historyItems[index], ...item }; else state.historyItems.push(item);
  if (item.type === "userMessage") removeMatchingLocalUserEcho(textFromContent(item.content), item);
  const old = findItemNode(item.id); const fresh = itemNode(item);
  if (!fresh) {
    if (old) old.remove();
    state.itemNodes.delete(String(item.id));
    return null;
  }
  fresh.dataset.itemId = item.id; clearEmptyMessages();
  if (old) {
    const completed = item.status === 'completed' || item.status === 'succeeded';
    if (!completed && old.tagName === 'DETAILS' && fresh.tagName === 'DETAILS') fresh.open = old.open;
    old.replaceWith(fresh);
  }
  else if (state.followTail || $('messages').children.length < 120) $("messages").append(fresh);
  else { $('newMessagesBtn').classList.remove('hidden'); return fresh; }
  state.itemNodes.set(String(item.id), fresh);
  return fresh;
}

async function sendMessage(event) {
  event.preventDefault(); if (!state.current) return;
  if (!(state.control?.mode === 'web' && state.control?.controller) && !state.control?.transition) {
    saveDraft();
    if (state.control?.desktopRunning && !confirm('需要切换到 Web 才能发送。确认桌面空闲后会关闭桌面 App，是否继续？')) return;
    await takeover();
    if (!(state.control?.mode === 'web' && state.control?.controller)) return;
  }
  if (state.control?.transition) return toast("正在准备 Codex，完成后即可发送");
  if (!(state.control?.mode === "web" && state.control?.controller && !state.threadSyncing)) return toast("内容已保留为草稿；接管完成后即可发送");
  const text = $("messageInput").value.trim(); if (!text && !state.attachments.length) return;
  if (state.attachments.some((item) => item.status === "uploading")) return toast("附件还在上传，完成后再发送");
    const failed = state.attachments.find((item) => item.status === "failed");
  if (failed) return toast(`${failed.name || "附件"} 上传失败，请重试或移除`);
  const mode = $("sendMode").value; const attachments = [...state.attachments]; const attachmentIds = attachments.map((a) => a.id).filter(Boolean);
  const threadId = state.current.id; const id = clientMessageId();
  const payload = { text, mode, attachmentIds, model: $('modelSelect').value, effort: $('effortSelect').value, summary: $('summarySelect').value, clientMessageId: id };
  const entry = { id, threadId, text, attachments, payload, status: 'sending', at: Date.now() };
  outbox.set(id, entry); persistOutbox();
  appendLocalUserMessage(localSubmissionText(text, attachments), id, 'sending');
  $('messageInput').value = ''; clearDraft(threadId); autoSize(); clearAttachments(false); workspaceAttachments.set(threadId, []);
  $("sendBtn").disabled = true;
  try {
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}/messages`, { method: "POST", body: payload, timeout: 25000 });
    entry.status = result.queued ? 'queued' : 'sent'; persistOutbox(); updateLocalSubmission(entry);
    if (state.current?.id !== threadId) return;
    if (result.queued) { toast('已加入队列'); await loadQueue(); }
    if (result.queued) { }
    else if (result.turnId) { toast("已引导当前任务"); }
    else { state.activeTurnId = result.turn?.id || null; setActivity({ phase: "thinking", label: "正在思考", since: Date.now() }); scrollBottom(); }
  } catch (error) {
    entry.status = error.status >= 400 && error.status < 500 && error.code !== 'SUBMISSION_UNCERTAIN' ? 'failed' : 'unknown'; entry.error = error.message;
    persistOutbox(); updateLocalSubmission(entry); toast(entry.status === 'unknown' ? '连接中断，正在核对这条消息是否已接收' : error.message);
    if (entry.status === 'unknown') setTimeout(() => reconcileSubmission(entry), 1200);
  } finally { updateComposer(); }
}

function updateComposer() {
  const can = state.control?.mode === "web" && state.control?.controller && state.current && !state.threadSyncing;
  const canAttach = Boolean(state.current || state.pendingThreadId);
  $("messageInput").disabled = !state.current;
  for (const id of ["sendMode", "modelSelect", "effortSelect", "summarySelect"]) $(id).disabled = !state.current;
  $('sendBtn').disabled = !state.current || state.control?.transition || state.threadSyncing;
  // Preparation is non-blocking: only the send box locks, the rest stays usable.
  if (state.control?.transition) { $("sendMode").disabled = true; $("sendBtn").disabled = true; }
  $("attachBtn").disabled = !canAttach;
  $('interruptBtn').classList.toggle('hidden', !state.activeTurnId || !can); $('interruptBtn').disabled = Boolean(state.stopping);
  $('interruptBtn').textContent = state.stopping ? '正在停止…' : '停止';
  $('sendBtn').classList.remove('stop-mode'); $('sendBtn').textContent = '↑';
  const sendLabel = !can ? '切换并发送' : state.activeTurnId ? ($('sendMode').value === 'steer' ? '发送为引导' : '加入队列') : '发送';
  $('sendBtn').title = sendLabel; $('sendBtn').setAttribute('aria-label', sendLabel);
  $("permissionShortcut").disabled = !(state.control?.mode === "web" && state.control?.controller);
  $("newThreadBtn").disabled = !(state.control?.mode === "web" && state.control?.controller);
  if (state.activeTurnId && $("sendMode").value === "auto") $("sendMode").value = "queue";
  if (!state.activeTurnId && $("sendMode").value === "steer") $("sendMode").value = "auto";
  $("mobileToolsBtn").textContent = `${modelShortLabel()} · 参数`;
}

function modelShortLabel() { const text = $("modelSelect").selectedOptions?.[0]?.textContent || "默认"; return text.length > 10 ? `${text.slice(0, 9)}…` : text; }

async function interruptTurn() { if (!state.current || state.stopping) return; state.stopping = true; updateComposer(); try { await api(`/api/threads/${encodeURIComponent(state.current.id)}/interrupt`, { method: 'POST', body: { turnId: state.activeTurnId } }); toast('已请求停止，正在等待确认'); } catch (e) { toast(e.message); } finally { state.stopping = false; updateComposer(); } }

async function loadQueue() { if (!state.current) return; const threadId = state.current.id; return singleFlight(`queue:${threadId}`, async () => { const q = await api(`/api/threads/${encodeURIComponent(threadId)}/queue`); if (state.current?.id !== threadId) return; state.queue = q.data || []; renderQueue(); }); }
function renderQueue() {
  const panel = $('queuePanel'); panel.classList.toggle('hidden', !state.queue.length);
  $('queueList').replaceChildren(...state.queue.map((item, index) => {
    const row = document.createElement('div'); row.className = 'queue-item';
    const content = document.createElement('div'); content.className = 'queue-content';
    const position = document.createElement('small'); position.textContent = index === 0 ? '下一条' : `第 ${index + 1} 条`;
    const text = document.createElement('span'); text.textContent = item.text || '[附件消息]'; content.append(position, text);
    const actions = document.createElement('div'); actions.className = 'queue-actions';
    const steer = actionButton('立即引导', 'ghost', () => steerQueueItem(item.id)); steer.disabled = !state.activeTurnId;
    const edit = actionButton('编辑', 'ghost', () => {
      const input = document.createElement('textarea'); input.className = 'queue-editor'; input.value = item.text || ''; content.replaceChildren(position, input);
      const save = actionButton('保存', 'ghost', async () => {
        save.disabled = true;
        try { await api(`/api/threads/${encodeURIComponent(state.current.id)}/queue/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { text: input.value } }); await loadQueue(); }
        catch (error) { toast(error.message); save.disabled = false; }
      });
      actions.replaceChildren(save, actionButton('取消', 'ghost', renderQueue)); input.focus();
    });
    actions.append(steer, edit, actionButton('移除', 'ghost', () => deleteQueueItem(item.id))); row.append(content, actions); return row;
  }));
  renderActivityPanel();
}
async function steerQueueItem(id) { try { await api(`/api/threads/${encodeURIComponent(state.current.id)}/queue/${encodeURIComponent(id)}/steer`, { method: "POST" }); toast("已作为引导发出"); await loadQueue(); } catch (error) { toast(error.message); } }
async function deleteQueueItem(id) { await api(`/api/threads/${encodeURIComponent(state.current.id)}/queue/${id}`, { method: "DELETE" }); await loadQueue(); }
async function clearQueue() { await api(`/api/threads/${encodeURIComponent(state.current.id)}/queue`, { method: "DELETE" }); await loadQueue(); }

function handlePaste(event) { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); addFiles(files); } }
async function addFiles(fileList) {
  const freeSlots = Math.max(0, 10 - state.attachments.length);
  const files = [...fileList].slice(0, freeSlots);
  if ([...fileList].length > freeSlots) toast("\u6700\u591a\u53ef\u540c\u65f6\u6dfb\u52a0 10 \u4e2a\u9644\u4ef6");
  for (const file of files) await queueUpload(file);
}
async function queueUpload(file) {
  if (!file || typeof file.size !== "number") return toast("\u65e0\u6cd5\u8bfb\u53d6\u8fd9\u4e2a\u6587\u4ef6");
  if (file.size > 50 * 1024 * 1024) return toast(`${file.name || "\u6587\u4ef6"} \u8d85\u8fc7 50MB`);
  const clientId = createBrowserId("upload");
  const entry = { clientId, name: file.name || "clipboard.png", size: file.size, mime: file.type || "application/octet-stream", file, status: "uploading", progress: 0 };
  state.attachments.push(entry); renderAttachments();
  try {
    const result = await uploadFile(file, clientId, (progress) => { entry.progress = progress; renderAttachments(); });
    Object.assign(entry, result, { status: "ready", progress: 100 }); delete entry.file; renderAttachments();
  } catch (error) {
    if (error.name === "AbortError") return;
    entry.status = "failed"; entry.error = error.message || "\u4e0a\u4f20\u5931\u8d25"; renderAttachments(); toast(`${entry.name}\uff1a${entry.error}`);
  }
}
function uploadFile(file, clientId, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); uploadTransfers.set(clientId, xhr);
    xhr.open("POST", `/api/uploads?name=${encodeURIComponent(file.name || "clipboard.png")}&type=${encodeURIComponent(file.type || "application/octet-stream")}`);
    xhr.withCredentials = true; xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(Math.max(1, Math.min(99, Math.round(event.loaded / event.total * 100)))); };
    xhr.onload = () => { uploadTransfers.delete(clientId); let data = {}; try { data = JSON.parse(xhr.responseText || "{}"); } catch { } if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || `HTTP ${xhr.status}`)); };
    xhr.onerror = () => { uploadTransfers.delete(clientId); reject(new Error("上传连接中断，可点击重试")); };
    xhr.onabort = () => { uploadTransfers.delete(clientId); reject(new DOMException("Aborted", "AbortError")); };
    xhr.send(file);
  });
}
async function legacyAddFiles(fileList) {
  const files = [...fileList].slice(0, Math.max(0, 10 - state.attachments.length));
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) { toast(`${file.name} 超过 50MB`); continue; }
    try {
      const result = await uploadFile(file); state.attachments.push(result); renderAttachments();
    } catch (error) { toast(`${file.name}：${error.message}`); }
  }
}
async function legacyUploadFile(file) { const url = `/api/uploads?name=${encodeURIComponent(file.name || "clipboard.png")}&type=${encodeURIComponent(file.type || "application/octet-stream")}`; const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: file }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }
function renderAttachments() {
  if (state.current?.id) {
    workspaceAttachments.set(state.current.id, state.attachments);
    try { localStorage.setItem(`codex-web-attachments:${state.current.id}`, JSON.stringify(state.attachments.filter((item) => item.status === 'ready').map(({file, ...item}) => item))); } catch { }
  }
  const tray = $("attachmentTray"); tray.classList.toggle("hidden", !state.attachments.length); tray.replaceChildren(...state.attachments.map((item) => {
    const box = document.createElement("div"); box.className = `attachment attachment-${item.status || "ready"}`;
    if (item.previewUrl) { const img = document.createElement("img"); img.src = item.previewUrl; img.alt = item.name; box.append(img); }
    const content = document.createElement("div"); content.className = "attachment-content";
    const name = document.createElement("strong"); name.textContent = item.name; content.append(name);
    const detail = document.createElement("small"); detail.textContent = item.status === "uploading" ? `正在上传 ${item.progress || 0}%` : item.status === "failed" ? (item.error || "上传失败") : formatFileSize(item.size); content.append(detail);
    if (item.status === "uploading") { const progress = document.createElement("i"); progress.className = "attachment-progress"; progress.style.setProperty("--upload-progress", `${item.progress || 0}%`); content.append(progress); }
    const actions = document.createElement("div"); actions.className = "attachment-actions";
    if (item.status === "failed" && item.file) { const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "重试"; retry.addEventListener("click", () => retryUpload(item.clientId)); actions.append(retry); }
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = item.status === "uploading" ? "取消" : "×"; cancel.title = item.status === "uploading" ? "取消上传" : "移除附件"; cancel.addEventListener("click", () => removeAttachment(item.clientId || item.id)); actions.append(cancel);
    box.append(content, actions); return box;
  }));
}
function formatFileSize(value) { const bytes = Number(value || 0); if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
async function retryUpload(clientId) { const item = state.attachments.find((entry) => entry.clientId === clientId); if (!item?.file) return; item.status = "uploading"; item.progress = 0; item.error = ""; renderAttachments(); try { const result = await uploadFile(item.file, clientId, (progress) => { item.progress = progress; renderAttachments(); }); Object.assign(item, result, { status: "ready", progress: 100 }); delete item.file; renderAttachments(); } catch (error) { if (error.name !== "AbortError") { item.status = "failed"; item.error = error.message; renderAttachments(); } } }
async function removeAttachment(key) { const item = state.attachments.find((entry) => entry.clientId === key || entry.id === key); if (!item) return; uploadTransfers.get(item.clientId)?.abort(); uploadTransfers.delete(item.clientId); state.attachments = state.attachments.filter((entry) => entry !== item); renderAttachments(); if (item.id) await api(`/api/uploads/${item.id}`, { method: "DELETE" }).catch(() => {}); }
function clearAttachments(removeRemote = true) { const old = state.attachments; state.attachments = []; renderAttachments(); for (const item of old) uploadTransfers.get(item.clientId)?.abort(); uploadTransfers.clear(); if (removeRemote) for (const item of old) if (item.id) api(`/api/uploads/${item.id}`, { method: "DELETE" }).catch(() => {}); }
function legacyRenderAttachments() { $("attachmentTray").classList.toggle("hidden", !state.attachments.length); $("attachmentTray").replaceChildren(...state.attachments.map((item) => { const box = document.createElement("div"); box.className = "attachment"; if (item.previewUrl) { const img = document.createElement("img"); img.src = item.previewUrl; box.append(img); } const name = document.createElement("span"); name.textContent = item.name; const del = document.createElement("button"); del.textContent = "×"; del.addEventListener("click", () => removeAttachment(item.id)); box.append(name, del); return box; })); }
async function legacyRemoveAttachment(id) { await api(`/api/uploads/${id}`, { method: "DELETE" }); state.attachments = state.attachments.filter((a) => a.id !== id); renderAttachments(); }
function legacyClearAttachments(removeRemote = true) { const old = state.attachments; state.attachments = []; renderAttachments(); if (removeRemote) for (const item of old) api(`/api/uploads/${item.id}`, { method: "DELETE" }).catch(() => {}); }

function renderConnectionState() {
  // The offline banner outranks the update banner: a dead socket is the more
  // urgent thing to say, and #bannerStack keeps both on their own rows.
  const offline = !state.socketConnected && (state.socketEverConnected || state.reconnectCount > 0);
  $("connectionBanner")?.classList.toggle("hidden", !offline);
  if (offline) $("updateBanner")?.classList.add("hidden");
  else if (state.update?.updateAvailable) $("updateBanner")?.classList.remove("hidden");
}
function prepareSeconds(c) {
  // Prefer the server clock so every tab shows the same elapsed time; fall back
  // to a local stamp when startedAt is absent or is not an epoch in ms.
  const started = Number(c.takeoverState?.startedAt);
  if (Number.isFinite(started) && started > 1_000_000_000_000 && started <= Date.now()) return Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (!state.prepareStartedAt) state.prepareStartedAt = Date.now();
  return Math.max(0, Math.floor((Date.now() - state.prepareStartedAt) / 1000));
}
function updatePrepareTitle() {
  const label = $("prepareTitle"); if (!label) return;
  const c = state.control || {};
  const seconds = prepareSeconds(c);
  label.textContent = `${c.takeoverState?.message || "正在准备 Codex…"}${seconds ? ` · 已用 ${seconds} 秒` : ""}`;
}
function stopPrepareTicker() { if (state.prepareTimer) { clearInterval(state.prepareTimer); state.prepareTimer = 0; } }
function renderPrepareState() {
  const preparing = Boolean(state.control?.transition);
  $("prepareBanner")?.classList.toggle("hidden", !preparing);
  if (!preparing) { stopPrepareTicker(); state.prepareStartedAt = 0; state.preparePollAt = 0; return; }
  updatePrepareTitle();
  if (state.prepareTimer) return;
  state.prepareTimer = setInterval(() => {
    if (!state.control?.transition) { stopPrepareTicker(); renderPrepareState(); return; }
    updatePrepareTitle();
    // The gateway also pushes a control event when preparation ends; this poll
    // is only a safety net so the banner can never stick on screen.
    if (Date.now() - Number(state.preparePollAt || 0) >= 2000) { state.preparePollAt = Date.now(); refreshControl({ reloadResources: false }).catch(() => {}); }
  }, 1000);
}
function startHeartbeat(socket) { stopHeartbeat(); const beat = () => { if (state.socket !== socket || socket.readyState !== WebSocket.OPEN) return; try { socket.send(JSON.stringify({ type: "ping", data: { ts: Date.now() } })); } catch { } }; beat(); state.pingTimer = setInterval(beat, 20_000); }
function stopHeartbeat() { if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; } }
function forceReconnect() { clearTimeout(state.reconnectTimer); state.reconnectCount = 0; const socket = state.socket; if (socket) { state.socketConnected = false; try { socket.close(); } catch { } } renderActivity(); connectEvents(); }
function reconnectIfStale(maxIdleMs = 45_000) {
  const socket = state.socket;
  const open = socket?.readyState === WebSocket.OPEN;
  if (open && Date.now() - Number(state.lastInboundAt || 0) <= maxIdleMs) return;
  clearTimeout(state.reconnectTimer);
  if (open) { state.socketConnected = false; state.reconnectCount = 0; try { socket.close(); } catch { } renderActivity(); }
  connectEvents();
}
function checkSocketHealth() {
  const socket = state.socket;
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (Date.now() - Number(state.lastInboundAt || 0) <= 45_000) return;
  if (Date.now() - Number(state.stallToastAt || 0) > 30_000) { state.stallToastAt = Date.now(); toast("连接已失活，正在重新连接…"); }
  state.reconnectCount = 0;
  state.lastInboundAt = Date.now();
  state.socketConnected = false;
  clearTimeout(state.reconnectTimer);
  try { socket.close(); } catch { }
  renderActivity();
  if (document.hidden || navigator.onLine === false) return;
  state.reconnectTimer = setTimeout(connectEvents, 500);
}

function connectEvents() {
  if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(state.reconnectTimer);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/events?since=${encodeURIComponent(state.lastEventSeq)}`);
  state.socket = socket;
  socket.onopen = () => {
    if (state.socket !== socket) return;
    const reconnecting = state.socketEverConnected;
    state.socketEverConnected = true;
    state.socketConnected = true;
    state.lastInboundAt = Date.now();
    clearTimeout(state.reconnectStableTimer);
    state.reconnectStableTimer = setTimeout(() => { state.reconnectCount = 0; }, 10_000);
    startHeartbeat(socket);
    renderActivity();
  };
  socket.onmessage = ({ data }) => {
    state.lastInboundAt = Date.now();
    if (state.socket !== socket) return;
    let event; try { event = JSON.parse(data); } catch { return; }
    if (event.type === "hello") {
      const changedEpoch = streamEpoch && streamEpoch !== event.data?.epoch;
      streamEpoch = event.data?.epoch || '';
      if (changedEpoch || (!event.data?.replayAvailable && state.lastEventSeq)) {
        // A restarted gateway begins a fresh event sequence. Reset the local
        // baseline after its snapshot so new low-numbered events are not
        // mistaken for duplicates from the previous process.
        state.lastEventSeq = Math.max(0, Number(event.data?.eventSeq || 0) || 0);
        resyncAfterGap();
      }
      else if (state.socketEverConnected && state.current) scheduleLatestView();
      return;
    }
    if (event.type === "pong") { state.lastRttMs = Math.max(0, Date.now() - Number(event.data?.ts || Date.now())); return; }
    if (event.seq && event.seq <= state.lastEventSeq) return;
    if (state.syncing) state.eventBacklog.push(event); else handleEvent(event);
  };
  socket.onerror = () => {
    if (state.socket === socket) {
      state.socketConnected = false;
      stopHeartbeat();
      try { socket.close(); } catch { }
      renderActivity();
    }
  };
  socket.onclose = () => {
    if (state.socket !== socket) return;
    state.socketConnected = false; state.socket = null; stopHeartbeat(); clearTimeout(state.reconnectStableTimer); state.reconnectCount = Math.min(8, state.reconnectCount + 1); renderActivity();
    const delay = Math.min(10_000, 500 * 2 ** state.reconnectCount);
    state.reconnectTimer = setTimeout(() => { if (!document.hidden && navigator.onLine !== false) connectEvents(); }, delay);
  };
}

async function resyncAfterGap() {
  if (state.syncing) return;
  state.syncing = true; setActivity({ phase: "sync", label: "正在恢复对话状态", since: Date.now() });
  const currentId = state.current?.id;
  try {
    await refreshControl();
    if (currentId && state.current?.id === currentId) {
      const result = await api(`/api/v2/threads/${encodeURIComponent(currentId)}/view?limit=60`);
      if (state.current?.id !== currentId) return;
      applyThreadResult(result, currentId);
      await loadQueue();
    }
    toast("连接已恢复，对话状态已同步");
    for (const entry of outbox.values()) if (entry.status === 'unknown' || entry.status === 'sending') void reconcileSubmission(entry);
  } catch (error) { toast(`恢复对话失败：${error.message}`); }
  finally {
    const backlog = state.eventBacklog.splice(0).sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    state.syncing = false;
    for (const event of backlog) handleEvent(event);
  }
}

function handleEvent(event) {
  if (event.epoch && streamEpoch && event.epoch !== streamEpoch) return;
  if (event.seq) state.lastEventSeq = Math.max(state.lastEventSeq, Number(event.seq));
  if (event.type === "control") { const modeChanged = state.control?.mode !== event.data?.mode; state.control = { ...(state.control || {}), ...(event.data || {}) }; renderControl(); scheduleControlRefresh(modeChanged); return; }
  if (event.type === "threadRemoved") { removeThreadFromView(event.data?.threadId); return; }
  if (event.type === 'threadChanged') { if (state.current?.id === event.data?.threadId) scheduleLatestView(); if (state.agentThreadId === event.data?.threadId) openAgent(state.agentThreadId, true); return; }
  if (event.type === "threadIndexChanged") { (state.control?.mode === "web" && state.control?.controller ? loadThreads() : loadThreadPreviews()).catch(() => {}); return; }
  if (event.type === "hostUpdate") { $("updateBanner").classList.remove("hidden"); $("updateDetail").textContent = "主机正在准备更新，服务即将短暂重启…"; $("updateNowBtn").disabled = true; return; }
  if (event.type === "heartbeat") return;
  if (event.type === "activity" && state.current?.id === event.data.threadId) return setActivity(event.data.activity);
  if (event.type === "queue" && state.current?.id === event.data.threadId) { state.queue = event.data.items; return renderQueue(); }
  if (event.type === "queueError") return toast(`队列暂时未发送，将自动重试：${event.data.error}`);
  if (event.type === "serverRequest") return receiveServerRequest(event.data);
  if (event.type === "serverRequestResolved") return resolvePendingRequest(event.data?.requestId);
  if (event.type === "desktopLive") return applyDesktopLiveEvent(event.data);
  if (event.type !== "notification") return;
  const { method, params } = event.data; const eventThreadId = params?.threadId || params?.thread?.id || params?.turn?.threadId || params?.turn?.thread_id; if (eventThreadId && state.current?.id !== eventThreadId) return;
  if (method === "thread/settings/updated") { state.currentSettings = params.threadSettings || null; applyThreadSettings(state.currentSettings); }
  if (method === "thread/tokenUsage/updated") state.tokenUsage = params.tokenUsage || null;
  if (method === "account/rateLimits/updated" && !$("usageModal").classList.contains("hidden")) scheduleUsageRefresh();
  if (method === "thread/status/changed") applyThreadStatus(params.status);
  if (method === "turn/started") { state.activeTurnId = params.turn?.id; state.threadStatus = { type: "active", activeFlags: [] }; setActivity({ phase: "thinking", label: "正在思考", since: Date.now() }); updateComposer(); renderQueue(); }
  if (method === "turn/plan/updated") upsertTurnCard("plan", params);
  if (method === "turn/diff/updated") upsertTurnCard("diff", params);
  if (method === "item/started") { setActivity({ phase: params.item?.type || "working", label: activityLabel(params.item), detail: activityDetail(params.item), since: Date.now() }); upsertItem(params.item); scrollBottom(); }
  if (method === "item/agentMessage/delta") queueStreamAction("agent", params.itemId, params.delta);
  if (method === "item/reasoning/summaryPartAdded") { const { stream } = reasoningItem(params.itemId, false); ensureReasoningPart(stream, "summary", params.summaryIndex); queueReasoningRender(params.itemId); }
  if (method === "item/reasoning/summaryTextDelta") { const { stream } = reasoningItem(params.itemId, false); appendReasoningDelta(stream, "summary", params.summaryIndex, params.delta); queueReasoningRender(params.itemId); }
  if (method === "item/reasoning/textDelta") { const { stream } = reasoningItem(params.itemId, false); appendReasoningDelta(stream, "content", params.contentIndex, params.delta); queueReasoningRender(params.itemId); }
  if (method === "item/commandExecution/outputDelta") queueStreamAction("command", params.itemId, params.delta);
  if (method === "item/commandExecution/terminalInteraction") queueStreamAction("terminal", params.itemId, params.stdin);
  if (method === "item/fileChange/patchUpdated") upsertItem({ id: params.itemId, type: "fileChange", status: "inProgress", changes: params.changes || [] });
  if (method === "item/fileChange/outputDelta") queueStreamAction("progress", params.itemId, params.delta);
  if (method === "item/mcpToolCall/progress") queueStreamAction("progress", params.itemId, params.message);
  if (method === "item/plan/delta") {
    let node = findItemNode(params.itemId); if (!node) node = upsertItem({ id: params.itemId, type: "plan", status: "inProgress", text: "" });
    queueStreamAction("plan", params.itemId, params.delta);
  }
  if (method === "item/agentMessage/delta") setActivity({ phase: "responding", label: "正在生成回复", since: state.activity?.phase === "responding" ? state.activity.since : Date.now() });
  if (method === "item/completed") {
    flushStreamUpdates();
    if (params.item.type === "reasoning") {
      const id = String(params.item.id || "");
      const stream = state.reasoningStreams.get(id) || createReasoningState(params.item);
      mergeCompletedReasoning(stream, params.item);
      if (id) state.reasoningStreams.set(id, stream);
      let node = findItemNode(id);
      if (node) updateReasoningNode(node, stream);
      else {
        node = reasoningNode(params.item, stream);
        node.dataset.itemId = id;
        $("messages").append(node);
        state.itemNodes.set(id, node);
      }
    } else upsertItem(params.item);
  }
  if (method === "turn/completed") { flushStreamUpdates(); for (const item of params.turn?.items || []) upsertItem(item); cacheCompletedTurn(params.turn); state.activeTurnId = null; state.stopping = false; state.threadStatus = { type: "idle" }; setActivity(state.queue.length ? { phase: "queue", label: "正在准备下一条排队消息", since: Date.now() } : null); touchCurrentThread(); updateComposer(); renderQueue(); renderActivityPanel(); scheduleLatestView(); }
  if (method === "serverRequest/resolved") resolvePendingRequest(params.requestId);
  if (method === "error") toast(params.error?.message || params.message || "Codex 运行出错");
}

function applyDesktopLiveEvent(data = {}) {
  if (!data.threadId || state.current?.id !== data.threadId) return;
  if (data.kind === "snapshot" && data.thread) {
    scheduleLatestView();
    return;
  }
  if (data.kind === "turnStarted") {
    state.activeTurnId = data.turnId || `desktop-${data.threadId}`;
    state.threadStatus = { type: "active", activeFlags: [] };
    setActivity({ phase: "thinking", label: "桌面 App 正在思考", since: Date.now() });
    updateComposer();
    return;
  }
  if (data.kind === "activity") {
    setActivity({ phase: data.phase || "working", label: data.label || "桌面 App 正在处理", since: state.activity?.since || Date.now() });
    updateComposer();
    return;
  }
  if (data.kind === "user" && data.text) {
    const id = String(data.itemId || "");
    if (!findItemNode(id)) {
      clearEmptyMessages();
      const node = messageNode("user", data.text); node.dataset.itemId = id; $("messages").append(node); state.itemNodes.set(id, node);
      scrollBottom();
    }
    return;
  }
  if (data.kind === "reasoning") {
    const { stream } = reasoningItem(data.itemId);
    appendReasoningDelta(stream, "summary", 0, data.delta || "");
    queueReasoningRender(data.itemId);
    setActivity({ phase: "thinking", label: "桌面 App 正在思考", since: state.activity?.since || Date.now() });
    return;
  }
  if (data.kind === "agent") {
    queueStreamAction("agent", data.itemId, data.delta || "");
    setActivity({ phase: "responding", label: "桌面 App 正在生成回复", since: state.activity?.phase === "responding" ? state.activity.since : Date.now() });
    return;
  }
  if (data.kind === "turnCompleted") {
    flushStreamUpdates();
    state.activeTurnId = null;
    state.threadStatus = { type: "idle" };
    setActivity(null);
    updateComposer();
    // The append stream is intentionally minimal. Refresh once at completion
    // so the final desktop snapshot also includes cards and any missed record.
    setTimeout(() => {
      if (state.control?.mode !== 'web' && state.current?.id === data.threadId) scheduleLatestView();
    }, 350);
  }
}

function findItemNode(id) { if (!id) return null; const key = String(id); const cached = state.itemNodes.get(key); if (cached?.isConnected) return cached; const node = $("messages").querySelector(`[data-item-id="${CSS.escape(key)}"]`); if (node) state.itemNodes.set(key, node); else state.itemNodes.delete(key); return node; }
function queueStreamAction(kind, itemId, value) {
  const id = String(itemId || ""); if (!id) return;
  const last = state.streamActions.at(-1);
  if (last && last.kind === kind && last.id === id && ["agent", "command", "plan"].includes(kind)) last.value += String(value || "");
  else state.streamActions.push({ kind, id, value: String(value || "") });
  scheduleStreamFlush();
}
function queueReasoningRender(itemId) { if (itemId != null) state.reasoningDirty.add(String(itemId)); scheduleStreamFlush(); }
function scheduleStreamFlush() { if (!state.streamFrame) state.streamFrame = requestAnimationFrame(flushStreamUpdates); }
function flushStreamUpdates() {
  if (state.streamFrame) cancelAnimationFrame(state.streamFrame);
  state.streamFrame = 0;
  const actions = state.streamActions.splice(0); const reasoningIds = [...state.reasoningDirty]; state.reasoningDirty.clear();
  if (!actions.length && !reasoningIds.length) return;
  for (const action of actions) {
    let node = findItemNode(action.id);
    if (action.kind === "agent") {
      if (!node) { clearEmptyMessages(); node = messageNode("assistant", ""); node.dataset.itemId = action.id; $("messages").append(node); state.itemNodes.set(action.id, node); }
      const content = node.querySelector('.message-content');
      const raw = `${node.dataset.rawText || ''}${action.value}`; node.dataset.rawText = raw;
      const index = state.historyItems.findIndex((item) => item.id === action.id);
      const live = { id: action.id, type: 'agentMessage', text: raw, turnId: state.activeTurnId };
      if (index >= 0) state.historyItems[index] = { ...state.historyItems[index], ...live }; else state.historyItems.push(live);
      renderMarkdown(content, raw, { streaming: true });
    } else if (action.kind === "command") appendCommandOutput(node, action.value);
    else if (action.kind === "terminal") appendTerminalInput(node, action.value);
    else if (action.kind === "plan") appendPlanDelta(node, action.value);
    else if (action.kind === "progress") appendToolProgress(node, action.value);
  }
  for (const id of reasoningIds) { const { node, stream } = reasoningItem(id); updateReasoningNode(node, stream); }
  if (state.followTail && $('messages').children.length > HISTORY_DOM_LIMIT + 8) renderHistory([], { reset: false });
  scrollBottom();
}
function resetMessageCaches() {
  if (state.streamFrame) cancelAnimationFrame(state.streamFrame);
  state.streamFrame = 0; state.streamActions.length = 0; state.reasoningDirty.clear(); state.reasoningStreams.clear(); state.itemNodes.clear();
}
function touchCurrentThread() {
  const index = state.threads.findIndex((thread) => thread.id === state.current?.id); if (index < 0) return;
  const [thread] = state.threads.splice(index, 1); thread.recencyAt = Date.now(); state.threads.unshift(thread); renderThreads();
}
function rememberThreadView(id, result, scrollTop = null) {
  if (!id || !result?.thread) return;
  const view = { result, scrollTop: Number(scrollTop || 0), followTail: scrollTop == null || state.current?.id !== id ? true : state.followTail, savedAt: Date.now() };
  state.threadViews.delete(id); state.threadViews.set(id, view);
  while (state.threadViews.size > THREAD_VIEW_LIMIT) state.threadViews.delete(state.threadViews.keys().next().value);
  void cacheView(id, view);
}
function readThreadView(id) { const view = state.threadViews.get(id); if (!view) return null; state.threadViews.delete(id); state.threadViews.set(id, view); return view; }
function saveCurrentThreadView() {
  const id = state.current?.id; if (!id) return;
  const existing = state.threadViews.get(id)?.result || {};
  rememberThreadView(id, currentViewResult({ ...existing, thread: state.current, threadSettings: state.currentSettings, tokenUsage: state.tokenUsage }), $("messages").scrollTop);
}
function currentViewResult(result) {
  if (state.followTail || !state.historyItems.length) return result;
  const turns = [];
  for (const item of state.historyItems.slice(state.historyVisibleStart, state.historyVisibleEnd)) {
    let turn = turns.at(-1); if (turn?.id !== item.turnId) { turn = { id: item.turnId, items: [] }; turns.push(turn); }
    turn.items.push(item);
  }
  const before = Number(pageCursor || 0) + state.historyVisibleStart;
  return { ...result, thread: { ...result.thread, turns }, page: { ...result.page, before: before ? String(before) : null, hasMore: before > 0 } };
}
function cacheCompletedTurn(turn) {
  if (!state.current || !turn) return;
  const turns = [...(state.current.turns || [])]; const index = turn.id ? turns.findIndex((item) => item.id === turn.id) : -1;
  if (index >= 0) turns[index] = turn; else turns.push(turn);
  state.current = { ...state.current, turns, status: { type: "idle" }, recencyAt: Date.now() };
  saveCurrentThreadView();
}
function delay(ms, signal) { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true }); }); }
function mergePendingRequests(...groups) { const map = new Map(); for (const group of groups) for (const item of group || []) if (item?.id != null) map.set(String(item.id), item); return [...map.values()]; }
function receiveServerRequest(request) { state.pendingRequests = mergePendingRequests(state.pendingRequests, [request]); renderInteraction(); }
function resolvePendingRequest(id) { state.pendingRequests = state.pendingRequests.filter((request) => String(request.id) !== String(id)); renderInteraction(); }

function renderInteraction() {
  const request = state.pendingRequests.find((item) => !item.params?.threadId || item.params.threadId === state.current?.id);
  if (!request) return hideInteraction();
  const box = $("approval"); box.replaceChildren(); box.classList.remove("hidden"); box.dataset.requestId = String(request.id);
  if (request.method === "item/tool/requestUserInput") renderUserQuestions(box, request);
  else if (request.method === "mcpServer/elicitation/request") renderMcpElicitation(box, request);
  else renderApprovalRequest(box, request);
}

function renderApprovalRequest(box, request) {
  const params = request.params || {};
  const titles = { "item/commandExecution/requestApproval": "允许执行命令？", "item/fileChange/requestApproval": "允许修改文件？", "item/permissions/requestApproval": "允许附加权限？" };
  setActivity({ phase: "approval", label: "等待你批准", since: Date.now() });
  box.append(interactionHeading(titles[request.method] || "Codex 请求批准", params.reason || approvalDetail(request)));
  const detail = document.createElement("pre"); detail.className = "interaction-detail"; detail.textContent = approvalDetail(request); box.append(detail);
  const actions = document.createElement("div"); actions.className = "approval-actions";
  let choices = [["允许一次", "accept", "approve"], ["本次会话允许", "acceptForSession", "approve"]];
  if (request.method === "item/commandExecution/requestApproval" && (params.proposedExecpolicyAmendment?.length || params.proposedNetworkPolicyAmendments?.length)) choices.push(["总是允许", "always", "approve"]);
  if (Array.isArray(params.availableDecisions)) choices = choices.filter(([, value]) => value === "always" || params.availableDecisions.includes(value));
  choices.push(["拒绝", "decline", "decline"], ["拒绝并停止", "cancel", "decline"]);
  for (const [label, decision, cls] of choices) actions.append(actionButton(label, cls, () => submitServerRequest(request.id, { decision })));
  box.append(actions);
}

function renderUserQuestions(box, request) {
  setActivity({ phase: "input", label: "等待你回答问题", since: Date.now() });
  const params = request.params || {}; const form = document.createElement("form"); form.className = "interaction-form";
  form.append(interactionHeading("Codex 需要你的选择", params.autoResolutionMs ? `此问题可能在 ${Math.ceil(params.autoResolutionMs / 1000)} 秒后自动处理` : "回答后任务会继续运行"));
  for (const question of params.questions || []) form.append(questionField(question));
  const actions = document.createElement("div"); actions.className = "approval-actions"; actions.append(actionButton("提交回答", "approve", () => {}), actionButton("跳过", "decline", () => {
    const answers = Object.fromEntries((params.questions || []).map((question) => [question.id, "取消"]));
    submitServerRequest(request.id, { answers }).catch(() => {});
  }));
  actions.firstElementChild.type = "submit"; form.append(actions);
  form.addEventListener("submit", (event) => { event.preventDefault(); const answers = {}; for (const question of params.questions || []) { const field = form.elements.namedItem(`question:${question.id}`); const other = form.elements.namedItem(`other:${question.id}`); let value = typeof RadioNodeList !== "undefined" && field instanceof RadioNodeList ? field.value : field?.value; if (other?.value?.trim()) value = other.value.trim(); answers[question.id] = value; } submitServerRequest(request.id, { answers }); });
  box.append(form);
}

function questionField(question) {
  const fieldset = document.createElement("fieldset"); fieldset.className = "question-field";
  const legend = document.createElement("legend"); legend.textContent = question.header || "问题"; const prompt = document.createElement("p"); prompt.textContent = question.question || "请选择"; fieldset.append(legend, prompt);
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length) for (const [index, option] of options.entries()) { const label = document.createElement("label"); label.className = "choice-option"; const input = document.createElement("input"); input.type = "radio"; input.name = `question:${question.id}`; input.value = option.label; if (index === 0) input.checked = true; const text = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = option.label; const small = document.createElement("small"); small.textContent = option.description || ""; text.append(strong, small); label.append(input, text); fieldset.append(label); }
  if (!options.length || question.isOther) { const input = document.createElement("input"); input.className = "interaction-input"; input.name = options.length ? `other:${question.id}` : `question:${question.id}`; input.type = question.isSecret ? "password" : "text"; input.autocomplete = "off"; input.placeholder = options.length ? "其他答案" : "请输入回答"; fieldset.append(input); if (question.isSecret && location.protocol !== "https:") { const warning = document.createElement("small"); warning.className = "security-warning"; warning.textContent = "当前不是 HTTPS 连接，请勿提交高敏感密码或密钥。"; fieldset.append(warning); } }
  return fieldset;
}

function renderMcpElicitation(box, request) {
  setActivity({ phase: "input", label: "等待你填写工具表单", since: Date.now() });
  const params = request.params || {}; const form = document.createElement("form"); form.className = "interaction-form";
  form.append(interactionHeading(`${params.serverName || "MCP 工具"} 请求信息`, params.message || "填写后工具会继续运行"));
  if (params.mode === "url") { const link = document.createElement("a"); link.className = "elicitation-link"; link.href = params.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "在新窗口打开授权页面"; form.append(link); }
  else if (params.mode === "form") for (const [name, schema] of Object.entries(params.requestedSchema?.properties || {})) form.append(schemaField(name, schema, (params.requestedSchema?.required || []).includes(name)));
  else { const label = document.createElement("label"); label.className = "schema-field"; label.textContent = "表单数据（JSON）"; const textarea = document.createElement("textarea"); textarea.name = "openai-form-json"; textarea.placeholder = "{}"; label.append(textarea); form.append(label); }
  const actions = document.createElement("div"); actions.className = "approval-actions"; actions.append(actionButton(params.mode === "url" ? "我已完成，继续" : "提交", "approve", () => {}), actionButton("拒绝", "decline", () => submitServerRequest(request.id, { action: "decline" })), actionButton("取消任务", "decline", () => submitServerRequest(request.id, { action: "cancel" })));
  actions.firstElementChild.type = "submit"; form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const content = {};
    if (params.mode === "form") {
      for (const name of Object.keys(params.requestedSchema?.properties || {})) {
        const field = form.elements.namedItem(`schema:${name}`);
        if (typeof RadioNodeList !== "undefined" && field instanceof RadioNodeList) content[name] = field.value;
        else if (field?.type === "checkbox") content[name] = field.checked;
        else if (field?.multiple) content[name] = [...field.selectedOptions].map((option) => option.value);
        else content[name] = field?.value;
      }
    } else if (params.mode !== "url") {
      try {
        Object.assign(content, JSON.parse(form.elements.namedItem("openai-form-json")?.value || "{}"));
      } catch {
        return toast("表单 JSON 格式不正确");
      }
    }
    submitServerRequest(request.id, { action: "accept", content });
  });
  box.append(form);
}

function schemaField(name, schema = {}, required = false) {
  const label = document.createElement("label"); label.className = "schema-field"; const title = document.createElement("span"); title.textContent = `${schema.title || name}${required ? " *" : ""}`; label.append(title);
  const choices = schemaChoices(schema); const types = schemaTypes(schema); let field;
  if (choices.length) { field = document.createElement("select"); if (types.includes("array")) field.multiple = true; if (!required && !field.multiple) field.append(new Option("请选择", "")); for (const choice of choices) field.append(new Option(choice, choice)); }
  else if (types.includes("boolean")) { field = document.createElement("input"); field.type = "checkbox"; }
  else { field = document.createElement("input"); field.type = types.includes("number") || types.includes("integer") ? "number" : schema.format === "password" ? "password" : "text"; if (schema.description) field.placeholder = schema.description; }
  field.name = `schema:${name}`; if (required && field.type !== "checkbox") field.required = true; label.append(field); return label;
}

function schemaChoices(schema, values = []) { if (!schema || typeof schema !== "object") return values; if (Array.isArray(schema.enum)) values.push(...schema.enum.map(String)); if (Object.hasOwn(schema, "const")) values.push(String(schema.const)); for (const item of schema.oneOf || []) schemaChoices(item, values); if (schema.items) schemaChoices(schema.items, values); return [...new Set(values)]; }
function schemaTypes(schema) { const values = []; const add = (value) => Array.isArray(value) ? value.forEach(add) : typeof value === "string" && values.push(value); add(schema?.type); for (const item of schema?.oneOf || []) add(item.type); return [...new Set(values)]; }
function approvalDetail(request) { const params = request.params || {}; if (request.method === "item/commandExecution/requestApproval") return [params.command, params.cwd && `目录：${params.cwd}`].filter(Boolean).join("\n"); if (request.method === "item/fileChange/requestApproval") return [params.reason, params.grantRoot && `写入范围：${params.grantRoot}`].filter(Boolean).join("\n") || "应用文件修改"; if (request.method === "item/permissions/requestApproval") return `${params.reason || "Codex 请求额外权限"}\n${prettyJson(params.permissions)}`; return params.reason || request.method; }
function interactionHeading(title, description) { const header = document.createElement("header"); header.className = "interaction-heading"; const wrap = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = title; const small = document.createElement("small"); small.textContent = description || ""; wrap.append(strong, small); header.append(wrap); return header; }
function actionButton(label, className, action) { const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = label; button.addEventListener("click", action); return button; }
async function submitServerRequest(id, body) { try { await api(`/api/server-requests/${encodeURIComponent(id)}`, { method: "POST", body }); resolvePendingRequest(id); if (state.activeTurnId) setActivity({ phase: "working", label: "正在继续处理", since: Date.now() }); toast("已提交，Codex 将继续运行"); } catch (error) { toast(error.message); } }
function hideInteraction() { $("approval").classList.add("hidden"); $("approval").replaceChildren(); delete $("approval").dataset.requestId; }
function prettyJson(value) { try { return JSON.stringify(value ?? {}, null, 2); } catch { return String(value); } }

function setActivity(activity) {
  const next = typeof activity === "string" ? { phase: "working", label: activity, since: Date.now() } : activity;
  if (state.activity === next || (state.activity && next && state.activity.phase === next.phase && state.activity.label === next.label && state.activity.detail === next.detail && state.activity.since === next.since)) return;
  state.activity = next; renderActivity();
  renderActivityPanel();
}
function renderActivity() { renderConnectionState(); const box = $("activityStatus"); if (!box) return; const disconnected = !state.socketConnected && state.control?.mode === "web"; const activity = disconnected ? { phase: "offline", label: "连接断开，正在重连", since: Date.now() } : state.activity; box.classList.toggle("hidden", !activity); box.classList.toggle("offline", disconnected); for (const cls of [...box.classList]) if (cls.startsWith("phase-")) box.classList.remove(cls); if (!activity) return; box.classList.add(`phase-${activity.phase || "working"}`); const seconds = Math.max(0, Math.floor((Date.now() - Number(activity.since || Date.now())) / 1000)); const detail = activity.detail ? ` · ${activity.detail}` : ""; box.lastElementChild.textContent = `${activity.label}${seconds ? ` · ${seconds}秒` : ""}${detail}`; }
function activityLabel(item = {}) { const labels = { reasoning: "正在思考", commandExecution: "正在执行命令", fileChange: "正在修改文件", webSearch: "正在搜索", mcpToolCall: "正在调用工具", dynamicToolCall: "正在调用工具", imageGeneration: "正在生成图片" }; return labels[item.type] || "正在处理"; }
function activityDetail(item = {}) { return item.type === "commandExecution" ? String(item.command || "").replace(/\s+/g, " ").slice(0, 80) : ""; }
function reasoningItem(itemId, createNode = true) { const id = String(itemId || ""); let stream = state.reasoningStreams.get(id); if (!stream) { stream = createReasoningState({ status: "inProgress" }); state.reasoningStreams.set(id, stream); } let node = findItemNode(id); if (!node && createNode) { clearEmptyMessages(); node = reasoningNode({ status: "inProgress" }, stream); node.dataset.itemId = id; $("messages").append(node); state.itemNodes.set(id, node); } return { node, stream }; }
function clearEmptyMessages() { for (const node of $("messages").querySelectorAll(":scope > .empty")) node.remove(); }

function applyThreadSettings(settings) {
  if (!settings) return;
  if (settings.model && [...$("modelSelect").options].some((item) => item.value === settings.model)) $("modelSelect").value = settings.model;
  renderEfforts();
  if (settings.effort && [...$("effortSelect").options].some((item) => item.value === settings.effort)) $("effortSelect").value = settings.effort;
  if (settings.summary && [...$("summarySelect").options].some((item) => item.value === settings.summary)) $("summarySelect").value = settings.summary;
  updateComposer();
}

function applyThreadStatus(status) {
  state.threadStatus = status || null;
  const type = typeof status === "string" ? status : status?.type;
  const flags = new Set(Array.isArray(status?.activeFlags) ? status.activeFlags : []);
  if (type === "idle") { state.activeTurnId = null; if (!state.queue.length) setActivity(null); updateComposer(); return; }
  if (type === "systemError") { setActivity({ phase: "error", label: "Codex 运行异常", since: Date.now() }); updateComposer(); return; }
  if (type !== "active") return;
  if (flags.has("waitingOnApproval")) setActivity({ phase: "approval", label: "等待你批准", since: Date.now() });
  else if (flags.has("waitingOnUserInput")) setActivity({ phase: "input", label: "等待你输入", since: Date.now() });
  else if (!state.activity) setActivity({ phase: "working", label: "正在处理", since: Date.now() });
  updateComposer();
}

async function openUsage() {
  closeAccountMenu();
  $("usageModal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  await loadUsage();
}

function closeUsage() { $("usageModal").classList.add("hidden"); document.body.classList.remove("modal-open"); }

function scheduleUsageRefresh() {
  clearTimeout(state.usageRefreshTimer);
  state.usageRefreshTimer = setTimeout(() => loadUsage().catch(() => {}), 400);
}

async function loadUsage() {
  $("usageLoading").textContent = "正在读取使用情况…";
  $("usageLoading").classList.remove("hidden");
  $("usageContent").classList.add("hidden");
  try {
    state.usage = await api("/api/account/usage");
    renderUsage(state.usage);
    renderAccountTokenTimeline(state.usage);
    $("usageLoading").classList.add("hidden");
    $("usageContent").classList.remove("hidden");
  } catch (error) {
    $("usageLoading").textContent = `无法读取使用情况：${error.message}`;
  }
}

function renderUsage(payload = {}) {
  const limits = payload.rateLimits || {};
  const byId = limits.rateLimitsByLimitId || {};
  const snapshot = byId.codex || limits.rateLimits || Object.values(byId)[0] || {};
  const windowInfo = snapshot.primary || snapshot.secondary || {};
  const used = Math.max(0, Math.min(100, Number(windowInfo.usedPercent || 0)));
  const remaining = Math.max(0, 100 - used);
  const resetCredits = limits.rateLimitResetCredits || {};
  const count = Math.max(0, Number(resetCredits.availableCount || 0));
  const firstCredit = Array.isArray(resetCredits.credits) ? resetCredits.credits.find((item) => item.status === "available") : null;
  $("usageLimitName").textContent = snapshot.limitName || (windowInfo.windowDurationMins >= 10_000 ? "每周使用限额" : "Codex 使用限额");
  $("usageResetAt").textContent = windowInfo.resetsAt ? `${formatResetTime(windowInfo.resetsAt)}重置` : "重置时间暂不可用";
  $("usageMeterFill").style.width = `${used}%`;
  $("usageRemaining").textContent = `剩余 ${Math.round(remaining)}%`;
  $("resetCreditCount").textContent = `可用 ${count} 次`;
  $("usageCreditDetail").textContent = firstCredit?.description || (count ? "点击使用一次额度重置" : "当前没有可用的重置次数");
  $("resetLimitBtn").disabled = count < 1 || payload.live === false;
  $("resetLimitBtn").dataset.creditId = firstCredit?.id || "";
  const buckets = payload.usage?.dailyUsageBuckets || [];
  const today = new Date().toISOString().slice(0, 10);
  const todayTokens = buckets.find((item) => item.startDate === today)?.tokens;
  $("usageTodayTokens").textContent = formatCount(todayTokens);
  $("usageLifetimeTokens").textContent = formatCount(payload.usage?.summary?.lifetimeTokens);
  $("usagePlan").textContent = formatPlan(snapshot.planType);
  $("usageMessage").textContent = payload.live === false
    ? `只读快照，更新于 ${formatUsageTimestamp(payload.cachedAt)}；接管后可刷新或使用额度重置。`
    : (snapshot.rateLimitReachedType ? "当前使用限额已达到上限。" : "");
}

function renderAccountTokenTimeline(payload = {}) {
  const now = new Date();
  const dayKey = (date) => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  };
  const today = dayKey(now);
  const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - 6);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const buckets = Array.isArray(payload.usage?.dailyUsageBuckets) ? payload.usage.dailyUsageBuckets : [];
  const observed = Array.isArray(payload.history?.observed) ? payload.history.observed : [];
  const localRecords = Array.isArray(payload.history?.localSessions?.records) ? payload.history.localSessions.records : [];
  const detailRecords = localRecords.length ? localRecords : observed;
  const sumOfficial = (from) => buckets.filter((item) => item?.startDate >= dayKey(from)).reduce((sum, item) => sum + Math.max(0, Number(item?.tokens || 0)), 0);
  const sumObserved = (records, from) => records.filter((item) => Number(item?.at) >= from.getTime()).reduce((total, item) => ({ input: total.input + Math.max(0, Number(item?.input || 0)), output: total.output + Math.max(0, Number(item?.output || 0)), cached: total.cached + Math.max(0, Number(item?.cached || 0)) }), { input: 0, output: 0, cached: 0 });
  const hourStart = new Date(now.getTime() - 60 * 60_000);
  const hour = sumObserved(detailRecords, hourStart);
  const dayDetail = sumObserved(detailRecords, new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const weekDetail = sumObserved(detailRecords, weekStart);
  const month = sumObserved(detailRecords, monthStart);
  const officialDay = buckets.find((item) => item?.startDate === today)?.tokens;
  $("usageHourTokens").textContent = formatCount(hour.input + hour.output);
  $("usageDayTokens").textContent = Number.isFinite(Number(officialDay)) && Number(officialDay) > 0 ? formatCount(officialDay) : formatCount(dayDetail.input + dayDetail.output);
  const officialWeek = sumOfficial(weekStart);
  const officialMonth = sumOfficial(monthStart);
  $("usageWeekTokens").textContent = officialWeek ? formatCount(officialWeek) : formatCount(weekDetail.input + weekDetail.output);
  $("usageMonthTokens").textContent = officialMonth ? formatCount(officialMonth) : formatCount(month.input + month.output);
  $("usageInputTokens").textContent = formatCount(month.input);
  $("usageOutputTokens").textContent = formatCount(month.output);
  $("usageCacheTokens").textContent = formatCount(month.cached);
  $("usageCacheRate").textContent = month.input ? `${Math.round(month.cached / month.input * 100)}%` : "--";
  $("usageTimelineSource").textContent = payload.live === false ? "账号额度为上次官方快照；输入、输出和缓存为本机网关本月观察值" : "账号总量来自官方；输入、输出和缓存为本机网关本月观察值";
}

async function switchAccount() {
  closeAccountMenu();
  let profiles;
  try { ({ profiles } = await api("/api/accounts")); } catch (error) { return toast(`\u65e0\u6cd5\u8bfb\u53d6\u8d26\u53f7\u5907\u4efd\uff1a${error.message}`); }
  if (!profiles?.length) return toast("\u672a\u627e\u5230\u8d26\u53f7\u5907\u4efd\uff0c\u8bf7\u5148\u7528\u8d26\u53f7\u5907\u4efd\u5de5\u5177\u4fdd\u5b58\u8d26\u53f7");
  const busy = Object.keys(state.control?.activeTurns || {}).length || Number(state.control?.queuedCount || 0) || Number(state.control?.pendingRequests?.length || 0);
  if (busy) return toast("\u5f53\u524d\u6709\u8fd0\u884c\u3001\u5ba1\u6279\u6216\u6392\u961f\u5185\u5bb9\uff0c\u8bf7\u5904\u7406\u5b8c\u518d\u5207\u6362\u8d26\u53f7");
  const options = profiles.map((profile, index) => `${index + 1}. ${profile.label || "\u672a\u547d\u540d\u8d26\u53f7"}${profile.hint ? `\uff08${profile.hint}\uff09` : ""}`).join("\n");
  const selected = Number(prompt(`\u9009\u62e9\u8981\u5207\u6362\u7684\u8d26\u53f7\uff1a\n${options}`, "1"));
  if (!Number.isInteger(selected) || selected < 1 || selected > profiles.length) return;
  const profile = profiles[selected - 1];
  if (!confirm(`\u5207\u6362\u5230\u201c${profile.label || "\u672a\u547d\u540d\u8d26\u53f7"}\u201d\uff1f\n\n\u4f1a\u66ff\u6362\u684c\u9762\u548c Web \u5171\u7528\u7684\u767b\u5f55\u8d26\u53f7\uff0c\u5e76\u77ed\u6682\u91cd\u542f Web Codex\u3002\u8fdb\u884c\u4e2d\u7684\u4efb\u52a1\u3001\u5ba1\u6279\u6216\u6392\u961f\u6d88\u606f\u5fc5\u987b\u5148\u5904\u7406\u5b8c\u3002`)) return;
  $("accountSwitchOverlay").classList.remove("hidden");
  try {
    const result = await api("/api/accounts/activate", { method: "POST", body: { profileId: profile.id } });
    toast(`\u5df2\u5207\u6362\u5230 ${result.profile?.label || profile.label || "\u6240\u9009\u8d26\u53f7"}\uff0c\u6b63\u5728\u91cd\u65b0\u8fde\u63a5\u2026`);
    setTimeout(() => location.reload(), Math.max(1500, Number(result.reconnectAfterMs) || 4500));
  } catch (error) {
    $("accountSwitchOverlay").classList.add("hidden");
    toast(`\u8d26\u53f7\u5207\u6362\u5931\u8d25\uff1a${error.message}`);
  }
}

function removeThreadFromView(threadId) {
  if (!threadId) return;
  state.threads = state.threads.filter((thread) => thread.id !== threadId);
  state.threadViews.delete(threadId);
  if (state.current?.id === threadId) { state.current = null; state.pendingThreadId = null; state.queue = []; $("messages").replaceChildren(emptyNode("任务已移除")); $("chatTitle").textContent = "选择一个任务"; $("chatMeta").textContent = "任务已从桌面 App 与 Web 同步移除"; renderQueue(); updateComposer(); }
  renderThreads();
}

function createBrowserId(prefix = "id") {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${prefix}-${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
async function resetRateLimit() {
  const count = Number((state.usage?.rateLimits?.rateLimitResetCredits?.availableCount) || 0);
  if (!count) return;
  if (!confirm(`将消耗 1 次额度重置，当前可用 ${count} 次。是否继续？`)) return;
  state.resetAttemptId ||= createBrowserId("reset");
  $("resetLimitBtn").disabled = true;
  $("usageMessage").textContent = "正在重置使用限额…";
  try {
    const result = await api("/api/account/rate-limit-reset", { method: "POST", body: { idempotencyKey: state.resetAttemptId, creditId: $("resetLimitBtn").dataset.creditId || null } });
    const labels = { reset: "使用限额已重置。", nothingToReset: "当前没有需要重置的限额窗口。", noCredit: "账户没有可用的重置次数。", alreadyRedeemed: "本次重置已经完成。" };
    state.resetAttemptId = null;
    await loadUsage();
    $("usageMessage").textContent = labels[result.outcome] || "重置请求已完成。";
  } catch (error) {
    $("usageMessage").textContent = `重置失败：${error.message}`;
    $("resetLimitBtn").disabled = false;
  }
}

function formatResetTime(value) { const date = new Date(Number(value) * 1000); if (Number.isNaN(date.getTime())) return ""; return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date); }
function formatUsageTimestamp(value) { const date = new Date(Number(value)); if (Number.isNaN(date.getTime())) return "未知时间"; return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date); }
function formatCount(value) { const count = Number(value); if (!Number.isFinite(count)) return "--"; return new Intl.NumberFormat("zh-CN", { notation: count >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(count); }
function formatPlan(value) { const names = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" }; return names[value] || value || "--"; }

async function api(url, options = {}) {
  const target = new URL(url, location.href);
  if (target.origin !== location.origin || !target.pathname.startsWith('/api/')) throw new Error('拒绝非本站接口地址');
  const controller = !options.signal ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeout || 20000) : null;
  try {
    const response = await fetch(url, { method: options.method || 'GET', credentials: 'same-origin', headers: options.body ? { 'Content-Type': 'application/json' } : undefined, body: options.body ? JSON.stringify(options.body) : undefined, signal: options.signal || controller.signal });
    if (response.status === 401 && options.allow401) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; error.code = data.code; throw error; }
    return data;
  } finally { if (timer) clearTimeout(timer); }
}
function singleFlight(key, operation) { if (inflightLoads.has(key)) return inflightLoads.get(key); const promise = Promise.resolve().then(operation).finally(() => inflightLoads.delete(key)); inflightLoads.set(key, promise); return promise; }
function textFromContent(content = []) { return content.map((part) => part.text || (part.path ? `[图片：${part.path}]` : "")).filter(Boolean).join("\n"); }
function formatDate(value) { if (!value) return ""; const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value); if (Number.isNaN(date.getTime())) return ""; return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date); }
function updateFollowTail() { state.followTail = isNearBottom(); $("newMessagesBtn").classList.toggle("hidden", state.followTail); }
function isNearBottom() { const messages = $("messages"); return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 140; }
function scrollBottom(force = false) {
  if (force) state.followTail = true;
  if (!state.followTail) { $("newMessagesBtn").classList.remove("hidden"); return; }
  if (state.scrollFrame) return;
  state.scrollFrame = requestAnimationFrame(() => { state.scrollFrame = 0; const messages = $("messages"); messages.scrollTop = messages.scrollHeight; state.followTail = true; $("newMessagesBtn").classList.add("hidden"); });
}
let autoSizeFrame = 0;
function autoSize() { if (autoSizeFrame) return; autoSizeFrame = requestAnimationFrame(() => { autoSizeFrame = 0; const input = $("messageInput"); input.style.height = "auto"; input.style.height = `${Math.min(180, input.scrollHeight)}px`; }); }
function draftKey(threadId = state.current?.id) { return threadId ? `codex-web-draft:${threadId}` : ""; }
function handleComposerInput() { autoSize(); clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 180); }
function saveDraft() {
  clearTimeout(draftTimer); draftTimer = 0;
  const key = draftKey(); if (!key) return;
  const value = $("messageInput").value;
  try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { }
}
function restoreDraft(threadId) {
  const key = draftKey(threadId); if (!key) return;
  let value = ""; try { value = localStorage.getItem(key) || ""; } catch { }
  $("messageInput").value = value; autoSize();
}
function clearDraft(threadId = state.current?.id) { const key = draftKey(threadId); if (key) try { localStorage.removeItem(key); } catch { } }
let toastTimer; function toast(text) { clearTimeout(toastTimer); $("toast").textContent = text; $("toast").classList.remove("hidden"); toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 4500); }

function localSubmissionText(text, attachments = []) {
  const names = attachments.map((item) => item.name).filter(Boolean);
  const suffix = names.length ? `\n\n附件：${names.join("、")}` : "";
  return `${text || "[附件消息]"}${suffix}`;
}

function appendLocalUserMessage(text, turnId, status = "sent") {
  if (!text) return;
  clearEmptyMessages();
  const id = `local-user:${turnId || Date.now()}`;
  if (findItemNode(id)) return;
  const node = messageNode("user", text);
  node.dataset.itemId = id;
  node.dataset.localUser = "true";
  node.dataset.localUserText = text;
  node.dataset.submissionId = turnId || '';
  if (status === "queued") {
    node.classList.add("queued");
    const badge = document.createElement("small");
    badge.className = "local-message-status";
    badge.textContent = "已排队，上一条完成后自动发送";
    node.append(badge);
  }
  $("messages").append(node);
  state.itemNodes.set(id, node);
  const submission = outbox.get(turnId); if (submission) updateLocalSubmission(submission);
  scrollBottom();
}

function removeMatchingLocalUserEcho(text, item = {}) {
  const value = String(text || "").trim();
  if (!value) return;
  for (const node of $("messages").querySelectorAll(':scope > .message.user[data-local-user="true"]')) {
    const submission = outbox.get(node.dataset.submissionId);
    if (submission && submission.threadId !== state.current?.id) continue;
    const fixedId = item.clientUserMessageId || item.clientMessageId || item.id;
    const attachmentMatch = submission?.attachments?.length && value.startsWith(submission.text || '') && submission.attachments.every((a) => value.includes(a.name) || value.includes(a.path || '\0'));
    if (node.dataset.submissionId === fixedId || String(node.dataset.localUserText || "").trim() === value || attachmentMatch) {
      state.itemNodes.delete(node.dataset.itemId || "");
      if (node.dataset.submissionId) { outbox.delete(node.dataset.submissionId); persistOutbox(); }
      node.remove();
      return;
    }
  }
}

function persistOutbox() {
  try { localStorage.setItem('codex-web-outbox-v1', JSON.stringify([...outbox.values()].slice(-50).map((entry) => ({ ...entry, attachments: entry.attachments.map(({ file, ...item }) => item) })))); } catch { }
}
function restoreOutbox() {
  try { for (const entry of JSON.parse(localStorage.getItem('codex-web-outbox-v1') || '[]')) if (Date.now() - entry.at < 86400_000) outbox.set(entry.id, { ...entry, status: entry.status === 'sending' ? 'unknown' : entry.status }); } catch { }
}
function renderOutbox() { for (const entry of outbox.values()) if (entry.threadId === state.current?.id) appendLocalUserMessage(localSubmissionText(entry.text, entry.attachments), entry.id, entry.status); }
function updateLocalSubmission(entry) {
  if (state.current?.id !== entry.threadId) return;
  const node = findItemNode(`local-user:${entry.id}`); if (!node) return;
  node.querySelector('.submission-actions')?.remove();
  const actions = document.createElement('div'); actions.className = 'submission-actions';
  const label = document.createElement('small'); label.className = 'local-message-status';
  label.textContent = ({ sending: '发送中…', sent: '已接收', queued: '已排队，上一条结束后继续', failed: '发送失败，可重新编辑', unknown: '结果待核对，未重复发送' })[entry.status] || entry.status;
  actions.append(label);
  if (entry.status === 'unknown') { const check = document.createElement('button'); check.type = 'button'; check.textContent = '核对'; check.onclick = () => reconcileSubmission(entry); actions.append(check); }
  if (entry.status === 'failed') { const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '重新编辑'; edit.onclick = () => { $('messageInput').value = entry.text; state.attachments = entry.attachments; renderAttachments(); saveDraft(); autoSize(); outbox.delete(entry.id); persistOutbox(); node.remove(); }; actions.append(edit); }
  node.append(actions);
}
async function reconcileSubmission(entry) {
  try {
    const receipt = await api(`/api/threads/${encodeURIComponent(entry.threadId)}/submissions/${encodeURIComponent(entry.id)}`);
    if (receipt.status === 'accepted') { entry.status = receipt.result?.queued ? 'queued' : 'sent'; if (state.current?.id === entry.threadId) { await refreshLatestView(); await loadQueue(); } }
    else if (receipt.status === 'failed') { entry.status = 'failed'; entry.error = receipt.error; }
    else entry.status = 'unknown';
    persistOutbox(); updateLocalSubmission(entry);
  } catch { entry.status = 'unknown'; updateLocalSubmission(entry); }
}
async function refreshLatestView() {
  const id = state.current?.id; if (!id) return;
  const result = await api(`/api/v2/threads/${encodeURIComponent(id)}/view?limit=60`);
  if (state.current?.id !== id) return;
  const cursor = pageCursor;
  applyThreadResult(result, id, { restoreScroll: state.followTail ? null : $('messages').scrollTop });
  if (cursor != null && Number(cursor) < Number(pageCursor)) pageCursor = cursor;
}
function scheduleLatestView() { clearTimeout(latestRefreshTimer); latestRefreshTimer = setTimeout(() => refreshLatestView().catch(() => {}), 400); }

function toggleActivityPanel(open = $('activityPanel').classList.contains('hidden')) {
  $('activityPanel').classList.toggle('hidden', !open); $('appView').classList.toggle('activity-open', open);
  $('activityPanelToggle').setAttribute('aria-expanded', String(open));
  if (open) { renderActivityPanel(); loadAgents(); }
}
function renderActivityPanel() {
  const box = $('activitySummary'); if (!box || $('activityPanel').classList.contains('hidden')) return;
  const plan = state.control?.turnPlans?.[state.current?.id];
  const files = state.historyItems.filter((item) => item.type === 'fileChange').flatMap((item) => item.changes || []).slice(-8);
  box.textContent = [state.activity?.label || (state.current ? '当前任务空闲' : '选择一个任务'), state.current?.model && `模型：${state.current.model}`, state.queue.length && `待发送：${state.queue.length} 条`, ...(plan?.plan || []).map((step) => `${step.status === 'completed' ? '✓' : '○'} ${step.step}`), ...files.map((file) => `文件：${file.path}`)].filter(Boolean).join('\n');
}
async function loadAgents() {
  const id = state.current?.id; if (!id) return;
  $('agentList').textContent = '正在读取子任务…';
  try {
    const result = await api(`/api/v2/threads/${encodeURIComponent(id)}/agents`);
    if (state.current?.id !== id) return;
    $('agentList').replaceChildren();
    for (const agent of result.data || []) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.agentThread = agent.id;
      const name = document.createElement('strong'); name.textContent = agent.name || agent.id;
      const detail = document.createElement('small'); detail.textContent = `${agent.model || '模型未提供'} · ${agent.status === 'inProgress' || agent.status === 'started' ? '运行中' : agent.status === 'completed' ? '已完成' : agent.status || '状态未提供'}`;
      button.append(name, detail); $('agentList').append(button);
    }
    if (!$('agentList').children.length) $('agentList').textContent = '这段会话暂未记录可打开的子任务。';
  } catch (error) { $('agentList').textContent = `子任务暂不可用：${error.message}`; }
}
async function openAgent(id, refresh = false) {
  if (!id) return; toggleActivityPanel(true); state.agentThreadId = id;
  const detail = $('agentDetail'); detail.classList.remove('hidden');
  if (!refresh) detail.textContent = '正在读取子智能体内容…';
  try {
    const result = await api(`/api/v2/threads/${encodeURIComponent(id)}/view?limit=30`);
    if (state.agentThreadId !== id) return;
    const header = document.createElement('h4'); header.textContent = result.thread.preview || '子任务内容';
    const full = document.createElement('button'); full.type = 'button'; full.textContent = '打开完整子对话'; full.onclick = () => { toggleActivityPanel(false); openThread(id); };
    const nodes = result.thread.turns.flatMap((turn) => turn.items).map((item) => itemNode(item, { lazy: true })).filter(Boolean);
    detail.replaceChildren(header, full, ...nodes);
    if (!nodes.length) detail.append(document.createTextNode('执行端暂未保存子任务内容，请稍后刷新。'));
  } catch (error) { detail.textContent = `暂时无法读取此子任务：${error.message}。主任务会继续运行。`; }
}

if (new URLSearchParams(location.search).get('ui') === 'legacy') $('experienceStyles').disabled = true;

if ("serviceWorker" in navigator && (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
