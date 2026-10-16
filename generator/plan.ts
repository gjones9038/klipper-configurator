// Resolve a Build against the Db into a Plan: every stepper on a slot with a
// driver, every heater/sensor/fan on a port, with issues collected on the way.
// Rendering (emit.ts) only formats a Plan; all decisions happen here.
import type { Build, Db, Issue, Rec, Interface, Link, McuInfo } from './types.ts';
import { mainboardFor } from './dbcore.ts';

const KD = 'https://www.klipper3d.org/';
// Klipper documentation pages the generated files refer to.
export const KLIPPER_DOCS = {
  configChecks: { title: 'Klipper: configuration checks (first power-on)', url: `${KD}Config_checks.html` },
  tmcSensorless: { title: 'Klipper: TMC drivers and sensorless homing', url: `${KD}TMC_Drivers.html#sensorless-homing` },
  pressureAdvance: { title: 'Klipper: tuning pressure advance', url: `${KD}Pressure_Advance.html` },
  resonances: { title: 'Klipper: measuring resonances (input shaper)', url: `${KD}Measuring_Resonances.html` },
  inputShaper: { title: 'Klipper: resonance compensation', url: `${KD}Resonance_Compensation.html` },
  bedLevel: { title: 'Klipper: bed level and the paper test', url: `${KD}Bed_Level.html` },
  probeCalibrate: { title: 'Klipper: probe calibration (offsets)', url: `${KD}Probe_Calibrate.html` },
  eddy: { title: 'Klipper: eddy current probes', url: `${KD}Eddy_Probe.html` },
  canbus: { title: 'Klipper: CAN bus setup', url: `${KD}CANBUS.html` },
  configRef: { title: 'Klipper: config reference', url: `${KD}Config_Reference.html` },
};

export const TOOLHEAD_MCU = 'toolhead';
type BoardKind = 'mainboard' | 'toolboard';

export interface DriverPlan {
  chip: string;               // drivers.yaml chip id
  section: string;            // klipper section prefix, e.g. tmc2209
  iface: Interface;
  pins: Record<string, string>;   // uart_pin | cs_pin + spi_bus/spi_software_*
  sense?: number;
  rref?: number;
  diag?: { key: string; pin: string };
  onboard: boolean;
  moduleId?: string;
  hv: boolean;
  standalone?: boolean;       // no UART/SPI: no TMC section, current set on the board
  uartAddress?: number;       // drivers sharing an address scheme (Sovol SV06: every driver at 3)
  microsteps?: number;        // fixed by the board (standalone drivers)
}

export interface StepperPlan {
  name: string;               // klipper section, e.g. stepper_x
  role: string;               // B, A, Z0 ... E
  position?: string;
  board: BoardKind;
  slot: string;
  step: string;
  dir: string;
  enable: string;
  rotationDistance: number;
  gearRatio?: string;
  microsteps: number;
  fullSteps: number;
  driver: DriverPlan;
  runCurrent: number;
  currentNote: string;
  motor?: Rec;
  endstop?: { port: string; pin: string; board: BoardKind } | 'virtual' | 'probe';
  group: 'xy' | 'z' | 'extruder';
  pairsWith?: string;
}

export interface PortUse {
  board: BoardKind;
  port: string;
  pin: string;
  tach?: string;
  maxPower?: number;          // heater cap from the board maker (Orbitool: 0.995 for short-circuit auto-recovery)
  multi?: { name: string; pins: string[] };   // several outputs switched as one through [multi_pin] (Geeetech 301 heater)
}

export interface FanPlan extends PortUse {
  role: string;
  enable?: string;            // fan driver enable line (Orbitool O2S part fan)
  multi?: { name: string; pins: string[] };   // several outputs driven as one through [multi_pin] (Sovol SV08 part fans)
  options?: Rec;              // settings the board maker requires for this port (e.g. cycle_time)
  voltage?: number;
  section: string;            // full section header
  defaults: Rec;
}

export interface ToolPlan {
  n: number;                  // tool number
  mcu: string;                // klipper mcu name
  toolboard: Rec;
  connection: 'can' | 'usb';
  extruderSection: string;    // extruder, extruder1, ...
  stepper: StepperPlan;
  extruder: Rec;
  hotend: Rec;
  thermistor: Rec;
  heater: PortUse;
  sensor: PortUse & { pullup: number };
  maxTemp: number;
  paBaseline: number;
  fans: FanPlan[];            // part cooling (fan_generic Tn_partfan) and hotend (heater_fan Tn_hotend_fan)
  probe: PortUse;             // Tap / OptoTap or mount switch: [tool Tn] detection_pin (and [tool_probe Tn] pin when per-tool)
  accel?: Rec;
  leds?: PortUse & { chain: number; order: string };
  dock?: { x: number; y: number; z: number };
}

