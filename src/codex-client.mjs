import { EventEmitter } from "node:events";
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const appVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version || "0.0.0";
const codexEntry = path.join(projectRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
const bundledCodexVersion = readJsonVersion(path.join(projectRoot, "node_modules", "@openai", "codex", "package.json"));
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
    this.runtime = { selected: null, candidates: [], failures: [] };
    this.stderrTail = [];
    // Supervision: every explicit start() arms auto-restart, every explicit
    // stop() disarms it. `starting` suppresses restarts while start() is
    // switching between candidates or is about to throw to its caller.
    this.autoRestart = false;
    this.starting = false;
    this.restartAttempt = 0;
    this.restartTimer = null;
    this.restarting = null;
    this.stableSince = 0;
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
    if (this.child) {
      if (this.ready) return null;
      if (this.starting) return this.waitUntilReady();
      // A child that exists but is neither ready nor starting is wedged
      // (for example an app-server that died during initialization).
      await this.#discardCurrentChild();
    }
    this.autoRestart = true;
    this.starting = true;
    this.#clearRestartTimer();
    try {
      return await this.#startOnce();
    } finally {
      this.starting = false;
    }
  }

  async waitUntilReady(timeoutMs = 15_000) {
    const deadline = Date.now() + Math.max(100, timeoutMs);
    while (Date.now() < deadline) {
      if (this.ready) return { ready: true };
      if (!this.child) throw new Error("Codex app-server is not running");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Codex app-server did not become ready in time");
  }

  async #startOnce() {
    const candidates = discoverCodexCandidates({ withVersions: false });
    this.runtime = { selected: null, candidates: candidates.map(publicCandidate), failures: [] };
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
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const initialized = await this.#startCandidate(candidate, browserMcpConfig);
        this.runtime.selected = publicCandidate(candidate);
        this.ready = true;
        this.stableSince = Date.now();
        this.restarting = null;
        await this.refreshBrowserStatus();
        void this.#hydrateVersion(candidate);
        this.emit("status", { ready: true, initialized, browser: this.getBrowserStatus(), runtime: this.getRuntimeStatus() });
        return initialized;
      } catch (error) {
        lastError = error;
        this.runtime.failures.push({ candidate: publicCandidate(candidate), error: conciseError(error) });
        await this.#discardCurrentChild();
      }
    }
    const details = this.runtime.failures.map((item) => `${item.candidate.label}: ${item.error}`).join("\n");
    this.#scheduleRestart(`没有可用的 Codex 后端：${conciseError(lastError)}`);
    throw new Error(`No compatible Codex app-server was found${details ? `\n${details}` : ""}`, { cause: lastError });
  }

  async #hydrateVersion(candidate) {
    if (candidate.version && candidate.version !== "unknown") return;
    const version = await readBinaryVersionAsync(candidate.command, candidate.prefixArgs, process.env);
    if (!version || version === "unknown") return;
    if (this.runtime.selected?.label === candidate.label && this.runtime.selected?.source === candidate.source) {
      this.runtime.selected = { ...this.runtime.selected, version };
    }
    this.runtime.candidates = this.runtime.candidates.map((item) => (
      item.label === candidate.label && item.source === candidate.source ? { ...item, version } : item
    ));
    this.emit("status", { ready: this.ready, runtime: this.getRuntimeStatus() });
  }

  async #startCandidate(candidate, browserMcpConfig) {
    this.stderrTail = [];
    this.ready = false;
    const args = [...candidate.prefixArgs, ...(codexProfile ? ["-p", codexProfile] : []), ...browserMcpConfig, "app-server", "--listen", "stdio://"];
    const child = spawn(candidate.command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.once("error", (error) => {
      if (this.child !== child) return;
      const wasReady = this.ready;
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
      this.serverRequests.clear();
      this.ready = false;
      this.child = null;
      this.emit("status", { ready: false, error: error.message, runtime: this.getRuntimeStatus() });
      if (!this.starting) this.#scheduleRestart(error.message);
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
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
      this.emit("status", { ready: false, error: error.message, runtime: this.getRuntimeStatus() });
      if (!this.starting) this.#scheduleRestart(error.message);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrTail.push(...String(chunk).split(/\r?\n/).filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-40);
      this.emit("stderr", String(chunk));
    });

    const lines = createInterface({ input: child.stdout });
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
    await this.#probeCompatibility();
    return initialized;
  }

  async #probeCompatibility() {
    // initialize alone does not force all config sections to deserialize.
    // These calls are read-only and cover model providers, global [agents]
    // settings, custom agent files, and persisted thread configuration.
    // model/list can wait on the remote model registry. Start it in parallel
    // with thread/list, but do not let a network stall hold takeover hostage.
    const models = this.request("model/list", { includeHidden: false }, { timeoutMs: 8_000 })
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error }));
    const listed = await this.request("thread/list", { limit: 1, sortKey: "recency_at", sortDirection: "desc", archived: false, modelProviders: [], sourceKinds: null }, { timeoutMs: 8_000 });
    const threadId = listed?.data?.[0]?.id;
    if (threadId) {
      try { await this.request("thread/read", { threadId, includeTurns: false }, { timeoutMs: 5_000 }); }
      catch (error) {
        if (isCompatibilityError(error)) throw error;
        this.emit("protocolError", { message: `Codex compatibility thread probe was inconclusive: ${conciseError(error)}`, method: "thread/read" });
      }
    }
    const modelOutcome = await Promise.race([
      models,
      new Promise((resolve) => setTimeout(() => resolve({ ok: true, background: true }), 900)),
    ]);
    if (modelOutcome.ok === false) {
      if (isCompatibilityError(modelOutcome.error) && !/timed out/i.test(String(modelOutcome.error?.message || ""))) throw modelOutcome.error;
      this.emit("protocolError", { message: `Codex compatibility model probe was inconclusive: ${conciseError(modelOutcome.error)}`, method: "model/list" });
    } else if (modelOutcome.background) {
      // Keep the validation useful without blocking the first turn.
      void models.then((outcome) => {
        if (outcome.ok === false) this.emit("protocolError", { message: `Codex compatibility model probe was inconclusive: ${conciseError(outcome.error)}`, method: "model/list" });
      });
    }
  }

  async #discardCurrentChild() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.ready = false;
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(new Error("Codex candidate was rejected"));
    }
    this.pending.clear();
    this.serverRequests.clear();
    await terminateChild(child);
  }

  getBrowserStatus() {
    return {
      ...this.browserStatus,
      tools: [...this.browserStatus.tools],
      missingTools: [...this.browserStatus.missingTools],
    };
  }

  getRuntimeStatus() {
    return {
      selected: this.runtime.selected ? { ...this.runtime.selected } : null,
      candidates: this.runtime.candidates.map((item) => ({ ...item })),
      failures: this.runtime.failures.map((item) => ({ candidate: { ...item.candidate }, error: item.error })),
      restart: this.getRestartStatus(),
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

  request(method, params = {}, { timeoutMs = 60_000 } = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Codex app-server is unavailable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, Math.max(1, timeoutMs));
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
    this.autoRestart = false;
    this.#clearRestartTimer();
    this.restarting = null;
    this.restartAttempt = 0;
    if (!this.child) return;
    const child = this.child;
    await terminateChild(child);
  }

  /**
   * Recovery entry point used by POST /api/control/recover: cancel any pending
   * backoff and start the backend now if it is not running.
   */
  async ensureStarted() {
    this.autoRestart = true;
    this.#clearRestartTimer();
    this.restartAttempt = 0;
    this.restarting = null;
    if (this.child) return { started: false, ready: this.ready };
    await this.start();
    return { started: true, ready: this.ready };
  }

  getRestartStatus() {
    return this.restarting ? { ...this.restarting } : null;
  }

  #clearRestartTimer() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
  }

  #scheduleRestart(reason) {
    if (!this.autoRestart || this.restartTimer) return;
    // Only a backend that stayed healthy long enough earns a fresh budget;
    // otherwise a backend that starts and dies immediately would reset the
    // backoff on every cycle and restart forever at the base delay.
    if (this.stableSince && Date.now() - this.stableSince >= 60_000) this.restartAttempt = 0;
    this.restartAttempt += 1;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.restartAttempt - 1, 5));
    this.restarting = { attempt: this.restartAttempt, nextRetryInMs: delay, reason: String(reason || "Codex 后端已停止").slice(0, 300) };
    this.emit("status", { ready: false, restarting: true, attempt: this.restartAttempt, nextRetryInMs: delay, error: this.restarting.reason, runtime: this.getRuntimeStatus() });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.autoRestart) return;
      this.start().catch((error) => this.emit("stderr", `Codex backend restart failed: ${conciseError(error)}`));
    }, delay);
    this.restartTimer.unref?.();
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

