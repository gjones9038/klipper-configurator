// Load data/*.yaml into a Db keyed by id. Node-only; the web build ships the
// same RawData as JSON and calls assembleDb in the browser.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { Db, Rec } from './types.ts';
import { assembleDb, type RawData } from './dbcore.ts';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

function load(path: string): Rec {
  return yaml.load(readFileSync(path, 'utf8')) as Rec;
}

function dir(path: string): Rec[] {
  return readdirSync(path).filter((f) => f.endsWith('.yaml')).sort().map((f) => load(join(path, f)));
}

export function loadRaw(dataDir: string = DATA_DIR): RawData {
  return {
    printers: dir(join(dataDir, 'printers')),
    mainboards: dir(join(dataDir, 'mainboards')),
    toolboards: dir(join(dataDir, 'toolboards')),
    drivers: load(join(dataDir, 'drivers.yaml')),
    extruders: load(join(dataDir, 'extruders.yaml')),
    hotends: load(join(dataDir, 'hotends.yaml')),
    filters: load(join(dataDir, 'filters.yaml')),
    motors: load(join(dataDir, 'motors', 'motors.yaml')),
    toolheads: load(join(dataDir, 'toolheads.yaml')),
    probes: load(join(dataDir, 'probes.yaml')),
    thermistors: load(join(dataDir, 'thermistors.yaml')),
    fans: load(join(dataDir, 'fans.yaml')),
    homing: load(join(dataDir, 'homing.yaml')),
  };
}

export function loadDb(dataDir: string = DATA_DIR): Db {
  return assembleDb(loadRaw(dataDir));
}
