import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-web-update-test-"));
const releaseServer = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    tag_name: "v99.0.0",
    html_url: "https://github.com/2909272751/codex-web-remote/releases/tag/v99.0.0",
    draft: false,
    prerelease: false,
    published_at: "2099-01-01T00:00:00Z",
    assets: [
      { name: "CodexWebRemote-Setup-99.0.0-win-x64.exe" },
      { name: "CodexWebRemote-Setup-99.0.0-win-x64.exe.sha256" },
    ],
  }));
});
await new Promise((resolve, reject) => { releaseServer.once("error", reject); releaseServer.listen(0, "127.0.0.1", resolve); });
const releasePort = releaseServer.address().port;
const gatewayPort = 18994;
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    CODEX_WEB_PASSWORD: "update-test-password",
    CODEX_WEB_HOST: "127.0.0.1",
    CODEX_WEB_PORT: String(gatewayPort),
    CODEX_WEB_DATA_DIR: path.join(temp, "data"),
    CODEX_WEB_UPLOAD_DIR: path.join(temp, "uploads"),
    CODEX_WEB_UPDATE_REQUEST_FILE: path.join(temp, "update-request.json"),
    CODEX_WEB_UPDATE_API: `http://127.0.0.1:${releasePort}/latest`,
  },
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await fetch(`http://127.0.0.1:${gatewayPort}/api/session`).then((response) => response.ok).catch(() => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const login = await fetch(`http://127.0.0.1:${gatewayPort}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "update-test-password" }),
  });
  if (!login.ok) throw new Error(`Login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/update/status`, { headers: { Cookie: cookie } });
  const status = await response.json();
  if (!response.ok || !status.currentVersion || !status.updateAvailable || status.latestVersion !== "99.0.0" || !status.updaterAvailable) throw new Error(`Unexpected update status: ${JSON.stringify(status)}`);
  console.log("UPDATE_CHECK_TEST_OK detected=true updater=true");
} finally {
  child.kill();
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 3000); });
  await new Promise((resolve) => releaseServer.close(resolve));
  await fsp.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (stderr.trim()) console.error(stderr.trim());
}
