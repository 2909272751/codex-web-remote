const OUTPUT_LIMIT = 500_000;

export function timelineItemNode(item = {}) {
  switch (item.type) {
    case "plan": return planItem(item);
    case "commandExecution": return commandItem(item);
    case "fileChange": return fileChangeItem(item);
    case "mcpToolCall": return mcpToolItem(item);
    case "dynamicToolCall": return dynamicToolItem(item);
    case "collabAgentToolCall": return collabItem(item);
    case "subAgentActivity": return simpleItem(item, "agents", "子代理活动", `${item.agentPath || item.agentThreadId || "子代理"} · ${item.kind || "处理中"}`);
    case "webSearch": return webSearchItem(item);
    case "imageView": return simpleItem(item, "image", "查看图片", item.path || "图片");
    case "sleep": return simpleItem(item, "wait", "等待", `${Math.max(0, Number(item.durationMs || 0))} 毫秒`);
    case "imageGeneration": return imageGenerationItem(item);
    case "enteredReviewMode": return simpleItem(item, "review", "进入审查模式", item.review || "正在审查代码");
    case "exitedReviewMode": return simpleItem(item, "review", "完成审查", item.review || "审查结束");
    case "contextCompaction": return simpleItem(item, "context", "上下文已整理", "Codex 已压缩较早的对话上下文");
    case "hookPrompt": return hookPromptItem(item);
    default: return item.type ? genericItem(item) : null;
  }
}

export function turnPlanNode(payload = {}) {
  const node = baseCard({ kind: "plan", icon: "☷", title: "执行计划", subtitle: payload.explanation || "Codex 正在更新计划", status: planOverallStatus(payload.plan), open: true });
  node.dataset.turnPlan = String(payload.turnId || "current");
  const list = document.createElement("ol"); list.className = "plan-steps";
  for (const entry of payload.plan || []) {
    const row = document.createElement("li"); row.className = `plan-step ${entry.status || "pending"}`;
    const mark = document.createElement("span"); mark.textContent = entry.status === "completed" ? "✓" : entry.status === "inProgress" ? "●" : "○";
    const text = document.createElement("span"); text.textContent = entry.step || "未命名步骤";
    row.append(mark, text); list.append(row);
  }
  node.querySelector(".timeline-body").append(list);
  return node;
}

export function turnDiffNode(payload = {}) {
  const diff = String(payload.diff || "");
  const stats = diffStats(diff);
  const node = baseCard({ kind: "diff", icon: "±", title: "本轮代码变更", subtitle: stats.label, status: diff ? "completed" : "inProgress", open: false });
  node.dataset.turnDiff = String(payload.turnId || "current");
  node.querySelector(".timeline-body").append(diffBlock(diff || "等待文件变更…"));
  return node;
}

export function appendCommandOutput(node, delta) {
  const output = node?.querySelector('[data-stream="command"]');
  if (!output) return;
  if (output.dataset.placeholder === "true") { output.textContent = ""; delete output.dataset.placeholder; }
  output.textContent = cappedAppend(output.textContent, delta);
  node.open = true;
}

export function appendTerminalInput(node, stdin) {
  appendCommandOutput(node, `\n› ${String(stdin || "")}\n`);
}

export function appendPlanDelta(node, delta) {
  const content = node?.querySelector('[data-stream="plan"]');
  if (!content) return;
  if (content.dataset.placeholder === "true") { content.textContent = ""; delete content.dataset.placeholder; }
  content.textContent = cappedAppend(content.textContent, delta);
  node.open = true;
}

export function appendToolProgress(node, message) {
  const list = node?.querySelector(".timeline-progress-list");
  if (!list) return;
  const row = document.createElement("li"); row.textContent = String(message || "正在处理"); list.append(row);
  while (list.children.length > 30) list.firstElementChild.remove();
  node.open = true;
}

function commandItem(item) {
  const action = item.commandActions?.[0]?.type;
  const labels = { read: "读取文件", listFiles: "列出文件", search: "搜索内容", unknown: "运行命令" };
  const node = baseCard({ kind: "command", icon: "›_", title: labels[action] || "运行命令", subtitle: compact(item.command), status: item.status, open: item.status === "inProgress" });
  const body = node.querySelector(".timeline-body");
  body.append(metaRow([
    item.cwd && `目录：${item.cwd}`,
    item.durationMs != null && `耗时：${formatDuration(item.durationMs)}`,
    item.exitCode != null && `退出码：${item.exitCode}`,
  ]));
  body.append(section("命令", codeBlock(item.command || "")));
  const output = codeBlock(item.aggregatedOutput || "等待输出…"); output.dataset.stream = "command";
  if (!item.aggregatedOutput) output.dataset.placeholder = "true";
  body.append(section("输出", output));
  return node;
}

