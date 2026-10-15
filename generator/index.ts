// Public entry point: Build + Db -> files, issues and wiring.
import { execFileSync } from 'node:child_process';
import type { Build, Db, Result } from './types.ts';
import { plan, PlanError } from './plan.ts';
import { emit } from './emit.ts';
import { wiring, wiringMarkdown, firmwareMarkdown } from './wiring.ts';

export { loadDb } from './db.ts';
export type { Build, Db, Result } from './types.ts';

export function generate(build: Build, db: Db, dataRev = dataRevision()): Result {
  let p;
  try {
    p = plan(build, db);
  } catch (e) {
    if (e instanceof PlanError) {
      return { ok: false, files: {}, issues: [{ level: 'error', code: e.code, message: e.message }], wiring: { connections: [], jumpers: [] } };
    }
    throw e;
  }
  const errors = p.issues.filter((i) => i.level === 'error');
  const w = wiring(p);
  if (errors.length) return { ok: false, files: {}, issues: p.issues, wiring: w };

  const files = emit(p, db, dataRev);
  files['WIRING.md'] = wiringMarkdown(p, w);
  files['FIRMWARE.md'] = firmwareMarkdown(p);
  const warnings = p.issues.filter((i) => i.level === 'warning');
  if (warnings.length) {
    files['WARNINGS.md'] = ['# Check these before powering on', '', ...warnings.map((i) => `- **${i.code}**: ${i.message}`), ''].join('\n');
  }
  return { ok: true, files, issues: p.issues, wiring: w };
}

let rev: string | undefined;
function dataRevision(): string {
  if (rev) return rev;
  try {
    rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim();
  } catch {
    rev = 'unknown';
  }
  return rev;
}
