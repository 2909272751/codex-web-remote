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

const $ = (id) => document.getElementById(id);
const state = { threads: [], projects: [], selectedProjectId: null, projectsLoaded: false, directory: null, createAfterProject: false, models: [], current: null, currentSettings: null, threadStatus: null, tokenUsage: null, pendingThreadId: null, socket: null, socketConnected: false, reconnectTimer: null, activeTurnId: null, activity: null, control: null, attachments: [], queue: [], reasoningStreams: new Map(), usage: null, resetAttemptId: null, usageRefreshTimer: null, pendingRequests: [], lastEventSeq: 0, syncing: false, eventBacklog: [], reconnectCount: 0, update: null, updateLoaded: false };
syncViewportHeight();
window.addEventListener("resize", syncViewportHeight, { passive: true });
window.addEventListener("orientationchange", syncViewportHeight, { passive: true });
window.visualViewport?.addEventListener("resize", syncViewportHeight, { passive: true });
window.visualViewport?.addEventListener("scroll", syncViewportHeight, { passive: true });
boot();
setInterval(renderActivity, 1000);

async function boot() {
  const session = await api("/api/session", { allow401: true });
  if (!session?.authenticated) return showLogin();
  showApp(); connectEvents(); await refreshControl();
}

$("loginForm").addEventListener("submit", async (event) => { event.preventDefault(); $("loginError").textContent = ""; try { await api("/api/login", { method: "POST", body: { password: $("password").value } }); showApp(); connectEvents(); await refreshControl(); } catch (error) { $("loginError").textContent = error.message; } });
$("logoutBtn").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); location.reload(); });
$("accountMenuBtn").addEventListener("click", (event) => { event.stopPropagation(); toggleAccountMenu(); });
$("usageMenuBtn").addEventListener("click", openUsage);
$("usageCloseBtn").addEventListener("click", closeUsage);
$("usageModal").addEventListener("click", (event) => { if (event.target === $("usageModal")) closeUsage(); });
$("resetLimitBtn").addEventListener("click", resetRateLimit);
$("updateNowBtn").addEventListener("click", applyHostUpdate);
document.addEventListener("click", (event) => { if (!event.target.closest(".sidebar-footer")) closeAccountMenu(); });
$("refreshBtn").addEventListener("click", () => state.control?.mode === "web" ? loadThreads() : loadThreadPreviews());
$("search").addEventListener("input", renderThreads);
$("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("open"));
$("menuBtn").addEventListener("click", () => $("sidebarBackdrop").classList.toggle("open", $("sidebar").classList.contains("open")));
$("sidebarBackdrop").addEventListener("click", closeSidebar);
$("sidebarCloseBtn").addEventListener("click", closeSidebar);
$("mobileToolsBtn").addEventListener("click", toggleComposerTools);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeProjectModal(); closeSidebar(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden && !state.socketConnected) connectEvents(); });
$("composer").addEventListener("submit", sendMessage);
$("messageInput").addEventListener("input", autoSize);
$("messageInput").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("composer").requestSubmit(); } });
$("messageInput").addEventListener("paste", handlePaste);
$("composer").addEventListener("dragover", (event) => { event.preventDefault(); });
$("composer").addEventListener("drop", (event) => { event.preventDefault(); addFiles(event.dataTransfer.files); });
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", () => { addFiles($("fileInput").files); $("fileInput").value = ""; });
$("takeoverBtn").addEventListener("click", takeover);
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
$("sendBtn").addEventListener("click", (event) => { if (state.activeTurnId) { event.preventDefault(); interruptTurn(); } });
$("clearQueueBtn").addEventListener("click", clearQueue);

function showLogin() { $("loginView").classList.remove("hidden"); $("appView").classList.add("hidden"); }
function showApp() { $("loginView").classList.add("hidden"); $("appView").classList.remove("hidden"); }
function syncViewportHeight() {
  const layoutHeight = window.innerHeight;
  const visualHeight = window.visualViewport?.height;
  // Some mobile browsers briefly retain the previous visual viewport after a
  // rotation/resize. Never let that stale value make the app taller than the
  // current layout viewport, otherwise the composer falls below the screen.
  const appHeight = Math.min(layoutHeight, Number.isFinite(visualHeight) ? visualHeight : layoutHeight);
  document.documentElement.style.setProperty("--app-height", `${Math.round(appHeight)}px`);
}
function closeSidebar() { $("sidebar").classList.remove("open"); $("sidebarBackdrop").classList.remove("open"); }
function toggleComposerTools() { const open = $("composerSettings").classList.toggle("open"); document.querySelector(".chat-shell")?.classList.toggle("tools-open", open); }
function toggleAccountMenu() { const open = $("accountMenu").classList.toggle("hidden") === false; $("accountMenuBtn").setAttribute("aria-expanded", String(open)); }
function closeAccountMenu() { $("accountMenu").classList.add("hidden"); $("accountMenuBtn").setAttribute("aria-expanded", "false"); }