function fileChangeItem(item) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const totals = changes.reduce((sum, change) => { const stats = diffStats(change.diff || ""); sum.add += stats.add; sum.del += stats.del; return sum; }, { add: 0, del: 0 });
  const node = baseCard({ kind: "files", icon: "▤", title: `编辑 ${changes.length} 个文件`, subtitle: `+${totals.add} −${totals.del}`, status: item.status, open: item.status === "inProgress" });
  const list = document.createElement("div"); list.className = "file-change-list";
  for (const change of changes) {
    const details = document.createElement("details"); details.className = "file-change";
    const header = document.createElement("summary");
    const kind = change.kind?.type || "update";
    const badge = document.createElement("span"); badge.className = `file-kind ${kind}`; badge.textContent = ({ add: "新增", delete: "删除", update: "修改" })[kind] || kind;
    const path = document.createElement("code"); path.textContent = change.path || "未知文件";
    const stats = document.createElement("small"); stats.textContent = diffStats(change.diff || "").label;
    header.append(badge, path, stats); details.append(header, diffBlock(change.diff || "暂无 Diff")); list.append(details);
  }
  if (!changes.length) { const waiting = document.createElement("p"); waiting.className = "timeline-muted"; waiting.textContent = "正在准备文件变更…"; list.append(waiting); }
  node.querySelector(".timeline-body").append(list);
  return node;
}

function planItem(item) {
  const node = baseCard({ kind: "plan", icon: "☷", title: "计划", subtitle: compact(item.text || "正在制定计划"), status: item.status || "completed", open: item.status === "inProgress" });
  const content = document.createElement("div"); content.className = "plan-text"; content.dataset.stream = "plan"; content.textContent = item.text || "正在制定计划…";
  if (!item.text) content.dataset.placeholder = "true";
  node.querySelector(".timeline-body").append(content); return node;
}

function mcpToolItem(item) {
  const title = item.appContext?.displayName || item.tool || "MCP 工具";
  const node = baseCard({ kind: "tool", icon: "◇", title, subtitle: item.server || item.pluginId || "工具调用", status: item.status, open: item.status === "inProgress" });
  const body = node.querySelector(".timeline-body");
  body.append(section("参数", codeBlock(pretty(item.arguments))));
  const progress = document.createElement("ul"); progress.className = "timeline-progress-list"; body.append(progress);
  if (item.result) appendToolResult(body, item.result);
  if (item.error?.message) body.append(errorBlock(item.error.message));
  if (item.durationMs != null) body.append(metaRow([`耗时：${formatDuration(item.durationMs)}`]));
  return node;
}

function dynamicToolItem(item) {
  const title = [item.namespace, item.tool].filter(Boolean).join(".") || "客户端工具";
  const node = baseCard({ kind: "tool", icon: "◇", title, subtitle: "动态工具调用", status: item.status, open: item.status === "inProgress" });
  const body = node.querySelector(".timeline-body"); body.append(section("参数", codeBlock(pretty(item.arguments))));
  const progress = document.createElement("ul"); progress.className = "timeline-progress-list"; body.append(progress);
  if (item.contentItems?.length) body.append(section("结果", codeBlock(item.contentItems.map((entry) => entry.text || entry.imageUrl || pretty(entry)).join("\n"))));
  return node;
}

function collabItem(item) {
  const node = baseCard({ kind: "agents", icon: "◎", title: "多代理协作", subtitle: String(item.tool || "协作任务"), status: item.status, open: item.status === "inProgress" });
  const body = node.querySelector(".timeline-body");
  if (item.prompt) body.append(section("任务", textBlock(item.prompt)));
  const agents = Object.entries(item.agentsStates || {}).map(([id, value]) => `${id}：${value?.status || pretty(value)}`);
  if (agents.length) body.append(section("代理状态", codeBlock(agents.join("\n"))));
  return node;
}

function webSearchItem(item) {
  const action = item.action || {};
  const labels = { search: "网页搜索", openPage: "打开网页", findInPage: "页内查找", other: "网页操作" };
  const detail = action.query || action.queries?.join("、") || action.url || action.pattern || item.query || "";
  return simpleItem(item, "search", labels[action.type] || "网页搜索", detail);
}

function imageGenerationItem(item) {
  const node = simpleItem(item, "image", "生成图片", item.revisedPrompt || item.savedPath || item.result || "图片生成任务");
  if (item.savedPath) node.querySelector(".timeline-body").append(metaRow([`保存位置：${item.savedPath}`]));
  return node;
}

function hookPromptItem(item) {
  const fragments = (item.fragments || []).map((fragment) => fragment.text || pretty(fragment)).filter(Boolean);
  return simpleItem(item, "context", "已加载附加指令", fragments.join("\n") || "Hook 提示");
}

