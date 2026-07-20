import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const port = 18996;
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: {
    ...process.env,
    CODEX_WEB_PASSWORD: "pwa-test-password",
    CODEX_WEB_HOST: "127.0.0.1",
    CODEX_WEB_PORT: String(port),
    CODEX_WEB_DATA_DIR: path.join(os.tmpdir(), `codex-pwa-${process.pid}`),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  const deadline = Date.now() + 20_000;
  let manifestResponse;
  while (Date.now() < deadline) {
    try {
      manifestResponse = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
      if (manifestResponse.ok) break;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!manifestResponse?.ok) throw new Error(`PWA server did not start: ${stderr}`);
  const manifest = await manifestResponse.json();
  if (manifest.name !== "Codex Web Remote" || manifest.display !== "standalone") throw new Error("Invalid PWA manifest");
  for (const asset of ["sw.js", "icon.svg"]) {
    const response = await fetch(`http://127.0.0.1:${port}/${asset}`);
    if (!response.ok) throw new Error(`Missing PWA asset: ${asset}`);
  }
  console.log("PWA_TEST_OK manifest=true serviceWorker=true icon=true");
} finally {
  child.kill();
}
