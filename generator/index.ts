// Public entry point for Node: generate() with the data revision taken from git.
import { execFileSync } from 'node:child_process';
import type { Build, Db, Result } from './types.ts';
import { generate as generateCore } from './generate.ts';

export { loadDb, loadRaw } from './db.ts';
export type { Build, Db, Result } from './types.ts';

export function generate(build: Build, db: Db, dataRev = dataRevision()): Result {
  return generateCore(build, db, dataRev);
}

let rev: string | undefined;
export function dataRevision(): string {
  if (rev) return rev;
  try {
    rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim();
  } catch {
    rev = 'unknown';
  }
  return rev;
}