async function refreshControl() {
  state.control = await api("/api/control/status");
  state.pendingRequests = Array.isArray(state.control.pendingRequests) ? state.control.pendingRequests : [];
  renderControl();
  await loadProjects().catch((error) => toast(`项目列表：${error.message}`));
  if (state.current?.id && state.control.activities?.[state.current.id]) setActivity(state.control.activities[state.current.id]);
  if (state.control.mode === "web" && state.control.controller) await loadThreads();
  else await loadThreadPreviews();
  if (state.control.mode === "web" && !state.models.length) await loadModels().catch((error) => toast(`模型列表：${error.message}`));
  if (!state.updateLoaded) await loadUpdateStatus();
}

async function loadUpdateStatus() {
  state.updateLoaded = true;
  try {
    state.update = await api("/api/update/status");
    const available = Boolean(state.update.updateAvailable);
    $("updateBanner").classList.toggle("hidden", !available);
    if (!available) return;
    $("updateTitle").textContent = `发现新版本 v${state.update.latestVersion}`;
    $("updateDetail").textContent = `当前 v${state.update.currentVersion}；更新会短暂重启服务，设置和数据都会保留。`;
    $("updateReleaseLink").href = state.update.releaseUrl || "#";
    $("updateNowBtn").disabled = !state.update.updaterAvailable || state.control?.mode !== "web";
    $("updateNowBtn").textContent = state.update.updaterAvailable ? "立即更新" : "请在主机更新";
  } catch (error) {
    state.updateLoaded = false;
  }
}

async function applyHostUpdate() {
  if (!state.update?.updateAvailable) return;
  if (!confirm(`更新到 v${state.update.latestVersion}？下载完成后服务会短暂断开并自动恢复。`)) return;
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
  $("statusDot").classList.toggle("ready", c.mode === "web" && c.codexReady);
  $("takeoverBtn").classList.toggle("hidden", c.mode === "web");
  $("releaseBtn").classList.toggle("hidden", c.mode !== "web" || !c.controller);
  $("fullAccessBtn").classList.toggle("hidden", c.mode !== "web" || !c.controller);
  $("fullAccessBtn").classList.toggle("enabled", Boolean(c.fullAccess));
  $("fullAccessBtn").textContent = c.fullAccess ? "完全访问：已开启" : "标准权限";
  $("fullAccessBtn").disabled = Boolean(c.transition);
  $("permissionShortcut").textContent = c.fullAccess ? "♧ 完全访问" : "♧ 标准权限";
  $("permissionShortcut").classList.toggle("enabled", Boolean(c.fullAccess));
  $("takeoverBtn").disabled = c.transition || c.controllerBusy;
  if (state.update?.updateAvailable) $("updateNowBtn").disabled = !state.update.updaterAvailable || c.mode !== "web";
  const labels = { desktop: "桌面 App 正在使用；接管后会正常关闭桌面 App", available: "桌面 App 未运行，可以接管", web: "Web 共享控制已开启，可在多个设备同时使用" };
  $("controlText").textContent = c.transition ? (c.takeoverState?.message || "正在切换…") : (c.takeoverState?.phase === "failed" ? `接管失败：${c.takeoverState.message}` : (labels[c.mode] || c.mode));
  const canControl = c.mode === "web" && c.controller;
  for (const id of ["messageInput", "sendMode", "attachBtn"]) $(id).disabled = !canControl || !state.current;
  $("sendBtn").disabled = !canControl || !state.current;
  $("permissionShortcut").disabled = !canControl;
  $("newThreadBtn").disabled = !canControl;
  if (c.mode !== "web" && !state.pendingThreadId && !state.current) $("messages").replaceChildren(emptyNode("左侧可只读查看任务；接管后可以继续对话和操作"));
  if (state.current?.id && c.mode === "web") {
    const settings = c.threadSettings?.[state.current.id];
    if (settings) { state.currentSettings = settings; applyThreadSettings(settings); }
    if (c.threadTokenUsage?.[state.current.id]) state.tokenUsage = c.threadTokenUsage[state.current.id];
    const restored = c.activities?.[state.current.id];
    const running = c.activeTurns?.[state.current.id];
    state.activeTurnId = running || null;
    if (restored) setActivity(restored);
    else if (running && !state.activity) setActivity({ phase: "working", label: "正在处理", since: Date.now() });
    else if (!running) setActivity(null);
    if (c.threadStatuses?.[state.current.id]) applyThreadStatus(c.threadStatuses[state.current.id]);
    renderRuntimeCards(c.turnPlans?.[state.current.id], c.turnDiffs?.[state.current.id]);
  }
  if (c.mode !== "web") { state.activeTurnId = null; setActivity(null); }
  renderInteraction();
  updateComposer();
}

