/** @typedef {{result: object, scrollTop: number, savedAt: number}} CachedView */
const memory = new Map();
let database;
function db() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return database ||= new Promise((resolve) => {
    try {
      const request = indexedDB.open('codex-workspace-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('views');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
export async function cacheView(id, view) {
  memory.delete(id); memory.set(id, view);
  while (memory.size > 8) memory.delete(memory.keys().next().value);
  const database = await db(); if (!database) return;
  try {
    const tx = database.transaction('views', 'readwrite');
    tx.objectStore('views').put(view, id);
    const values = tx.objectStore('views').getAll();
    const keys = tx.objectStore('views').getAllKeys();
    keys.onsuccess = () => {
      const entries = keys.result.map((key, index) => ({ key, at: values.result[index]?.savedAt || 0 }));
      for (const entry of entries.sort((a, b) => b.at - a.at).slice(8)) tx.objectStore('views').delete(entry.key);
    };
  } catch { }
}
export async function restoreView(id) {
  if (memory.has(id)) return memory.get(id);
  const database = await db(); if (!database) return null;
  return new Promise((resolve) => {
    try { const request = database.transaction('views').objectStore('views').get(id); request.onsuccess = () => resolve(request.result || null); request.onerror = () => resolve(null); } catch { resolve(null); }
  });
}
export function readRoute(hash = globalThis.location?.hash || '') {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  return { threadId: p.get('task') || '', projectId: p.get('project') || '' };
}
export function writeRoute(threadId, projectId, replace = false) {
  const p = new URLSearchParams(); if (threadId) p.set('task', threadId); if (projectId) p.set('project', projectId);
  const next = `${location.pathname}${location.search}#${p}`;
  if (`${location.pathname}${location.search}${location.hash}` !== next) history[replace ? 'replaceState' : 'pushState'](null, '', next);
}
export function clientMessageId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
export function mergeItems(previous, incoming, prepend = false) {
  const map = new Map();
  for (const item of prepend ? [...incoming, ...previous] : [...previous, ...incoming]) {
    const key = item.id; if (!key) continue;
    const old = map.get(key);
    map.set(key, old ? { ...old, ...item } : item);
  }
  return [...map.values()];
}
