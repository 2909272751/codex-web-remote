import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appRoot = process.env.CODEX_WEB_TEST_APP_ROOT
  ? path.resolve(process.env.CODEX_WEB_TEST_APP_ROOT)
  : path.resolve(import.meta.dirname, "..");
const { CodexClient } = await import(pathToFileURL(path.join(appRoot, "src", "codex-client.mjs")));

const originalCodexHome = process.env.CODEX_HOME;
const cleanCodexHome = await mkdtemp(path.join(os.tmpdir(), "codex-web-clean-profile-"));
const client = new CodexClient();
let stderr = "";
client.on("stderr", (chunk) => { stderr += String(chunk); });

try {
  process.env.CODEX_HOME = cleanCodexHome;
  await client.start();
  const result = await client.request("thread/list", {
    limit: 1,
    sortKey: "recency_at",
    sortDirection: "desc",
    archived: false,
    modelProviders: [],
    sourceKinds: null,
  });
  if (!Array.isArray(result?.data)) throw new Error("Clean profile thread/list did not return data");
  console.log("CLEAN_PROFILE_TEST_OK initialize=true threadList=true");
} catch (error) {
  if (stderr.trim()) console.error(stderr.trim());
  throw error;
} finally {
  await client.stop();
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await rm(cleanCodexHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
