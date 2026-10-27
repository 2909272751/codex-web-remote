// P0/P1 acceptance test.
//
//   node scripts/p0p1-test.mjs
//
// Run A  boots a throwaway gateway on a spare port: version consistency,
//        password-less token login, public address auto-follow with the DPAPI
//        guard, WS hello/ping/pong/heartbeat, and the recover endpoint's
//        authorization (desktop/available callers must take over first).
// Run B  proves a password-less launcher settings file is never rewritten.
// Run C  drives CodexClient in-process with a fake app-server to prove the
//        supervision chain: crash -> restart, escalating backoff, stop disarms.
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.CODEX_WEB_P0P1_PORT || 18999);
const password = "p0p1-test-password";
const base = `http://127.0.0.1:${port}`;
const pkg = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fakeCodexSource = `
import readline from "node:readline";
if (process.argv.includes("--version")) { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
const lifetime = Number(process.env.FAKE_CODEX_LIFETIME_MS || 0);
if (lifetime > 0) setTimeout(() => process.exit(7), lifetime);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake-codex/0.0.0" } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [] } });
  if (message.method === "thread/list") return send({ id: message.id, result: { data: [] } });
  send({ id: message.id, result: {} });
});
`;

async function prepareState(name) {
  const stateRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `cwr-${name}-`));
  const dataDir = path.join(stateRoot, "data");
  await fsp.mkdir(dataDir, { recursive: true });
  const fakeScript = path.join(stateRoot, "fake-codex.mjs");
  const fakeCmd = path.join(stateRoot, "fake-codex.cmd");
  await fsp.writeFile(fakeScript, fakeCodexSource, "utf8");
  await fsp.writeFile(fakeCmd, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, "utf8");
  // Deterministic tunnel fixture: developer machines may use any FRP address.
  const frpRoot = path.join(stateRoot, 'frp'); const instance = path.join(frpRoot, 'instances', 'test');
  await fsp.mkdir(instance, { recursive: true });
  await fsp.writeFile(path.join(instance, 'runtime-frpc.toml'), 'serverAddr = "127.0.0.1"\n[[proxies]]\nname = "8NslZhYa2biO"\ntype = "tcp"\nlocalPort = 18888\nremotePort = 44077\n');
  await fsp.writeFile(path.join(instance, 'selection.json'), JSON.stringify({ '8NslZhYa2biO': true }));
  await fsp.writeFile(path.join(instance, 'domain-binding.json'), JSON.stringify({ enabled: true, zone: 'liuhaobin.top', hostname: '@' }));
  await fsp.writeFile(path.join(instance, 'runtime.json'), JSON.stringify({ status: 'running' }));
  return { stateRoot, dataDir, fakeCmd, frpRoot, settingsFile: path.join(stateRoot, "settings.json") };
}

async function writeSettings(file, { withPassword }) {
  const settings = { ProtectedPassword: withPassword ? "A".repeat(120) : "", Port: port, SecureCookie: false, AutoStart: false, PublicUrl: "" };
  await fsp.writeFile(file, JSON.stringify(settings, null, 2), "utf8");
  return settings;
}

async function startGateway(state, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_WEB_PASSWORD: password,
      CODEX_WEB_HOST: "127.0.0.1",
      CODEX_WEB_PORT: String(port),
      CODEX_WEB_DATA_DIR: state.dataDir,
      CODEX_WEB_SETTINGS_FILE: state.settingsFile,
      CODEX_WEB_FRP_DATA_ROOT: state.frpRoot,
      // The real tunnel fronts 18888; this throwaway gateway runs on a spare
      // port, so tell the resolver which local port the tunnel actually maps.
      CODEX_WEB_FRP_LOCAL_PORT: "18888",
      CODEX_WEB_BROWSER_MCP: "0",
      CODEX_WEB_CODEX_PATH: state.fakeCmd,
      CODEX_WEB_PUBLIC_REFRESH_MS: "60000",
      CODEX_WEB_TEST_MODE: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));
  for (let index = 0; index < 120; index++) {
    await sleep(250);
    if (child.exitCode != null) break;
    try {
      const response = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return { child, log };
    } catch { }
  }
  throw new Error(`gateway did not become healthy on ${port}\n${log.join("")}`);
}

async function stopGateway(gateway) {
  if (!gateway?.child || gateway.child.exitCode != null) return;
  gateway.child.kill();
  await Promise.race([new Promise((resolve) => gateway.child.once("exit", resolve)), sleep(5000)]);
}

