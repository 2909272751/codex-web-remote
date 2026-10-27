import { spawn } from 'node:child_process';
import fs from 'node:fs';
const leaf = process.argv.includes('--leaf');
const record = process.argv.at(-1);
let child;
if (!leaf) child = spawn(process.execPath, [import.meta.filename, '--leaf', `${record}.child`], { windowsHide: true, stdio: 'ignore' });
fs.writeFileSync(record, JSON.stringify({ pid: process.pid, childPid: child?.pid, marker: 'codex-web-process-fixture' }));
setInterval(() => {}, 1000);
