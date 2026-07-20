import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const root = path.resolve(import.meta.dirname, "..");
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-web-integration-"));
const port = 18992;
const base = `http://127.0.0.1:${port}`;
const password = "integration-test-only";
let cookie = "";
let secondaryCookie = "";
let lastSetCookie = "";
let child;
let socket;
let stderr = "";
const serverEnv = {
  ...process.env,
  CODEX_WEB_TEST_MODE: "1",
  CODEX_WEB_TEST_DROP_TURN_COMPLETED: "1",
  CODEX_WEB_HOST: "127.0.0.1",
  CODEX_WEB_PORT: String(port),
  CODEX_WEB_PASSWORD: password,
  CODEX_WEB_SESSION_HOURS: "24",
  CODEX_WEB_DATA_DIR: path.join(temp, "data"),
  CODEX_WEB_UPLOAD_DIR: path.join(temp, "uploads"),
};

const request = async (url, options = {}) => {
  const sessionCookie = options.sessionCookie ?? cookie;
  const response = await fetch(`${base}${url}`, {
    method: options.method || "GET",
    headers: { ...(sessionCookie ? { Cookie: sessionCookie } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.headers.get("set-cookie")) { lastSetCookie = response.headers.get("set-cookie"); cookie = lastSetCookie.split(";")[0]; }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url}: ${data.error || response.status}`);
  return data;
};

const waitFor = async (check, timeoutMs = 180_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("Timed out waiting for queued turns");
};

const startServer = async () => {
  const processHandle = spawn(process.execPath, ["server.mjs"], { cwd: root, env: serverEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  processHandle.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await waitFor(async () => fetch(`${base}/api/session`).then((response) => response.ok).catch(() => false), 15_000);
  return processHandle;
};

const stopServer = async (processHandle) => {
  if (!processHandle || processHandle.killed) return;
  await new Promise((resolve) => { processHandle.once("exit", resolve); processHandle.kill(); setTimeout(resolve, 3000); });
};

try {
  child = await startServer();
  await request("/api/login", { method: "POST", body: { password } });
  if (!/Max-Age=86400/i.test(lastSetCookie)) throw new Error(`Unexpected session lifetime: ${lastSetCookie}`);
  const persistedSessions = await fsp.readFile(path.join(temp, "data", "sessions.json"), "utf8");
  if (persistedSessions.includes(cookie.split("=")[1])) throw new Error("Raw session token was persisted");
  await request("/api/control/takeover", { method: "POST", body: {} });
  const primaryCookie = cookie;
  await request("/api/login", { method: "POST", body: { password } });
  secondaryCookie = cookie;
  const secondaryControl = await request("/api/control/status");
  if (!secondaryControl.controller || secondaryControl.controllerBusy || !secondaryControl.sharedWebControl) {
    throw new Error(`Second Web session did not receive shared control: ${JSON.stringify(secondaryControl)}`);
  }
  cookie = primaryCookie;
  const primaryControl = await request("/api/control/status");
  if (!primaryControl.controller || primaryControl.controllerBusy || !primaryControl.sharedWebControl) {
    throw new Error(`First Web session lost shared control: ${JSON.stringify(primaryControl)}`);
  }
  let accountUsageVerified = true;
  try {
    const accountUsage = await request("/api/account/usage");
    if (!accountUsage.rateLimits?.rateLimits) throw new Error("Account rate limits were not returned");
  } catch (error) {
    // The quota endpoint is a separate ChatGPT backend and can be temporarily
    // unavailable while normal Codex turns still work. Keep the integration
    // suite useful without treating that external outage as a product failure.
    if (!/failed to fetch codex rate limits|error sending request/i.test(error.message)) throw error;
    accountUsageVerified = false;
  }
  const created = await request("/api/threads", { method: "POST", body: { cwd: root } });
  const threadId = created.thread.id;
  let completedCount = 0;
  let replyText = "";
  let sawActivity = false;
  let sawQueueActivity = false;
  let sawOfficialActive = false;
  let sawOfficialIdle = false;
  let sawSettings = false;
  let sawReasoning = false;
  let sawTokenUsage = false;
  let sawCommandStart = false;
  let sawCommandOutput = false;
  let highestSeq = 0;
  const observedStatuses = [];
  const completedTurns = [];
  socket = new WebSocket(`${base.replace("http", "ws")}/events`, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.on("message", (raw) => {
    try {
      const event = JSON.parse(String(raw));
      if (event.seq) highestSeq = Math.max(highestSeq, Number(event.seq));
      if (event.type === "activity" && event.data?.threadId === threadId) {
        sawActivity ||= Boolean(event.data.activity?.label);
        sawQueueActivity ||= event.data.activity?.phase === "queue";
      }
      if (event.type !== "notification" || event.data?.params?.threadId !== threadId) return;
      if (event.data.method === "thread/status/changed") observedStatuses.push(event.data.params.status);
      if (event.data.method === "thread/status/changed" && event.data.params.status?.type === "active") sawOfficialActive = true;
      if (event.data.method === "thread/status/changed" && event.data.params.status?.type === "idle") sawOfficialIdle = true;
      if (event.data.method === "thread/settings/updated") sawSettings = true;
      if (event.data.method === "thread/tokenUsage/updated") sawTokenUsage = true;
      if (event.data.method === "item/started" && event.data.params.item?.type === "reasoning") sawReasoning = true;
      if (event.data.method === "item/started" && event.data.params.item?.type === "commandExecution") sawCommandStart = true;
      if (event.data.method === "item/commandExecution/outputDelta" && String(event.data.params.delta || "").includes("TIMELINE_COMMAND_OK")) sawCommandOutput = true;
      if (event.data.method.startsWith("item/reasoning/")) sawReasoning = true;
      if (event.data.method === "item/agentMessage/delta") replyText += event.data.params.delta || "";
      if (event.data.method === "turn/completed") { completedCount += 1; completedTurns.push(event.data.params.turn); }
    } catch { }
  });
  const [primarySubmission, secondarySubmission] = await Promise.all([
    request(`/api/threads/${threadId}/messages`, { method: "POST", sessionCookie: primaryCookie, body: { text: "Run a shell command that prints TIMELINE_COMMAND_OK, then reply with exactly QUEUE_FIRST_OK.", mode: "auto", effort: "low", summary: "detailed" } }),
    request(`/api/threads/${threadId}/messages`, { method: "POST", sessionCookie: secondaryCookie, body: { text: "Reply with exactly QUEUE_SECOND_OK.", mode: "auto" } }),
  ]);
  if (Number(Boolean(primarySubmission.queued)) + Number(Boolean(secondarySubmission.queued)) !== 1) {
    throw new Error(`Concurrent Web submissions were not serialized: ${JSON.stringify({ primarySubmission, secondarySubmission })}`);
  }
  await waitFor(async () => {
    const status = await request("/api/control/status");
    return completedCount >= 2 && !status.activeTurns?.[threadId] && !status.queuedByThread?.[threadId];
  });
  const failedTurns = completedTurns.filter((turn) => turn?.status === "failed");
  if (failedTurns.length) throw new Error(`Turns failed: ${JSON.stringify(failedTurns.map((turn) => turn.error))}`);
  if (!replyText.includes("QUEUE_FIRST_OK") || !replyText.includes("QUEUE_SECOND_OK")) throw new Error(`Expected replies were missing: ${replyText}`);
  if (!sawActivity || !sawQueueActivity) throw new Error("Thinking or queue activity events were not emitted");
  if (!sawOfficialActive || !sawOfficialIdle) throw new Error(`Official thread status lifecycle was incomplete: ${JSON.stringify(observedStatuses)}`);
  if (!sawSettings) throw new Error("Official thread settings were not synchronized");
  if (!sawTokenUsage) throw new Error("Official token usage events were not emitted");
  if (!sawCommandStart || !sawCommandOutput) throw new Error("Command timeline events were incomplete");
  const synchronized = await request("/api/control/status");
  if (!synchronized.fullAccess) throw new Error("Full access was not enabled by default");
  if (!synchronized.turnPlans || !synchronized.turnDiffs || !Array.isArray(synchronized.pendingRequests)) throw new Error("Reconnect state snapshot is incomplete");
  const restoredSettings = synchronized.threadSettings?.[threadId];
  if (!restoredSettings || restoredSettings.summary !== "detailed" || restoredSettings.effort !== "low") throw new Error("Thread reasoning settings were not restored");

  const replayFrom = highestSeq;
  socket.close(); socket = null;
  await request("/api/control/full-access", { method: "POST", body: { enabled: false } });
  let replayHello = false;
  let replayedControl = false;
  socket = new WebSocket(`${base.replace("http", "ws")}/events?since=${replayFrom}`, { headers: { Cookie: cookie } });
  socket.on("message", (raw) => {
    try {
      const event = JSON.parse(String(raw));
      if (event.type === "hello") replayHello = event.data?.replayAvailable === true;
      if (event.type === "control" && event.seq > replayFrom && event.data?.fullAccess === false) replayedControl = true;
    } catch { }
  });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  await waitFor(async () => replayHello && replayedControl, 10_000);
  await request("/api/control/full-access", { method: "POST", body: { enabled: true } });
  await request("/api/control/release", { method: "POST", body: { discardQueue: true } });
  socket.close(); socket = null;
  await stopServer(child); child = null;
  child = await startServer();
  const restoredSession = await request("/api/session");
  if (!restoredSession.authenticated) throw new Error("24-hour session did not survive a server restart");
  console.log(`WEB_INTEGRATION_OK reasoning_events=${sawReasoning} account_usage=${accountUsageVerified ? "verified" : "upstream_unavailable"}`);
  if (stderr.trim()) console.error(stderr.trim());
} finally {
  socket?.close();
  await stopServer(child);
  await fsp.rm(temp, { recursive: true, force: true });
}
