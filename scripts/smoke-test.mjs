import fsp from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { CodexClient } from "../src/codex-client.mjs";

const client = new CodexClient();
let reply = "";
let targetThreadId = null;
let targetTurnId = null;
const imagePath = path.join(os.tmpdir(), `codex-web-smoke-${process.pid}.png`);
const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const completed = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Smoke test timed out")), 120_000);
  client.on("notification", ({ method, params }) => {
    if (params?.threadId !== targetThreadId) return;
    if (method === "item/agentMessage/delta") reply += params.delta || "";
    if (method === "turn/completed") {
      clearTimeout(timeout);
      if (params.turn?.status === "failed") reject(new Error(params.turn?.error?.message || "Turn failed"));
      else resolve();
    }
  });
  client.on("serverRequest", (request) => client.respondToServerRequest(request.id, { decision: "decline" }));
});

try {
  await fsp.writeFile(imagePath, png1x1);
  await client.start();
  const started = await client.request("thread/start", { cwd: process.cwd(), ephemeral: true });
  targetThreadId = started.thread.id;
  const turn = await client.request("turn/start", {
    threadId: targetThreadId,
    input: [{ type: "text", text: "Inspect the attached image, then reply with exactly WEB_REMOTE_OK." }, { type: "localImage", path: imagePath }],
  });
  targetTurnId = turn.turn.id;
  try {
    await client.request("turn/steer", {
      threadId: targetThreadId,
      expectedTurnId: targetTurnId,
      input: [{ type: "text", text: "Keep the final reply exactly WEB_REMOTE_OK." }],
      clientUserMessageId: crypto.randomUUID(),
    });
  } catch (error) {
    if (!/active turn|invalid request/i.test(error.message)) throw error;
  }
  await completed;
  if (!reply.includes("WEB_REMOTE_OK")) throw new Error(`Unexpected reply: ${reply}`);
  console.log("SMOKE_TEST_OK");
} finally {
  await client.stop();
  await fsp.rm(imagePath, { force: true });
}
