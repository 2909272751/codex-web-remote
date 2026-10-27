function safeUrl(value, image = false) {
  try { const url = new URL(value, location.href); return (image ? url.origin === location.origin || ['blob:'].includes(url.protocol) : ['http:', 'https:', 'mailto:'].includes(url.protocol)) ? url.href : ''; } catch { return ''; }
}
function inline(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|!?\[[^\]]*\]\([^\s)]+\))/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    const token = match[0]; let el;
    if (token.startsWith('`')) { el = document.createElement('code'); el.textContent = token.slice(1, -1); }
    else if (token.startsWith('**')) { el = document.createElement('strong'); el.textContent = token.slice(2, -2); }
    else if (token.startsWith('*')) { el = document.createElement('em'); el.textContent = token.slice(1, -1); }
    else {
      const [, image, label, href] = /^(!?)\[([^\]]*)\]\((.*)\)$/.exec(token);
      const url = safeUrl(href, Boolean(image));
      if (!url) { el = document.createTextNode(token); }
      else if (image) { el = document.createElement('img'); el.src = url; el.alt = label; el.loading = 'lazy'; }
      else { el = document.createElement('a'); el.href = url; el.textContent = label; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    }
    parent.append(el); start = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}
function codeBlock(code, language) {
  const box = document.createElement('section'); box.className = 'code-block';
  const header = document.createElement('header'); const label = document.createElement('span'); label.textContent = language || '代码';
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制'; copy.setAttribute('aria-label', '复制代码');
  copy.onclick = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else { const t = document.createElement('textarea'); t.value = code; box.append(t); t.select(); const ok = document.execCommand('copy'); t.remove(); if (!ok) throw new Error(); }
      copy.textContent = '已复制';
    } catch { copy.textContent = '请选择代码复制'; }
    setTimeout(() => { copy.textContent = '复制'; }, 1800);
  };
  header.append(label, copy);
  const pre = document.createElement('pre'); const content = document.createElement('code'); content.textContent = code; pre.append(content); box.append(header, pre); return box;
}
export function renderMarkdown(container, text, { streaming = false } = {}) {
  container.classList.add('markdown-body');
  if (streaming) { container.textContent = String(text || ''); return; }
  const lines = String(text || '').split(/\r?\n/); const fragment = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const language = line.replace(/^\s*```/, '').trim(); const body = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
      fragment.append(codeBlock(body.join('\n'), language)); continue;
    }
    if (!line.trim()) continue;
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      const table = document.createElement('table'); const wrap = document.createElement('div'); wrap.className = 'table-scroll';
      const row = (line, tag) => { const tr = document.createElement('tr'); for (const value of line.trim().replace(/^\||\|$/g, '').split('|')) { const cell = document.createElement(tag); inline(cell, value.trim()); tr.append(cell); } table.append(tr); };
      row(line, 'th'); i++;
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) row(lines[++i], 'td');
      wrap.append(table); fragment.append(wrap); continue;
    }
    let el; let content = line;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const list = /^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(line);
    if (heading) { el = document.createElement(`h${heading[1].length}`); content = heading[2]; }
    else if (list) { el = document.createElement('div'); el.className = 'markdown-list-item'; content = `• ${list[1]}`; }
    else if (/^>\s?/.test(line)) { el = document.createElement('blockquote'); content = line.replace(/^>\s?/, ''); }
    else { el = document.createElement('p'); }
    inline(el, content); fragment.append(el);
  }
  container.replaceChildren(fragment);
}
