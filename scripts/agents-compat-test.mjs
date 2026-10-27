import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalCodexHome = process.env.CODEX_HOME;
const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-agents-compat-"));
await mkdir(path.join(codexHome, "agents"), { recursive: true });
await writeFile(path.join(codexHome, "config.toml"), `[agents]\nenabled = true\nmax_concurrent_threads_per_session = 1\ninterrupt_message = true\n`);
await writeFile(path.join(codexHome, "agents", "compat_worker.toml"), `name = "compat_worker"\ndescription = "Compatibility probe worker"\ndeveloper_instructions = "Only report that the compatibility probe loaded."\nsandbox_mode = "read-only"\n`);
process.env.CODEX_HOME = codexHome;

const { CodexClient } = await import("../src/codex-client.mjs");
const client = new CodexClient();
let stderr = "";
client.on("stderr", (chunk) => { stderr += String(chunk); });
try {
  await client.start();
  const runtime = client.getRuntimeStatus();
  assert.ok(runtime.selected, "a compatible runtime should be selected");
  const models = await client.request("model/list", { includeHidden: false });
  assert.ok(Array.isArray(models?.data), "selected runtime should keep serving requests after the compatibility probe");
  console.log(`AGENTS_COMPAT_TEST_OK source=${runtime.selected.source} version=${runtime.selected.version} fallbacks=${runtime.failures.length}`);
} catch (error) {
  if (stderr.trim()) console.error(stderr.trim());
  throw error;
} finally {
  await client.stop().catch(() => {});
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await rm(codexHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
