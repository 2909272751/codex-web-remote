/**
 * src/frp-address.mjs —— P0-1 公网地址解析（契约 §4）
 *
 * 从 88frp-node 的本地运行时数据里解析出 codexweb 的公网访问地址，
 * 供 server.mjs 写 settings.json 的 PublicUrl、以及 /api/public-link 使用。
 *
 * 设计约束（契约 §4）：
 *  - 纯 Node ESM、零依赖、只读、不写任何文件；
 *  - 任何异常都不许抛出：一律返回 { ok:false, source:"none", detail }；
 *  - 数据源全部免鉴权（本地文件），不需要任何凭据。
 *
 * 数据源（<dataRoot>\instances\<id>\）：
 *  - runtime-frpc.toml   TOML：serverAddr / serverPort + 多个 [[proxies]]
 *  - selection.json      {"<tunnelName>": true|false}，只有 true 才是启用的隧道
 *  - domain-binding.json {enabled, zone, hostname, canWrite, autoFollow}
 *  - runtime.json        {status:"running", pid}，用于挑选活跃实例
 *
 * 注意：runtime-frpc.toml 是 GBK 编码且带中文注释，但我们只按行解析 ASCII 的
 * `key = value` 行、且只保留白名单键，因此注释的编码与内容都不影响解析。
 * 顶层 `user = "..."` 等凭据键被白名单挡在外面，永远不会进入返回值或诊断串。
 */

import fs from "node:fs/promises";
import path from "node:path";

/** codexweb 网关的默认本地端口（契约 §4） */
const DEFAULT_LOCAL_PORT = 18888;
/** 88frp-node 的默认数据根目录 */
const DEFAULT_DATA_ROOT = "C:\\ProgramData\\88frp-node\\data";

/**
 * 只保留实现所需的键：
 *  - 顶层只要 serverAddr / serverPort（user、token 等凭据键直接丢弃）
 *  - [[proxies]] 只要隧道定位所需的 5 个键
 */
const TOP_LEVEL_KEYS = new Set(["serverAddr", "serverPort"]);
const PROXY_KEYS = new Set(["name", "type", "localIP", "localPort", "remotePort"]);

/** 统一构造失败结果，保证返回结构永远是完整的 9 个键 */
function failure(detail) {
  return {
    ok: false,
    url: null,
    host: null,
    remotePort: null,
    serverAddr: null,
    tunnelName: null,
    instanceId: null,
    source: "none",
    detail: String(detail),
  };
}

/**
 * 解析单个 TOML 标量值。只认字符串 / 数字 / 布尔；
 * 数组、日期等一律返回 null（本模块用不到）。
 * 字符串按引号截取，因此行尾的行内注释会被自然忽略。
 */
function parseTomlScalar(raw) {
  const text = String(raw).trim();
  if (!text) return null;

  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    const end = text.indexOf(quote, 1);
    return end === -1 ? text.slice(1) : text.slice(1, end);
  }

  const numberMatch = /^[+-]?(?:\d+\.\d+|\d+)/.exec(text);
  if (numberMatch) return Number(numberMatch[0]);

  if (/^true\b/i.test(text)) return true;
  if (/^false\b/i.test(text)) return false;

  return null;
}

/**
 * 极简 TOML 解析：只处理 `key = value` 与 `[[section]]` / `[section]` 行。
 * 遇到 `[[proxies]]` 就开一个新段对象。注释行（# 开头）直接跳过。
 *
 * 之所以敢这么简：TOML 的多行数组、内联表、日期在本文件里都不存在，
 * 而按行 + 白名单键足以稳定取出 serverAddr / serverPort / proxies。
 */
function parseMinimalToml(text) {
  const top = {};
  const proxies = [];
  let currentProxy = null;

  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const section = /^\[\[?\s*([A-Za-z0-9_.-]+)\s*\]?\]/.exec(trimmed);
    if (section) {
      if (section[1] === "proxies") {
        currentProxy = {};
        proxies.push(currentProxy);
      } else {
        currentProxy = null; // 其它段（transport 等）不关心
      }
      continue;
    }

    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!kv) continue;

    const key = kv[1];
    const value = parseTomlScalar(kv[2]);
    if (value === null) continue;

    if (currentProxy) {
      if (PROXY_KEYS.has(key)) currentProxy[key] = value;
    } else if (TOP_LEVEL_KEYS.has(key)) {
      top[key] = value;
    }
  }

  return { top, proxies };
}

