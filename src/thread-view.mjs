import crypto from 'node:crypto';

// Read models are disposable. Original Codex rollouts remain authoritative.
export class ThreadViews {
  constructor() { this.assets = new Map(); this.details = new Map(); }
  page(thread, { before, limit = 60, revision = '', epoch = '' } = {}) {
    const source = thread.turns || [];
    const totalItems = source.reduce((n, turn) => n + (turn.items?.length || 0), 0);
    const end = before == null || before === '' ? totalItems : Math.max(0, Math.min(totalItems, Number(before) || 0));
    const start = Math.max(0, end - Math.max(1, Math.min(80, Number(limit) || 60)));
    const turns = [];
    let bytes = 0;
    // Walk backward to the requested page, not a clone of the whole history.
    let position = totalItems;
    const selected = [];
    outer: for (let t = source.length - 1; t >= 0; t--) {
      const turn = source[t]; const items = turn.items || [];
      if (position - items.length >= end) { position -= items.length; continue; }
      for (let i = items.length - 1; i >= 0; i--) {
        position--; if (position >= end) continue; if (position < start) break outer;
        selected.push({ ...items[i], id: String(items[i].id || `${turn.id || 'turn'}:${i}`), turnId: turn.id });
      }
    }
    for (const item of selected) {
      const key = `${thread.id}:${item.id}`;
      this.details.set(key, item);
      const small = this.compact(item, thread.id);
      const size = Buffer.byteLength(JSON.stringify(small));
      if (bytes + size > 260_000 && turns.length) break;
      bytes += size;
      let turn = turns.at(-1);
      if (turn?.id !== item.turnId) { turn = { id: item.turnId, items: [] }; turns.push(turn); }
      turn.items.unshift(small);
    }
    turns.reverse();
    const count = turns.reduce((n, turn) => n + turn.items.length, 0);
    const { turns: ignored, ...metadata } = thread;
    return { thread: { ...metadata, turns }, revision, epoch, page: { before: end - count > 0 ? String(end - count) : null, hasMore: end - count > 0, totalItems } };
  }
  compact(item, threadId) {
    if (item?.id) this.details.set(`${threadId}:${item.id}`, item);
    let truncated = false;
    let remaining = 50_000;
    const visit = (value, key = '', depth = 0) => {
      if (typeof value === 'string') {
        if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
          const id = crypto.createHash('sha256').update(`${threadId}:${value}`).digest('hex');
          this.assets.set(id, { value, threadId });
          return `/api/v2/threads/${encodeURIComponent(threadId)}/assets/${id}`;
        }
        if (remaining <= 0) { truncated = true; return ''; }
        if (value.length > 3500 || value.length > remaining) { truncated = true; const text = `${value.slice(0, Math.min(1800, remaining))}\n…完整内容按需加载…\n${remaining > 2000 ? value.slice(-1200) : ''}`; remaining -= text.length; return text; }
        remaining -= value.length;
        return value;
      }
      if (depth > 12) { truncated = true; return '[嵌套内容，展开查看]'; }
      if (Array.isArray(value)) { if (value.length > 30) truncated = true; return value.slice(0, 30).map((v) => visit(v, key, depth + 1)); }
      if (value && typeof value === 'object') {
        // MCP images use a separate data/mimeType pair.
        if (value.type === 'image' && typeof value.data === 'string' && value.data.length > 1024) {
          return { type: 'image', imageUrl: visit(`data:${value.mimeType || value.mime_type || 'image/png'};base64,${value.data}`) };
        }
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k, depth + 1)]));
      }
      return value;
    };
    const small = visit({ id: item.id, type: item.type, turnId: item.turnId, ...item });
    if (truncated) { small.truncated = true; small.detailUrl = `/api/v2/threads/${encodeURIComponent(threadId)}/items/${encodeURIComponent(item.id)}`; }
    // Keep resource maps bounded, independent of history size.
    while (this.details.size > 1200) this.details.delete(this.details.keys().next().value);
    while (this.assets.size > 120) this.assets.delete(this.assets.keys().next().value);
    return small;
  }
}

export function relatedAgentIds(thread) {
  const agents = new Map();
  for (const turn of thread?.turns || []) for (const item of turn.items || []) {
    if (!['collabAgentToolCall', 'subAgentActivity', 'dynamicToolCall'].includes(item.type)) continue;
    const ids = [item.agentThreadId, ...(item.receiverThreadIds || []), ...Object.keys(item.agentsStates || {})].filter(Boolean);
    for (const content of item.contentItems || []) {
      try { const data = JSON.parse(content.text || '{}'); const id = data.agent_id || data.agentId || data.thread_id || data.threadId; if (id) ids.push(id); } catch { }
    }
    for (const id of ids) {
      const info = item.agentsStates?.[id] || {};
      agents.set(String(id), { id: String(id), name: item.agentPath || info.name || info.agentNickname || String(id).slice(0, 12), model: info.model || item.model || '', status: info.status || item.kind || item.status || 'unknown', result: info.message || info.result || '' });
    }
  }
  return [...agents.values()];
}
