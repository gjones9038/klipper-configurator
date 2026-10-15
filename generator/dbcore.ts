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
  toolchangers: Rec;
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
    toolchangers: byId(raw.toolchangers.toolchangers),
  };
}

// The mainboard record for a build: the board plus any extension boards plugged
// into it (e.g. the Leviathan extension), whose driver slots, fans and thermistors
// are appended and tagged with the extension id. Unknown extension ids are skipped
// here; the planner reports them.
export function mainboardFor(db: Db, mb: { id: string; extensions?: string[] }): Rec {
  const board = db.mainboards[mb.id];
  if (!board || !mb.extensions?.length) return board;
  const exts = mb.extensions.map((id) => (board.extensions ?? []).find((e: Rec) => e.id === id)).filter(Boolean) as Rec[];
  if (!exts.length) return board;
  const tag = (e: Rec, list?: Rec[]) => (list ?? []).map((x) => ({ ...x, extension: e.id }));
  return {
    ...board,
    driver_slots: [...board.driver_slots, ...exts.flatMap((e) => tag(e, e.driver_slots))],
    fans: [...(board.fans ?? []), ...exts.flatMap((e) => tag(e, e.fans))],
    thermistors: [...(board.thermistors ?? []), ...exts.flatMap((e) => tag(e, e.thermistors))],
    activeExtensions: exts,
  };
}