/** 读 JSON：区分「文件不存在 / 内容非法 / 成功」，供诊断串使用 */
async function readJsonSafe(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    const code = error && error.code ? error.code : null;
    return { value: null, error: code === "ENOENT" ? "not-found" : `invalid(${code || (error && error.message) || "error"})` };
  }
}

/** 读文本：失败返回 null，不抛 */
async function readTextSafe(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * 枚举候选实例：只保留存在 runtime-frpc.toml 的实例目录，
 * 并记录 toml 的 mtime（多实例时的兜底排序依据）。
 */
async function listInstances(instancesDir) {
  const entries = await fs.readdir(instancesDir, { withFileTypes: true });
  const instances = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(instancesDir, entry.name);
    const tomlFile = path.join(dir, "runtime-frpc.toml");
    try {
      const stat = await fs.stat(tomlFile);
      instances.push({ id: entry.name, dir, tomlFile, mtimeMs: stat.mtimeMs, status: null });
    } catch {
      // 没有 runtime-frpc.toml 的实例无法解析，跳过
    }
  }

  return instances;
}

/** hostname 归一化：hostname === "@"（或空）时用 zone，否则 hostname.zone */
function bindingHostname(binding) {
  const zone = typeof binding.zone === "string" ? binding.zone.trim() : "";
  if (!zone) return null;
  const hostname = typeof binding.hostname === "string" ? binding.hostname.trim() : "";
  if (!hostname || hostname === "@") return zone;
  return `${hostname}.${zone}`;
}

