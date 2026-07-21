import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const codexEntry = path.join(projectRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
const codexProfile = process.env.CODEX_WEB_CODEX_PROFILE || "";
const playwrightMcpEntry = path.join(projectRoot, "node_modules", "@playwright", "mcp", "cli.js");
const runtimeDataRoot = process.env.CODEX_WEB_DATA_DIR ? path.resolve(process.env.CODEX_WEB_DATA_DIR) : path.join(projectRoot, ".runtime-data");
const playwrightOutputDir = path.join(runtimeDataRoot, "playwright-output");
const playwrightProfileDir = path.join(runtimeDataRoot, "playwright-profile");
const enableBrowserMcp = process.env.CODEX_WEB_BROWSER_MCP !== "0";

export class CodexClient extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.ready = false;
    this.stderrTail = [];
  }

  async start() {
    if (this.child) return;
    this.stderrTail = [];
    const playwrightArgs = [
      playwrightMcpEntry,
      "--browser", "msedge",
      "--headless",
      "--user-data-dir", playwrightProfileDir,
      "--output-dir", playwrightOutputDir,
      "--output-max-size", "104857600",
      "--viewport-size", "1280x800",
      "--block-service-workers",
      "--image-responses", "allow",
    ];
    const browserMcpConfig = enableBrowserMcp ? [
      "--disable", "apps",
      "--disable", "remote_plugin",
      "-c", `mcp_servers.playwright.command=${JSON.stringify(process.execPath)}`,
      "-c", `mcp_servers.playwright.args=${JSON.stringify(playwrightArgs)}`,
      "-c", "mcp_servers.playwright.startup_timeout_sec=30",
      "-c", "mcp_servers.playwright.tool_timeout_sec=120",
    ] : [];
    const args = [codexEntry, ...(codexProfile ? ["-p", codexProfile] : []), ...browserMcpConfig, "app-server", "--listen", "stdio://"];
    this.child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.on("exit", (code, signal) => {
      const stderr = this.stderrTail.slice(-12).join("\n").trim();
      const detail = stderr ? `\n${stderr}` : "";
      const error = new Error(`Codex app-server stopped (code=${code}, signal=${signal ?? "none"})${detail}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.ready = false;
      this.child = null;
      this.emit("status", { ready: false, error: error.message });
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail.push(...String(chunk).split(/\r?\n/).filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-40);
      this.emit("stderr", String(chunk));
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.#handleLine(line));

    const initialized = await this.request("initialize", {
      clientInfo: {
        name: "codex_web_remote",
        title: "Codex Web Remote",
        version: "1.4.3",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.ready = true;
    this.emit("status", { ready: true, initialized });
    return initialized;
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Codex app-server is unavailable"));
    const id = this.nextId++;
    this.#send({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timeout, method });
    });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  respondToServerRequest(id, result) {
    if (!this.serverRequests.has(String(id))) throw new Error("Approval request is no longer pending");
    this.#send({ id, result });
    this.serverRequests.delete(String(id));
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }

  close() {
    void this.stop();
  }

  #send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", { message: "Invalid JSON from app-server", line });
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.serverRequests.set(String(message.id), message);
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) this.emit("notification", message);
  }
}
