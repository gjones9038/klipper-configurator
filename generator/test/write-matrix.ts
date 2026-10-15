// Write every generatable matrix case to <out>/<case>/ for tools/klipper_check.py.
// Usage: node generator/test/write-matrix.ts <out-dir>
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generate, loadDb } from '../index.ts';
import { matrix } from './matrix.ts';

const out = process.argv[2] ?? 'out/matrix';
rmSync(out, { recursive: true, force: true });
const db = loadDb();
let written = 0;
const skipped: string[] = [];
for (const c of matrix(db)) {
  const r = generate(c.build, db);
  if (!r.ok) { skipped.push(`${c.name}: ${r.issues.find((i) => i.level === 'error')!.code}`); continue; }
  for (const [name, text] of Object.entries(r.files)) {
    const p = join(out, c.name, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  writeFileSync(join(out, c.name, 'build.json'), JSON.stringify(c.build, null, 2));
  written++;
}
console.log(`wrote ${written} cases to ${out}; ${skipped.length} not generatable:`);
for (const s of skipped) console.log('  ' + s);
