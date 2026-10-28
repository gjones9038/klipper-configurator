#!/usr/bin/env node
// Build the web app.
//   node tools/build_web.ts           dist/web/index.html: one self-contained page (script,
//                                     styles, fonts and data inlined) that works uploaded to any
//                                     static host or opened straight from disk
//   node tools/build_web.ts --serve   dev build in dist/dev (separate app.js + db.json),
//                                     rebuilt on change and served on :8080
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { loadRaw, dataRevision } from '../generator/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serve = process.argv.includes('--serve');

const options: esbuild.BuildOptions = {
  entryPoints: [join(root, 'web', 'main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: !serve,
  logLevel: 'info',
};

if (!serve) await buildPortable();
else {
  const out = join(root, 'dist', 'dev');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'db.json'), JSON.stringify({ rev: dataRevision(), raw: loadRaw() }));
  for (const f of ['index.html', 'style.css']) copyFileSync(join(root, 'web', f), join(out, f));
  options.outfile = join(out, 'app.js');
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: out, host: '127.0.0.1', port: 8080 });
  console.log(`serving dist/dev on http://localhost:${port} (data and index.html are copied once; rerun after editing them)`);
}

// One file, so a partial upload, a host with odd MIME types or a file:// open
// cannot leave the page without its script: browsers refuse module scripts and
// fetch() on file:// pages, so it is a classic inline script plus a JSON data tag.
async function buildPortable() {
  const out = join(root, 'dist', 'web');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const js = await esbuild.build({ ...options, format: 'iife', sourcemap: false, write: false });
  const script = js.outputFiles[0].text;
  // JSON is valid JS, so "<" keeps "</script>" out of the tag without changing the data.
  const db = JSON.stringify({ rev: dataRevision(), raw: loadRaw() }).replace(/</g, '\\u003c');
  const css = fonts() + readFileSync(join(root, 'web', 'style.css'), 'utf8');
  for (const [what, text, tag] of [['script', script, '</script'], ['style', css, '</style']]) {
    if (text.toLowerCase().includes(tag)) throw new Error(`portable build: the inlined ${what} contains ${tag}`);
  }

  let html = readFileSync(join(root, 'web', 'index.html'), 'utf8')
    .replace(/^<link rel="preconnect".*\n/gm, '')
    .replace(/^<link href="https:\/\/fonts\.googleapis\.com.*\n/m, '')
    .replace(/^<script type="module" src="app\.js"><\/script>\n/m, '');
  const head = html;
  html = html
    .replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${css}</style>`)
    .replace('</body>', () => `<script type="application/json" id="kc-db">${db}</script>\n<script>${script}</script>\n</body>`);
  if (html === head || /href="style\.css"|fonts\.googleapis|app\.js/.test(html)) throw new Error('portable build: web/index.html changed shape; update buildPortable()');

  writeFileSync(join(out, 'index.html'), html);
  writeFileSync(join(out, 'README.txt'), readme());
  copyFileSync(join(root, 'node_modules', '@fontsource', 'ibm-plex-sans', 'LICENSE'), join(out, 'FONT-LICENSE.txt'));
  console.log(`wrote dist/web/index.html (${(html.length / 1e6).toFixed(1)} MB), README.txt, FONT-LICENSE.txt`);
}

/** The IBM Plex weights the page uses, as inline @font-face rules (latin subset, like Google Fonts serves). */
function fonts(): string {
  const faces: [string, string, number[]][] = [['IBM Plex Sans', 'ibm-plex-sans', [400, 500, 600, 700]], ['IBM Plex Mono', 'ibm-plex-mono', [400, 500, 600]]];
  let css = '';
  for (const [family, pkg, weights] of faces) {
    for (const w of weights) {
      const file = join(root, 'node_modules', '@fontsource', pkg, 'files', `${pkg}-latin-${w}-normal.woff2`);
      const data = readFileSync(file).toString('base64');
      css += `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${w}; font-display: swap; src: url(data:font/woff2;base64,${data}) format('woff2'); }\n`;
    }
  }
  return css;
}

function readme(): string {
  return `Klipper Configurator
Data revision: ${dataRevision()}

Open index.html in a web browser (double-click it), or upload index.html to
any web host. It needs no internet connection and no install; nothing you
enter leaves your computer.

- Your build is remembered by the browser. Use "Save build" to keep a copy as
  build.json, and "Open build" to load it again (for example on another computer).
- "Download config .zip" gives you the config files. Upload them to the printer
  in Mainsail or Fluidd (the Machine / Configuration page).
- Sending files straight to the printer works when the page is on a web
  address that Moonraker allows (cors_domains). Opened from disk, Moonraker
  blocks it, so use the zip instead.
- Links to documentation open on the internet, so they need a connection.

Fonts: IBM Plex, under the SIL Open Font License (FONT-LICENSE.txt).
`;
}
