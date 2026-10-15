// Moonraker HTTP client for uploading a generated config. Endpoints and
// behaviour from Moonraker docs/external_api (file_manager.md, printer.md,
// server.md, authorization.md). Uses only fetch / FormData, so it also runs
// under Node for tests against a real Moonraker.
import { carryOverSaveConfig, type CarryOver } from '../generator/saveconfig.ts';

export interface Target { url: string; apiKey?: string }

export class MoonrakerError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

/** Accept "voron.local" or "http://voron.local:7125/"; Moonraker is also reachable through the web UI's address (nginx proxies its API). */
export function normalizeUrl(input: string): string {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

async function call<T>(t: Target, method: 'GET' | 'POST', path: string, body?: BodyInit, json = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (t.apiKey) headers['X-Api-Key'] = t.apiKey;
  if (json) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(t.url + path, { method, headers, body });
  } catch {
    throw new MoonrakerError(unreachable(t.url));
  }
  let data: any;
  try { data = await res.json(); } catch { data = undefined; }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new MoonrakerError('Moonraker refused the request (not authorized). Enter the API key (Mainsail/Fluidd settings, or GET /access/api_key on the printer), or add this computer to [authorization] trusted_clients in moonraker.conf.', res.status);
    }
    throw new MoonrakerError(data?.error?.message ?? `HTTP ${res.status} from ${path}`, res.status);
  }
  return (data && typeof data === 'object' && 'result' in data ? data.result : data) as T;
}

function unreachable(url: string): string {
  const here = typeof location !== 'undefined' ? location.origin : '';
  const mixed = typeof location !== 'undefined' && location.protocol === 'https:' && url.startsWith('http:');
  return mixed
    ? `This page is served over HTTPS, so the browser blocks requests to ${url} (plain HTTP). Open the configurator over HTTP (e.g. npm run web:dev) or serve Moonraker over HTTPS.`
    : `Could not reach Moonraker at ${url}. Check the address and port (7125, or the web UI's address). If it is right, the browser is blocking it: add ${here || 'this page\'s origin'} to cors_domains under [authorization] in moonraker.conf and restart Moonraker.`;
}

export interface PrinterStatus {
  klippyState: string;          // ready / startup / shutdown / error / disconnected
  printState?: string;          // print_stats.state: standby / printing / paused / complete / cancelled / error
  configFiles: string[];        // paths relative to the config root
}

export async function status(t: Target): Promise<PrinterStatus> {
  const info = await call<any>(t, 'GET', '/server/info');
  if (!info?.registered_directories?.includes('config')) throw new MoonrakerError('Moonraker has no "config" root registered.');
  const files = await call<Array<{ path: string }>>(t, 'GET', '/server/files/list?root=config');
  let printState: string | undefined;
  if (info.klippy_state === 'ready') {
    const q = await call<any>(t, 'GET', '/printer/objects/query?print_stats=state');
    printState = q?.status?.print_stats?.state;
  }
  return { klippyState: info.klippy_state ?? (info.klippy_connected ? 'unknown' : 'disconnected'), printState, configFiles: files.map((f) => f.path) };
}

export const DOCS_DIR = 'klipper-configurator';

/** What goes where: .cfg files at their generated paths, guides and JSON under klipper-configurator/. */
export function uploadSet(files: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(files)) out[name.endsWith('.cfg') ? name : `${DOCS_DIR}/${name}`] = text;
  for (const [name, text] of Object.entries(extra)) out[`${DOCS_DIR}/${name}`] = text;
  return out;
}

export interface UploadPlan {
  files: Record<string, string>;      // config-relative path -> content (printer.cfg already merged)
  overwrite: string[];                // existing files that will be replaced (and backed up)
  carry: CarryOver;
  missingIncludes: string[];          // [include x] targets neither generated nor on the printer
}

export async function plan(t: Target, generated: Record<string, string>, extra: Record<string, string>, st: PrinterStatus, keepSaveConfig: boolean): Promise<UploadPlan> {
  const set = uploadSet(generated, extra);
  const oldPrinter = keepSaveConfig && st.configFiles.includes('printer.cfg') ? await download(t, 'printer.cfg') : undefined;
  const carry = carryOverSaveConfig(generated, oldPrinter);
  set['printer.cfg'] = carry.printerCfg;
  const includes = [...generated['printer.cfg'].matchAll(/^\[include ([^\]]+)\]/gm)].map((m) => m[1].trim());
  const missingIncludes = includes.filter((f) => !(f in set) && !st.configFiles.includes(f));
  return { files: set, overwrite: Object.keys(set).filter((p) => st.configFiles.includes(p)).sort(), carry, missingIncludes };
}

export async function download(t: Target, path: string): Promise<string> {
  const headers: Record<string, string> = t.apiKey ? { 'X-Api-Key': t.apiKey } : {};
  let res: Response;
  try { res = await fetch(`${t.url}/server/files/config/${path.split('/').map(encodeURIComponent).join('/')}`, { headers }); } catch { throw new MoonrakerError(unreachable(t.url)); }
  if (!res.ok) throw new MoonrakerError(`Could not read ${path} (HTTP ${res.status}).`, res.status);
  return res.text();
}

export function backupName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `klipper-configurator-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.zip`;
}

/** Zip every file that will be overwritten into config/<backup>.zip. Returns its config-relative path, or undefined when nothing is overwritten. */
export async function backup(t: Target, paths: string[], name = backupName()): Promise<string | undefined> {
  if (!paths.length) return undefined;
  const r = await call<any>(t, 'POST', '/server/files/zip',
    JSON.stringify({ dest: `config/${name}`, items: paths.map((p) => `config/${p}`), store_only: false }), true);
  return r?.destination?.path ?? name;
}

async function sha256(text: string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;   // only in secure contexts (https, localhost)
  if (!subtle) return undefined;
  const d = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function uploadFile(t: Target, path: string, text: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  const form = new FormData();
  form.append('root', 'config');
  if (slash > 0) form.append('path', path.slice(0, slash));   // created if missing (file_manager.md)
  const sum = await sha256(text);
  if (sum) form.append('checksum', sum);
  form.append('file', new Blob([text], { type: 'text/plain' }), path.slice(slash + 1));
  await call(t, 'POST', '/server/files/upload', form);
}

export async function firmwareRestart(t: Target): Promise<void> {
  await call(t, 'POST', '/printer/firmware_restart');
}

/** Backup, then upload every file. Stops at the first failure; reports what was written. */
export async function upload(t: Target, p: UploadPlan, onProgress: (done: number, total: number, path: string) => void = () => {}):
  Promise<{ backup?: string; written: string[] }> {
  const backupPath = await backup(t, p.overwrite);
  const written: string[] = [];
  const entries = Object.entries(p.files);
  for (const [path, text] of entries) {
    onProgress(written.length, entries.length, path);
    try {
      await uploadFile(t, path, text);
    } catch (e) {
      const msg = (e as Error).message;
      throw new MoonrakerError(`Upload stopped at ${path}: ${msg}. ${written.length} of ${entries.length} files were written${backupPath ? `; the previous files are in ${backupPath}` : ''}.`);
    }
    written.push(path);
  }
  onProgress(written.length, entries.length, '');
  return { backup: backupPath, written };
}
