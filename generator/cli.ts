#!/usr/bin/env node
// Usage: node generator/cli.ts <build.json> [out-dir]
// Writes the config files into out-dir (default ./out) and prints issues.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generate, loadDb } from './index.ts';

const [buildPath, outDir = 'out'] = process.argv.slice(2);
if (!buildPath) {
  console.error('usage: node generator/cli.ts <build.json> [out-dir]');
  process.exit(2);
}
const result = generate(JSON.parse(readFileSync(buildPath, 'utf8')), loadDb());
for (const i of result.issues) console.log(`${i.level.toUpperCase().padEnd(7)} ${i.code}: ${i.message}`);
if (!result.ok) process.exit(1);
for (const [name, text] of Object.entries(result.files)) {
  const path = join(outDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
writeFileSync(join(outDir, 'wiring.json'), JSON.stringify(result.wiring, null, 2) + '\n');
console.log(`wrote ${Object.keys(result.files).length + 1} files to ${outDir}/`);
