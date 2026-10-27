import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverCodexCandidates } from "../src/codex-client.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-test-"));
try {
  const userProfile = path.join(temp, "user");
  const localAppData = path.join(temp, "local");
  const codexHome = path.join(userProfile, ".codex");
  const configured = path.join(localAppData, "OpenAI", "Codex", "bin", "current", process.platform === "win32" ? "codex.exe" : "codex");
  await mkdir(path.dirname(configured), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(configured, "");
  if (process.platform !== "win32") await chmod(configured, 0o755);
  await writeFile(path.join(codexHome, "config.toml"), `[agents]\nenabled = true\n\n[shell_environment_policy.set]\nCODEX_CLI_PATH = '${configured.replaceAll("\\", "\\\\")}'\n`);

  const env = { ...process.env, USERPROFILE: userProfile, LOCALAPPDATA: localAppData, CODEX_HOME: codexHome, PATH: "" };
  const candidates = discoverCodexCandidates({ env });
  assert.equal(candidates[0].source, "config", "configured desktop-compatible CLI should be preferred");
  assert.equal(candidates.filter((candidate) => candidate.source === "config").length, 1, "same CLI must not be duplicated through desktop discovery");
  assert.equal(candidates.at(-1).source, "bundled", "bundled CLI must remain the final standalone fallback");
  assert.ok(candidates.every((candidate) => candidate.version), "candidate metadata should always include a version label");

  const standalone = discoverCodexCandidates({ env: { ...env, CODEX_HOME: path.join(temp, "missing"), LOCALAPPDATA: path.join(temp, "missing-local") } });
  assert.equal(standalone.at(-1).source, "bundled", "a computer without Desktop Codex must still have a bundled backend");
  console.log("CODEX_RUNTIME_TEST_OK configured=true deduplicated=true bundledFallback=true");
} finally {
  await rm(temp, { recursive: true, force: true });
}