export function discoverCodexCandidates({ env = process.env, exists = fs.existsSync, withVersions = true } = {}) {
  const candidates = [];
  const addNative = (source, value) => {
    const executable = normalizeExecutablePath(value);
    if (!executable || !exists(executable)) return;
    const isCommandShim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
    candidates.push({
      source,
      label: sourceLabel(source),
      command: isCommandShim ? (env.ComSpec || env.COMSPEC || "cmd.exe") : executable,
      prefixArgs: isCommandShim ? ["/d", "/s", "/c", executable] : [],
      version: withVersions ? readBinaryVersion(executable, env) : "unknown",
    });
  };
  addNative("override", env.CODEX_WEB_CODEX_PATH);
  const configured = configuredCodexCliPath(env.CODEX_HOME || path.join(env.USERPROFILE || "", ".codex"));
  addNative("config", configured);
  for (const command of desktopCodexExecutables(env, exists)) addNative("desktop", command);
  const pathCommand = resolvePathCodex(env);
  addNative("path", pathCommand);
  candidates.push({ source: "bundled", label: "Web bundled Codex", command: process.execPath, prefixArgs: [codexEntry], version: bundledCodexVersion });
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.command.toLocaleLowerCase("en-US")}\0${candidate.prefixArgs.join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function configuredCodexCliPath(codexHome) {
  try {
    const content = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const match = content.match(/^\s*CODEX_CLI_PATH\s*=\s*(['"])(.*?)\1\s*$/m);
    return match?.[2] || "";
  } catch { return ""; }
}

function desktopCodexExecutables(env, exists) {
  const root = path.join(env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
  if (!root || !exists(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "codex.exe"))
      .filter(exists)
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  } catch { return []; }
}

function resolvePathCodex(env) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["codex"], { env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return "";
  const matches = String(result.stdout || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return matches.find((item) => /codex\.exe$/i.test(item))
    || matches.find((item) => /codex\.(?:cmd|bat)$/i.test(item))
    || matches.find((item) => /[/\\]codex$/i.test(item))
    || "";
}

function normalizeExecutablePath(value) {
  return String(value || "").trim().replace(/^(['"])(.*)\1$/, "$2");
}

function sourceLabel(source) {
  return ({ override: "Configured Web Codex", config: "Codex config CLI", desktop: "Desktop Codex", path: "System Codex" })[source] || source;
}

function readJsonVersion(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")).version || "unknown"; }
  catch { return "unknown"; }
}

function readBinaryVersion(command, env = process.env) {
  try {
    const isCommandShim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const executable = isCommandShim ? (env.ComSpec || env.COMSPEC || "cmd.exe") : command;
    const args = isCommandShim ? ["/d", "/s", "/c", command, "--version"] : ["--version"];
    const result = spawnSync(executable, args, { env, encoding: "utf8", windowsHide: true, timeout: 5000 });
    return String(result.stdout || result.stderr || "").trim().replace(/^codex-cli\s+/i, "") || "unknown";
  } catch { return "unknown"; }
}

function readBinaryVersionAsync(command, prefixArgs, env = process.env) {
  return new Promise((resolve) => {
    const args = [...(prefixArgs || []), "--version"];
    execFile(command, args, { env, encoding: "utf8", windowsHide: true, timeout: 5_000 }, (error, stdout, stderr) => {
      if (error) { resolve("unknown"); return; }
      resolve(String(stdout || stderr || "").trim().replace(/^codex-cli\s+/i, "") || "unknown");
    });
  });
}

function publicCandidate(candidate) {
  return { source: candidate.source, label: candidate.label, version: candidate.version || "unknown" };
}

function conciseError(error) {
  return String(error?.message || error || "unknown error").replace(/\s+/g, " ").slice(0, 600);
}

function isCompatibilityError(error) {
  return /failed to load configuration|invalid type|unknown field|unknown variant|toml|method not found|unsupported method|invalid params/i.test(String(error?.message || error || ""));
}

function terminateChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) return resolve();
    const timer = setTimeout(() => {
      if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}
