import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const codexEntry = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");

export class TerminalSession extends EventEmitter {
  constructor() { super(); this.pty = null; this.threadId = null; this.cwd = root; this.buffer = ""; this.startedAt = 0; }
  get running() { return Boolean(this.pty); }
  status() { return { running: this.running, threadId: this.threadId, cwd: this.cwd, startedAt: this.startedAt }; }
  start({ threadId = "", cwd = root, cols = 120, rows = 34 } = {}) {
    if (this.pty && this.threadId === threadId) return this.status();
    this.stop();
    this.threadId = String(threadId || ""); this.cwd = path.resolve(cwd || root); this.buffer = ""; this.startedAt = Date.now();
    const args = [codexEntry];
    if (this.threadId) args.push("resume", this.threadId);
    this.pty = pty.spawn(process.execPath, args, { name: "xterm-256color", cols, rows, cwd: this.cwd, env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }, useConpty: true });
    this.pty.onData((data) => { this.buffer = (this.buffer + data).slice(-2_000_000); this.emit("data", data); });
    this.pty.onExit(({ exitCode, signal }) => { this.pty = null; this.emit("exit", { exitCode, signal }); });
    this.emit("status", this.status()); return this.status();
  }
  write(data) { if (!this.pty) throw new Error("Codex CLI 未运行"); this.pty.write(String(data)); }
  resize(cols, rows) { if (this.pty) this.pty.resize(Math.max(20, Math.min(300, cols)), Math.max(8, Math.min(120, rows))); }
  stop() { if (!this.pty) return; const current = this.pty; this.pty = null; try { current.kill(); } catch { } this.emit("status", this.status()); }
}