function connectEvents(cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/events?since=0`, { headers: { Cookie: cookie } });
    const messages = [];
    socket.on("message", (raw) => { try { messages.push(JSON.parse(String(raw))); } catch { } });
    socket.on("open", () => resolve({ socket, messages }));
    socket.on("error", reject);
  });
}

async function runServerSurface() {
  const stateA = await prepareState("a");
  const before = await writeSettings(stateA.settingsFile, { withPassword: true });
  const gatewayA = await startGateway(stateA, { CODEX_WEB_AUTO_PREPARE: "0" });
  try {
    const sessionResponse = await fetch(`${base}/api/session`);
    const session = await sessionResponse.json();
    check("A1 version is current package version", session.version === pkg.version, `session=${session.version} pkg=${pkg.version}`);
    check("A1b /api/session answers 200", sessionResponse.status === 200, `status=${sessionResponse.status}`);
    check("A1c unauthenticated session is not logged in", session.authenticated === false, JSON.stringify(session.authenticated));

    const token = JSON.parse(await fsp.readFile(path.join(stateA.dataDir, "access-token.json"), "utf8")).token;
    const login = await fetch(`${base}/?t=${encodeURIComponent(token)}`, { redirect: "manual" });
    const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
    check("A2 token login redirects with cookie", login.status === 302 && cookie.startsWith("codex_web_session="), `status=${login.status}`);
    check("A2b redirect target drops the token", login.headers.get("location") === "/", String(login.headers.get("location")));

    const bad = await fetch(`${base}/?t=not-the-token`, { redirect: "manual" });
    check("A3 wrong token is rejected", bad.status === 401, `status=${bad.status}`);
    const empty = await fetch(`${base}/?t=`, { redirect: "manual" });
    check("A3b empty token falls through to the login page", empty.status === 200, `status=${empty.status}`);

    const authed = await fetch(`${base}/api/control/status`, { headers: { Cookie: cookie } });
    check("A3c cookie from token opens authenticated APIs", authed.status === 200, `status=${authed.status}`);

    const link = await (await fetch(`${base}/api/public-link`)).json();
    check("A8 public address resolved from 88frp state", link.ok === true && link.url === "http://liuhaobin.top:44077", JSON.stringify({ ok: link.ok, url: link.url, source: link.source }));
    check("A8b tunnel metadata matches", link.tunnelName === "8NslZhYa2biO" && link.remotePort === 44077, `${link.tunnelName}/${link.remotePort}`);
    check("S1 public-link never exposes the access token", !JSON.stringify(link).includes(token) && !("accessUrl" in link), Object.keys(link).join(","));

    await sleep(1200);
    const settings = JSON.parse(await fsp.readFile(stateA.settingsFile, "utf8"));
    check("A8c PublicUrl written with access token", settings.PublicUrl === `http://liuhaobin.top:44077/?t=${token}`, settings.PublicUrl);
    check("A8d DPAPI password blob preserved byte-for-byte", settings.ProtectedPassword === before.ProtectedPassword, `${String(settings.ProtectedPassword).length} chars`);

    const { socket, messages } = await connectEvents(cookie);
    await sleep(600);
    const hello = messages.find((message) => message.type === "hello");
    check("A6 hello carries serverVersion", hello?.data?.serverVersion === pkg.version, JSON.stringify(hello?.data || {}));

    const pingTs = Date.now();
    socket.send(JSON.stringify({ type: "ping", data: { ts: pingTs } }));
    await sleep(600);
    const pong = messages.find((message) => message.type === "pong");
    check("A6b ping is answered with pong", pong?.data?.ts === pingTs, JSON.stringify(pong?.data || {}));

    const recover = await fetch(`${base}/api/control/recover`, { method: "POST", headers: { Cookie: cookie, Origin: base } });
    const recoverBody = await recover.json().catch(() => ({}));
    check("A4 recover refuses to start a backend this page does not control", recover.status === 409 && recoverBody.code === "TAKEOVER_REQUIRED", `${recover.status} ${JSON.stringify(recoverBody)}`);

    await sleep(16000);
    check("A6c heartbeat keeps arriving", messages.some((message) => message.type === "heartbeat"), `messages=${messages.length}`);
    socket.close();
  } finally {
    await stopGateway(gatewayA);
  }
}

async function runSettingsGuard() {
  const stateB = await prepareState("b");
  await writeSettings(stateB.settingsFile, { withPassword: false });
  const gatewayB = await startGateway(stateB);
  try {
    await sleep(1500);
    const settings = JSON.parse(await fsp.readFile(stateB.settingsFile, "utf8"));
    check("A8e settings without ProtectedPassword are never rewritten", settings.PublicUrl === "", `PublicUrl=${JSON.stringify(settings.PublicUrl)}`);
  } finally {
    await stopGateway(gatewayB);
  }
}