async function takeover() {
  $("takeoverBtn").disabled = true; toast("正在确认任务状态并强制接管…");
  try { await api("/api/control/takeover", { method: "POST", body: { force: false } }); }
  catch (error) {
    if (error.message.includes("强制接管") && confirm("桌面 Codex 仍有后台进程。强制接管可能丢失尚未发送的输入，是否继续？")) {
      try { await api("/api/control/takeover", { method: "POST", body: { force: true } }); }
      catch (forceError) { toast(forceError.message); await refreshControl().catch(() => {}); return; }
    }
    else { toast(error.message); return; }
  }
  const pending = state.pendingThreadId;
  await refreshControl();
  if (pending && state.threads.some((thread) => thread.id === pending)) await openThread(pending);
  toast("接管成功");
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

async function loadThreads() { const result = await api("/api/threads"); state.threads = result.data || []; renderThreads(); }
async function loadThreadPreviews() { const result = await api("/api/thread-previews"); state.threads = result.data || []; renderThreads(); }
async function loadProjects(preferredId = null) {
  const result = await api("/api/projects");
  state.projects = Array.isArray(result.data) ? result.data : [];
  if (!state.projectsLoaded || preferredId !== null) {
    const remembered = preferredId ?? readProjectPreference();
    const currentMatch = state.current?.cwd ? state.projects.find((project) => projectContainsPath(project.path, state.current.cwd)) : null;
    state.selectedProjectId = remembered === "" || state.projects.some((project) => project.id === remembered) ? remembered : (currentMatch?.id || state.projects[0]?.id || "");
    state.projectsLoaded = true;
  } else if (state.selectedProjectId && !state.projects.some((project) => project.id === state.selectedProjectId)) {
    state.selectedProjectId = state.projects[0]?.id || "";
  }
  writeProjectPreference(state.selectedProjectId);
  renderProjects(); renderThreads();
}
async function loadModels() { const result = await api("/api/models"); state.models = result.data || []; renderModels(); }
function renderModels() { const select = $("modelSelect"); const selected = select.value; const options = [new Option("默认模型", "")]; for (const model of state.models) options.push(new Option(model.displayName || model.name || model.model || model.id, model.model || model.id)); select.replaceChildren(...options); if ([...select.options].some((item) => item.value === selected)) select.value = selected; renderEfforts(); }
function renderEfforts() { const model = state.models.find((item) => (item.model || item.id) === $("modelSelect").value); const values = model?.supportedReasoningEfforts || []; const selected = $("effortSelect").value; const labels = { none: "无思考", minimal: "极轻", low: "轻度", medium: "中等", high: "较深", xhigh: "深度", max: "最深", ultra: "Ultra" }; $("effortSelect").replaceChildren(new Option("默认强度", ""), ...values.map((item) => { const value = typeof item === "string" ? item : (item.reasoningEffort || item.effort || item.value); return new Option(labels[value] || value, value); })); if ([...$("effortSelect").options].some((item) => item.value === selected)) $("effortSelect").value = selected; }

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

function selectProject(id) { state.selectedProjectId = id; writeProjectPreference(id); renderProjects(); renderThreads(); }

async function removeProject(project) {
  if (!confirm(`从 Web 项目列表移除“${project.name}”？电脑里的文件和对话记录不会删除。`)) return;
  try { await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" }); await loadProjects(state.selectedProjectId === project.id ? "" : state.selectedProjectId); toast("已从项目列表移除，文件未删除"); }
  catch (error) { toast(error.message); }
}

function renderThreads() {
  const query = $("search").value.trim().toLowerCase();
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  const list = state.threads.filter((thread) => (!project || projectContainsPath(project.path, thread.cwd)) && `${thread.preview || thread.id} ${thread.cwd || ""}`.toLowerCase().includes(query));
  const nodes = list.map((thread) => { const b = document.createElement("button"); b.className = `thread${(state.current?.id || state.pendingThreadId) === thread.id ? " active" : ""}`; const head = document.createElement("div"); head.className = "thread-head"; const title = document.createElement("strong"); title.textContent = thread.preview || "未命名任务"; head.append(title); if (state.control?.activeTurns?.[thread.id]) { const live = document.createElement("i"); live.className = "thread-live"; live.title = "正在运行"; head.append(live); } const queued = Number(state.control?.queuedByThread?.[thread.id] || 0); if (queued) { const badge = document.createElement("b"); badge.className = "thread-queue"; badge.textContent = queued; badge.title = `${queued} 条排队消息`; head.append(badge); } const meta = document.createElement("small"); meta.textContent = formatDate(thread.recencyAt || thread.updatedAt || thread.createdAt); b.append(head, meta); b.addEventListener("click", () => state.control?.mode === "web" ? openThread(thread.id) : previewThread(thread)); return b; });
  if (!nodes.length) { const empty = document.createElement("div"); empty.className = "thread-list-empty"; empty.textContent = project ? "这个项目还没有任务" : "暂无任务"; nodes.push(empty); }
  $("threadList").replaceChildren(...nodes);
}

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

function normalizeClientPath(value) { return String(value || "").replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase("en-US"); }
function projectContainsPath(projectPath, candidatePath) { const project = normalizeClientPath(projectPath); const candidate = normalizeClientPath(candidatePath); return Boolean(project && candidate && (candidate === project || candidate.startsWith(`${project}/`))); }
function folderName(value) { const parts = String(value || "").replace(/[\\/]+$/, "").split(/[\\/]/); return parts.at(-1) || value; }
function readProjectPreference() { try { const value = localStorage.getItem("codex-web-project-id"); return value === "__all__" ? "" : value; } catch { return null; } }
function writeProjectPreference(value) { try { localStorage.setItem("codex-web-project-id", value || "__all__"); } catch { } }

async function previewThread(thread) {
  state.pendingThreadId = thread.id;
  $("chatTitle").textContent = thread.preview || "Codex 任务"; $("chatMeta").textContent = "正在读取本机记录…";
  $("messages").replaceChildren(emptyNode("正在加载对话历史…"));
  renderThreads(); closeSidebar(); updateComposer();
  try {
    const result = await api(`/api/thread-previews/${encodeURIComponent(thread.id)}`);
    if (state.pendingThreadId !== thread.id) return;
    state.current = result.thread;
    $("chatMeta").textContent = `${result.thread.cwd || thread.id} · 只读`;
    renderHistory(result.thread.turns || []); renderThreads(); updateComposer();
  } catch (error) { $("messages").replaceChildren(emptyNode(error.message)); toast(error.message); }
}

async function openThread(id) {
  const result = await api(`/api/threads/${encodeURIComponent(id)}`);
  applyThreadResult(result, id);
  renderThreads(); closeSidebar(); await loadQueue(); updateComposer();
}

function applyThreadResult(result, id = result.thread?.id) {
  state.current = result.thread;
  state.currentSettings = result.threadSettings || state.control?.threadSettings?.[id] || null;
  state.threadStatus = result.thread?.status || state.control?.threadStatuses?.[id] || null;
  state.tokenUsage = result.tokenUsage || state.control?.threadTokenUsage?.[id] || null;
  state.pendingRequests = mergePendingRequests(state.control?.pendingRequests || [], result.pendingRequests || []);
  state.pendingThreadId = null;
  applyThreadSettings(state.currentSettings);
  state.activeTurnId = result.thread.status?.type === "active" ? (state.control?.activeTurns?.[id] || null) : null;
  setActivity(state.control?.activities?.[id] || (state.activeTurnId ? { phase: "working", label: "正在处理", since: Date.now() } : null));
  $("chatTitle").textContent = result.thread.preview || "Codex 任务"; $("chatMeta").textContent = result.thread.cwd || id;
  renderHistory(result.thread.turns || []);
  renderRuntimeCards(result.turnPlan || state.control?.turnPlans?.[id], result.turnDiff || state.control?.turnDiffs?.[id]);
  renderInteraction();
}

function renderHistory(turns) { state.reasoningStreams.clear(); const nodes = []; for (const turn of turns) for (const item of turn.items || []) { const node = itemNode(item); if (node) { if (item.id) node.dataset.itemId = item.id; nodes.push(node); } } $("messages").replaceChildren(...(nodes.length ? nodes : [emptyNode("这个任务暂时没有可显示的消息")])); scrollBottom(); }
function itemNode(item) { if (item.type === "userMessage") return messageNode("user", textFromContent(item.content)); if (item.type === "agentMessage") return messageNode("assistant", item.text || ""); if (item.type === "reasoning") { const stream = createReasoningState(item); if (item.id) state.reasoningStreams.set(item.id, stream); return reasoningNode(item, stream); } return timelineItemNode(item); }
function messageNode(role, text, pre = false) { const wrap = document.createElement("article"); wrap.className = `message ${role}`; const label = document.createElement("div"); label.className = "role"; label.textContent = role === "user" ? "你" : "Codex"; const content = document.createElement(pre ? "pre" : "div"); content.textContent = text; wrap.append(label, content); return wrap; }
function reasoningNode(item = {}, stream = createReasoningState(item)) { const box = document.createElement("details"); box.className = "message reasoning"; box.open = stream.status === "inProgress"; const title = document.createElement("summary"); const content = document.createElement("div"); content.className = "reasoning-content"; box.append(title, content); updateReasoningNode(box, stream); return box; }
function updateReasoningNode(node, stream) { const working = stream.status === "inProgress"; node.querySelector("summary").textContent = working ? "正在思考" : "思考过程"; node.querySelector(".reasoning-content").textContent = visibleReasoningText(stream) || (working ? "正在思考…" : "未提供推理摘要"); if (working) node.open = true; }
function reasoningText(item = {}) { return reasoningTextFromItem(item); }
function emptyNode(text) { const node = document.createElement("div"); node.className = "empty"; node.textContent = text; return node; }

function renderRuntimeCards(plan, diff) {
  if (plan) upsertTurnCard("plan", plan);
  if (diff?.diff) upsertTurnCard("diff", diff);
}
function upsertTurnCard(type, payload) {
  clearEmptyMessages();
  const turnId = String(payload.turnId || "current");
  const selector = type === "plan" ? `[data-turn-plan="${CSS.escape(turnId)}"]` : `[data-turn-diff="${CSS.escape(turnId)}"]`;
  const old = $("messages").querySelector(selector); const fresh = type === "plan" ? turnPlanNode(payload) : turnDiffNode(payload);
  if (old) old.replaceWith(fresh); else $("messages").append(fresh);
  scrollBottom();
}
function upsertItem(item) {
  if (!item?.id) return null;
  const old = $("messages").querySelector(`[data-item-id="${CSS.escape(item.id)}"]`); const fresh = itemNode(item);
  if (!fresh) return old;
  fresh.dataset.itemId = item.id; clearEmptyMessages();
  if (old) old.replaceWith(fresh); else $("messages").append(fresh);
  return fresh;
}

async function sendMessage(event) {
  event.preventDefault(); if (!state.current) return;
  const text = $("messageInput").value.trim(); if (!text && !state.attachments.length) return;
  const mode = $("sendMode").value; const attachmentIds = state.attachments.map((a) => a.id);
  $("sendBtn").disabled = true;
  try {
    const result = await api(`/api/threads/${encodeURIComponent(state.current.id)}/messages`, { method: "POST", body: { text, mode, attachmentIds, model: $("modelSelect").value, effort: $("effortSelect").value, summary: $("summarySelect").value } });
    $("messageInput").value = ""; autoSize(); clearAttachments(false);
    if (result.queued) { toast("已加入队列"); await loadQueue(); }
    else if (result.turnId) { toast("已引导当前任务"); }
    else { state.activeTurnId = result.turn?.id || null; setActivity({ phase: "thinking", label: "正在思考", since: Date.now() }); scrollBottom(); }
  } catch (error) { toast(error.message); } finally { updateComposer(); }
}

function updateComposer() {
  const can = state.control?.mode === "web" && state.control?.controller && state.current;
  for (const id of ["messageInput", "sendMode", "attachBtn", "sendBtn", "modelSelect", "effortSelect", "summarySelect"]) $(id).disabled = !can;
  $("interruptBtn").classList.add("hidden");
  $("sendBtn").classList.toggle("stop-mode", Boolean(state.activeTurnId));
  $("sendBtn").textContent = state.activeTurnId ? "■" : "↑";
  $("sendBtn").title = state.activeTurnId ? "停止当前任务" : "发送";
  $("sendBtn").setAttribute("aria-label", state.activeTurnId ? "停止当前任务" : "发送");
  $("permissionShortcut").disabled = !(state.control?.mode === "web" && state.control?.controller);
  $("newThreadBtn").disabled = !(state.control?.mode === "web" && state.control?.controller);
  if (state.activeTurnId && $("sendMode").value === "auto") $("sendMode").value = "queue";
  if (!state.activeTurnId && $("sendMode").value === "steer") $("sendMode").value = "auto";
  $("mobileToolsBtn").textContent = `${modelShortLabel()} · 参数`;
}

function modelShortLabel() { const text = $("modelSelect").selectedOptions?.[0]?.textContent || "默认"; return text.length > 10 ? `${text.slice(0, 9)}…` : text; }

async function interruptTurn() { if (!state.current) return; try { await api(`/api/threads/${encodeURIComponent(state.current.id)}/interrupt`, { method: "POST", body: { turnId: state.activeTurnId } }); toast("已请求中断"); } catch (e) { toast(e.message); } }

async function loadQueue() { if (!state.current) return; const q = await api(`/api/threads/${encodeURIComponent(state.current.id)}/queue`); state.queue = q.data || []; renderQueue(); }
function renderQueue() { const panel = $("queuePanel"); panel.classList.toggle("hidden", !state.queue.length); $("queueList").replaceChildren(...state.queue.map((item, index) => { const row = document.createElement("div"); row.className = "queue-item"; const content = document.createElement("div"); content.className = "queue-content"; const position = document.createElement("small"); position.textContent = index === 0 ? "下一条" : `第 ${index + 1} 条`; const text = document.createElement("span"); text.textContent = item.text || "[附件消息]"; content.append(position, text); const actions = document.createElement("div"); actions.className = "queue-actions"; const steer = document.createElement("button"); steer.className = "ghost"; steer.textContent = "立即引导"; steer.disabled = !state.activeTurnId; steer.title = state.activeTurnId ? "将这条排队消息立即发送为引导" : "当前没有运行中的任务；队列会自动发送"; steer.addEventListener("click", () => steerQueueItem(item.id)); const del = document.createElement("button"); del.className = "ghost"; del.textContent = "取消"; del.addEventListener("click", () => deleteQueueItem(item.id)); actions.append(steer, del); row.append(content, actions); return row; })); }
async function steerQueueItem(id) { try { await api(`/api/threads/${encodeURIComponent(state.current.id)}/queue/${encodeURIComponent(id)}/steer`, { method: "POST" }); toast("已作为引导发出"); await loadQueue(); } catch (error) { toast(error.message); } }
async function deleteQueueItem(id) { await api(`/api/threads/${encodeURIComponent(state.current.id)}/queue/${id}`, { method: "DELETE" }); await loadQueue(); }
async function clearQueue() { await api(`/api/threads/${encodeURIComponent(state.current.id)}/queue`, { method: "DELETE" }); await loadQueue(); }

function handlePaste(event) { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); addFiles(files); } }
async function addFiles(fileList) {
  const files = [...fileList].slice(0, Math.max(0, 10 - state.attachments.length));
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) { toast(`${file.name} 超过 50MB`); continue; }
    try {
      const result = await uploadFile(file); state.attachments.push(result); renderAttachments();
    } catch (error) { toast(`${file.name}：${error.message}`); }
  }
}
async function uploadFile(file) { const url = `/api/uploads?name=${encodeURIComponent(file.name || "clipboard.png")}&type=${encodeURIComponent(file.type || "application/octet-stream")}`; const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: file }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }
function renderAttachments() { $("attachmentTray").classList.toggle("hidden", !state.attachments.length); $("attachmentTray").replaceChildren(...state.attachments.map((item) => { const box = document.createElement("div"); box.className = "attachment"; if (item.previewUrl) { const img = document.createElement("img"); img.src = item.previewUrl; box.append(img); } const name = document.createElement("span"); name.textContent = item.name; const del = document.createElement("button"); del.textContent = "×"; del.addEventListener("click", () => removeAttachment(item.id)); box.append(name, del); return box; })); }
async function removeAttachment(id) { await api(`/api/uploads/${id}`, { method: "DELETE" }); state.attachments = state.attachments.filter((a) => a.id !== id); renderAttachments(); }
function clearAttachments(removeRemote = true) { const old = state.attachments; state.attachments = []; renderAttachments(); if (removeRemote) for (const item of old) api(`/api/uploads/${item.id}`, { method: "DELETE" }).catch(() => {}); }

