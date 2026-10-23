// Export step: upload the generated config to the printer through Moonraker.
// Flow: check (status + plan) -> review -> upload (backup zip first) -> optional
// firmware restart. Async state lives here; the page re-renders via rerender().
import type { Build, Result } from '../generator/types.ts';
import { h, checkbox, type Child } from './dom.ts';
import * as mr from './moonraker.ts';

const URL_KEY = 'klipper-configurator.moonraker.v1';

type Phase = 'idle' | 'checking' | 'ready' | 'uploading' | 'done' | 'error';
const st: {
  url: string; apiKey: string; keep: boolean; phase: Phase; error?: string;
  status?: mr.PrinterStatus; plan?: mr.UploadPlan; planKey?: string;
  progress?: { done: number; total: number; path: string };
  result?: { backup?: string; written: string[] };
  restart?: 'sending' | 'sent' | string;
} = { url: loadUrl(), apiKey: '', keep: true, phase: 'idle' };

function loadUrl(): string {
  try { return localStorage.getItem(URL_KEY) ?? ''; } catch { return ''; }
}
function saveUrl(u: string) {
  try { localStorage.setItem(URL_KEY, u); } catch { /* storage blocked: just not remembered */ }
}

/** Cheap fingerprint of the generated files, to notice the build changed after a check. */
function keyOf(files: Record<string, string>): string {
  let hsh = 0;
  for (const [k, v] of Object.entries(files)) for (const s of [k, v]) for (let i = 0; i < s.length; i++) hsh = (hsh * 31 + s.charCodeAt(i)) | 0;
  return String(hsh);
}

const BUSY = new Set(['printing', 'paused']);

export function renderUpload(result: Result, build: Build, rerender: () => void): Child {
  const target = (): mr.Target => ({ url: mr.normalizeUrl(st.url), apiKey: st.apiKey.trim() || undefined });
  const extra = { 'wiring.json': JSON.stringify(result.wiring, null, 2) + '\n', 'build.json': JSON.stringify(build, null, 2) + '\n' };
  const key = keyOf(result.files) + (st.keep ? 'k' : '');
  // After a failed upload too: the plan was made for the build as it was at check time.
  const stale = st.plan && st.planKey !== key && (st.phase === 'ready' || st.phase === 'error');

  const check = async () => {
    if (!st.url.trim()) { st.phase = 'error'; st.error = 'Enter the printer address first.'; rerender(); return; }
    saveUrl(st.url.trim());
    Object.assign(st, { phase: 'checking', error: undefined, plan: undefined, result: undefined, restart: undefined });
    rerender();
    try {
      st.status = await mr.status(target());
      st.plan = await mr.plan(target(), result.files, extra, st.status, st.keep);
      st.planKey = key;
      st.phase = 'ready';
    } catch (e) {
      st.phase = 'error';
      st.error = (e as Error).message;
    }
    rerender();
  };

  const upload = async () => {
    if (!st.plan) return;
    st.phase = 'uploading';
    rerender();
    try {
      st.result = await mr.upload(target(), st.plan, (done, total, path) => { st.progress = { done, total, path }; rerender(); });
      st.phase = 'done';
    } catch (e) {
      st.phase = 'error';
      st.error = (e as Error).message;
    }
    rerender();
  };

  const restart = async () => {
    st.restart = 'sending';
    rerender();
    try { await mr.firmwareRestart(target()); st.restart = 'sent'; } catch (e) { st.restart = (e as Error).message; }
    rerender();
  };

  const busy = st.phase === 'checking' || st.phase === 'uploading';
  const printing = !!st.status?.printState && BUSY.has(st.status.printState);
  const origin = location.origin;

  return h('section', { class: 'card upload' },
    h('h2', null, 'Upload to printer (Moonraker)'),
    h('div', { class: 'grid', style: 'grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))' },
      h('div', { class: 'field' },
        h('label', { class: 'label', for: 'mr-url' }, 'Printer address'),
        h('input', { id: 'mr-url', type: 'text', placeholder: 'voron.local or http://192.168.1.50:7125', value: st.url, autocomplete: 'url', spellcheck: 'false',
          disabled: busy, onChange: (e: Event) => { st.url = (e.target as HTMLInputElement).value; st.phase = 'idle'; st.plan = undefined; rerender(); } })),
      h('div', { class: 'field' },
        h('label', { class: 'label', for: 'mr-key' }, 'API key (optional)'),
        h('input', { id: 'mr-key', type: 'password', autocomplete: 'off', value: st.apiKey, disabled: busy, placeholder: 'only if Moonraker asks',
          onChange: (e: Event) => { st.apiKey = (e.target as HTMLInputElement).value; } }))),
    checkbox('Keep saved values from the current printer.cfg', st.keep, (v) => { st.keep = v; st.phase = st.plan ? 'idle' : st.phase; st.plan = undefined; rerender(); },
      'Keeps the values Klipper saved after calibration (heater tuning, probe offset, bed mesh, input shaper, dock positions). Values for parts the new config no longer has are left out, because Klipper would refuse to start with them.', busy),
    h('p', { class: 'hint', style: 'margin:0' },
      'Your browser sends the files straight to Moonraker (the service behind Mainsail and Fluidd), so Moonraker has to allow this page first: in moonraker.conf, under ', h('code', { class: 'mono' }, '[authorization]'),
      ', add ', h('code', { class: 'mono' }, origin), ' to ', h('code', { class: 'mono' }, 'cors_domains'), ', then restart Moonraker.'),
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
      h('button', { type: 'button', class: 'btn btn-steel', disabled: busy, onClick: check }, st.phase === 'checking' ? 'Checking…' : st.plan ? 'Check again' : 'Check printer'),
      st.plan && st.phase !== 'done' ? h('button', { type: 'button', class: 'btn btn-primary', disabled: busy || printing || !!stale, onClick: upload },
        st.phase === 'uploading' ? `Uploading ${st.progress?.done ?? 0} / ${st.progress?.total ?? '…'}` : `Upload ${Object.keys(st.plan.files).length} files`) : null),
    st.phase === 'error' && st.error ? h('div', { class: 'issue error', role: 'alert' }, st.error) : null,
    stale ? h('div', { class: 'issue warning' }, 'The build changed after the check. Check again before uploading.') : null,
    st.status && st.plan && st.phase !== 'error' ? review(st.status, st.plan, printing) : null,
    st.phase === 'done' && st.result ? done(st.result, printing, restart) : null,
  );
}

