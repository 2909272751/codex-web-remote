import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cwr-takeover-activity-"));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const password = "takeover-activity-test-password";
const base = `http://127.0.0.1:${port}`;
const sessionRoot = path.join(temp, "sessions");
const stateFile = path.join(temp, "desktop-state.json");
const sessionFile = path.join(sessionRoot, "2026", "10", "20", "rollout-long-turn.jsonl");
let child = null;

async function request(pathname, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      origin: base,
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data, cookie: response.headers.get("set-cookie") || "" };
}

try {
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  const startedEvent = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-long" },
  });
  const fillerLine = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(80) } });
  // More than the 1MB tail: the safety scan must find task_started outside it.
  const filler = `${fillerLine}\n`.repeat(16_000);
  await fs.writeFile(sessionFile, `${startedEvent}\n${filler}`, "utf8");
  await fs.writeFile(stateFile, JSON.stringify({
    running: true,
    processes: [{
      pid: 999_998,
      parentPid: 1,
      name: "ChatGPT.exe",
      executablePath: "C:\\fixture\\ChatGPT.exe",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    }],
  }), "utf8");

  child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_WEB_HOST: "127.0.0.1",
      CODEX_WEB_PORT: String(port),
      CODEX_WEB_PASSWORD: password,
      CODEX_WEB_DATA_DIR: path.join(temp, "data"),
      CODEX_WEB_TEST_MODE: "1",
      CODEX_WEB_TEST_DESKTOP_STATE_FILE: stateFile,
      CODEX_WEB_SESSION_ROOT: sessionRoot,
      CODEX_WEB_AUTO_PREPARE: "0",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const readyDeadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try { const response = await fetch(`${base}/api/session`); if (response.ok) { ready = true; break; } } catch { }
    await delay(100);
  }
  assert.ok(ready, `activity test gateway did not start: ${stderr.slice(-1200)}`);

  const login = await request("/api/login", { method: "POST", body: { password } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const cookie = login.cookie.split(";")[0];

  const busyStarted = performance.now();
  const busy = await request("/api/control/takeover", { method: "POST", body: { force: false }, cookie });
  const busyMs = Math.round(performance.now() - busyStarted);
  assert.equal(busy.status, 409, JSON.stringify(busy.data));
  assert.equal(busy.data.code, "DESKTOP_BUSY", JSON.stringify(busy.data));
  assert.equal(busy.data.activity?.running, true);

  await fs.appendFile(sessionFile, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-long" },
  })}\n`, "utf8");

  const takeoverStarted = performance.now();
  const takeover = await request("/api/control/takeover", { method: "POST", body: { force: false }, cookie });
  const takeoverMs = Math.round(performance.now() - takeoverStarted);
  assert.equal(takeover.status, 200, JSON.stringify(takeover.data));
  assert.equal(takeover.data.ok, true, JSON.stringify(takeover.data));

  const status = await request("/api/control/status", { cookie });
  assert.equal(status.data.mode, "web");
  await request("/api/control/release", { method: "POST", body: { discardQueue: true }, cookie });
  console.log(JSON.stringify({ result: "TAKEOVER_ACTIVITY_TEST_OK", busyMs, takeoverMs }));
} finally {
  if (child && child.exitCode == null) {
    try { child.kill(); } catch { }
    await delay(500);
    if (child.exitCode == null) { try { child.kill("SIGKILL"); } catch { } }
  }
  if (temp.startsWith(path.join(os.tmpdir(), "cwr-takeover-activity-"))) await fs.rm(temp, { recursive: true, force: true });
}
