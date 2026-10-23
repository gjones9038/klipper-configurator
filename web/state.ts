// Build state: defaults, persistence and normalize(), which keeps a build
// consistent after each edit (e.g. switching to an EZ board swaps stepstick
// modules for EZ ones). normalize() only fixes choices that are no longer
// possible; anything the user must decide is left for plan() to report.
import type { Build, Db, Rec } from '../generator/types.ts';
import { mainboardFor } from '../generator/dbcore.ts';
import example from '../examples/v24-350-leviathan-sb2209.json' with { type: 'json' };

const KEY = 'klipper-configurator.build.v1';
const STEP_KEY = 'klipper-configurator.step.v1';

export function defaultBuild(): Build {
  return structuredClone(example) as Build;
}

/**
 * Switch printer. A printer that ships with a fixed board (stock.mainboards) starts
 * from its stock parts; leaving one for a kit printer starts from the example build.
 */
export function switchPrinter(b: Build, db: Db, id: string): Build {
  const next = db.printers[id];
  const prev = db.printers[b.printer];
  const st = next.stock;
  if (st?.mainboards?.length) {
    const board = db.mainboards[st.mainboards[0]];
    return {
      printer: id, size: next.sizes[0].id, variant: 'standard',
      mainboard: { id: board.id, connection: board.interfaces[0] },
      ...(st.toolboard ? { toolboard: { id: st.toolboard, connection: db.toolboards[st.toolboard].interfaces[0] } } : {}),
      drivers: b.drivers, motors: { xy: '', z: '' },
      homing: { xy: st.homing_xy ?? 'physical', z: st.homing_z ?? 'physical_min' },
      ...(st.probe ? { probe: st.probe, ...(st.probe_offsets?.[st.probe] ? { probeOffset: { ...st.probe_offsets[st.probe] } } : {}) } : {}),
      extruder: st.extruder, hotend: st.hotend,
      thermistors: { hotend: st.thermistors.hotend, bed: st.thermistors.bed },
      fans: (st.fans ?? ['part_cooling']).map((role: string) => ({ role })),
      autotune: false, webUi: b.webUi,
    };
  }
  if (prev?.stock?.mainboards?.length) return { ...defaultBuild(), printer: id, webUi: b.webUi };
  return { ...b, printer: id };
}

export function loadSaved(): { build?: Build; step?: number } {
  try {
    const b = localStorage.getItem(KEY);
    const s = localStorage.getItem(STEP_KEY);
    return { build: b ? JSON.parse(b) : undefined, step: s ? Number(s) : undefined };
  } catch {
    return {};
  }
}

export function save(build: Build, step: number) {
  try {
    localStorage.setItem(KEY, JSON.stringify(build));
    localStorage.setItem(STEP_KEY, String(step));
  } catch { /* private mode or storage blocked: the build just isn't remembered */ }
}

/** Check that a loaded build names records that exist, so the wizard can show it. */
export function knownIds(b: any, db: Db): string | null {
  if (!b || typeof b !== 'object') return 'not a build object';
  if (!db.printers[b.printer]) return `unknown printer "${b.printer}"`;
  if (!db.mainboards[b.mainboard?.id]) return `unknown mainboard "${b.mainboard?.id}"`;
  if (b.toolboard && !db.toolboards[b.toolboard.id]) return `unknown toolhead board "${b.toolboard.id}"`;
  if (!db.extruders[b.extruder]) return `unknown extruder "${b.extruder}"`;
  if (!db.hotends[b.hotend]) return `unknown hotend "${b.hotend}"`;
  if (!b.drivers?.xy || !b.motors || !b.homing || !b.thermistors || !Array.isArray(b.fans)) return 'missing required fields';
  return null;
}

const ifaces = (rec: Rec): string[] => (Array.isArray(rec.interface) ? rec.interface : [rec.interface]);

