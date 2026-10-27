import assert from "node:assert/strict";
import { projectMatchesThread, projectRootPaths, threadTimestamp } from "../public/project-utils.js";

const appProject = {
  path: "E:\\实用软件开发",
  roots: [{ path: "E:\\实用软件开发" }, { path: "E:\\实用软件开发\\插件" }],
};
assert.deepEqual(projectRootPaths(appProject), ["E:\\实用软件开发", "E:\\实用软件开发\\插件"]);
assert.equal(projectMatchesThread(appProject, "E:\\实用软件开发"), true);
assert.equal(projectMatchesThread(appProject, "e:/实用软件开发/电脑软件/dsh插件/codex-web-remote"), true);
assert.equal(projectMatchesThread(appProject, "E:\\实用软件开发备份"), false);

const stringRootsProject = { path: "C:\\fallback", roots: ["C:\\workspace"] };
assert.equal(projectMatchesThread(stringRootsProject, "C:\\workspace\\src"), true);
assert.equal(projectMatchesThread(stringRootsProject, "C:\\fallback"), false);
assert.equal(projectMatchesThread({ path: "C:\\fallback" }, "C:\\fallback\\src"), true);
assert.equal(projectMatchesThread({ path: "C:\\fallback", roots: [] }, "C:\\fallback\\src"), true);

const staleRecency = Math.floor((Date.now() - 3 * 60 * 60_000) / 1000);
const latestUpdate = new Date(Date.now() - 10 * 60_000).toISOString();
const threadA = { recencyAt: staleRecency, updatedAt: latestUpdate };
const threadB = { recencyAt: Math.floor((Date.now() - 60 * 60_000) / 1000), updatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() };
assert.equal(threadTimestamp(threadA), Date.parse(latestUpdate));
assert.ok(threadTimestamp(threadA) > threadTimestamp(threadB));
assert.equal(threadTimestamp({}), 0);

console.log("PROJECT_UTILS_TEST_OK objectRoots=true stringRoots=true fallback=true latestTimestamp=true");