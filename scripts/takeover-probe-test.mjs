import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32") {
  console.log("TAKEOVER_PROBE_TEST_OK windows=skipped");
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cwr-takeover-probe-"));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const password = "takeover-probe-test-password";
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
      CODEX_WEB_AUTO_PREPARE: "0",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const readyDeadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try { const response = await fetch(`${base}/api/session`); if (response.ok) { ready = true; break; } } catch { }
    await delay(120);
  }
  assert.ok(ready, `probe test gateway did not start: ${stderr.slice(-1200)}`);

  const login = await request("/api/login", { method: "POST", body: { password } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const cookie = login.cookie.split(";")[0];

  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now();
    const status = await request("/api/control/status", { cookie });
    samples.push(Math.round(performance.now() - started));
    assert.equal(status.status, 200, JSON.stringify(status.data));
    if (!status.data.desktopRunning) {
      console.log(JSON.stringify({ result: "TAKEOVER_PROBE_TEST_OK", desktopRunning: false, samples }));
      process.exitCode = 0;
      break;
    }
    assert.ok(Array.isArray(status.data.desktopProcesses) && status.data.desktopProcesses.length > 0);
    assert.ok(status.data.desktopProcesses.every((item) => Number.isFinite(Date.parse(item.startedAt))));
  }
  if (!process.exitCode) {
    assert.ok(samples[0] < 2_500, `first desktop probe is too slow: ${samples[0]}ms`);
    console.log(JSON.stringify({ result: "TAKEOVER_PROBE_TEST_OK", desktopRunning: true, samples }));
  }
} finally {
  if (child && child.exitCode == null) {
    try { child.kill(); } catch { }
    await delay(400);
    if (child.exitCode == null) { try { child.kill("SIGKILL"); } catch { } }
  }
  if (temp.startsWith(path.join(os.tmpdir(), "cwr-takeover-probe-"))) await fs.rm(temp, { recursive: true, force: true });
}