function review(s: mr.PrinterStatus, p: mr.UploadPlan, printing: boolean): Child {
  const created = Object.keys(p.files).filter((f) => !p.overwrite.includes(f));
  return h('div', { class: 'section', style: 'gap:8px' },
    h('div', { class: 'hint' }, `Klipper: ${s.klippyState}${s.printState ? ` · print: ${s.printState}` : ''} · ${s.configFiles.length} files in the config folder`),
    printing ? h('div', { class: 'issue error' }, 'The printer is printing. Upload after the print ends.') : null,
    p.overwrite.length
      ? h('details', null, h('summary', null, p.overwrite.length > 1 ? `Replaces ${p.overwrite.length} files; they are zipped into the config folder first` : 'Replaces 1 file; it is zipped into the config folder first'),
        h('ul', { class: 'links mono' }, p.overwrite.map((f) => h('li', null, f))))
      : h('div', { class: 'hint' }, 'No existing files are replaced.'),
    created.length ? h('details', null, h('summary', null, `Adds ${created.length} new file${created.length > 1 ? 's' : ''}`), h('ul', { class: 'links mono' }, created.map((f) => h('li', null, f)))) : null,
    p.carry.kept.length ? h('div', { class: 'hint' }, `Saved values kept: ${p.carry.kept.map((k) => `[${k}]`).join(' ')}`) : null,
    p.carry.dropped.length ? h('div', { class: 'issue warning' }, 'Saved values dropped: ',
      p.carry.dropped.map((d) => `[${d.section}]${d.option ? ` ${d.option}` : ''} (${d.why})`).join('; '), '. They stay in the backup zip.') : null,
    p.missingIncludes.length ? h('div', { class: 'issue warning' }, `printer.cfg includes ${p.missingIncludes.join(', ')}, which is not on the printer. Install it (e.g. the Mainsail / Fluidd client config) or Klipper will not start.`) : null,
  );
}

function done(r: { backup?: string; written: string[] }, printing: boolean, restart: () => void): Child {
  return h('div', { class: 'section', style: 'gap:8px' },
    h('div', { class: 'status ok', role: 'status' }, h('span', null, h('b', null, `Uploaded ${r.written.length} files`),
      h('small', null, r.backup ? `Previous files: config/${r.backup}` : 'Nothing was replaced, so no backup was needed.'))),
    h('p', { class: 'hint', style: 'margin:0' }, 'Klipper reads the new config on restart. If it does not start, the error names the line; the backup zip has the old files.'),
    h('button', { type: 'button', class: 'btn btn-steel', disabled: printing || st.restart === 'sending' || st.restart === 'sent', onClick: restart },
      st.restart === 'sent' ? 'Restart requested' : st.restart === 'sending' ? 'Restarting…' : 'Firmware restart'),
    st.restart && !['sending', 'sent'].includes(st.restart) ? h('div', { class: 'issue error' }, st.restart) : null,
  );
}
