// Turn the raw data files into a Db. No Node APIs: the CLI feeds it from
// data/*.yaml (db.ts), the web app from db.json (tools/build_web.ts).
import type { Db, Rec } from './types.ts';

// One entry per data file, parsed but untouched. Directories become lists.
export interface RawData {
  printers: Rec[];
  mainboards: Rec[];
  toolboards: Rec[];
  drivers: Rec;
  extruders: Rec;
  hotends: Rec;
  filters: Rec;
  motors: Rec;
  toolheads: Rec;
  probes: Rec;
  thermistors: Rec;
  fans: Rec;
  homing: Rec;
}

function byId(items: Rec[]): Record<string, Rec> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

export function assembleDb(raw: RawData): Db {
  const motorIndex: Record<string, Rec> = {};
  for (const m of raw.motors.motors as Rec[]) {
    motorIndex[m.id] = m;
    for (const a of m.aliases ?? []) motorIndex[a.toLowerCase()] = m;
  }
  return {
    printers: byId(raw.printers),
    mainboards: byId(raw.mainboards),
    toolboards: byId(raw.toolboards),
    motors: motorIndex,
    drivers: raw.drivers,
    modules: byId(raw.drivers.modules),
    extruders: byId(raw.extruders.extruders),
    zDrives: byId(raw.extruders.z_drives),
    hotends: byId(raw.hotends.hotends),
    hotendDefaults: raw.hotends.defaults,
    flowClasses: raw.hotends.flow_classes,
    toolheads: byId(raw.toolheads.toolheads),
    probes: byId(raw.probes.probes),
    thermistors: byId(raw.thermistors.user_choices),
    fanRoles: raw.fans.roles,
    homing: raw.homing,
    filters: byId(raw.filters.filters),
    filterDefaults: raw.filters.defaults,
  };
}
