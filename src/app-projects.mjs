import fsp from 'node:fs/promises';
import path from 'node:path';

let sqliteModulePromise = null;
let cache = { at: 0, dir: '', available: false, projects: [] };

async function loadSqlite() {
  if (!sqliteModulePromise) sqliteModulePromise = import('node:sqlite').catch(() => null);
  return sqliteModulePromise;
}

function parseMetadata(value) {
  try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; }
  catch { return {}; }
}

async function readCandidateProjects(candidates) {
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return null;
  for (const candidate of candidates.slice(0, 4)) {
    let db = null;
    try {
      db = new sqlite.DatabaseSync(candidate.file, { readOnly: true, timeout: 2_000 });
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
      if (!tables.has('projects')) continue;
      const rootsTable = tables.has('project_roots');
      const projects = [];
      const byId = new Map();
      for (const row of db.prepare('SELECT id, name, metadata, position, created_at_ms, updated_at_ms FROM projects ORDER BY position, created_at_ms').all()) {
        const project = {
          id: String(row.id),
          name: String(row.name || ''),
          metadata: parseMetadata(row.metadata),
          position: Number(row.position || 0),
          createdAt: Number(row.created_at_ms || 0),
          updatedAt: Number(row.updated_at_ms || 0),
          recencyAt: null,
          roots: [],
        };
        projects.push(project);
        byId.set(project.id, project);
      }
      if (rootsTable) {
        for (const row of db.prepare('SELECT project_id, path, position FROM project_roots ORDER BY project_id, position').all()) {
          const project = byId.get(String(row.project_id));
          if (project) project.roots.push({ path: String(row.path || '') });
        }
      }
      return projects.map((project) => {
        const roots = project.roots.map((root) => String(root?.path || '')).filter(Boolean);
        return { ...project, roots, path: roots[0] || '', saved: true, source: 'app' };
      });
    } catch { }
    finally { try { db?.close(); } catch { } }
  }
  return null;
}

export async function readAppProjects(codexHomeDir, { force = false, cacheMs = 2_000 } = {}) {
  const dir = path.resolve(codexHomeDir);
  if (!force && cache.dir === dir && cache.at && Date.now() - cache.at < cacheMs) return { available: cache.available, projects: cache.projects };
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
    const projects = await readCandidateProjects(candidates);
    cache = { at: Date.now(), dir, available: projects !== null, projects: projects || [] };
    return { available: cache.available, projects: cache.projects };
  } catch {
    cache = { at: Date.now(), dir, available: false, projects: [] };
    return { available: false, projects: [] };
  }
}
