// App shell: loads the data, holds the build, and re-renders everything from
// state after each change. The generator runs in the browser on every edit.
import type { Build, Db, Issue, Result } from '../generator/types.ts';
import { assembleDb, type RawData } from '../generator/dbcore.ts';
import { generate } from '../generator/generate.ts';
import { plan as makePlan, type Plan } from '../generator/plan.ts';
import { h, download, resetIds, type Child } from './dom.ts';
import { STEPS, stepOf, type Ctx } from './steps.ts';
import { renderExport, buildTitle, buildSummary, fileView } from './export.ts';
import { defaultBuild, loadSaved, save, normalize, knownIds } from './state.ts';

const EXPORT = STEPS.length;   // index of the export step
const app = document.getElementById('app')!;

let db: Db;
let rev = 'unknown';
let build: Build;
let step = 0;
let result: Result;
let plan: Plan | undefined;
let exportFile = 'printer.cfg';
let previewFile: Record<number, string> = {};
let notice: { tone: 'ok' | 'bad'; text: string } | undefined;

function compute() {
  result = generate(build, db, rev);
  try { plan = makePlan(build, db); } catch { plan = undefined; }
}

function update(fn: (b: Build) => void) {
  const next = structuredClone(build);
  fn(next);
  build = normalize(next, db);
  notice = undefined;
  commit();
}

function goto(i: number) {
  step = Math.max(0, Math.min(EXPORT, i));
  commit();
  window.scrollTo({ top: 0 });
}

function commit() {
  compute();
  save(build, step);
  render();
}

function loadBuild(raw: unknown, source: string) {
  const problem = knownIds(raw, db);
  if (problem) { notice = { tone: 'bad', text: `${source}: ${problem}. Kept the current build.` }; render(); return; }
  try {
    build = normalize(raw as Build, db);
  } catch (e) {
    notice = { tone: 'bad', text: `${source} couldn't be loaded (${(e as Error).message}). Kept the current build.` }; render(); return;
  }
  notice = { tone: 'ok', text: `Loaded ${source}.` };
  commit();
}

function openFile() {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    let raw: unknown;
    try { raw = JSON.parse(await f.text()); } catch { notice = { tone: 'bad', text: `${f.name} is not valid JSON.` }; render(); return; }
    loadBuild(raw, f.name);
  });
  input.click();
}

// --- rendering ----------------------------------------------------------------

function header(): HTMLElement {
  return h('header', { class: 'top' },
    h('div', { class: 'brand' },
      logo(),
      h('div', { class: 'brand-name' }, 'Klipper ', h('span', null, 'Configurator')),
      h('span', { class: 'tag', title: 'Component data revision' }, `data @ ${rev}`)),
    h('nav', { class: 'top-actions', 'aria-label': 'Build' },
      h('button', { type: 'button', class: 'btn', onClick: openFile }, 'Open build'),
      h('button', { type: 'button', class: 'btn', onClick: () => download('build.json', new Blob([JSON.stringify(build, null, 2) + '\n'], { type: 'application/json' })) }, 'Save build'),
      h('button', { type: 'button', class: 'btn', onClick: () => { if (confirm('Start over from the example build? Your current choices will be lost.')) { build = defaultBuild(); goto(0); } } }, 'Reset'),
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => goto(EXPORT) }, 'Generate config')));
}