/** IPv6 字面量需要加方括号才能拼进 URL */
function formatHostForUrl(host) {
  if (typeof host !== "string" || !host) return host;
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

/**
 * 解析 codexweb 的公网访问地址。
 *
 * @param {{localPort?: number, dataRoot?: string}} [options]
 * @returns {Promise<{ok:boolean,url:string|null,host:string|null,remotePort:number|null,
 *   serverAddr:string|null,tunnelName:string|null,instanceId:string|null,
 *   source:"domain-binding"|"server-addr"|"none",detail:string}>}
 */
export async function resolvePublicAddress(options = {}) {
  try {
    const opts = options && typeof options === "object" ? options : {};

    const localPort = Number.isFinite(opts.localPort) && opts.localPort > 0
      ? Math.trunc(opts.localPort)
      : DEFAULT_LOCAL_PORT;
    const dataRoot = typeof opts.dataRoot === "string" && opts.dataRoot.trim()
      ? opts.dataRoot.trim()
      : DEFAULT_DATA_ROOT;

    const instancesDir = path.join(dataRoot, "instances");
    let instances;
    try {
      instances = await listInstances(instancesDir);
    } catch (error) {
      const code = error && error.code ? error.code : "";
      return failure(`读取实例目录失败（${instancesDir}）：${code || (error && error.message) || "未知错误"}`);
    }

    if (instances.length === 0) {
      return failure(`没有找到任何含 runtime-frpc.toml 的实例目录（${instancesDir}）`);
    }

    // 读 runtime.json 判定活跃实例
    for (const instance of instances) {
      const runtime = await readJsonSafe(path.join(instance.dir, "runtime.json"));
      const status = runtime.value && typeof runtime.value.status === "string" ? runtime.value.status : null;
      instance.status = status;
    }

    // 契约 §4：优先 status==="running"，否则取 runtime-frpc.toml mtime 最新者
    const running = instances.filter((instance) => instance.status === "running");
    const pool = (running.length ? running : instances).slice();
    pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const chosen = pool[0];

    const notes = [];
    notes.push(`实例 ${chosen.id}（共 ${instances.length} 个，status=${chosen.status ?? "unknown"}）`);
    if (running.length === 0) notes.push("无 running 实例，回退到 toml mtime 最新者");

    const tomlText = await readTextSafe(chosen.tomlFile);
    if (tomlText === null) {
      return failure(`无法读取 ${chosen.tomlFile}`);
    }

    const { top, proxies } = parseMinimalToml(tomlText);
    const serverAddr = typeof top.serverAddr === "string" && top.serverAddr ? top.serverAddr : null;
    const serverPort = Number.isFinite(top.serverPort) ? top.serverPort : null;
    notes.push(`serverAddr=${serverAddr ?? "?"}${serverPort ? `:${serverPort}` : ""}`);

    // ---- 隧道选择：type=tcp 且 localPort 命中 codexweb 网关端口 ----
    const tcpProxies = proxies.filter((proxy) => {
      const type = typeof proxy.type === "string" ? proxy.type.toLowerCase() : "tcp"; // frp 默认 tcp
      return type === "tcp";
    });
    const byPort = tcpProxies.filter((proxy) => proxy.localPort === localPort);

    if (byPort.length === 0) {
      const available = proxies
        .filter((proxy) => Number.isFinite(proxy.localPort))
        .map((proxy) => proxy.localPort)
        .sort((a, b) => a - b);
      return failure(
        `实例 ${chosen.id} 中没有 localPort=${localPort} 的 tcp 隧道（现有 localPort：${available.join(", ") || "无"}）`,
      );
    }

    // selection.json：只有 true 的隧道是启用的
    const selection = await readJsonSafe(path.join(chosen.dir, "selection.json"));
    const selectionMap = selection.value && typeof selection.value === "object" ? selection.value : null;
    if (!selectionMap) notes.push(`selection.json ${selection.error ?? "不可用"}`);
    const enabledOf = (name) => {
      if (!selectionMap || typeof name !== "string" || !name) return null; // 未知
      const flag = selectionMap[name];
      return typeof flag === "boolean" ? flag : null; // 未列出 → 未知
    };

    const enabledOnes = byPort.filter((proxy) => enabledOf(proxy.name) === true);
    const disabledOnes = byPort.filter((proxy) => enabledOf(proxy.name) === false);

    let tunnel = null;
    if (enabledOnes.length > 0) {
      tunnel = enabledOnes[0];
      if (enabledOnes.length > 1) notes.push(`有 ${enabledOnes.length} 条隧道命中同一 localPort，取第一条`);
    } else if (disabledOnes.length === byPort.length) {
      const names = byPort.map((proxy) => proxy.name ?? "?").join(", ");
      return failure(`localPort=${localPort} 的隧道在 selection.json 中被禁用（${names}），未启用则公网地址不可用`);
    } else {
      tunnel = byPort[0]; // selection.json 缺失或未列出该隧道 → 按存在处理
      notes.push("selection.json 未确认启用状态，按存在处理");
    }

    const tunnelName = typeof tunnel.name === "string" && tunnel.name ? tunnel.name : null;
    const remotePort = Number.isFinite(tunnel.remotePort) ? Math.trunc(tunnel.remotePort) : null;
    const enabledFlag = enabledOf(tunnel.name);
    notes.push(
      `隧道 ${tunnelName ?? "?"} localPort=${localPort} → remotePort=${remotePort ?? "?"}` +
        `（selection=${enabledFlag === null ? "unknown" : String(enabledFlag)}）`,
    );

    if (remotePort === null) {
      return failure(`隧道 ${tunnelName ?? "?"} 没有可用的 remotePort`);
    }

    // ---- host 选择：domain-binding 可用则用域名，否则用 serverAddr ----
    const binding = await readJsonSafe(path.join(chosen.dir, "domain-binding.json"));
    let host = null;
    let source = "none";

    const bindingValue = binding.value && typeof binding.value === "object" ? binding.value : null;
    if (!bindingValue) {
      notes.push(`domain-binding.json ${binding.error ?? "不可用"}，回退 serverAddr`);
    } else if (bindingValue.enabled !== true) {
      notes.push("domain-binding.enabled 非 true，回退 serverAddr");
    } else if (bindingValue.canWrite === false) {
      // canWrite=false 表示域名解析记录无法自动维护，域名不可靠 → 回退
      notes.push("domain-binding.canWrite 为 false，域名记录无法维护，回退 serverAddr");
    } else {
      const domain = bindingHostname(bindingValue);
      if (domain) {
        host = domain;
        source = "domain-binding";
      } else {
        notes.push("domain-binding 缺少有效 zone，回退 serverAddr");
      }
    }

    if (source !== "domain-binding") {
      if (serverAddr) {
        host = serverAddr;
        source = "server-addr";
      } else {
        return failure(`实例 ${chosen.id} 既没有可用域名绑定，也没有 serverAddr`);
      }
    }

    const url = `http://${formatHostForUrl(host)}:${remotePort}`;
    notes.push(`source=${source} host=${host}`);

    return {
      ok: true,
      url,
      host,
      remotePort,
      serverAddr,
      tunnelName,
      instanceId: chosen.id,
      source,
      detail: notes.join("；"),
    };
  } catch (error) {
    // 契约要求：任何异常都不得抛出
    return failure(`解析公网地址时发生异常：${(error && error.message) || String(error)}`);
  }
}

export default resolvePublicAddress;
