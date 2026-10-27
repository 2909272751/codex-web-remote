import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cwr-takeover-speed-"));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const password = "takeover-speed-test-password";
const stateFile = path.join(temp, "desktop-state.json");
const dataDir = path.join(temp, "data");
const base = `http://127.0.0.1:${port}`;
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
  await fs.writeFile(stateFile, JSON.stringify({
    running: true,
    processes: [{
      pid: 999_999,
      parentPid: 1,
      name: "ChatGPT.exe",
      executablePath: "C:\\fixture\\ChatGPT.exe",
      startedAt: new Date(Date.now() + 3_600_000).toISOString(),
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
      CODEX_WEB_DATA_DIR: dataDir,
      CODEX_WEB_TEST_MODE: "1",
      CODEX_WEB_TEST_DESKTOP_STATE_FILE: stateFile,
      CODEX_WEB_AUTO_PREPARE: "0",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const readyDeadline = Date.now() + 25_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try { const response = await fetch(`${base}/api/session`); if (response.ok) { ready = true; break; } } catch { }
    await delay(120);
  }
  assert.ok(ready, `test gateway did not start: ${stderr.slice(-1200)}`);

  const login = await request("/api/login", { method: "POST", body: { password } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const cookie = login.cookie.split(";")[0];
  assert.ok(cookie, "login did not return a session cookie");

  const statusStarted = performance.now();
  const initial = await request("/api/control/status", { cookie });
  const statusMs = Math.round(performance.now() - statusStarted);
  assert.equal(initial.status, 200, JSON.stringify(initial.data));
  assert.equal(initial.data.desktopRunning, true);

  const started = performance.now();
  const takeover = await request("/api/control/takeover", { method: "POST", body: { force: false }, cookie });
  const responseMs = Math.round(performance.now() - started);
  assert.equal(takeover.status, 200, JSON.stringify(takeover.data));
  assert.equal(takeover.data.ok, true, JSON.stringify(takeover.data));

  let finalStatus = null;
  const takeoverDeadline = Date.now() + 45_000;
  while (Date.now() < takeoverDeadline) {
    const state = await request("/api/control/status", { cookie });
    finalStatus = state.data;
    if (finalStatus.mode === "web" && finalStatus.codexReady) break;
    if (finalStatus.takeoverState?.phase === "failed") break;
    await delay(200);
  }
  const totalMs = Math.round(performance.now() - started);
  assert.equal(finalStatus?.mode, "web", JSON.stringify(finalStatus?.takeoverState));
  assert.equal(finalStatus?.codexReady, true);
  assert.equal(finalStatus?.takeoverState?.phase, "ready");
  assert.ok(totalMs < 40_000, `takeover took too long: ${totalMs}ms`);

  await request("/api/control/release", { method: "POST", body: { discardQueue: true }, cookie });
  console.log(JSON.stringify({
    result: "TAKEOVER_SPEED_TEST_OK",
    statusMs,
    responseMs,
    totalMs,
    serverDurationMs: takeover.data.durationMs || null,
    timings: takeover.data.timings || finalStatus?.takeoverState?.timings || null,
  }));
} finally {
  if (child && child.exitCode == null) {
    try { child.kill(); } catch { }
    await delay(500);
    if (child.exitCode == null) { try { child.kill("SIGKILL"); } catch { } }
  }
  if (temp.startsWith(path.join(os.tmpdir(), "cwr-takeover-speed-"))) await fs.rm(temp, { recursive: true, force: true });
}