export function canDevices(b: Build, db: Db): string[] {
  const out: string[] = [];
  if (b.toolboard && (b.toolboard.connection ?? 'can') === 'can') out.push(b.toolchanger ? `T0 ${db.toolboards[b.toolboard.id].name}` : db.toolboards[b.toolboard.id].name);
  b.toolchanger?.tools.forEach((t, i) => {
    if ((t.toolboard.connection ?? 'can') === 'can') out.push(`T${i + 1} ${db.toolboards[t.toolboard.id].name}`);
  });
  const p = b.probe ? db.probes[b.probe] : undefined;
  if (p && p.kind === 'eddy_native' && (b.probeConnection ?? ifaces(p)[0]) === 'can') out.push(p.name);
  return out;
}

export function normalize(input: Build, db: Db): Build {
  const b = structuredClone(input);
  const printer = db.printers[b.printer];
  if (!printer.sizes.some((s: Rec) => s.id === b.size)) b.size = printer.sizes[printer.sizes.length - 1].id;
  if (!printer.variants.some((v: Rec) => v.id === (b.variant ?? 'standard'))) b.variant = 'standard';
  if (b.toolhead && !db.toolheads[b.toolhead]?.applies_to.includes(b.printer)) b.toolhead = undefined;

  // Z drive belongs to the 2.4, leadscrews to the Trident.
  if (b.zDrive && !db.zDrives[b.zDrive]?.applies_to.includes(b.printer)) delete b.zDrive;
  if (b.leadscrew && !printer.leadscrew_options?.some((l: Rec) => l.id === b.leadscrew)) delete b.leadscrew;

  // Extensions belong to one board; drop any the picked board does not have.
  if (b.mainboard.extensions) {
    const known = new Set((db.mainboards[b.mainboard.id].extensions ?? []).map((e: Rec) => e.id));
    b.mainboard.extensions = b.mainboard.extensions.filter((id) => known.has(id));
    if (!b.mainboard.extensions.length) delete b.mainboard.extensions;
  }
  const board = mainboardFor(db, b.mainboard);
  if (b.mainboard.mcu && !board.mcu_variants.some((m: Rec) => m.chip === b.mainboard.mcu)) delete b.mainboard.mcu;
  if (!board.interfaces.includes(b.mainboard.connection)) b.mainboard.connection = board.interfaces.includes('usb') ? 'usb' : board.interfaces[0];

  if (b.toolboard) {
    const tb = db.toolboards[b.toolboard.id];
    if (!tb.interfaces.includes(b.toolboard.connection ?? 'can')) b.toolboard.connection = tb.interfaces[0];
  }
  if (b.probe) {
    const p = db.probes[b.probe];
    if (p.kind !== 'inductive' || p.output) delete b.probeOutput;
    else b.probeOutput ??= 'npn-no';
    if (p.kind === 'eddy_native' && Array.isArray(p.interface)) {
      if (!p.interface.includes(b.probeConnection)) b.probeConnection = p.interface[0];
    } else delete b.probeConnection;
    if (b.homing.z === 'probe_virtual_endstop' && !p.z_endstop_capable) b.homing.z = 'nozzle_switch';
  } else if (b.homing.z === 'probe_virtual_endstop') {
    b.homing.z = 'nozzle_switch';
  }
  // Toolchanger toolheads (StealthChanger) switch the build into toolchanger mode:
  // every tool has its own board and Tap sensor, which homes Z and probes.
  const tc = toolchangerFor(b, db);
  if (tc) {
    const firstTapBoard = Object.values(db.toolboards).find((t) => t.probe_ports?.length && t.interfaces.includes('can'))!;
    b.toolboard ??= { id: firstTapBoard.id, connection: 'can' };
    b.toolchanger ??= { system: tc.id, tools: [{ toolboard: { ...b.toolboard } }] };
    b.toolchanger.system = tc.id;
    for (const t of b.toolchanger.tools) {
      const tb = db.toolboards[t.toolboard.id];
      if (!tb) t.toolboard = { id: b.toolboard.id, connection: b.toolboard.connection };
      else if (!tb.interfaces.includes(t.toolboard.connection ?? 'can')) t.toolboard.connection = tb.interfaces[0];
      if (t.extruder && !db.extruders[t.extruder]) delete t.extruder;
      if (t.hotend && !db.hotends[t.hotend]) delete t.hotend;
    }
    if (b.toolchanger.docks) b.toolchanger.docks = b.toolchanger.docks.slice(0, b.toolchanger.tools.length + 1);
    if (b.toolchanger.zProbe !== 'shuttle') {
      for (const k of ['probe', 'probeOffset', 'probeOutput', 'probeConnection'] as const) delete b[k];
    } else if (b.probe && (!['eddy_native', 'eddy_plugin'].includes(db.probes[b.probe]?.kind) || db.probes[b.probe]?.interface === 'toolboard_i2c')) {
      delete b.probe;
    }
    b.homing.z = 'probe_virtual_endstop';
  } else {
    delete b.toolchanger;
  }
  if (b.homing.z !== 'nozzle_switch') delete b.homing.zSwitchXY;

  // A USB-CAN adapter only when something is on CAN and the board isn't bridging.
  if (canDevices(b, db).length && b.mainboard.connection !== 'usb-can-bridge') b.canAdapter ??= 'u2c';
  else delete b.canAdapter;

  // Driver modules must fit the board's sockets; onboard boards ignore them.
  if (board.driver_mount !== 'onboard') {
    for (const g of ['xy', 'z', 'extruder'] as const) {
      const choice = b.drivers[g];
      if (!choice) continue;
      const mod = db.modules[choice.module];
      if (!mod || mod.format !== board.driver_mount) choice.module = board.driver_mount === 'ez' ? 'btt-ez2209' : 'btt-tmc2209';
      const chipIfaces: string[] = db.drivers.chips[db.modules[choice.module].chip].interfaces;
      if (choice.interface && !chipIfaces.includes(choice.interface)) delete choice.interface;
      if (chipIfaces.length < 2) delete choice.interface;
    }
  }
  if (b.toolboard) delete b.drivers.extruder;
  if (!b.toolboard || !db.toolheads[b.toolhead ?? '']?.leds) b.leds = false;

  // Fans: a fan pinned to the toolhead board falls back to auto when there is none,
  // and a chosen port is dropped when the board it would be on does not have it.
  for (const f of b.fans) if (f.board === 'toolboard' && !b.toolboard) { delete f.board; delete f.port; }
  for (const f of b.fans) {
    if (!f.port) continue;
    const kind = f.board ?? (db.fanRoles[f.role]?.prefer_board === 'toolboard' && b.toolboard ? 'toolboard' : 'mainboard');
    const ports: Rec[] = kind === 'toolboard' ? db.toolboards[b.toolboard!.id]?.fans ?? [] : board.fans ?? [];
    if (!ports.some((p) => p.id === f.port)) delete f.port;
  }
  if (b.nevermore?.port && !(board.fans ?? []).some((p: Rec) => p.id === b.nevermore!.port)) delete b.nevermore.port;
  // Slot overrides: keep only steppers this build has and slots this board has.
  if (b.slotOverrides) {
    const variant = printer.variants.find((v: Rec) => v.id === (b.variant ?? 'standard'));
    const steppers = new Set([...printer.steppers, ...(variant?.extra_steppers ?? [])].map((d: Rec) => d.klipper).concat(b.toolboard ? [] : ['extruder']));
    const slots = new Set((board.driver_slots ?? []).map((d: Rec) => d.id));
    for (const [st, sl] of Object.entries(b.slotOverrides)) if (!steppers.has(st) || !slots.has(sl)) delete b.slotOverrides[st];
    if (!Object.keys(b.slotOverrides).length) delete b.slotOverrides;
  }
  return b;
}

export function toolchangerFor(b: Build, db: Db): Rec | undefined {
  return Object.values(db.toolchangers).find((t) => t.toolheads?.includes(b.toolhead));
}

/** Drivers a build needs on the mainboard (motion, plus the extruder without a toolhead board). */
export function driversNeeded(b: Build, db: Db): number {
  const variant = db.printers[b.printer].variants.find((v: Rec) => v.id === (b.variant ?? 'standard'));
  return variant.drivers_required.motion + (b.toolboard ? 0 : variant.drivers_required.extruder);
}