// The red chevron: logo only.
function logo(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const path = document.createElementNS(ns, 'path');
  for (const [k, v] of Object.entries({ width: '30', height: '22', viewBox: '0 0 30 22', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const [k, v] of Object.entries({ d: 'M2 2 L15 18 L28 2', fill: 'none', stroke: '#C8323A', 'stroke-width': '4' })) path.setAttribute(k, v);
  svg.appendChild(path);
  return svg;
}

function stepBar(): HTMLElement {
  const errSteps = new Set(result.issues.filter((i) => i.level === 'error').map((i) => stepOf(i)?.id));
  const names = [...STEPS.map((s) => ({ id: s.id, name: s.name })), { id: 'export', name: 'Export' }];
  return h('nav', { class: 'steps', 'aria-label': 'Steps' }, h('ol', null, names.map((s, i) =>
    h('li', null, h('button', {
      type: 'button', class: `step-btn${errSteps.has(s.id) ? ' has-error' : ''}`, 'aria-current': i === step ? 'step' : null,
      onClick: () => goto(i),
    }, h('span', { class: 'step-num' }, i + 1), s.name, errSteps.has(s.id) ? h('span', { class: 'sr-only' }, ' (has errors)') : null)))));
}

function issueList(issues: Issue[]): Child {
  if (!issues.length) return null;
  return h('ul', { class: 'issues' }, issues.map((i) => {
    const s = stepOf(i);
    const at = s ? STEPS.indexOf(s) : -1;
    return h('li', { class: `issue ${i.level}`, title: i.code }, i.message,
      at >= 0 && at !== step ? [' ', h('button', { type: 'button', class: 'btn', style: 'min-height:32px;padding:4px 10px;margin-top:6px', onClick: () => goto(at) }, `Go to ${s!.name}`)] : null);
  }));
}

function statusBox(): HTMLElement {
  const errors = result.issues.filter((i) => i.level === 'error');
  const warnings = result.issues.filter((i) => i.level === 'warning');
  return errors.length
    ? h('div', { class: 'status bad', role: 'status' }, h('span', null, h('b', null, `${errors.length} thing${errors.length > 1 ? 's' : ''} to fix first`), h('small', null, 'The config is written once these are sorted out. "Go to" opens the step that needs it.')))
    : h('div', { class: 'status ok', role: 'status' }, h('span', null, h('b', null, 'Config generated'), h('small', null, `${Object.keys(result.files).length} files ready${warnings.length ? ` · ${warnings.length} note${warnings.length === 1 ? '' : 's'} to read below` : ''}`)));
}

function aside(): HTMLElement {
  const errors = result.issues.filter((i) => i.level === 'error');
  const warnings = result.issues.filter((i) => i.level === 'warning');
  const names = Object.keys(result.files).filter((n) => !n.endsWith('.json'));
  const want = previewFile[step] ?? STEPS[step].preview;
  const file = names.includes(want) ? want : 'printer.cfg';
  return h('aside', { class: 'aside', 'aria-label': 'Live preview' },
    statusBox(),
    issueList(errors),
    warnings.length ? h('details', { open: warnings.length <= 3 ? true : null },
      h('summary', { class: 'label', style: 'cursor:pointer;padding:6px 0' }, `Notes to read · ${warnings.length}`), issueList(warnings)) : null,
    result.ok ? h('div', { class: 'section' },
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px' },
        h('h2', null, 'File preview'),
        h('select', { 'aria-label': 'Preview file', style: 'width:auto;min-height:36px;padding:4px 8px;font-family:var(--mono);font-size:14px',
          onChange: (e: Event) => { previewFile[step] = (e.target as HTMLSelectElement).value; render(); } },
        names.map((n) => h('option', { value: n, selected: n === file }, n)))),
      fileView(file, result.files[file])) : null,
    plan && (STEPS[step].id === 'mainboard' || STEPS[step].id === 'motors') ? slotGrid(plan) : null);
}

function slotGrid(p: Plan): HTMLElement {
  const used = new Map(p.steppers.filter((s) => s.board === 'mainboard').map((s) => [s.slot, s]));
  return h('div', { class: 'section' }, h('h2', null, 'Motor sockets on the board'),
    h('div', { class: 'slots' }, p.board.driver_slots.map((slot: any) => {
      const s = used.get(slot.id);
      return h('div', { class: `slot${s ? '' : ' free'}` }, h('span', null, slot.id), h('b', null, s ? s.name.replace('stepper_', '') : 'free'));
    })));
}

function render() {
  resetIds();
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active && active !== document.body
    ? active.id || (active instanceof HTMLInputElement && active.name ? `${active.name}=${active.value}` : '') : '';

  const page: Child[] = [header(), stepBar()];
  if (notice) page.push(h('div', { class: `status ${notice.tone}`, role: 'status', style: 'margin: 16px 28px 0' }, notice.text));
  if (step === EXPORT) {
    page.push(h('div', { class: 'layout' }, h('main', { class: 'main' },
      h('div', null, h('div', { class: 'eyebrow' }, `Step ${EXPORT + 1} / ${EXPORT + 1} · Export`), h('h1', null, buildTitle(build, db)), h('p', { class: 'lead' }, buildSummary(build, db))),
      result.ok ? [statusBox(), renderExport({ db, build, result, file: exportFile, pickFile: (f) => { exportFile = f; render(); }, rerender: render })]
        : [statusBox(), issueList(result.issues.filter((i) => i.level === 'error'))],
      h('div', { class: 'foot-nav' }, h('button', { type: 'button', class: 'btn', onClick: () => goto(EXPORT - 1) }, `← ${STEPS[EXPORT - 1].name}`)))));
  } else {
    const s = STEPS[step];
    const ctx: Ctx = { db, build, result, plan, update };
    page.push(h('div', { class: 'layout' },
      h('main', { class: 'main' },
        h('div', null, h('div', { class: 'eyebrow' }, `Step ${step + 1} / ${EXPORT + 1}`), h('h1', null, s.title), h('p', { class: 'lead' }, s.lead)),
        s.render(ctx),
        h('div', { class: 'foot-nav' },
          step > 0 ? h('button', { type: 'button', class: 'btn', onClick: () => goto(step - 1) }, `← ${STEPS[step - 1].name}`) : h('span'),
          h('button', { type: 'button', class: 'btn btn-steel', onClick: () => goto(step + 1) }, step + 1 === EXPORT ? 'Review & export →' : `${STEPS[step + 1].name} →`))),
      aside()));
  }
  app.replaceChildren(...(page.flat(Infinity as 1) as Node[]).filter(Boolean));

  if (focusKey) {
    const [name, value] = focusKey.split('=');
    const el = value !== undefined
      ? app.querySelector<HTMLElement>(`input[name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`)
      : document.getElementById(focusKey);
    el?.focus({ preventScroll: true });
  }
}

async function boot() {
  try {
    // The built page embeds the data; the dev server's page fetches it.
    const embedded = document.getElementById('kc-db');
    let data: { rev: string; raw: RawData };
    if (embedded) data = JSON.parse(embedded.textContent ?? '');
    else {
      const res = await fetch('db.json');
      if (!res.ok) throw new Error(`db.json: HTTP ${res.status}`);
      data = await res.json();
    }
    db = assembleDb(data.raw);
    rev = data.rev;
  } catch (e) {
    app.replaceChildren(h('p', { class: 'boot' }, `Could not load the component data (${(e as Error).message}). Rebuild with npm run web:build and use dist/web/index.html.`));
    return;
  }
  const saved = loadSaved();
  // A saved build from older data (a renamed part) must never leave the page blank: start fresh instead.
  try {
    build = saved.build && !knownIds(saved.build, db) ? normalize(saved.build, db) : normalize(defaultBuild(), db);
    if (saved.build && knownIds(saved.build, db)) notice = { tone: 'bad', text: `Your last build couldn't be restored (${knownIds(saved.build, db)}), so this is a fresh one. Use Open build if you saved a copy.` };
  } catch (e) {
    build = normalize(defaultBuild(), db);
    notice = { tone: 'bad', text: `Your last build couldn't be restored (${(e as Error).message}), so this is a fresh one. Use Open build if you saved a copy.` };
  }
  step = saved.step !== undefined && saved.step >= 0 && saved.step <= EXPORT ? saved.step : 0;
  commit();
}

boot();
