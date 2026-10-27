import fsp from 'node:fs/promises';
import path from 'node:path';

let sqliteModulePromise = null;
let cache = { at: 0, dir: '', values: new Map() };

async function loadSqlite() {
  if (!sqliteModulePromise) sqliteModulePromise = import('node:sqlite').catch(() => null);
  return sqliteModulePromise;
}

async function readCandidateTitles(candidates, values) {
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return;
  for (const candidate of candidates.slice(0, 4)) {
    let db = null;
    try {
      db = new sqlite.DatabaseSync(candidate.file, { readOnly: true, timeout: 2_000 });
      const statement = db.prepare('pragma table_info(threads)');
      const rawColumns = statement.all();
      const columns = new Set();
      for (const column of rawColumns) columns.add(String(column.name));
      if (!columns.has('id') || !columns.has('title')) continue;
      const nameColumn = columns.has('name') ? 'name' : 'NULL AS name';
      const updatedColumn = columns.has('updated_at_ms') ? 'updated_at_ms' : '0 AS updated_at_ms';
      const query = 'SELECT id, ' + nameColumn + ', title, ' + updatedColumn + ' FROM threads';
      const rows = db.prepare(query).all();
      for (const row of rows) {
        const id = String(row.id || '').trim();
        if (!id) continue;
        const custom = String(row.name || '').trim();
        const title = String(row.title || '').trim();
        const effective = custom || title;
        if (effective) values.set(id, { title: effective, custom: Boolean(custom), updatedAt: Number(row.updated_at_ms || 0) });
      }
    } catch { }
    finally { try { db?.close(); } catch { } }
    if (values.size) return;
  }
}

export async function readAppThreadTitles(codexHomeDir, { force = false, cacheMs = 2_000 } = {}) {
  const dir = path.resolve(codexHomeDir);
  if (!force && cache.dir === dir && cache.at && Date.now() - cache.at < cacheMs) return cache.values;
  const values = new Map();
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = /^state(?:_(\d+))?\.sqlite$/i.exec(entry.name);
      if (!match) continue;
      const file = path.join(dir, entry.name);
      let mtimeMs = 0;
      try { mtimeMs = (await fsp.stat(file)).mtimeMs; } catch { }
      candidates.push({ file, version: Number(match[1] || 0), mtimeMs });
    }
    candidates.sort((a, b) => b.version - a.version || b.mtimeMs - a.mtimeMs);
    await readCandidateTitles(candidates, values);
  } catch { }
  cache = { at: Date.now(), dir, values };
  return values;
}
