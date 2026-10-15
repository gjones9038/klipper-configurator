// Display helpers for generated files: Klipper cfg highlighting and a small
// Markdown renderer covering what wiring.ts / emit.ts produce (headings,
// lists, tables, quotes, fenced code, links, bold, inline code). Everything is
// built as DOM nodes, never innerHTML.
import { h, extLink, type Child } from './dom.ts';

export function cfgLines(text: string): Child[] {
  return text.split('\n').map((line) => {
    let node: Child;
    const ci = commentIndex(line);
    const body = ci < 0 ? line : line.slice(0, ci);
    const comment = ci < 0 ? '' : line.slice(ci);
    const sec = /^\[.*\]\s*$/.exec(body);
    const kv = /^(\w+)(\s*[:=])(.*)$/.exec(body);
    if (sec) node = h('span', { class: /^\[gcode_macro/.test(body) ? 'c-macro' : 'c-sec' }, body);
    else if (kv) node = [h('span', { class: 'c-key' }, kv[1]), kv[2] + kv[3]];
    else node = body;
    return [node, comment ? h('span', { class: 'c-com' }, comment) : null, '\n'];
  });
}

// '#' starts a comment unless it is inside a Jinja expression or a hex colour.
function commentIndex(line: string): number {
  const t = line.trimStart();
  if (t.startsWith('#') || t.startsWith(';')) return line.indexOf(t[0]);
  const m = /\s#\s/.exec(line);
  return m && !line.includes('{') ? m.index + 1 : -1;
}

export function inline(text: string): Child[] {
  const out: Child[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|<(https?:\/\/[^>]+)>/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(/^https?:/.test(m[2]) ? extLink(m[2], inline(m[1])) : inline(m[1]));
    else if (m[3] !== undefined) out.push(h('strong', null, m[3]));
    else if (m[4] !== undefined) out.push(h('code', null, m[4]));
    else out.push(extLink(m[5], m[5]));
    last = re.lastIndex;
  }
  out.push(text.slice(last));
  return out;
}

export function markdown(text: string): HTMLElement {
  const root = h('div', { class: 'md' });
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      root.append(h('pre', { class: 'code' }, cfgLines(body.join('\n'))));
      continue;
    }
    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hd) {
      const tag = (['h1', 'h2', 'h3', 'h3'] as const)[hd[1].length - 1];
      root.append(h(tag, null, inline(hd[2])));
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) {
        if (/^\|[\s:|-]+\|$/.test(lines[i])) continue;
        rows.push(lines[i].slice(1, -1).split('|').map((c) => c.trim()));
      }
      const [head, ...body] = rows;
      root.append(h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, head.map((c) => h('th', null, inline(c))))),
        h('tbody', null, body.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c)))))))));
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      for (; i < lines.length && lines[i].startsWith('>'); i++) body.push(lines[i].replace(/^>\s?/, ''));
      root.append(h('blockquote', null, inline(body.join(' '))));
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]); i++) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        // continuation lines indented under the item
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i + 1])) items[items.length - 1] += ' ' + lines[++i].trim();
      }
      root.append(h(ordered ? 'ol' : 'ul', null, items.map((t) => h('li', null, inline(t)))));
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#|\||>|```|\s*([-*]|\d+\.)\s)/.test(lines[i]); i++) para.push(lines[i]);
    root.append(h('p', null, inline(para.join(' '))));
  }
  return root;
}
