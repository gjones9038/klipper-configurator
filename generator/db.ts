// Load data/*.yaml into a Db keyed by id. Node-only; the web build will ship
// the same object as JSON (see buildDbJson).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { Db, Rec } from './types.ts';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

function load(path: string): Rec {
  return yaml.load(readFileSync(path, 'utf8')) as Rec;
}

function byId(items: Rec[]): Record<string, Rec> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

function dir(path: string): Record<string, Rec> {
  return byId(readdirSync(path).filter((f) => f.endsWith('.yaml')).map((f) => load(join(path, f))));
}

export function loadDb(dataDir: string = DATA_DIR): Db {
  const drivers = load(join(dataDir, 'drivers.yaml'));
  const extruders = load(join(dataDir, 'extruders.yaml'));
  const hotends = load(join(dataDir, 'hotends.yaml'));
  const motors = load(join(dataDir, 'motors', 'motors.yaml')).motors as Rec[];
  const motorIndex: Record<string, Rec> = {};
  for (const m of motors) {
    motorIndex[m.id] = m;
    for (const a of m.aliases ?? []) motorIndex[a.toLowerCase()] = m;
  }
  return {
    printers: dir(join(dataDir, 'printers')),
    mainboards: dir(join(dataDir, 'mainboards')),
    toolboards: dir(join(dataDir, 'toolboards')),
    motors: motorIndex,
    drivers,
    modules: byId(drivers.modules),
    extruders: byId(extruders.extruders),
    zDrives: byId(extruders.z_drives),
    hotends: byId(hotends.hotends),
    hotendDefaults: hotends.defaults,
    flowClasses: hotends.flow_classes,
    toolheads: byId(load(join(dataDir, 'toolheads.yaml')).toolheads),
    probes: byId(load(join(dataDir, 'probes.yaml')).probes),
    thermistors: byId(load(join(dataDir, 'thermistors.yaml')).user_choices),
    fanRoles: load(join(dataDir, 'fans.yaml')).roles,
    homing: load(join(dataDir, 'homing.yaml')),
  };
}
