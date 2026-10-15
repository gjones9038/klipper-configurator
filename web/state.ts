// Build state: defaults, persistence and normalize(), which keeps a build
// consistent after each edit (e.g. switching to an EZ board swaps stepstick
// modules for EZ ones). normalize() only fixes choices that are no longer
// possible; anything the user must decide is left for plan() to report.
import type { Build, Db, Rec } from '../generator/types.ts';
import example from '../examples/v24-350-leviathan-sb2209.json' with { type: 'json' };

const KEY = 'klipper-configurator.build.v1';
const STEP_KEY = 'klipper-configurator.step.v1';

export function defaultBuild(): Build {
  return structuredClone(example) as Build;
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
  if (b.toolboard && (b.toolboard.connection ?? 'can') === 'can') out.push(db.toolboards[b.toolboard.id].name);
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

  const board = db.mainboards[b.mainboard.id];
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

  // Fans: a fan pinned to the toolhead board falls back to auto when there is none.
  for (const f of b.fans) if (f.board === 'toolboard' && !b.toolboard) { delete f.board; delete f.port; }
  return b;
}

/** Drivers a build needs on the mainboard (motion, plus the extruder without a toolhead board). */
export function driversNeeded(b: Build, db: Db): number {
  const variant = db.printers[b.printer].variants.find((v: Rec) => v.id === (b.variant ?? 'standard'));
  return variant.drivers_required.motion + (b.toolboard ? 0 : variant.drivers_required.extruder);
}