function connectEvents() {
  if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(state.reconnectTimer);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/events?since=${encodeURIComponent(state.lastEventSeq)}`);
  state.socket = socket;
  socket.onopen = () => { if (state.socket !== socket) return; state.socketConnected = true; state.reconnectCount += 1; renderActivity(); };
  socket.onmessage = ({ data }) => {
    if (state.socket !== socket) return;
    let event; try { event = JSON.parse(data); } catch { return; }
    if (event.type === "hello") {
      if (!event.data?.replayAvailable && state.lastEventSeq) {
        // A restarted gateway begins a fresh event sequence. Reset the local
        // baseline after its snapshot so new low-numbered events are not
        // mistaken for duplicates from the previous process.
        state.lastEventSeq = Math.max(0, Number(event.data?.eventSeq || 0) || 0);
        resyncAfterGap();
      }
      return;
    }
    if (event.seq && event.seq <= state.lastEventSeq) return;
    if (state.syncing) state.eventBacklog.push(event); else handleEvent(event);
  };
  socket.onclose = () => {
    if (state.socket !== socket) return;
    state.socketConnected = false; state.socket = null; renderActivity();
    state.reconnectTimer = setTimeout(() => { if (!document.hidden) connectEvents(); }, Math.min(10_000, 1_000 + state.reconnectCount * 750));
  };
}

async function resyncAfterGap() {
  if (state.syncing) return;
  state.syncing = true; setActivity({ phase: "sync", label: "正在恢复对话状态", since: Date.now() });
  const currentId = state.current?.id;
  try {
    await refreshControl();
    if (currentId && state.control?.mode === "web") {
      const result = await api(`/api/threads/${encodeURIComponent(currentId)}`);
      applyThreadResult(result, currentId);
      await loadQueue();
    }
    toast("连接已恢复，对话状态已同步");
  } catch (error) { toast(`恢复对话失败：${error.message}`); }
  finally {
    const backlog = state.eventBacklog.splice(0).sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    state.syncing = false;
    for (const event of backlog) handleEvent(event);
  }
}

function handleEvent(event) {
  if (event.seq) state.lastEventSeq = Math.max(state.lastEventSeq, Number(event.seq));
  if (event.type === "control") return refreshControl().catch(() => {});
  if (event.type === "hostUpdate") { $("updateBanner").classList.remove("hidden"); $("updateDetail").textContent = "主机正在准备更新，服务即将短暂重启…"; $("updateNowBtn").disabled = true; return; }
  if (event.type === "heartbeat") return;
  if (event.type === "activity" && state.current?.id === event.data.threadId) return setActivity(event.data.activity);
  if (event.type === "queue" && state.current?.id === event.data.threadId) { state.queue = event.data.items; return renderQueue(); }
  if (event.type === "queueError") return toast(`队列暂时未发送，将自动重试：${event.data.error}`);
  if (event.type === "serverRequest") return receiveServerRequest(event.data);
  if (event.type === "serverRequestResolved") return resolvePendingRequest(event.data?.requestId);
  if (event.type !== "notification") return;
  const { method, params } = event.data; const eventThreadId = params?.threadId || params?.thread?.id || params?.turn?.threadId || params?.turn?.thread_id; if (eventThreadId && state.current?.id !== eventThreadId) return;
  if (method === "thread/settings/updated") { state.currentSettings = params.threadSettings || null; applyThreadSettings(state.currentSettings); }
  if (method === "thread/tokenUsage/updated") state.tokenUsage = params.tokenUsage || null;
  if (method === "account/rateLimits/updated" && !$("usageModal").classList.contains("hidden")) scheduleUsageRefresh();
  if (method === "thread/status/changed") applyThreadStatus(params.status);
  if (method === "turn/started") { state.activeTurnId = params.turn?.id; state.threadStatus = { type: "active", activeFlags: [] }; setActivity({ phase: "thinking", label: "正在思考", since: Date.now() }); updateComposer(); renderQueue(); loadQueue().catch(() => {}); }
  if (method === "turn/plan/updated") upsertTurnCard("plan", params);
  if (method === "turn/diff/updated") upsertTurnCard("diff", params);
  if (method === "item/started") { setActivity({ phase: params.item?.type || "working", label: activityLabel(params.item), detail: activityDetail(params.item), since: Date.now() }); upsertItem(params.item); scrollBottom(); }
  if (method === "item/agentMessage/delta") { let node = [...document.querySelectorAll(".message.assistant")].findLast((el) => el.dataset.itemId === params.itemId); if (!node) { clearEmptyMessages(); node = messageNode("assistant", ""); node.dataset.itemId = params.itemId; $("messages").append(node); } node.lastElementChild.textContent += params.delta || ""; scrollBottom(); }
  if (method === "item/reasoning/summaryPartAdded") { const { node, stream } = reasoningItem(params.itemId); ensureReasoningPart(stream, "summary", params.summaryIndex); updateReasoningNode(node, stream); }
  if (method === "item/reasoning/summaryTextDelta") { const { node, stream } = reasoningItem(params.itemId); appendReasoningDelta(stream, "summary", params.summaryIndex, params.delta); updateReasoningNode(node, stream); scrollBottom(); }
  if (method === "item/reasoning/textDelta") { const { node, stream } = reasoningItem(params.itemId); appendReasoningDelta(stream, "content", params.contentIndex, params.delta); updateReasoningNode(node, stream); scrollBottom(); }
  if (method === "item/commandExecution/outputDelta") appendCommandOutput(findItemNode(params.itemId), params.delta);
  if (method === "item/commandExecution/terminalInteraction") appendTerminalInput(findItemNode(params.itemId), params.stdin);
  if (method === "item/fileChange/patchUpdated") upsertItem({ id: params.itemId, type: "fileChange", status: "inProgress", changes: params.changes || [] });
  if (method === "item/fileChange/outputDelta") appendToolProgress(findItemNode(params.itemId), params.delta);
  if (method === "item/mcpToolCall/progress") appendToolProgress(findItemNode(params.itemId), params.message);
  if (method === "item/plan/delta") {
    let node = findItemNode(params.itemId); if (!node) node = upsertItem({ id: params.itemId, type: "plan", status: "inProgress", text: "" });
    appendPlanDelta(node, params.delta);
  }
  if (method === "item/agentMessage/delta") setActivity({ phase: "responding", label: "正在生成回复", since: state.activity?.phase === "responding" ? state.activity.since : Date.now() });
  if (method === "item/completed") { if (params.item.type === "reasoning") { const stream = state.reasoningStreams.get(params.item.id) || createReasoningState(params.item); mergeCompletedReasoning(stream, params.item); state.reasoningStreams.set(params.item.id, stream); const old = findItemNode(params.item.id); const fresh = reasoningNode(params.item, stream); fresh.dataset.itemId = params.item.id; if (old) old.replaceWith(fresh); else $("messages").append(fresh); } else upsertItem(params.item); }
  if (method === "turn/completed") { for (const item of params.turn?.items || []) upsertItem(item); state.activeTurnId = null; state.threadStatus = { type: "idle" }; setActivity(state.queue.length ? { phase: "queue", label: "正在准备下一条排队消息", since: Date.now() } : null); updateComposer(); renderQueue(); loadQueue().catch(() => {}); loadThreads().catch(() => {}); }
  if (method === "serverRequest/resolved") resolvePendingRequest(params.requestId);
  if (method === "error") toast(params.error?.message || params.message || "Codex 运行出错");
}

function findItemNode(id) { return id ? $("messages").querySelector(`[data-item-id="${CSS.escape(String(id))}"]`) : null; }
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

function setActivity(activity) { state.activity = typeof activity === "string" ? { phase: "working", label: activity, since: Date.now() } : activity; renderActivity(); }
function renderActivity() { const box = $("activityStatus"); if (!box) return; const disconnected = !state.socketConnected && state.control?.mode === "web"; const activity = disconnected ? { label: "连接断开，正在重连", since: Date.now() } : state.activity; box.classList.toggle("hidden", !activity); box.classList.toggle("offline", disconnected); if (!activity) return; const seconds = Math.max(0, Math.floor((Date.now() - Number(activity.since || Date.now())) / 1000)); const detail = activity.detail ? ` · ${activity.detail}` : ""; box.lastElementChild.textContent = `${activity.label}${seconds ? ` · ${seconds}秒` : ""}${detail}`; }
function activityLabel(item = {}) { const labels = { reasoning: "正在思考", commandExecution: "正在执行命令", fileChange: "正在修改文件", webSearch: "正在搜索", mcpToolCall: "正在调用工具", dynamicToolCall: "正在调用工具", imageGeneration: "正在生成图片" }; return labels[item.type] || "正在处理"; }
function activityDetail(item = {}) { return item.type === "commandExecution" ? String(item.command || "").replace(/\s+/g, " ").slice(0, 80) : ""; }
function reasoningItem(itemId) { const id = String(itemId || ""); let stream = state.reasoningStreams.get(id); if (!stream) { stream = createReasoningState({ status: "inProgress" }); state.reasoningStreams.set(id, stream); } let node = document.querySelector(`.reasoning[data-item-id="${CSS.escape(id)}"]`); if (!node) { clearEmptyMessages(); node = reasoningNode({ status: "inProgress" }, stream); node.dataset.itemId = id; $("messages").append(node); } return { node, stream }; }
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
  if (state.control?.mode !== "web") return toast("接管 Codex 后才能读取实时使用情况");
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
  $("resetLimitBtn").disabled = count < 1;
  $("resetLimitBtn").dataset.creditId = firstCredit?.id || "";
  const buckets = payload.usage?.dailyUsageBuckets || [];
  const today = new Date().toISOString().slice(0, 10);
  const todayTokens = buckets.find((item) => item.startDate === today)?.tokens;
  $("usageTodayTokens").textContent = formatCount(todayTokens);
  $("usageLifetimeTokens").textContent = formatCount(payload.usage?.summary?.lifetimeTokens);
  $("usagePlan").textContent = formatPlan(snapshot.planType);
  $("usageMessage").textContent = snapshot.rateLimitReachedType ? "当前使用限额已达到上限。" : "";
}

async function resetRateLimit() {
  const count = Number((state.usage?.rateLimits?.rateLimitResetCredits?.availableCount) || 0);
  if (!count) return;
  if (!confirm(`将消耗 1 次额度重置，当前可用 ${count} 次。是否继续？`)) return;
  state.resetAttemptId ||= crypto.randomUUID();
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
function formatCount(value) { const count = Number(value); if (!Number.isFinite(count)) return "--"; return new Intl.NumberFormat("zh-CN", { notation: count >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(count); }
function formatPlan(value) { const names = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" }; return names[value] || value || "--"; }

async function api(url, options = {}) { const response = await fetch(url, { method: options.method || "GET", credentials: "same-origin", headers: options.body ? { "Content-Type": "application/json" } : undefined, body: options.body ? JSON.stringify(options.body) : undefined }); if (response.status === 401 && options.allow401) return null; const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }
function textFromContent(content = []) { return content.map((part) => part.text || (part.path ? `[图片：${part.path}]` : "")).filter(Boolean).join("\n"); }
function formatDate(value) { if (!value) return ""; const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value); if (Number.isNaN(date.getTime())) return ""; return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date); }
function scrollBottom() { requestAnimationFrame(() => { $("messages").scrollTop = $("messages").scrollHeight; }); }
function autoSize() { const input = $("messageInput"); input.style.height = "auto"; input.style.height = `${Math.min(180, input.scrollHeight)}px`; }
let toastTimer; function toast(text) { clearTimeout(toastTimer); $("toast").textContent = text; $("toast").classList.remove("hidden"); toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 4500); }

if ("serviceWorker" in navigator && (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
