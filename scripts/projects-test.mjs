import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = 18998;
const base = `http://127.0.0.1:${port}`;
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-web-projects-"));
const dataDir = path.join(tempRoot, "data");
const projectPath = path.join(tempRoot, "示例项目");
await fsp.mkdir(projectPath, { recursive: true });
let cookie = "";
let stderr = "";

const serverEnv = {
  ...process.env,
  CODEX_WEB_PASSWORD: "projects-test-password",
  CODEX_WEB_HOST: "127.0.0.1",
  CODEX_WEB_PORT: String(port),
  CODEX_WEB_DATA_DIR: dataDir,
  CODEX_WEB_TEST_MODE: "1",
};

async function startServer() {
  stderr = "";
  const child = spawn(process.execPath, ["server.mjs"], { cwd: root, env: serverEnv, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/session`)).ok) return child; } catch { }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Project test server did not start: ${stderr}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function request(url, options = {}) {
  const response = await fetch(`${base}${url}`, {
    method: options.method || "GET",
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(options.body ? { "Content-Type": "application/json", Origin: base } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !options.allowError) throw new Error(data.error || `HTTP ${response.status}`);
  return { response, data };
}

let child;
try {
  child = await startServer();
  await request("/api/login", { method: "POST", body: { password: "projects-test-password" } });

  const browser = await request(`/api/directories?path=${encodeURIComponent(tempRoot)}`);
  if (!browser.data.entries.some((entry) => entry.path === projectPath)) throw new Error("Remote directory browser did not return the project folder");

  const invalid = await request("/api/projects", { method: "POST", body: { path: "relative-folder" }, allowError: true });
  if (invalid.response.status !== 400) throw new Error("Relative project path was not rejected");

  const added = await request("/api/projects", { method: "POST", body: { path: projectPath, name: "手机项目" } });
  if (added.data.project.path !== projectPath || !added.data.project.saved) throw new Error("Project was not saved correctly");
  const projectId = added.data.project.id;

  const renamed = await request("/api/projects", { method: "POST", body: { path: `${projectPath}${path.sep}`, name: "重命名项目" } });
  if (renamed.data.project.id !== projectId || renamed.data.project.name !== "重命名项目") throw new Error("Duplicate project path was not de-duplicated");

  await stopServer(child); child = await startServer(); cookie = "";
  await request("/api/login", { method: "POST", body: { password: "projects-test-password" } });
  const persisted = await request("/api/projects");
  const matches = persisted.data.data.filter((project) => project.path === projectPath);
  if (matches.length !== 1 || matches[0].name !== "重命名项目") throw new Error("Project did not persist across restart");

  await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", body: {} });
  const removed = await request("/api/projects");
  if (removed.data.data.some((project) => project.path === projectPath)) throw new Error("Project was not removed from the catalog");
  await fsp.access(projectPath);
  console.log("PROJECTS_TEST_OK add=true browse=true persist=true remove_keeps_files=true");
} finally {
  await stopServer(child);
  await fsp.rm(tempRoot, { recursive: true, force: true });
}
