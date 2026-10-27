import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/markdown.js';

// Pure renderer contract, independent of browser permissions and network.
class Node {
  constructor(tag = '#text', text = '') { this.tagName = tag; this.children = []; this.ownText = text; this.classList = { add() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this.ownText = ''; }
  setAttribute(name, value) { this[name] = value; }
  get textContent() { return this.ownText + this.children.map(n => typeof n === 'string' ? n : n.textContent).join(''); }
  set textContent(text) { this.ownText = String(text); this.children = []; }
}
globalThis.document = { createElement: tag => new Node(tag), createTextNode: text => new Node('#text', text), createDocumentFragment: () => new Node('#fragment') };
globalThis.location = { href: 'http://localhost:18888/', origin: 'http://localhost:18888' };
const box = new Node('div');
renderMarkdown(box, '# 标题\n**强调** 和 `内联代码`\n```js\nconsole.log("test");\n```\n|输入|输出|\n|---|---|\n|1|2|\n[安全链接](https://example.com/)\n[拒绝脚本](javascript:alert)\n<img src=x onerror=alert(1)>\n![禁止外站跟踪图](https://example.com/track)');
const all = []; const walk = n => { if (typeof n === 'string') return; all.push(n); n.children.forEach(walk); }; walk(box);
assert.equal(all.filter(n => n.tagName === 'h1').length, 1);
assert.equal(all.filter(n => n.tagName === 'strong').length, 1);
assert.equal(all.filter(n => n.tagName === 'table').length, 1);
assert(all.some(n => n.tagName === 'code' && n.textContent.includes('console.log')));
assert.equal(all.filter(n => n.tagName === 'a').length, 1);
assert.equal(all.filter(n => n.tagName === 'img').length, 0);
assert(box.textContent.includes('<img src=x onerror=alert(1)>'));
renderMarkdown(box, '**还在生成', { streaming: true }); assert.equal(box.textContent, '**还在生成');
console.log('MARKDOWN_TEST_OK heading=true code=true table=true safe_links=true no_html_execution=true streaming=true');
