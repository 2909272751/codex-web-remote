import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { threadTimestamp } from "../public/project-utils.js";

const root = path.resolve(import.meta.dirname, "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cwr-thread-list-order-"));
const profile = path.join(temp, "user");
const codexHome = path.join(profile, ".codex");
const dataDir = path.join(temp, "data");
const boundPort = net.createServer();
await new Promise((resolve) => boundPort.listen(0, "127.0.0.1", resolve));
const port = boundPort.address().port;
await new Promise((resolve) => boundPort.close(resolve));
const base = `http://127.0.0.1:${port}`;
const password = "thread-list-order-password";
let child = null;

try {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const now = Date.now();
  const latestUpdate = new Date(now - 10 * 60_000).toISOString();
  const records = [
    { id: "thread-newer-update", name: "最新更新", preview: "最新更新", cwd: "E:\\实用软件开发", recencyAt: Math.floor((now - 3 * 60 * 60_000) / 1000), updatedAt: latestUpdate, createdAt: new Date(now - 5 * 60 * 60_000).toISOString() },
    { id: "thread-newer-recency", name: "较新活跃", preview: "较新活跃", cwd: "E:\\实用软件开发", recencyAt: Math.floor((now - 60 * 60_000) / 1000), updatedAt: new Date(now - 2 * 60 * 60_000).toISOString(), createdAt: new Date(now - 6 * 60 * 60_000).toISOString() },
  ];
  await fs.writeFile(path.join(dataDir, "threads.json"), JSON.stringify(records), "utf8");

  child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      USERPROFILE: profile,
      CODEX_WEB_HOST: "127.0.0.1",
      CODEX_WEB_PORT: String(port),
      CODEX_WEB_PASSWORD: password,
      CODEX_WEB_DATA_DIR: dataDir,
      CODEX_WEB_TEST_MODE: "1",
      CODEX_WEB_AUTO_PREPARE: "0",
      CODEX_WEB_TITLE_CACHE_MS: "0",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/session`)).ok) { ready = true; break; } } catch { }
    await delay(100);
  }
  assert.ok(ready, `thread-list-order server did not start: ${stderr.slice(-1200)}`);
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const previews = await (await fetch(`${base}/api/thread-previews`, { headers: { cookie } })).json();
  assert.equal(previews.data[0].id, "thread-newer-update", JSON.stringify(previews));
  assert.ok(threadTimestamp(previews.data[0]) > threadTimestamp(previews.data[1]));
  console.log("THREAD_LIST_ORDER_TEST_OK newestSignalFirst=true");
} finally {
  if (child && child.exitCode == null) {
    try { child.kill(); } catch { }
    await delay(500);
    if (child.exitCode == null) { try { child.kill("SIGKILL"); } catch { } }
  }
  if (temp.startsWith(path.join(os.tmpdir(), "cwr-thread-list-order-"))) await fs.rm(temp, { recursive: true, force: true });
}