// Export step: every generated file, the wiring list, MCUs and links, plus
// the .zip download.
import type { Build, Db, Result } from '../generator/types.ts';
import { h, extLink, download, type Child } from './dom.ts';
import { cfgLines, markdown } from './text.ts';
import { zip } from './zip.ts';
import { renderUpload } from './upload.ts';

export function buildTitle(b: Build, db: Db): string {
  const p = db.printers[b.printer];
  return `${p.name} · ${b.size}${b.variant === 'awd' ? ' · AWD' : ''}`;
}

export function buildSummary(b: Build, db: Db): string {
  const board = db.mainboards[b.mainboard.id];
  const conn = { usb: 'USB', can: 'CAN', 'usb-can-bridge': 'USB-CAN bridge' }[b.mainboard.connection];
  return [
    `${board.name} ${board.revisions.join('/')}${(b.mainboard.extensions ?? []).map((id) => ` + ${board.extensions?.find((e: any) => e.id === id)?.name ?? id}`).join('')} (${conn})`,
    b.toolchanger ? `${db.toolchangers[b.toolchanger.system]?.name ?? 'toolchanger'}, ${b.toolchanger.tools.length + 1} tools` : null,
    b.toolboard ? `${b.toolchanger ? 'T0 ' : ''}${db.toolboards[b.toolboard.id].name}` : 'no toolhead board',
    db.extruders[b.extruder].name, db.hotends[b.hotend].name,
    b.toolchanger ? 'Tap on every tool' : b.probe ? db.probes[b.probe].name : 'no probe',
    b.homing.xy === 'sensorless' ? 'sensorless X/Y' : 'X/Y switches',
    b.autotune ? 'TMC autotune' : null,
    b.nevermore ? db.filters[b.nevermore.model].name : null,
  ].filter(Boolean).join(' · ');
}

export function zipFiles(result: Result, build: Build): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(result.files)) out[`klipper-config/${name}`] = text;
  out['klipper-config/wiring.json'] = JSON.stringify(result.wiring, null, 2) + '\n';
  out['klipper-config/build.json'] = JSON.stringify(build, null, 2) + '\n';
  return out;
}

// Files in the order a user reads them: configs, macros, then the guides.
function fileOrder(names: string[]): string[] {
  const rank = (n: string) => n === 'printer.cfg' ? 0 : n.endsWith('.cfg') && !n.includes('/') ? 1 : n.startsWith('tools/') ? 1.5 : n.startsWith('macros/') ? 2 : n === 'WARNINGS.md' ? 3 : n.endsWith('.md') ? 4 : 5;
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function fileView(name: string, text: string): Child {
  if (name.endsWith('.md')) return h('div', { style: 'padding: 16px 18px' }, markdown(text));
  return h('pre', { class: 'code' }, name.endsWith('.cfg') ? cfgLines(text) : text);
}

export function renderExport(opts: { db: Db; build: Build; result: Result; file: string; pickFile(f: string): void; rerender(): void }): Child {
  const { db, build, result } = opts;
  const names = fileOrder(Object.keys(result.files));
  const file = names.includes(opts.file) ? opts.file : 'printer.cfg';
  const text = result.files[file] ?? '';
  const warnings = result.issues.filter((i) => i.level === 'warning').length;
  const copy = async (e: Event) => {
    const btn = e.currentTarget as HTMLButtonElement;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  };
  const topics = [...new Set(result.links.map((l) => l.topic))];
  return [
    h('div', { class: 'files' },
      h('nav', { 'aria-label': 'Generated files' },
        h('div', { class: 'label', style: 'padding: 4px 16px 10px' }, `Files · ${names.length}`),
        h('ul', null, names.map((n) => h('li', null, h('button', { type: 'button', class: 'file-btn', 'aria-current': String(n === file), onClick: () => opts.pickFile(n) }, n))))),
      h('div', { class: 'viewer' },
        h('div', { class: 'viewer-bar' }, h('span', null, `${file} · ${text.split('\n').length} lines`),
          h('button', { type: 'button', class: 'btn', onClick: copy }, 'Copy')),
        fileView(file, text))),
    h('div', { class: 'cards' },
      h('section', { class: 'card' }, h('h2', null, 'Export'),
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => download('klipper-config.zip', zip(zipFiles(result, build))) }, 'Download config .zip'),
        h('button', { type: 'button', class: 'btn', onClick: () => download('build.json', new Blob([JSON.stringify(build, null, 2) + '\n'], { type: 'application/json' })) }, 'Save build.json'),
        h('p', { class: 'hint', style: 'margin:0' }, `${names.length} files plus wiring.json and build.json. ${warnings ? `Read WARNINGS.md (${warnings}) before powering on. ` : ''}`,
          'To run Klipper\'s own batch-mode check on this exact build: ', h('code', { class: 'mono' }, 'npm run generate -- build.json out/mine && npm run klipper-check -- out/mine'))),
      renderUpload(result, build, opts.rerender),
      h('section', { class: 'card' }, h('h2', null, 'Microcontrollers'),
        h('ul', { class: 'links' }, result.mcus.map((m) => h('li', null, h('b', null, m.what), ' · ', h('span', { class: 'mono' }, `[${m.name === 'mcu' ? 'mcu' : `mcu ${m.name}`}] ${m.chip.toUpperCase()}`)))),
        h('p', { class: 'hint', style: 'margin:0' }, 'make menuconfig settings for each are in FIRMWARE.md.')),
      result.wiring.jumpers.length ? h('section', { class: 'card' }, h('h2', null, 'Jumpers before power-on'),
        result.wiring.jumpers.map((j) => h('div', { class: 'jumper' }, j))) : null),
    h('section', { class: 'section' }, h('h2', null, 'Wiring'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['#', 'Component', 'Board', 'Connector', 'Pins', 'Note'].map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', null, result.wiring.connections.map((c) => h('tr', null,
          h('td', null, h('span', { class: 'wire-num' }, c.num)), h('td', null, h('b', null, c.component)),
          h('td', null, c.tool !== undefined ? `T${c.tool}` : c.board === 'toolboard' ? 'Toolhead' : 'Main'),
          h('td', { class: 'mono', style: 'color: var(--light-blue)' }, c.connector), h('td', { class: 'mono' }, c.pins), h('td', { class: 'hint' }, c.note ?? ''))))))),
    h('section', { class: 'section' }, h('h2', null, 'Documentation'),
      h('div', { class: 'cards' }, topics.map((t) => h('div', { class: 'card' }, h('h2', null, t),
        h('ul', { class: 'links' }, result.links.filter((l) => l.topic === t).map((l) => h('li', null, extLink(l.url, l.title)))))))),
  ];
}