function genericItem(item) { return simpleItem(item, "generic", friendlyType(item.type), pretty(item)); }
function simpleItem(item, kind, title, text) {
  const node = baseCard({ kind, icon: iconFor(kind), title, subtitle: compact(text), status: item.status || "completed", open: item.status === "inProgress" });
  node.querySelector(".timeline-body").append(textBlock(text || "")); return node;
}

function baseCard({ kind, icon, title, subtitle, status, open }) {
  const node = document.createElement("details"); node.className = `message timeline-card timeline-${kind}`; node.open = Boolean(open);
  const summary = document.createElement("summary");
  const mark = document.createElement("span"); mark.className = "timeline-icon"; mark.textContent = icon;
  const heading = document.createElement("span"); heading.className = "timeline-heading";
  const strong = document.createElement("strong"); strong.textContent = title;
  const small = document.createElement("small"); small.textContent = subtitle || "";
  heading.append(strong, small);
  const badge = document.createElement("span"); badge.className = `timeline-status ${statusClass(status)}`; badge.textContent = statusText(status);
  summary.append(mark, heading, badge);
  const body = document.createElement("div"); body.className = "timeline-body";
  node.append(summary, body); return node;
}

function section(title, child) { const wrap = document.createElement("section"); const label = document.createElement("h4"); label.textContent = title; wrap.append(label, child); return wrap; }
function codeBlock(text) { const pre = document.createElement("pre"); pre.className = "timeline-code"; pre.textContent = String(text || ""); return pre; }
function diffBlock(text) { const pre = codeBlock(text); pre.classList.add("timeline-diff"); return pre; }
function textBlock(text) { const div = document.createElement("div"); div.className = "timeline-text"; div.textContent = String(text || ""); return div; }
function errorBlock(text) { const div = document.createElement("div"); div.className = "timeline-error"; div.textContent = String(text || "工具执行失败"); return div; }
function metaRow(values) { const row = document.createElement("div"); row.className = "timeline-meta"; for (const value of values.filter(Boolean)) { const span = document.createElement("span"); span.textContent = value; row.append(span); } return row; }

function toolResultText(result) {
  const content = Array.isArray(result?.content) ? result.content.map((entry) => entry?.text || entry?.resource?.uri || (isToolImage(entry) ? "[图片]" : pretty(entry))).join("\n") : "";
  return content || pretty(result?.structuredContent ?? result);
}
function appendToolResult(body, result) {
  body.append(section("结果", codeBlock(toolResultText(result))));
  for (const entry of Array.isArray(result?.content) ? result.content : []) {
    const src = toolImageSource(entry);
    if (!src) continue;
    const image = document.createElement("img");
    image.className = "timeline-tool-image";
    image.alt = "工具返回的截图";
    image.loading = "lazy";
    image.src = src;
    body.append(image);
  }
}
function isToolImage(entry) { return Boolean(toolImageSource(entry)); }
function toolImageSource(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.image_url === "string") return entry.image_url;
  if (typeof entry.imageUrl === "string") return entry.imageUrl;
  if (typeof entry.data === "string" && (entry.type === "image" || String(entry.mimeType || entry.mime_type || "").startsWith("image/"))) {
    return `data:${entry.mimeType || entry.mime_type || "image/png"};base64,${entry.data}`;
  }
  return "";
}
function diffStats(diff) { let add = 0; let del = 0; for (const line of String(diff || "").split(/\r?\n/)) { if (line.startsWith("+") && !line.startsWith("+++")) add += 1; if (line.startsWith("-") && !line.startsWith("---")) del += 1; } return { add, del, label: `+${add} −${del}` }; }
function planOverallStatus(plan = []) { return plan.some((item) => item.status === "inProgress") ? "inProgress" : plan.length && plan.every((item) => item.status === "completed") ? "completed" : "pending"; }
function statusClass(status) { return String(status || "completed").replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`); }
function statusText(status) { return ({ inProgress: "运行中", completed: "完成", failed: "失败", declined: "已拒绝", pending: "待处理" })[status] || String(status || "完成"); }
function formatDuration(ms) { const value = Number(ms || 0); return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`; }
function compact(value) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, 180); }
function cappedAppend(current, delta) { const joined = `${current || ""}${delta || ""}`; return joined.length > OUTPUT_LIMIT ? `…较早输出已折叠…\n${joined.slice(-OUTPUT_LIMIT)}` : joined; }
function pretty(value) { if (typeof value === "string") return value; try { return JSON.stringify(value ?? {}, null, 2); } catch { return String(value); } }
function friendlyType(type) { return String(type || "事件").replace(/([a-z])([A-Z])/g, "$1 $2"); }
function iconFor(kind) { return ({ search: "⌕", image: "▧", wait: "◷", review: "✓", context: "↻", agents: "◎", generic: "•" })[kind] || "•"; }