export interface Plan {
  build: Build;
  printer: Rec;
  size: Rec;
  variant: Rec;
  board: Rec;
  mcu: Rec;
  toolboard?: Rec;
  toolhead?: Rec;
  steppers: StepperPlan[];
  extruder: Rec;
  hotend: Rec;
  hotendHeater: PortUse;
  hotendSensor: PortUse & { pullup: number };
  bedHeater?: PortUse;                       // undefined when the printer has no heated bed
  bedSensor?: PortUse & { pullup: number };
  chamberSensor?: PortUse & { pullup?: number };
  thermistor: { hotend: Rec; bed?: Rec; chamber?: Rec };
  maxTemp: number;
  fans: FanPlan[];
  probe?: Rec & { port?: PortUse; offset: { x: number; y: number }; output?: string; connection?: string; i2c?: { mcu: string; bus: string; port: Rec } };
  bltouch?: { board: BoardKind; sensor: string; control: string };
  accel?: Rec & { board: BoardKind };
  leds?: PortUse & { chain: number; order: string };
  paBaseline: number;
  nevermore?: { model: Rec; mode: 'always' | 'hot_bed'; threshold: number; speed: number; postMinutes: number; fan: FanPlan };
  homingCurrent: Record<string, number>;
  issues: Issue[];
  links: Link[];
  mcus: McuInfo[];
  tools?: ToolPlan[];         // toolchanger: T0..Tn
  toolchanger?: { rec: Rec; safeY?: number; closeY?: number; yMin?: number; zMax?: number; zProbe: 'per_tool' | 'shuttle' };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Where macros may move the nozzle. Cartesian/CoreXY beds have 0,0 in a corner; a delta's
 * round bed is centred on 0,0 with a radius, and its full height is only reachable near the
 * centre (so parking goes to the centre before rising).
 */
export function bedGeometry(p: { printer: Rec; size: Rec }) {
  if (p.printer.kinematics === 'delta') {
    const r = p.size.bed_radius;
    const y = -r2(r * 0.85);
    const half = r2(Math.sqrt(r * r - y * y) * 0.8);
    return {
      delta: true, radius: r, center: [0, 0] as [number, number], front: [0, -r2(r * 0.6)] as [number, number],
      purge: { x0: -half, x1: half - 10, x2: half, y }, park: [0, 0] as [number, number],
    };
  }
  const [bx, by] = p.size.bed_mm;
  return {
    delta: false, radius: 0, center: [bx / 2, by / 2] as [number, number], front: [bx / 2, 20] as [number, number],
    purge: { x0: 20, x1: 100, x2: 110, y: 5 }, park: [bx / 2, by - 10] as [number, number],
  };
}

/** Split "!^PA1" into modifiers and bare pin. */
function splitPin(raw: string): [string, string] {
  const m = /^([!^~]*)(.*)$/.exec(raw)!;
  return [m[1], m[2]];
}

/** Qualify a board pin for use in printer.cfg: modifiers first, then mcu prefix. */
export function qpin(board: BoardKind, raw: string, extraMods = '', mcuName = TOOLHEAD_MCU): string {
  const [mods, bare] = splitPin(raw);
  const all = [...new Set((extraMods + mods).split(''))].join('');
  return all + (board === 'toolboard' ? `${mcuName}:` : '') + bare;
}

const qpinBase = qpin;

/** MCU name of toolchanger tool n: T0 keeps "toolhead", T1.. are "toolhead1".. */
export const toolMcu = (n: number) => (n === 0 ? TOOLHEAD_MCU : `${TOOLHEAD_MCU}${n}`);
/** Klipper extruder section of tool n (Klipper's M104/M109 T<n> use the same mapping). */
export const extruderName = (n: number) => (n === 0 ? 'extruder' : `extruder${n}`);

export function plan(build: Build, db: Db): Plan {
  const issues: Issue[] = [];
  const links: Link[] = [];
  function addLinks(docs: Array<{ title: string; url: string }> | undefined, topic: string) {
    for (const d of docs ?? []) if (!links.some((l) => l.url === d.url)) links.push({ ...d, topic });
  }
  const repoLink = (rec: Rec, what: string) => {
    const repo = rec.sources?.find((s: Rec) => !/Klipper3d|VoronDesign/.test(s.repo))?.repo ?? rec.sources?.[0]?.repo;
    return repo ? [{ title: `${rec.name} ${rec.revisions?.join('/') ?? ''}: ${what}`.replace(/\s+:/, ':'), url: repo }] : [];
  };
  const err = (code: string, message: string) => issues.push({ level: 'error', code, message });
  const warn = (code: string, message: string) => issues.push({ level: 'warning', code, message });
  const need = <T>(v: T | undefined, code: string, what: string): T => {
    if (v === undefined || v === null) throw new PlanError(code, what);
    return v;
  };

  const printer = need(db.printers[build.printer], 'unknown_printer', `Unknown printer "${build.printer}"`);
  const size = need(printer.sizes.find((s: Rec) => s.id === build.size), 'unknown_size',
    `${printer.name} has no size "${build.size}"`);
  const variant = need(printer.variants.find((v: Rec) => v.id === (build.variant ?? 'standard')),
    'unknown_variant', `${printer.name} has no variant "${build.variant}"`);
  const baseBoard = need(db.mainboards[build.mainboard.id], 'unknown_board', `Unknown mainboard "${build.mainboard.id}"`);
  for (const id of build.mainboard.extensions ?? []) {
    if (!(baseBoard.extensions ?? []).some((e: Rec) => e.id === id)) {
      throw new PlanError('unknown_extension', `${baseBoard.name} has no extension board "${id}".`);
    }
  }
  const board = mainboardFor(db, build.mainboard);
  const mcu = build.mainboard.mcu
    ? need(board.mcu_variants.find((m: Rec) => m.chip === build.mainboard.mcu), 'unknown_mcu',
      `${board.name} has no MCU variant "${build.mainboard.mcu}"`)
    : board.mcu_variants[0];
  const toolboard = build.toolboard
    ? need(db.toolboards[build.toolboard.id], 'unknown_toolboard', `Unknown toolhead board "${build.toolboard.id}"`)
    : undefined;
  const toolhead = build.toolhead ? need(db.toolheads[build.toolhead], 'unknown_toolhead',
    `Unknown toolhead "${build.toolhead}"`) : undefined;
  const extruder = need(db.extruders[build.extruder], 'unknown_extruder', `Unknown extruder "${build.extruder}"`);
  const hotend = need(db.hotends[build.hotend], 'unknown_hotend', `Unknown hotend "${build.hotend}"`);

  if (toolboard?.for_extruders && !toolboard.for_extruders.includes(build.extruder)) {
    warn('toolboard_extruder', `${toolboard.name} is made for the ${toolboard.for_extruders.map((id: string) => db.extruders[id]?.name ?? id).join(' / ')}, not the ${extruder.name}.`);
  }
  addLinks(printer.docs, 'printer');
  addLinks(repoLink(board, 'manufacturer docs, pinout and sample configs'), 'mainboard');
  for (const e of board.activeExtensions ?? []) addLinks(repoLink(e, 'manufacturer docs, schematic and sample config'), 'mainboard');
  if (toolboard) addLinks(repoLink(toolboard, 'manufacturer docs and pinout'), 'toolhead board');
  addLinks(extruder.docs, 'extruder');
  addLinks([KLIPPER_DOCS.configChecks], 'first power-on');

  // [extruder] max_temp: the lower of the hotend's rating and the thermistor's.
  // A bare hotend's rating covers only its metal parts (heater and sensor not
  // included), and some hotends have no published rating at all.
  function hotendMaxTemp(he: Rec, th: Rec, label = ''): number {
    const tl: number | undefined = th.max_temp_c;
    if (he.max_temp == null) {
      if (tl == null) throw new PlanError('no_max_temp', `${label}Neither the ${he.name} nor the ${th.label} thermistor has a known maximum temperature.`);
      warn('hotend_max_temp_unknown', `${label}The ${he.name} has no published maximum temperature, so the ${th.label} thermistor's limit (${tl}°C) is used. Check your hotend's own limit.`);
      return tl;
    }
    const t = Math.min(he.max_temp, tl ?? he.max_temp);
    if (he.max_temp_basis === 'metalwork') {
      warn('max_temp_capped', `${label}The ${he.name} comes without a heater or thermistor; its ${he.max_temp}°C rating covers only the metal parts. The top temperature is set to ${t}°C by the ${th.label} thermistor${th.basis === 'seller' ? ` (a seller's rating; generic parts vary, so check yours)` : ''}. Your heater cartridge's own rating applies too.`);
    } else if (t < he.max_temp) {
      warn('max_temp_capped', `${label}The hotend's top temperature is limited to ${t}°C by the ${th.label} thermistor (the hotend itself is rated ${he.max_temp}°C).`);
    }
    return t;
  }

  // A probe needs a supply voltage the port provides (toolboard v1.x Endstop
  // connectors are 5 V only; inductive probes need 12-24 V).
  function checkProbeSupply(p: Rec, port: Rec | undefined, kind: BoardKind, b: Rec | undefined) {
    const pv: number[] | undefined = port?.supply_v;
    const need: number[] | undefined = p.supply_v;
    if (!pv || !port) return;
    if (!pv.length) {
      warn('probe_power_elsewhere', `${port.id} on ${b?.name ?? `the ${kind}`} has only signal and ground wires, no power. Power the ${p.name} from another connector${need ? ` (it needs ${Math.min(...need)}-${Math.max(...need)} V)` : ''}.`);
      return;
    }
    if (!need) return;
    const [lo, hi] = [Math.min(...need), Math.max(...need)];
    if (!pv.some((v) => v >= lo && v <= hi)) {
      err('probe_supply', `The ${p.name} needs ${lo}-${hi} V, but ${port.id} on ${b?.name ?? `the ${kind}`} only gives ${pv.join(' or ')} V. Power it from another connector or choose another probe.`);
    }
  }
  // Voron-Tap OptoTap README (Sensor Logic): OPB9x0 sensors are totem pole and
  // drive the signal to 5 V, which RP2040 toolhead boards' pins do not tolerate.
  function tapSignalWarning(tb: Rec, label = '') {
    if (tb.mcu?.chip !== 'rp2040') return;
    warn('tap_5v_signal', `${label}${tb.name} has an RP2040, whose inputs are not 5 V tolerant. OptoTap boards with an Optek OPB9x0 sensor drive the signal to 5 V (Voron-Tap OptoTap README); check your sensor part number before connecting it.`);
  }

  // --- toolchanger: checks that shape the rest of the plan ----------------
  const tcSpec = build.toolchanger;
  const shuttle = tcSpec?.zProbe === 'shuttle';
  const tcRec: Rec | undefined = tcSpec
    ? need(db.toolchangers[tcSpec.system], 'unknown_toolchanger', `Unknown toolchanger "${tcSpec.system}"`)
    : undefined;
  if (tcSpec && tcRec) {
    if (!tcRec.applies_to.includes(build.printer)) {
      err('toolchanger_printer', tcRec.not_supported?.[build.printer]
        ?? `${tcRec.name} is modelled for ${tcRec.applies_to.map((id: string) => db.printers[id]?.name ?? id).join(', ')} only.`);
    }
    if (build.toolhead !== tcRec.toolhead) err('toolchanger_toolhead', `${tcRec.name} tools are "${db.toolheads[tcRec.toolhead]?.name}"; set the toolhead to it.`);
    if (!toolboard) err('toolchanger_needs_toolboard', `Every ${tcRec.name} tool carries its own toolhead board; T0 has none.`);
    if (!shuttle && build.probe) err('toolchanger_probe', `${tcRec.name} homes and probes with each tool's own Tap sensor ([tool_probe]); remove the separate probe, or choose a shuttle-mounted eddy probe.`);
    if (shuttle) {
      const sp = build.probe ? db.probes[build.probe] : undefined;
      if (!sp || !['eddy_native', 'eddy_plugin'].includes(sp.kind) || sp.interface === 'toolboard_i2c') {
        err('toolchanger_shuttle_probe', `A shuttle-mounted probe must be an eddy probe with its own MCU (USB or CAN), such as a Cartographer, Beacon or BTT Eddy USB (klipper-toolchanger examples). ${sp ? `${sp.name} is not.` : 'Choose one.'}`);
      }
      warn('toolchanger_z_offsets', `With the probe on the shuttle, no tool touches the bed during homing: measure each tool's gcode_z_offset against T0 (StealthChanger wiki: Offsets) before printing with it.`);
    }
    if (build.homing.z !== 'probe_virtual_endstop') err('toolchanger_z_homing', `${tcRec.name} homes Z with the ${shuttle ? 'shuttle probe' : 'tool probe'}; set Z homing to "Probe as Z endstop".`);
    if (!tcSpec.tools.length) err('toolchanger_one_tool', 'A toolchanger needs at least two tools; add T1.');
    for (const k of tcRec.module.known_issues ?? []) {
      warn('toolchanger_module', k.text);
      addLinks(k.links, 'toolchanger');
    }
    addLinks(tcRec.docs, 'toolchanger');
  }
  if (board.status !== 'reviewed') {
    warn('board_needs_review', `${board.name}: its pin list comes from a single source ("needs review"). Check the pins against the board's own pin diagram before powering on.`);
  }
  // Things the user has to check or do (plain language); source disagreements stay in the data's details.
  for (const c of board.checks ?? []) warn('board_check', `${board.name}: ${c}`);
  for (const e of board.activeExtensions ?? []) for (const c of e.checks ?? []) warn('board_check', `${e.name}: ${c}`);

  // --- connectivity ------------------------------------------------------
  if (!board.interfaces.includes(build.mainboard.connection)) {
    err('connection_unsupported', `${board.name} cannot connect by "${build.mainboard.connection}"; it supports ${board.interfaces.join(', ')} (Mainboard step).`);
  }
  if (toolboard) {
    const tconn = build.toolboard!.connection ?? (toolboard.interfaces.includes('can') ? 'can' : 'usb');
    if (!toolboard.interfaces.includes(tconn)) {
      err('toolboard_connection', `${toolboard.name} can't connect by ${tconn.toUpperCase()}; choose its other connection on the Toolhead board step.`);
    }
    if (tconn === 'can' && build.mainboard.connection !== 'usb-can-bridge' && !build.canAdapter) {
      err('no_can_path', `${toolboard.name} connects over CAN, which needs a path to your Pi: set the mainboard to "USB-CAN bridge", or use a separate USB-CAN adapter (Toolhead board step).`);
    }
  }

  // --- steppers and slots ------------------------------------------------
  const motionDefs: Rec[] = [...printer.steppers, ...(variant.extra_steppers ?? [])];
  const extruderOnToolboard = !!toolboard;
  // Motion roles in printer order (CoreXY: B, A [, B1, A1]; cartesian: X, Y), then Z.
  const roleOrder = motionDefs.filter((d) => !d.role.startsWith('Z')).map((d) => d.role);
  const zRoles = motionDefs.filter((d) => d.role.startsWith('Z')).map((d) => d.role);
  const orderedRoles = [...roleOrder, ...zRoles, ...(extruderOnToolboard ? [] : ['E'])];
  const defByRole: Record<string, Rec> = Object.fromEntries(motionDefs.map((d) => [d.role, d]));
  defByRole.E = { klipper: 'extruder', role: 'E' };

  const slots: Rec[] = board.driver_slots;
  if (slots.length < orderedRoles.length) {
    const hint = !extruderOnToolboard && slots.length >= orderedRoles.length - 1
      ? ' Adding a toolhead board frees one: the extruder motor then runs from the toolhead board (Toolhead board step).' : '';
    const unused = (baseBoard.extensions ?? []).filter((e: Rec) => !build.mainboard.extensions?.includes(e.id));
    const extHint = unused.map((e: Rec) => ` ${hint ? 'Or turn' : 'Turn'} on the ${e.name} on the Mainboard step: it adds ${e.driver_slots?.length ?? 0} more.`).join('');
    throw new PlanError('not_enough_drivers',
      `The ${board.name} has ${slots.length} motor sockets, but this ${printer.name} needs ${orderedRoles.length} (one per motor).${hint}${extHint}`);
  }

  // Overrides first, then HV slots for A/B, then the remaining slots in order.
  const assign: Record<string, Rec> = {};
  const free = [...slots];
  const take = (slot: Rec) => free.splice(free.indexOf(slot), 1);
  for (const [stepper, slotId] of Object.entries(build.slotOverrides ?? {})) {
    const role = orderedRoles.find((r) => defByRole[r].klipper === stepper);
    const slot = slots.find((s) => s.id === slotId);
    if (!role || !slot) { err('bad_override', `The socket chosen for ${stepper} (${slotId}) does not exist on this board. Pick another on the Motors step.`); continue; }
    if (!free.includes(slot)) { err('slot_taken', `Socket ${slotId} is chosen for two motors.`); continue; }
    assign[role] = slot; take(slot);
  }
  // HV slots go to A/B first, then to the AWD pair (Leviathan extension: B1 on
  // HV STEPPER 2, A1 on HV STEPPER 3, as in LDO's v2t_leviathan_ext.cfg).
  const hvSlots = free.filter((s) => s.onboard_driver?.motor_power);
  for (const role of roleOrder) {
    if (!assign[role] && hvSlots.length) { const s = hvSlots.shift()!; assign[role] = s; take(s); }
  }
  for (const role of orderedRoles) {
    if (!assign[role]) { const s = free.shift()!; assign[role] = s; }
  }

  // Enable-pin polarity sanity check: flags data like Max EZ Motor-4.
  const inverted = slots.filter((s) => String(s.enable_pin).startsWith('!')).length;
  for (const [role, slot] of Object.entries(assign)) {
    if (inverted > slots.length / 2 && !String(slot.enable_pin).startsWith('!')) {
      warn('enable_polarity', `${board.name}: socket ${slot.id} (used for ${defByRole[role].klipper}) is set up differently from the other sockets in the sources, which may be a mistake in them. If that motor won't move or won't switch off, use another socket.`);
    }
  }

  const zDrive = build.zDrive ? db.zDrives[build.zDrive] : undefined;
  if (build.zDrive && !zDrive) err('unknown_zdrive', `Unknown Z drive "${build.zDrive}"`);
  const leadscrew = printer.leadscrew_options
    ? (printer.leadscrew_options.find((l: Rec) => l.id === build.leadscrew) ??
       printer.leadscrew_options.find((l: Rec) => l.default))
    : undefined;

  const motorFor = (group: 'xy' | 'z' | 'extruder'): Rec | undefined => {
    const id = group === 'extruder' ? (build.motors.extruder ?? extruder.recommended_motor) : build.motors[group];
    if (!id) return undefined;
    const m = db.motors[id.toLowerCase()];
    if (!m) warn('unknown_motor', `Motor "${id}" is not in the motor list, so its current uses the printer's default and autotune skips it.`);
    return m;
  };
  const motors = { xy: motorFor('xy'), z: motorFor('z'), extruder: motorFor('extruder') };

  const steppers: StepperPlan[] = [];
  const homingXY = build.homing.xy;
  for (const role of orderedRoles) {
    const def = defByRole[role];
    const slot = assign[role];
    const group: 'xy' | 'z' | 'extruder' = role === 'E' ? 'extruder' : role.startsWith('Z') ? 'z' : 'xy';
    steppers.push(buildStepper(def, slot, 'mainboard', group));
  }
  if (extruderOnToolboard) {
    const d = toolboard!.extruder_driver;
    steppers.push(buildStepper({ klipper: 'extruder', role: 'E' }, {
      id: 'extruder', step_pin: d.step_pin, dir_pin: d.dir_pin, enable_pin: d.enable_pin,
      uart_pin: d.uart_pin, tx_pin: d.tx_pin, uart_address: d.uart_address, spi_cs_pin: d.spi_cs_pin, spi_bus: d.spi_bus, spi_software: d.spi_software,
      onboard_driver: { chip: d.chip, klipper_section: db.drivers.chips[d.chip].klipper_section,
        sense_resistor: d.sense_resistor, rref: d.rref_ohms },
    }, 'toolboard', 'extruder'));
  }

  function buildStepper(def: Rec, slot: Rec, boardKind: BoardKind, group: 'xy' | 'z' | 'extruder',
    tool: { extruder: Rec; motor?: Rec; mcu: string } = { extruder, motor: motors.extruder, mcu: TOOLHEAD_MCU }): StepperPlan {
    const driver = resolveDriver(slot, boardKind, group, tool.mcu);
    const motor = group === 'extruder' ? tool.motor : motors[group];
    const extruder = tool.extruder;
    // Extruder direction is a property of the extruder (Sovol SV06: !PB3 in Klipper's config).
    const dirInverted = def.dir_inverted ?? (group === 'extruder' ? tool.extruder.dir_inverted : undefined) ?? false;
    let rotationDistance: number, gearRatio: string | undefined, microsteps: number;
    if (group === 'extruder') {
      rotationDistance = extruder.rotation_distance;
      gearRatio = extruder.gear_ratio ?? undefined;
      microsteps = extruder.microsteps ?? 16;
    } else if (group === 'z') {
      if (def.leadscrew) {
        rotationDistance = leadscrew?.rotation_distance ?? 8;
      } else {
        rotationDistance = zDrive?.rotation_distance ?? def.rotation_distance;
        gearRatio = zDrive?.gear_ratio ?? def.gear_ratio;
      }
      microsteps = zDrive?.microsteps ?? printer.defaults.stepper_z.microsteps;
    } else {
      rotationDistance = def.rotation_distance;
      microsteps = printer.defaults.stepper_xy.microsteps;
    }
    if (driver.standalone && driver.microsteps) microsteps = driver.microsteps;   // set by the board's MS pins
    const fullSteps = motor?.step_angle_deg === 0.9 ? 400 : 200;
    const { current, note } = runCurrent(group, motor, driver, slot, extruder);
    return {
      name: def.klipper, role: def.role, position: def.position, board: boardKind, slot: slot.id,
      step: qpin(boardKind, slot.step_pin, '', tool.mcu),
      dir: qpin(boardKind, slot.dir_pin, dirInverted ? '!' : '', tool.mcu),
      enable: qpin(boardKind, slot.enable_pin, '', tool.mcu),
      rotationDistance, gearRatio, microsteps, fullSteps, driver,
      runCurrent: current, currentNote: note, motor, group, pairsWith: def.pairs_with,
    };
  }

  function resolveDriver(slot: Rec, boardKind: BoardKind, group: 'xy' | 'z' | 'extruder', mcuName = TOOLHEAD_MCU): DriverPlan {
    const qpin = (b: BoardKind, raw: string, mods = '') => qpinBase(b, raw, mods, mcuName);
    const chips = db.drivers.chips;
    if (slot.onboard_driver?.standalone) {
      const od = slot.onboard_driver;
      return { chip: od.chip ?? 'standalone', section: '', iface: 'standalone', pins: {}, onboard: true, hv: false, standalone: true, microsteps: od.microsteps };
    }
    if (slot.onboard_driver) {
      const od = slot.onboard_driver;
      const iface: Interface = slot.uart_pin ? 'uart' : 'spi';
      const pins: Record<string, string> = {};
      if (iface === 'uart') {
        pins.uart_pin = qpin(boardKind, slot.uart_pin);
        if (slot.tx_pin) pins.tx_pin = qpin(boardKind, slot.tx_pin);   // separate TX line (Klipper [tmc2209] tx_pin)
      } else {
        pins.cs_pin = qpin(boardKind, slot.spi_cs_pin);
        // A toolhead board's driver brings its own SPI (bus or software pins); never the mainboard's.
        const spi = slot.spi_bus ? { bus: slot.spi_bus } : slot.spi_software ? { software: slot.spi_software } : boardKind === 'toolboard' ? undefined : board.tmc_spi;
        if (!spi) err('no_tmc_spi', `The data for this ${boardKind === 'toolboard' ? 'toolhead board' : 'board'} is missing how its ${od.chip.toUpperCase()} driver connects, so it can't be used yet.`);
        Object.assign(pins, spiPins(spi, boardKind, mcuName));
      }
      return {
        chip: od.chip, section: od.klipper_section ?? chips[od.chip].klipper_section, iface, pins,
        sense: od.sense_resistor ?? chips[od.chip].sense_resistor_default ?? undefined,
        rref: od.rref ?? (od.chip === 'tmc2240' ? chips.tmc2240.current_reference.default_ohms : undefined),
        diag: slot.diag_pin ? { key: slot.diag_pin_key ?? 'diag_pin', pin: diagPin(slot, od.chip, boardKind, mcuName) } : undefined,
        onboard: true, hv: !!od.motor_power, uartAddress: slot.uart_address,
      };
    }
    const choice = build.drivers[group] ?? build.drivers.xy;
    const mod = db.modules[choice.module];
    if (!mod) throw new PlanError('unknown_driver_module', `Unknown driver module "${choice.module}"`);
    const chip = chips[mod.chip];
    if (mod.format !== board.driver_mount) {
      err('driver_format', `The ${mod.id} driver doesn't fit the ${board.name}'s sockets (it takes ${board.driver_mount === 'ez' ? 'EZ' : 'stepstick'} drivers). Choose another on the Motors step.`);
    }
    if (board.supported_drivers && !board.supported_drivers.includes(mod.chip)) {
      err('driver_unsupported', `The ${board.name}'s maker doesn't list ${mod.chip.toUpperCase()} drivers as supported. Choose another driver on the Motors step.`);
    }
    const iface: Interface = choice.interface ?? chip.interfaces[0];
    if (!chip.interfaces.includes(iface)) {
      err('driver_interface', `The ${mod.chip.toUpperCase()} driver can't use ${iface.toUpperCase()} mode; it supports ${chip.interfaces.map((x: string) => x.toUpperCase()).join(' and ')}.`);
    }
    const pins: Record<string, string> = {};
    if (iface === 'uart') {
      pins.uart_pin = qpin(boardKind, slot.uart_pin);
    } else {
      if (!board.tmc_spi) err('no_tmc_spi', `The data for the ${board.name} is missing how SPI drivers connect, so use UART-mode drivers on this board.`);
      pins.cs_pin = qpin(boardKind, slot.spi_cs_pin);
      Object.assign(pins, spiPins(board.tmc_spi, boardKind, mcuName));
    }
    let diagKey = 'diag_pin';
    if (chip.sensorless) {
      const k = chip.sensorless.pin_key;
      diagKey = mod.diag_pin_key ?? (Array.isArray(k) ? 'diag1_pin' : k);
    }
    return {
      chip: mod.chip, section: chip.klipper_section, iface, pins,
      sense: mod.sense_resistor ?? chip.sense_resistor_default ?? undefined,
      rref: mod.rref ?? (mod.chip === 'tmc2240' ? chip.current_reference.default_ohms : undefined),
      diag: slot.diag_pin ? { key: diagKey, pin: diagPin(slot, mod.chip, boardKind, mcuName) } : undefined,
      onboard: false, moduleId: mod.id, hv: false,
    };
  }

  function spiPins(spi: Rec | undefined, boardKind: BoardKind, mcuName = TOOLHEAD_MCU): Record<string, string> {
    const qpin = (b: BoardKind, raw: string) => qpinBase(b, raw, '', mcuName);
    if (!spi || spi.default) return {};   // default: the MCU's first SPI bus, as when Klipper's config names none
    if (spi.bus) return { spi_bus: spi.bus };
    return {
      spi_software_mosi_pin: qpin(boardKind, spi.software.mosi_pin),
      spi_software_miso_pin: qpin(boardKind, spi.software.miso_pin),
      spi_software_sclk_pin: qpin(boardKind, spi.software.sclk_pin),
    };
  }

  function diagPin(slot: Rec, chip: string, boardKind: BoardKind, mcuName = TOOLHEAD_MCU): string {
    const qpin = (b: BoardKind, raw: string, mods: string) => qpinBase(b, raw, mods, mcuName);
    // Board data wins (LDO uses ^! everywhere); otherwise Klipper's TMC_Drivers.md:
    // ^ for TMC2209-family DIAG, ^! for TMC2130/5160/2240 DIAG0/DIAG1.
    const mods = slot.diag_modifier ?? (chip === 'tmc2209' || chip === 'tmc2226' ? '^' : '^!');
    return qpin(boardKind, slot.diag_pin, mods);
  }

  function runCurrent(group: 'xy' | 'z' | 'extruder', motor: Rec | undefined, driver: DriverPlan, slot: Rec, extruder: Rec) {
    // Published reference values first (extruder maker, Z drive maker, Voron),
    // never above the policy ceiling: fraction_of_rated x motor rating and the
    // driver/slot limits. The ceiling is shown so users know their headroom.
    if (driver.standalone) return { current: 0, note: 'Standalone driver: the current is set on the board' };
    const chip = db.drivers.chips[driver.chip];
    const policy = db.drivers.run_current_policy.fraction_of_rated;
    const caps: Array<[number, string]> = [];
    if (motor) caps.push([motor.rated_current_a * policy, `${Math.round(policy * 100)}% of the motor's ${motor.rated_current_a} A rating`]);
    if (chip.practical_max_rms_a) caps.push([chip.practical_max_rms_a, `the ${driver.chip.toUpperCase()} driver's practical limit`]);
    if (slot.onboard_driver?.max_current_a) caps.push([slot.onboard_driver.max_current_a, `the ${slot.id} socket's rating`]);
    const [ceiling, ceilingWhy] = caps.reduce((a, b) => (b[0] < a[0] ? b : a), [Infinity, ''] as [number, string]);

    const override = build.runCurrent?.[group];
    if (override) {
      if (override > ceiling) warn('run_current_high', `The ${group === 'xy' ? 'X/Y' : group === 'z' ? 'Z' : 'extruder'} motor current you entered (${override} A) is above ${r2(ceiling)} A (${ceilingWhy}).`);
      return { current: override, note: 'your setting' };
    }
    let ref: number, refWhy: string;
    if (group === 'extruder' && extruder.run_current) [ref, refWhy] = [extruder.run_current, `Recommended for the ${extruder.name}`];
    else if (group === 'extruder') [ref, refWhy] = [printer.defaults.extruder.run_current, `Starting value for the ${printer.name}`];
    else if (group === 'z' && zDrive?.run_current) [ref, refWhy] = [zDrive.run_current, `Recommended for the ${zDrive.id} Z drive`];
    else if (group === 'z') [ref, refWhy] = [printer.defaults.stepper_z.run_current, `Starting value for the ${printer.name}`];
    else [ref, refWhy] = [printer.defaults.stepper_xy.run_current, `Starting value for the ${printer.name}`];
    if (ref > ceiling) return { current: r2(ceiling), note: `${refWhy} is ${ref} A, lowered to ${r2(ceiling)} A (${ceilingWhy})` };
    return { current: ref, note: ceiling < Infinity ? `${refWhy}. Safe up to ${r2(ceiling)} A (${ceilingWhy}).` : refWhy };
  }

  // --- homing ------------------------------------------------------------
  const homingCurrent: Record<string, number> = {};
  const usedEndstops = new Set<string>();
  // Endstop headers that share a pin with a DIAG line in use for sensorless homing.
  const sensorlessSlots = new Set<string>();
  const pickEndstop = (stepper: StepperPlan, axis: string) => {
    const eps: Rec[] = (board.endstops ?? []).filter((e: Rec) => !(e.diag_of && sensorlessSlots.has(e.diag_of)));
    const ep = eps.find((e) => e.diag_of === stepper.slot && !usedEndstops.has(e.id))
      ?? eps.find((e) => e.id.toUpperCase().startsWith(axis) && !usedEndstops.has(e.id))
      ?? eps.find((e) => !usedEndstops.has(e.id));
    if (!ep) { err('no_endstop_port', `${board.name} has no free endstop input left for ${axis}.`); return undefined; }
    usedEndstops.add(ep.id);
    // Board data gives the polarity when a source states it (Ender 3 S1: !PA5); else a pull-up.
    return { port: ep.id, pin: qpin('mainboard', ep.pin, ep.modifier ?? '^'), board: 'mainboard' as BoardKind };
  };
  const byName = (n: string) => steppers.find((s) => s.name === n);
  const delta = printer.kinematics === 'delta';
  if (delta) {
    // A delta homes all three towers upward onto their endstops together; there is no separate Z.
    if (homingXY === 'sensorless') err('sensorless_unsupported', 'Sensorless homing is not set up for delta printers here; use the tower endstop switches (Homing step).');
    for (const [name, axis] of [['stepper_a', 'A'], ['stepper_b', 'B'], ['stepper_c', 'C']] as const) {
      const s = byName(name);
      if (s) s.endstop = pickEndstop(s, axis);
    }
  }
  for (const [name, axis] of (delta ? [] : [['stepper_x', 'X'], ['stepper_y', 'Y']]) as Array<[string, string]>) {
    const s = byName(name)!;
    if (homingXY === 'physical') {
      s.endstop = pickEndstop(s, axis);
    } else {
      const chip = db.drivers.chips[s.driver.chip];
      if (s.driver.standalone) err('sensorless_unsupported', `${board.name}: the ${s.slot} driver is standalone (Klipper cannot talk to it), so sensorless homing is not possible for ${name}. Use endstop switches (Homing step).`);
      else if (!chip.sensorless) err('sensorless_unsupported', `The ${s.driver.chip} driver on ${s.slot} cannot sense the motor stalling (no StallGuard), so sensorless homing is not possible for ${name}.`);
      else if (!s.driver.diag) err('sensorless_no_diag', `${board.name}: no stall-detect (DIAG) line is known for socket ${s.slot}, so sensorless homing is not possible for ${name}. Use endstop switches.`);
      s.endstop = 'virtual';
      sensorlessSlots.add(s.slot);
      homingCurrent[name] = r2(s.runCurrent * 0.7);
    }
  }
  if (homingXY === 'sensorless') {
    for (const s of steppers) if (s.pairsWith) homingCurrent[s.name] = r2(s.runCurrent * 0.7);
  }
  const zs = byName('stepper_z');
  if (!zs) {
    // delta: towers handled above
  } else if (build.homing.z === 'probe_virtual_endstop') {
    zs.endstop = 'probe';
  } else {
    zs.endstop = pickEndstop(zs, 'Z');
    if (build.homing.z === 'nozzle_switch' && !build.homing.zSwitchXY) {
      err('no_z_switch_xy', 'Enter the Z switch position on the Homing step. Homing at a guessed position could drive the nozzle into the bed.');
    }
    const sw = build.homing.zSwitchXY;
    const min = printer.defaults.stepper_xy.position_min;
    if (sw && (sw[0] < min || sw[1] < min || sw[0] > size.position_max.x || sw[1] > size.position_max.y)) {
      err('z_switch_out_of_range', `The Z switch position (${sw.join(', ')}) is outside the area the nozzle can reach (${size.position_max.x} x ${size.position_max.y} mm). Check it on the Homing step.`);
    }
  }

  // --- heaters and thermistors ------------------------------------------
  const pick = (list: Rec[], pred: (x: Rec) => boolean) => list.find(pred);
  const thermHotend = db.thermistors[build.thermistors.hotend];
  const thermBed = db.thermistors[build.thermistors.bed];
  if (!thermHotend) throw new PlanError('unknown_thermistor', `Unknown hotend thermistor "${build.thermistors.hotend}"`);
  const heatedBed = printer.heated_bed !== false;
  if (!thermBed && heatedBed) throw new PlanError('unknown_thermistor', `Unknown bed thermistor "${build.thermistors.bed}"`);
  for (const t of heatedBed ? [thermHotend, thermBed] : [thermHotend]) {
    if (t.custom_definition_required && !t.definition) err('custom_thermistor', `${t.label} needs a custom [thermistor] definition, which the data does not have yet.`);
    if (t.needs) err('thermistor_hw', `${t.label} needs extra hardware (${t.needs.join('; ')}), which the generator does not configure yet.`);
  }
  const mbHeaters: Rec[] = board.heaters;
  const mbTherms: Rec[] = board.thermistors;
  const bedHeaterRec = heatedBed ? need(pick(mbHeaters, (h) => h.role === 'bed'), 'no_bed_heater', `${board.name} has no bed heater output.`) : undefined;
  const isBedTherm = (t: Rec) => t.typical_use === 'bed' || ['TB', 'THB'].includes(t.id);
  const bedThermRec = heatedBed ? pick(mbTherms, isBedTherm) ?? mbTherms[1] : undefined;
  const usedTherm = new Set<string>(bedThermRec ? [bedThermRec.id] : []);
  let hotendHeater: PortUse, hotendSensor: PortUse & { pullup: number };
  if (toolboard) {
    const h = toolboard.heaters[0];
    const t = pick(toolboard.thermistors, (x) => x.typical_use === 'hotend')!;
    hotendHeater = { board: 'toolboard', port: h.id, pin: qpin('toolboard', h.pin), maxPower: h.max_power };
    hotendSensor = { board: 'toolboard', port: t.id, pin: qpin('toolboard', t.pin), pullup: t.pullup_ohms ?? 4700 };
  } else {
    const h = need(pick(mbHeaters, (x) => x.role === 'hotend'), 'no_hotend_heater', `${board.name} has no hotend heater output.`);
    const t = need(pick(mbTherms, (x) => !isBedTherm(x) && !usedTherm.has(x.id)), 'no_thermistor', 'No free thermistor port for the hotend.');
    usedTherm.add(t.id);
    hotendHeater = h.pins
      ? { board: 'mainboard', port: h.id, pin: 'multi_pin:hotend_heater', multi: { name: 'hotend_heater', pins: h.pins.map((x: string) => qpin('mainboard', x)) }, maxPower: h.max_power }
      : { board: 'mainboard', port: h.id, pin: qpin('mainboard', h.pin), maxPower: h.max_power };
    hotendSensor = { board: 'mainboard', port: t.id, pin: qpin('mainboard', t.pin), pullup: t.pullup_ohms ?? 4700 };
  }
  let chamberSensor: (PortUse & { pullup?: number }) | undefined;
  let thermChamber: Rec | undefined;
  if (build.thermistors.chamber) {
    thermChamber = db.thermistors[build.thermistors.chamber];
    if (!thermChamber) err('unknown_thermistor', `Unknown chamber thermistor "${build.thermistors.chamber}"`);
    const tbChamber = toolboard && !tcRec && pick(toolboard.thermistors, (x) => x.typical_use === 'chamber');
    if (tbChamber) {
      chamberSensor = { board: 'toolboard', port: tbChamber.id, pin: qpin('toolboard', tbChamber.pin), pullup: tbChamber.pullup_ohms };
    } else {
      const t = pick(mbTherms, (x) => !usedTherm.has(x.id) && !isBedTherm(x));
      if (t) { usedTherm.add(t.id); chamberSensor = { board: 'mainboard', port: t.id, pin: qpin('mainboard', t.pin), pullup: t.pullup_ohms }; }
      else err('no_thermistor', 'No free thermistor port for the chamber sensor.');
    }
  }
  const maxTemp = hotendMaxTemp(hotend, thermHotend);

  // --- fans ----------------------------------------------------------------
  const usedFans: Record<BoardKind, Set<string>> = { mainboard: new Set(), toolboard: new Set() };
  const roleCount: Record<string, number> = {};
  const fans: FanPlan[] = [];
  for (const f of build.fans) {
    const role = db.fanRoles[f.role];
    if (!role) { err('unknown_fan_role', `Unknown fan role "${f.role}"`); continue; }
    let kind: BoardKind = f.board ?? (role.prefer_board === 'toolboard' && toolboard ? 'toolboard' : 'mainboard');
    if (kind === 'toolboard' && !toolboard) { err('no_toolboard', `Fan "${f.role}" is set to the toolhead board, but none is selected.`); kind = 'mainboard'; }
    const ports: Rec[] = kind === 'toolboard' ? toolboard!.fans : board.fans;
    // A port meant for this role (stock wiring, e.g. Ender 3 S1 hotend fan on PC0) comes first.
    const port = f.port ? ports.find((p) => p.id === f.port)
      : ports.find((p) => p.typical_use === f.role && !usedFans[kind].has(p.id)) ?? ports.find((p) => !p.typical_use && !usedFans[kind].has(p.id)) ?? ports.find((p) => !usedFans[kind].has(p.id));
    if (!port) { err('no_fan_port', `No ${f.port ? `port ${f.port}` : 'free fan port'} on the ${kind} for "${f.role}".`); continue; }
    if (usedFans[kind].has(port.id)) { err('fan_port_taken', `${port.id} on the ${kind} is used for two fans.`); continue; }
    usedFans[kind].add(port.id);
    roleCount[f.role] = (roleCount[f.role] ?? 0) + 1;
    let section: string = role.klipper_section;
    if (f.name) section = `${section.split(' ')[0]} ${f.name}`;
    else if (roleCount[f.role] > 1) {
      if (section === 'fan') { err('two_part_fans', 'Klipper has one part-cooling fan output; wire both fans to one port.'); continue; }
      section = `${section}_${roleCount[f.role]}`;
    }
    if (f.tachometer && !port.tachometer_pin) warn('no_tach', `${port.id} on the ${kind} has no fan-speed (tachometer) input, so that setting is ignored.`);
    const tach = f.tachometer && port.tachometer_pin ? qpin(kind, port.tachometer_pin) : undefined;
    const multiName = `${f.role}_${kind}`.replace(/[^a-z0-9_]/gi, '_');
    fans.push({
      // Without a heated bed, fans that follow the bed (electronics, exhaust) follow the hotend.
      role: f.role, section, defaults: !heatedBed && role.defaults.heater === 'heater_bed' ? { ...role.defaults, heater: 'extruder' } : role.defaults, board: kind, port: port.id,
      pin: port.pins ? `multi_pin:${multiName}` : qpin(kind, port.pin), tach,
      multi: port.pins ? { name: multiName, pins: port.pins.map((x: string) => qpin(kind, x)) } : undefined,
      enable: port.enable_pin ? qpin(kind, port.enable_pin) : undefined,
      options: tach && port.tachometer_ppr ? { ...port.klipper, tachometer_ppr: port.tachometer_ppr } : port.klipper,
    });
  }
  // Nevermore filter: a fan_generic on the mainboard plus print start/end behaviour.
  let nevermore: Plan['nevermore'];
  if (build.nevermore) {
    const nm = build.nevermore;
    const model = db.filters[nm.model];
    if (!model) err('unknown_filter', `Unknown filter "${nm.model}"`);
    else if (fans.some((f) => f.section === 'fan_generic nevermore')) err('nevermore_twice', 'The Nevermore is set up twice (as a fan and as the air filter); keep one.');
    else {
      addLinks(model.docs, 'filter');
      const port = nm.port ? board.fans.find((p: Rec) => p.id === nm.port) : board.fans.find((p: Rec) => !usedFans.mainboard.has(p.id));
      if (!port || usedFans.mainboard.has(port.id)) err('no_fan_port', `No ${nm.port ? `free port ${nm.port}` : 'free fan port'} on the mainboard for the ${model.name}.`);
      else {
        usedFans.mainboard.add(port.id);
        const voltage = nm.voltage ?? model.voltage_options[0];
        if (!model.voltage_options.includes(voltage)) err('filter_voltage', `${model.name} fans run at ${model.voltage_options.join(' or ')} V, not ${voltage} V.`);
        if (port.voltage_options && !port.voltage_options.includes(voltage)) {
          err('fan_port_voltage', `${port.id} on the ${board.name} can only give ${port.voltage_options.join(' or ')} V, but the ${model.name} needs ${voltage} V. Use another port, or power the filter from its own ${voltage} V supply switched by a MOSFET module.`);
        }
        if (model.min_supply_a) warn('filter_current', `The ${model.name} draws up to ${model.min_supply_a} A at ${voltage} V (maker's figure), more than most board fan ports can give (the Leviathan's give 0.5 A). Check your port's rating, or run the filter through a MOSFET module.`);
        const d = db.filterDefaults;
        const fan: FanPlan = { role: 'nevermore', section: 'fan_generic nevermore', defaults: db.fanRoles.nevermore.defaults, board: 'mainboard', port: port.id, pin: qpin('mainboard', port.pin), voltage };
        fans.push(fan);
        nevermore = { model, mode: nm.mode ?? d.mode, threshold: d.hot_bed_threshold_c, speed: nm.speed ?? d.speed, postMinutes: nm.postPrintMinutes ?? d.post_print_minutes, fan };
      }
    }
  }
  // hotend_fan: always_on (wired to 24 V) or controller_fan (one fan cools hotend and board: Neptune 4).
  if (!fans.some((f) => f.role === 'hotend') && !printer.hotend_fan) err('no_hotend_fan', 'Add a hotend fan (Fans step). Without it, heat creeps up the hotend and jams the filament.');

  // --- probe ---------------------------------------------------------------
  let probe: Plan['probe'];
  let bltouch: Plan['bltouch'];
  const extraMcus: McuInfo[] = [];
  if (build.probe) {
    const p = need(db.probes[build.probe], 'unknown_probe', `Unknown probe "${build.probe}"`);
    addLinks(p.docs, 'probe');
    const known = p.defaults ?? p.offsets;
    const offset = build.probeOffset ?? { x: known?.x_offset ?? 0, y: known?.y_offset ?? 0 };
    if (!build.probeOffset && !known) warn('probe_offset_default', `The ${p.name}'s offset from the nozzle depends on how it is mounted, so 0, 0 is used for now. Measure it (Klipper's probe calibration guide), enter it on the Homing step, then calibrate again.`);
    if (p.kind === 'eddy_native') {
      if (p.interface === 'toolboard_i2c') {
        // Eddy Coil: an LDC1612 on the toolhead board's I2C header, driven by that board's MCU.
        const port = toolboard?.i2c_ports?.[0];
        if (!toolboard) err('probe_needs_toolboard', `${p.name} connects to a toolhead board's I2C header; select a toolhead board.`);
        else if (!port) {
          err('probe_needs_i2c', Array.isArray(toolboard.i2c_ports)
            ? `${toolboard.name} has no I2C header, so the ${p.name} cannot connect to it (manufacturer pin diagram). Use the BTT Eddy USB, or a toolhead board with an I2C header.`
            : `${p.name} connects to a toolhead board's I2C header, and ${toolboard.name} has no I2C header recorded yet.`);
        }
        else {
          probe = { ...p, offset, connection: 'toolboard_i2c', i2c: { mcu: TOOLHEAD_MCU, bus: port.bus, port } };
          addLinks([KLIPPER_DOCS.eddy], 'probe');
        }
      } else {
        const conn = build.probeConnection ?? (Array.isArray(p.interface) ? p.interface[0] : p.interface);
        const ifaces = Array.isArray(p.interface) ? p.interface : [p.interface];
        if (!ifaces.includes(conn)) err('probe_connection', `${p.name} supports ${ifaces.join(', ')}, not ${conn}.`);
        if (conn === 'can' && build.mainboard.connection !== 'usb-can-bridge' && !build.canAdapter) {
          err('no_can_path', `${p.name} on CAN needs a path to your Pi: set the mainboard to "USB-CAN bridge", or use a separate USB-CAN adapter.`);
        }
        extraMcus.push({ name: p.mcu.name, chip: p.mcu.chip, what: p.name, klipperCheck: true });
        probe = { ...p, offset, connection: conn };
        addLinks([KLIPPER_DOCS.eddy], 'probe');
      }
    } else if (p.kind === 'eddy_plugin') {
      extraMcus.push({ name: 'beacon', chip: 'beacon', what: p.name, klipperCheck: false });
      if (build.homing.z === 'probe_virtual_endstop' && build.homing.xy === 'sensorless') {
        err('beacon_sensorless', `The ${p.name} can't home Z together with sensorless X/Y homing yet. Use endstop switches for X/Y, or home Z another way.`);
      }
      warn('plugin_required', `The ${p.name} needs its maker's Klipper plugin installed on your printer (${p.plugin.repo}).`);
      probe = { ...p, offset };
    } else if (p.kind === 'servo_pin') {
      const src = toolboard?.bltouch ? { b: 'toolboard' as BoardKind, d: toolboard.bltouch } : board.bltouch ? { b: 'mainboard' as BoardKind, d: board.bltouch } : undefined;
      if (!src) err('no_bltouch_port', 'Neither of your boards has a BLTouch connector. Choose another probe, or a board with one.');
      else bltouch = { board: src.b, sensor: qpin(src.b, src.d.sensor_pin, '^'), control: qpin(src.b, src.d.control_pin) };
      probe = { ...p, offset };
    } else {
      // Inductive probes go on the mainboard PROBE port (Voron); contact probes on the toolhead.
      const preferTool = !['inductive', 'integrated'].includes(p.kind);   // a printer's built-in probe uses the board's own input
      const tPort = toolboard?.probe_ports?.[0];
      const mPort = board.probe_ports?.[0];
      const use = preferTool && tPort ? { b: 'toolboard' as BoardKind, port: tPort } : mPort ? { b: 'mainboard' as BoardKind, port: mPort } : tPort ? { b: 'toolboard' as BoardKind, port: tPort } : undefined;
      if (!use) err('no_probe_port', `Your boards have no free input for the ${p.name}.`);
      checkProbeSupply(p, use?.port, use?.b ?? 'mainboard', use?.b === 'toolboard' ? toolboard : board);
      if (p.id === 'voron-tap' && use?.b === 'toolboard') tapSignalWarning(toolboard!);
      let mods: string;
      let output: string | undefined;
      if (p.kind === 'inductive') {
        output = p.output ?? build.probeOutput;
        if (!output) err('probe_output_needed', `Choose your inductive probe's output type on the Homing step (NPN or PNP, NO or NC). It is printed on the probe or its listing.`);
        if (output?.startsWith('pnp') && use && !use.port.pnp_capable) {
          err('pnp_unsupported_port', `The ${p.name} is a PNP probe: when triggered it sends out its full 12-24 V, and ${use.port.id} on the ${use.b} isn't known to accept that. Use an NPN probe, or a board whose probe port has a PNP setting.`);
        }
        // A probe whose polarity its maker documents (RatOS: ^probe_pin for SuperPINDA-type NPN NC)
        // wins; otherwise the port modifier, which is for the NC reference probe. NO flips the inversion.
        const base = p.pin_modifier ?? use?.port.modifier ?? '^';
        mods = output?.endsWith('-no') ? (base.includes('!') ? base.replace('!', '') : base + '!') : base;
        if (output?.endsWith('-no')) warn('probe_no', `${p.name} is normally open (NO): if its wire breaks, Klipper thinks the bed is still far away and the nozzle can crash. Voron recommends normally closed (NC) probes.`);
        if (use && !use.port.modifier && !p.pin_modifier) warn('probe_modifier_default', `No source says how ${use.port.id} on the ${use.b} reads the probe, so "${mods}" is used. Before homing, run QUERY_PROBE: it must say "open" away from the bed and "TRIGGERED" near metal.`);
        if (use && !use.port.protected) warn('probe_voltage', `${use.port.id} is not known to handle 12-24 V, and inductive probes send out their supply voltage. Add a BAT85 diode in the signal wire (black band toward the probe), as in Voron's wiring guide, or use a protected probe port.`);
        if (use?.port.pnp_capable) warn('probe_port_jumper', `Set the ${use.port.id} jumper to ${output?.startsWith('pnp') ? 'PNP' : 'NPN'} to match the probe.`);
      } else {
        mods = use?.port.modifier ?? p.pin_modifier ?? '^';
      }
      probe = { ...p, offset, output, port: use && { board: use.b, port: use.port.id, pin: qpin(use.b, use.port.pin, mods) } };
      if (p.needs_macros) warn('probe_macros', `The ${p.name} needs its own pick-up and dock macros, which this tool doesn't write. Install them from the probe's instructions.`);
    }
    if (build.homing.z === 'probe_virtual_endstop' && !p.z_endstop_capable && !delta) {
      err('probe_not_z_endstop', `The ${p.name} cannot set Z zero. Choose a nozzle switch or Z endstop switch for Z homing.`);
    }
  } else if (tcRec && !shuttle) {
    // Each tool's Tap sensor is the probe; Klipper sees one probe object (tool_probe_endstop).
    probe = { id: 'tool_probe', name: 'Tap sensor on each tool ([tool_probe])', kind: 'tool_probe', z_endstop_capable: true, offset: { x: 0, y: 0 } };
  } else if (build.homing.z === 'probe_virtual_endstop' && !delta) {
    err('no_probe', 'Z homing with a probe needs a probe: choose one on the Homing step.');
  }
  if (printer.z_leveling && !build.probe && !tcRec) err('no_probe_for_leveling', `${printer.name} needs a probe to level its ${printer.z_leveling === 'quad_gantry_level' ? 'gantry' : 'bed'}: choose one on the Homing step.`);

  // --- accelerometer, LEDs -------------------------------------------------
  const accel = toolboard?.accelerometer ? { ...toolboard.accelerometer, board: 'toolboard' as BoardKind } : undefined;
  let leds: Plan['leds'];
  if (build.leds && toolhead?.leds) {
    const port = toolboard?.neopixel_ports?.[0];
    if (!port) warn('no_led_port', 'The toolhead LEDs need an RGB port on the toolhead board, and this one has none, so they are left out.');
    else leds = { board: 'toolboard', port: port.id, pin: qpin('toolboard', port.pin), chain: toolhead.leds.chain_count, order: toolhead.leds.color_order };
  }

  // --- autotune and tuning baselines --------------------------------------
  if (build.autotune) {
    if (steppers.every((s) => s.driver.standalone)) warn('autotune_standalone', 'klipper_tmc_autotune needs TMC drivers on UART/SPI; every driver here is standalone, so it is skipped.');
    for (const s of steppers) {
      if (s.driver.standalone) continue;
      const at = db.drivers.chips[s.driver.chip].autotune;
      if (at !== 'supported') warn('autotune_untested', `The klipper_tmc_autotune plugin lists its support for the ${s.driver.chip} (${s.name}) as "${at}".`);
    }
  }
  const flow = db.flowClasses[hotend.flow_class]?.pa_offset ?? 0;
  const paBaseline = r2((extruder.pa_baseline?.start ?? 0.04) + flow);
  if ((build.nozzleDiameter ?? 0.4) !== 0.4) warn('pa_nozzle', 'The starting pressure advance value assumes a 0.4 mm nozzle; tune it for yours (TUNE_PA).');

  // --- toolchanger: one ToolPlan per tool ---------------------------------
  let tools: ToolPlan[] | undefined;
  let toolchanger: Plan['toolchanger'];
  if (tcSpec && tcRec && toolboard) {
    const tapMods = db.probes['voron-tap']?.pin_modifier ?? '^';
    const probePort = (tb: Rec, n: number, mcuName: string): PortUse => {
      const port = tb.probe_ports?.[0];
      if (!port) {
        err('no_probe_port', `T${n}: ${tb.name} has no probe input for the Tap sensor.`);
        return { board: 'toolboard', port: '?', pin: '?' };
      }
      checkProbeSupply(db.probes['voron-tap'], port, 'toolboard', tb);
      tapSignalWarning(tb, `T${n}: `);
      return { board: 'toolboard', port: port.id, pin: qpin('toolboard', port.pin, port.modifier ?? tapMods, mcuName) };
    };
    const toolFan = (f: FanPlan, n: number): FanPlan => ({
      ...f,
      section: f.role === 'part_cooling' ? `fan_generic T${n}_partfan` : `heater_fan T${n}_hotend_fan`,
      defaults: f.role === 'hotend' ? { ...f.defaults, heater: extruderName(n) } : f.defaults,
    });

    // T0: the main toolhead already planned above. Its toolboard fans move into the tool.
    const t0Fans = fans.filter((f) => f.board === 'toolboard');
    for (const f of t0Fans) {
      if (!['part_cooling', 'hotend'].includes(f.role)) err('toolchanger_fan_board', `Fan "${f.role}" is on T0's board; only the part cooling and hotend fans travel with a tool. Put it on the mainboard.`);
    }
    for (const role of ['part_cooling', 'hotend']) {
      if (!t0Fans.some((f) => f.role === role)) err('toolchanger_fan_board', `The ${role.replace('_', ' ')} fan must be on the tool's board on a toolchanger (each tool has its own).`);
    }
    fans.splice(0, fans.length, ...fans.filter((f) => f.board !== 'toolboard'));
    const t0Conn = build.toolboard!.connection ?? (toolboard.interfaces.includes('can') ? 'can' : 'usb');
    tools = [{
      n: 0, mcu: toolMcu(0), toolboard, connection: t0Conn, extruderSection: 'extruder',
      stepper: steppers.find((s) => s.group === 'extruder')!,
      extruder, hotend, thermistor: thermHotend, heater: hotendHeater, sensor: hotendSensor, maxTemp, paBaseline,
      fans: t0Fans.filter((f) => ['part_cooling', 'hotend'].includes(f.role)).map((f) => toolFan(f, 0)),
      probe: probePort(toolboard, 0, toolMcu(0)), accel, leds, dock: tcSpec.docks?.[0] ?? undefined,
    }];

    tcSpec.tools.forEach((spec, i) => {
      const n = i + 1;
      const mcuName = toolMcu(n);
      const tb = need(db.toolboards[spec.toolboard.id], 'unknown_toolboard', `T${n}: unknown toolhead board "${spec.toolboard.id}"`);
      const conn = spec.toolboard.connection ?? (tb.interfaces.includes('can') ? 'can' : 'usb');
      if (!tb.interfaces.includes(conn)) err('toolboard_connection', `T${n}: ${tb.name} can't connect by ${conn.toUpperCase()}; choose its other connection.`);
      if (conn === 'can' && build.mainboard.connection !== 'usb-can-bridge' && !build.canAdapter) {
        err('no_can_path', `T${n}: ${tb.name} connects over CAN, which needs a path to your Pi: set the mainboard to "USB-CAN bridge", or use a separate USB-CAN adapter.`);
      }
      if (tb.status !== 'reviewed') warn('board_needs_review', `T${n}: ${tb.name}'s pin list comes from a single source ("needs review"). Check the pins against the board's own pin diagram before powering on.`);
      addLinks(repoLink(tb, 'manufacturer docs and pinout'), 'toolhead board');
      const ext = need(db.extruders[spec.extruder ?? build.extruder], 'unknown_extruder', `T${n}: unknown extruder "${spec.extruder}"`);
      const he = need(db.hotends[spec.hotend ?? build.hotend], 'unknown_hotend', `T${n}: unknown hotend "${spec.hotend}"`);
      const th = need(db.thermistors[spec.hotendThermistor ?? build.thermistors.hotend], 'unknown_thermistor', `T${n}: unknown thermistor "${spec.hotendThermistor}"`);
      if (th.custom_definition_required && !th.definition) err('custom_thermistor', `T${n}: ${th.label} needs a custom [thermistor] definition, which the data does not have yet.`);
      if (th.needs) err('thermistor_hw', `T${n}: ${th.label} needs extra hardware (${th.needs.join('; ')}), which the generator does not configure yet.`);
      if (toolhead?.compatible_extruders && !toolhead.compatible_extruders.includes(ext.id)) {
        warn('tool_extruder_fit', `T${n}: ${ext.name} is not listed as fitting the ${toolhead.name}.`);
      }
      addLinks(ext.docs, 'extruder');
      const motorId: string | undefined = spec.extruderMotor ?? (spec.extruder ? ext.recommended_motor : build.motors.extruder ?? ext.recommended_motor);
      const motor = motorId ? db.motors[motorId.toLowerCase()] : undefined;
      if (motorId && !motor) warn('unknown_motor', `T${n}: motor "${motorId}" is not in the motor list, so its current uses the printer's default and autotune skips it.`);
      const d = tb.extruder_driver;
      const stepper = buildStepper({ klipper: extruderName(n), role: 'E' }, {
        id: 'extruder', step_pin: d.step_pin, dir_pin: d.dir_pin, enable_pin: d.enable_pin,
        uart_pin: d.uart_pin, tx_pin: d.tx_pin, uart_address: d.uart_address, spi_cs_pin: d.spi_cs_pin, spi_bus: d.spi_bus, spi_software: d.spi_software,
        onboard_driver: { chip: d.chip, klipper_section: db.drivers.chips[d.chip].klipper_section, sense_resistor: d.sense_resistor, rref: d.rref_ohms },
      }, 'toolboard', 'extruder', { extruder: ext, motor, mcu: mcuName });
      steppers.push(stepper);
      const h = tb.heaters[0];
      const t = pick(tb.thermistors, (x) => x.typical_use === 'hotend')!;
      const toolMax = hotendMaxTemp(he, th, `T${n}: `);
      // Same fan ports as T0 when the board has them, so every tool is wired alike.
      const used = new Set<string>();
      const toolFans: FanPlan[] = [];
      for (const f0 of tools![0].fans) {
        const port = tb.fans.find((p: Rec) => p.id === f0.port && !used.has(p.id)) ?? tb.fans.find((p: Rec) => !used.has(p.id));
        if (!port) { err('no_fan_port', `T${n}: no free fan port on ${tb.name} for the ${f0.role.replace('_', ' ')} fan.`); continue; }
        used.add(port.id);
        toolFans.push(toolFan({ ...f0, port: port.id, pin: qpin('toolboard', port.pin, '', mcuName), tach: undefined,
          enable: port.enable_pin ? qpin('toolboard', port.enable_pin, '', mcuName) : undefined, options: port.klipper }, n));
      }
      let toolLeds: ToolPlan['leds'];
      if (build.leds && toolhead?.leds) {
        const port = tb.neopixel_ports?.[0];
        if (!port) warn('no_led_port', `T${n}: the LEDs need an RGB port on ${tb.name}, and it has none, so they are left out.`);
        else toolLeds = { board: 'toolboard', port: port.id, pin: qpin('toolboard', port.pin, '', mcuName), chain: toolhead.leds.chain_count, order: toolhead.leds.color_order };
      }
      tools!.push({
        n, mcu: mcuName, toolboard: tb, connection: conn, extruderSection: extruderName(n), stepper,
        extruder: ext, hotend: he, thermistor: th,
        heater: { board: 'toolboard', port: h.id, pin: qpin('toolboard', h.pin, '', mcuName), maxPower: h.max_power },
        sensor: { board: 'toolboard', port: t.id, pin: qpin('toolboard', t.pin, '', mcuName), pullup: t.pullup_ohms ?? 4700 },
        maxTemp: toolMax,
        paBaseline: r2((ext.pa_baseline?.start ?? 0.04) + (db.flowClasses[he.flow_class]?.pa_offset ?? 0)),
        fans: toolFans, probe: probePort(tb, n, mcuName),
        accel: tb.accelerometer ? { ...tb.accelerometer } : undefined, leds: toolLeds,
        dock: tcSpec.docks?.[n] ?? undefined,
      });
    });

    const missing = tools.filter((t) => !t.dock).map((t) => `T${t.n}`);
    if (missing.length) {
      warn('tool_dock_unset', `No dock position for ${missing.join(', ')} yet. Tool changes to and from ${missing.length > 1 ? 'them' : 'it'} are refused until you measure it with TC_DOCK_ALIGN_START / TC_DOCK_ALIGN_SAVE (toolchanger.cfg) or enter it here. ${tcRec.dock_z_rule}.`);
    }
    if (tcSpec.safeY === undefined) {
      warn('toolchanger_safe_y', `No safe Y set. Tool changes are refused until it is: ${tcRec.safe_y_rule} (StealthChanger wiki).`);
    }
    // Docks sit outside the print area; Klipper only moves inside the stepper limits.
    const yMin = tcSpec.travel?.yMin ?? printer.defaults.stepper_xy.position_min;
    const zMax = tcSpec.travel?.zMax ?? size.position_max.z;
    const pathZ = Math.max(...[...tcRec.dropoff_path, ...tcRec.pickup_path].map((q: Rec) => q.z ?? 0));
    warn('toolchanger_travel', `The docks sit outside the normal print area, and Klipper only moves where it's allowed to (Y down to ${yMin}, Z up to ${zMax} right now). Set "Y travel minimum" and "Z travel maximum" on the Homing step to what your printer can really reach before measuring the docks.`);
    for (const t of tools) {
      if (!t.dock) continue;
      if (t.dock.y < yMin) err('dock_out_of_range', `T${t.n}'s dock (Y ${t.dock.y}) is further forward than Klipper may move (Y ${yMin}). Set "Y travel minimum" to ${t.dock.y} or lower on the Homing step.`);
      if (t.dock.z + pathZ > zMax) err('dock_out_of_range', `T${t.n}'s dock (Z ${t.dock.z}, plus ${pathZ} mm for the docking move) is higher than Klipper may move (Z ${zMax}). Set "Z travel maximum" to at least ${r2(t.dock.z + pathZ)} on the Homing step.`);
    }
    if (tcSpec.safeY !== undefined && tcSpec.safeY > size.position_max.y) err('safe_y_out_of_range', `Safe Y (${tcSpec.safeY}) is further than Y can travel (${size.position_max.y} mm).`);
    const docked = tools.filter((t) => t.dock).map((t) => t.dock!.y);
    toolchanger = {
      rec: tcRec, safeY: tcSpec.safeY, yMin: tcSpec.travel?.yMin, zMax: tcSpec.travel?.zMax, zProbe: shuttle ? 'shuttle' : 'per_tool',
      closeY: docked.length === tools.length ? r2(Math.max(...docked) + tcRec.close_y_offset) : undefined,
    };
    if (tools.some((t) => t.connection === 'can')) addLinks([KLIPPER_DOCS.canbus], 'wiring');
  }

  return {
    build, printer, size, variant, board, mcu, toolboard, toolhead, steppers, extruder, hotend,
    hotendHeater, hotendSensor,
    bedHeater: bedHeaterRec && { board: 'mainboard', port: bedHeaterRec.id, pin: qpin('mainboard', bedHeaterRec.pin) },
    bedSensor: bedThermRec && { board: 'mainboard', port: bedThermRec.id, pin: qpin('mainboard', bedThermRec.pin), pullup: bedThermRec.pullup_ohms ?? 4700 },
    chamberSensor, thermistor: { hotend: thermHotend, bed: heatedBed ? thermBed : undefined, chamber: thermChamber }, maxTemp,
    fans, probe, bltouch, accel, leds, paBaseline, nevermore, homingCurrent, issues,
    links: finishLinks(),
    mcus: [
      { name: 'mcu', chip: mcu.build_as ?? mcu.chip, checkDict: mcu.check_dict, what: board.name, klipperCheck: true },
      ...(tools
        ? tools.map((t) => ({ name: t.mcu, chip: t.toolboard.mcu.chip, checkDict: t.toolboard.mcu.check_dict, what: `T${t.n}: ${t.toolboard.name}`, klipperCheck: true }))
        : toolboard ? [{ name: TOOLHEAD_MCU, chip: toolboard.mcu.chip, checkDict: toolboard.mcu.check_dict, what: toolboard.name, klipperCheck: true }] : []),
      ...extraMcus,
    ],
    tools, toolchanger,
  };

  function finishLinks(): Link[] {
    if (build.homing.xy === 'sensorless') addLinks([KLIPPER_DOCS.tmcSensorless], 'homing');
    if (build.autotune) addLinks([{ title: 'klipper_tmc_autotune (install + options)', url: 'https://github.com/andrewmcgr/klipper_tmc_autotune' }], 'drivers');
    if (toolboard && (build.toolboard!.connection ?? 'can') === 'can') addLinks([KLIPPER_DOCS.canbus], 'wiring');
    if (build.probe) addLinks([KLIPPER_DOCS.probeCalibrate], 'probe');
    addLinks([KLIPPER_DOCS.bedLevel], 'z offset');
    addLinks([KLIPPER_DOCS.pressureAdvance], 'tuning');
    addLinks([accel ? KLIPPER_DOCS.resonances : KLIPPER_DOCS.inputShaper], 'tuning');
    return links;
  }
}

export class PlanError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
