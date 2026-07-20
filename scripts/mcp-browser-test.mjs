import http from "node:http";
import path from "node:path";
import { CodexClient } from "../src/codex-client.mjs";

const root = path.resolve(import.meta.dirname, "..");
const pageServer = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Playwright MCP QA</title><h1>PLAYWRIGHT_NAV_OK</h1><button onclick=\"document.querySelector('h1').textContent='PLAYWRIGHT_CLICK_OK'\">测试点击</button>");
});

await new Promise((resolve, reject) => {
  pageServer.once("error", reject);
  pageServer.listen(0, "127.0.0.1", resolve);
});

const address = pageServer.address();
const url = `http://127.0.0.1:${address.port}/`;
const client = new CodexClient();
let stderr = "";
client.on("stderr", (chunk) => { stderr += String(chunk); });

try {
  await client.start();
  const started = await client.request("thread/start", { cwd: root, ephemeral: true, approvalPolicy: "never", sandbox: "danger-full-access" });
  const threadId = started.thread.id;
  await client.request("mcpServer/tool/call", { server: "playwright", tool: "browser_navigate", threadId, arguments: { url } });
  const snapshot = await client.request("mcpServer/tool/call", { server: "playwright", tool: "browser_snapshot", threadId, arguments: {} });
  const snapshotText = JSON.stringify(snapshot);
  if (!snapshotText.includes("PLAYWRIGHT_NAV_OK") || !snapshotText.includes("测试点击")) throw new Error(`Browser snapshot did not contain the QA page: ${snapshotText.slice(0, 1000)}`);
  const ref = snapshotText.match(/button.*?测试点击.*?ref[=:\\"' ]+([a-z0-9]+)/i)?.[1];
  if (!ref) throw new Error(`Could not find the button ref in snapshot: ${snapshotText.slice(0, 1000)}`);
  const clickResult = await client.request("mcpServer/tool/call", { server: "playwright", tool: "browser_click", threadId, arguments: { target: ref } });
  const clicked = await client.request("mcpServer/tool/call", { server: "playwright", tool: "browser_snapshot", threadId, arguments: {} });
  if (!JSON.stringify(clicked).includes("PLAYWRIGHT_CLICK_OK")) throw new Error(`Browser click did not update the page: ${JSON.stringify({ ref, clickResult, clicked }).slice(0, 2000)}`);
  const screenshot = await client.request("mcpServer/tool/call", { server: "playwright", tool: "browser_take_screenshot", threadId, arguments: { fullPage: false } });
  if (!Array.isArray(screenshot?.content) || !screenshot.content.some((entry) => entry?.type === "image")) throw new Error(`Browser screenshot did not return image content: ${JSON.stringify(screenshot).slice(0, 1000)}`);
  console.log("PLAYWRIGHT_MCP_TEST_OK navigate=true click=true screenshot=true");
} catch (error) {
  if (stderr.trim()) console.error(stderr.trim());
  throw error;
} finally {
  await client.stop();
  await new Promise((resolve) => pageServer.close(resolve));
}
