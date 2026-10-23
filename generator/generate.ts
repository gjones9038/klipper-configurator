// Build + Db -> files, issues and wiring. No Node APIs, so the web app runs
// this same code in the browser.
import type { Build, Db, Result } from './types.ts';
import { plan, PlanError } from './plan.ts';
import { emit } from './emit.ts';
import { wiring, wiringMarkdown, firmwareMarkdown, linksMarkdown, slicerMarkdown, linkSection } from './wiring.ts';

export function generate(build: Build, db: Db, dataRev: string): Result {
  let p;
  try {
    p = plan(build, db);
  } catch (e) {
    if (e instanceof PlanError) {
      return { ok: false, files: {}, issues: [{ level: 'error', code: e.code, message: e.message }], wiring: { connections: [], jumpers: [] }, links: [], mcus: [] };
    }
    throw e;
  }
  const errors = p.issues.filter((i) => i.level === 'error');
  const w = wiring(p);
  if (errors.length) return { ok: false, files: {}, issues: p.issues, wiring: w, links: p.links, mcus: p.mcus };

  const files = emit(p, db, dataRev);
  files['WIRING.md'] = wiringMarkdown(p, w);
  files['FIRMWARE.md'] = firmwareMarkdown(p);
  files['SLICER.md'] = slicerMarkdown(p);
  files['LINKS.md'] = linksMarkdown(p);
  files['mcus.json'] = JSON.stringify(p.mcus, null, 2) + '\n';
  const warnings = p.issues.filter((i) => i.level === 'warning');
  // The plain-language notes the web app shows for each part (AWD: check motor pairs with the belts
  // loose; Leviathan: the HV input powers the X/Y sockets), so a CLI user reads them too.
  const notes: Array<[string, string[] | undefined]> = [
    [p.printer.name, p.printer.notes], [`${p.printer.name}: ${p.variant?.name ?? ''}`, p.variant?.notes],
    [p.board.name, p.board.notes], ...(p.board.activeExtensions ?? []).map((e: any): [string, string[]] => [e.name, e.notes]),
    ...(p.tools ? p.tools.map((t): [string, string[]] => [`T${t.n}: ${t.toolboard.name}`, t.toolboard.notes]) : p.toolboard ? [[p.toolboard.name, p.toolboard.notes] as [string, string[]]] : []),
    ...(p.probe?.notes ? [[p.probe.name, p.probe.notes] as [string, string[]]] : []),
  ];
  const noteLines = [...new Map(notes.filter(([, n]) => n?.length).map(([who, n]) => [who, n!])).entries()]
    .flatMap(([who, n]) => [`### ${who}`, '', ...n.map((x) => `- ${x}`), '']);
  if (warnings.length || noteLines.length) {
    files['WARNINGS.md'] = ['# Check these before powering on', '', ...warnings.map((i) => `- ${i.message}`), '',
      ...(noteLines.length ? ['## Notes for your hardware', '', ...noteLines] : []), ...linkSection(p)].join('\n');
  }
  return { ok: true, files, issues: p.issues, wiring: w, links: p.links, mcus: p.mcus };
}
