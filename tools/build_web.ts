#!/usr/bin/env node
// Build the static web app into dist/web: bundle web/main.ts, copy the page
// and stylesheet, and write db.json (the raw data files + data revision).
//   node tools/build_web.ts            one-off build
//   node tools/build_web.ts --serve    rebuild on change, serve on :8080
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { loadRaw, dataRevision } from '../generator/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'web');
const serve = process.argv.includes('--serve');

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'db.json'), JSON.stringify({ rev: dataRevision(), raw: loadRaw() }));
for (const f of ['index.html', 'style.css']) copyFileSync(join(root, 'web', f), join(out, f));

const options: esbuild.BuildOptions = {
  entryPoints: [join(root, 'web', 'main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: join(out, 'app.js'),
  sourcemap: true,
  minify: !serve,
  logLevel: 'info',
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: out, host: '127.0.0.1', port: 8080 });
  console.log(`serving dist/web on http://localhost:${port} (data and index.html are copied once; rerun after editing them)`);
} else {
  await esbuild.build(options);
}