async function runSupervision() {
  const stateC = await prepareState("c");
  process.env.CODEX_WEB_CODEX_PATH = stateC.fakeCmd;
  process.env.CODEX_WEB_BROWSER_MCP = "0";
  process.env.CODEX_WEB_DATA_DIR = stateC.dataDir;
  process.env.FAKE_CODEX_LIFETIME_MS = "700";
  const { CodexClient } = await import(pathToFileURL(path.join(root, "src", "codex-client.mjs")).href);
  const client = new CodexClient();
  const events = [];
  client.on("status", (data) => events.push({ at: Date.now(), ...data }));
  await client.start();
  check("C1 fake backend starts", client.ready === true, `ready=${client.ready}`);
  await sleep(13_000);
  const restarts = events.filter((event) => event.restarting);
  check("C2 crash triggers a scheduled restart", restarts.length >= 2, `restarts=${restarts.length}`);
  const attempts = restarts.map((event) => event.attempt);
  check("C3 backoff attempt counter escalates", attempts.length >= 2 && attempts[attempts.length - 1] > attempts[0], `attempts=${attempts.join(",")}`);
  const delays = restarts.map((event) => event.nextRetryInMs);
  check("C4 retry delay grows", delays.length >= 2 && delays[delays.length - 1] > delays[0], `delays=${delays.join(",")}`);
  const readyEvents = events.filter((event) => event.ready === true).length;
  check("C5 restarts actually brought the backend back", readyEvents >= 2, `readyEvents=${readyEvents} (initial + at least one restart)`);
  await client.stop();
  const afterStop = events.filter((event) => event.restarting).length;
  await sleep(4000);
  check("C6 stop disarms supervision", events.filter((event) => event.restarting).length === afterStop && !client.child, `restartsAfterStop=${events.filter((event) => event.restarting).length - afterStop}`);
}

async function runAutoPrepare() {
  const stateD = await prepareState("d");
  await writeSettings(stateD.settingsFile, { withPassword: true });
  // Production keeps the browser MCP enabled and its status check is lazy, so
  // this mirrors the real auto-prepare path instead of the disabled-browser one.
  const gatewayD = await startGateway(stateD, { CODEX_WEB_BROWSER_MCP: "1" });
  try {
    const token = JSON.parse(await fsp.readFile(path.join(stateD.dataDir, "access-token.json"), "utf8")).token;
    const login = await fetch(`${base}/?t=${encodeURIComponent(token)}`, { redirect: "manual" });
    const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
    const started = Date.now();
    const { socket } = await connectEvents(cookie);
    let web = false;
    let status = {};
    for (let index = 0; index < 80; index++) {
      await sleep(250);
      status = await (await fetch(`${base}/api/control/status`, { headers: { Cookie: cookie } })).json();
      if (status.mode === "web" && status.codexReady) { web = true; break; }
    }
    check("D1 opening the UI prepares the backend without a manual takeover", web, `elapsed=${Date.now() - started}ms mode=${status.mode} codexReady=${status.codexReady}`);
    check("D2 the automatic prepare is labelled as such", status.takeoverState?.auto === true, JSON.stringify(status.takeoverState));
    const samples = [];
    for (let index = 0; index < 4; index++) {
      const at = Date.now();
      await fetch(`${base}/api/control/status`, { headers: { Cookie: cookie } });
      samples.push(Date.now() - at);
    }
    check("E1 cached desktop probe keeps status polling fast", samples[0] < 500 && Math.max(...samples.slice(1)) < 50, `samples=${samples.join(",")}ms`);

    // Releasing hands control to the desktop app, which takes seconds to appear.
    // A reconnect inside that window must not pull control back to the web.
    const release = await fetch(`${base}/api/control/release`, { method: "POST", headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ discardQueue: true }) });
    check("F1 release succeeds from web mode", release.ok, `status=${release.status}`);
    socket.close();
    await sleep(400);
    const reconnect = await connectEvents(cookie);
    await sleep(4000);
    const afterRelease = await (await fetch(`${base}/api/control/status`, { headers: { Cookie: cookie } })).json();
    check("F2 reconnect right after release does not steal control back", afterRelease.mode !== "web" && afterRelease.codexReady === false, `mode=${afterRelease.mode} codexReady=${afterRelease.codexReady} transition=${afterRelease.transition}`);
    reconnect.socket.close();
  } finally {
    await stopGateway(gatewayD);
  }
}

await runServerSurface();
await runSettingsGuard();
await runSupervision();
await runAutoPrepare();

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  [${item.detail}]` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
