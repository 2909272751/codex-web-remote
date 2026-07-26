import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const appVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version || "0.0.0";
const codexEntry = path.join(projectRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
const codexProfile = process.env.CODEX_WEB_CODEX_PROFILE || "";
const playwrightMcpEntry = path.join(projectRoot, "node_modules", "@playwright", "mcp", "cli.js");
const runtimeDataRoot = process.env.CODEX_WEB_DATA_DIR ? path.resolve(process.env.CODEX_WEB_DATA_DIR) : path.join(projectRoot, ".runtime-data");
const playwrightOutputDir = path.join(runtimeDataRoot, "playwright-output");
const playwrightProfileDir = path.join(runtimeDataRoot, "playwright-profile");
const enableBrowserMcp = process.env.CODEX_WEB_BROWSER_MCP !== "0";
const isolateBrowserMcp = process.env.CODEX_WEB_BROWSER_ISOLATED !== "0";
const requiredBrowserTools = ["browser_navigate", "browser_snapshot", "browser_take_screenshot"];

export class CodexClient extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.ready = false;
    this.stderrTail = [];
    this.browserStatus = {
      configured: enableBrowserMcp,
      ready: false,
      verified: false,
      server: "playwright",
      tools: [],
      missingTools: [...requiredBrowserTools],
      message: enableBrowserMcp ? "浏览器后端尚未启动" : "浏览器后端已在配置中禁用",
      checkedAt: 0,
    };
  }

  async start() {
    if (this.child) return;
    this.stderrTail = [];
    const playwrightArgs = [
      playwrightMcpEntry,
      "--browser", "msedge",
      "--headless",
      ...(isolateBrowserMcp ? ["--isolated"] : []),
      ...(!isolateBrowserMcp ? ["--user-data-dir", playwrightProfileDir] : []),
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
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
      this.serverRequests.clear();
      this.ready = false;
      this.browserStatus = {
        ...this.browserStatus,
        ready: false,
        verified: false,
        message: "Codex 后端已停止，浏览器后端不可用",
        checkedAt: Date.now(),
      };
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
        version: appVersion,
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.ready = true;
    await this.refreshBrowserStatus();
    this.emit("status", { ready: true, initialized, browser: this.getBrowserStatus() });
    return initialized;
  }

  getBrowserStatus() {
    return {
      ...this.browserStatus,
      tools: [...this.browserStatus.tools],
      missingTools: [...this.browserStatus.missingTools],
    };
  }

  async refreshBrowserStatus() {
    const checkedAt = Date.now();
    if (!enableBrowserMcp) {
      this.browserStatus = {
        configured: false,
        ready: false,
        verified: false,
        server: "playwright",
        tools: [],
        missingTools: [...requiredBrowserTools],
        message: "浏览器后端已在配置中禁用",
        checkedAt,
      };
      return this.getBrowserStatus();
    }
    if (!this.ready) {
      this.browserStatus = {
        ...this.browserStatus,
        ready: false,
        message: "Codex 后端尚未就绪",
        checkedAt,
      };
      return this.getBrowserStatus();
    }
    // Enumerating MCP tools or running a probe eagerly opens a second
    // Playwright connection in some Codex versions. With a persistent Edge
    // profile that can lock the profile before the real browser turn starts.
    // Keep startup side-effect free; the first real browser tool call verifies
    // the session and is surfaced to the Web UI.
    this.browserStatus = {
      ...this.browserStatus,
      configured: true,
      ready: true,
      verified: false,
      tools: [...requiredBrowserTools],
      missingTools: [],
      message: "独立 Edge 浏览器已配置，首次网页操作时验证",
      checkedAt,
    };
    return this.getBrowserStatus();
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Codex app-server is unavailable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    try { this.#send({ method, params }); }
    catch (error) { this.emit("protocolError", { message: error?.message || "Codex notify failed", method }); }
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
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is unavailable");
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

    if (message.method) {
      try {
        this.emit("notification", message);
      } catch (error) {
        this.emit("protocolError", {
          message: error?.message || "Notification handler failed",
          stack: error?.stack || "",
          method: message.method,
        });
      }
    }
  }
}
