// Build spec: everything the user chooses in the wizard. Ids refer to records
// in data/. Optional fields fall back to printer/toolhead defaults.

export type Interface = 'uart' | 'spi' | 'standalone';
export type Connection = 'usb' | 'can' | 'usb-can-bridge' | 'usb-serial';   // usb-serial: USB through an on-board CH340-type chip

export interface DriverChoice {
  module: string;            // drivers.yaml modules[].id, e.g. "btt-tmc2209"
  interface?: Interface;     // only needed when the chip supports both (TMC2240)
}

export interface FanSpec {
  role: string;              // fans.yaml roles key
  board?: 'mainboard' | 'toolboard';
  port?: string;             // board fans[].id; auto-assigned when omitted
  name?: string;             // section name override, e.g. "nevermore_left"
  tachometer?: boolean;      // fan has a tach wire and the port has a tach pin
}

export interface Build {
  printer: string;
  size: string;
  variant?: string;                          // "standard" (default) | "awd"
  mainboard: {
    id: string;
    mcu?: string;                            // mcu_variants[].chip; default first
    connection: Connection;
    bootloaderKib?: number;                  // override when the board was reflashed
    extensions?: string[];                   // mainboard extensions[].id, e.g. ldo-leviathan-ext
  };
  toolboard?: { id: string; connection?: 'can' | 'usb' };
  canAdapter?: 'u2c' | null;                 // separate USB-CAN adapter instead of bridge mode
  drivers: { xy: DriverChoice; z: DriverChoice; extruder?: DriverChoice };
  motors: { xy: string; z: string; extruder?: string };
  runCurrent?: { xy?: number; z?: number; extruder?: number };
  zDrive?: string;                           // extruders.yaml z_drives[].id (Voron 2.4)
  leadscrew?: string;                        // printer leadscrew_options[].id (Trident)
  homing: {
    xy: 'physical' | 'sensorless';
    z: 'nozzle_switch' | 'probe_virtual_endstop' | 'physical_min';
    zSwitchXY?: [number, number];            // nozzle switch position, required for nozzle_switch
  };
  probe?: string;
  probeOffset?: { x: number; y: number };
  probeOutput?: 'npn-nc' | 'npn-no' | 'pnp-nc' | 'pnp-no';   // inductive probes with unknown output
  probeConnection?: 'usb' | 'can';                           // probes with their own MCU (Cartographer)
  toolhead?: string;
  extruder: string;
  hotend: string;
  thermistors: { hotend: string; bed: string; chamber?: string };
  bed?: { maxPower?: number; maxTemp?: number };
  fans: FanSpec[];
  nevermore?: {
    model: string;                           // filters.yaml id
    voltage?: 12 | 24;                       // fan voltage (sets the port jumper reminder)
    port?: string;                           // mainboard fan port; auto when omitted
    mode?: 'always' | 'hot_bed';             // hot_bed: only when the bed target is above the threshold
    speed?: number;                          // 0-1
    postPrintMinutes?: number;               // keep filtering after the print
  };
  leds?: boolean;
  beeps?: boolean;                           // buzzer tunes at print end / pause; default on when a buzzer exists
  autotune?: boolean;
  webUi?: 'mainsail' | 'fluidd' | 'none';    // default mainsail: its cfg provides PAUSE/RESUME/CANCEL_PRINT
  nozzleDiameter?: number;
  slotOverrides?: Record<string, string>;    // klipper stepper name -> slot id
  toolchanger?: ToolchangerSpec;
}

// Toolchanger (StealthChanger). T0 is the main toolhead described above
// (toolboard, extruder, hotend, thermistors.hotend, motors.extruder); tools lists T1..Tn.
export interface ToolchangerSpec {
  system: string;                            // toolchangers.yaml id
  tools: ToolSpec[];
  docks?: Array<Dock | null>;                // index = tool number (T0 first); measured with TC_DOCK_* macros
  safeY?: number;                            // StealthChanger wiki: park_y + thickest tool + buffer
  zProbe?: 'per_tool' | 'shuttle';           // per_tool: each tool's Tap ([tool_probe]); shuttle: one eddy probe (build.probe) on the shuttle
  travel?: { yMin?: number; zMax?: number };  // stepper_y position_min / stepper_z position_max that reach the docks
}

export interface ToolSpec {
  toolboard: { id: string; connection?: 'can' | 'usb' };
  extruder?: string;                         // default: T0's
  hotend?: string;
  hotendThermistor?: string;
  extruderMotor?: string;
}

export interface Dock { x: number; y: number; z: number }

// One generated issue. Errors block generation; warnings go into the output.
export interface Issue {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

export interface WireConnection {
  num: number;
  component: string;
  board: 'mainboard' | 'toolboard';
  connector: string;
  pins: string;
  note?: string;
  tool?: number;              // toolchanger tool number for parts on a tool's board
}

// A documentation link for the user. The web UI opens these in a new tab
// (target="_blank" rel="noopener noreferrer").
export interface Link {
  title: string;
  url: string;
  topic: string;              // what it helps with, e.g. "probe", "mainboard", "tuning"
}

export interface McuInfo {
  name: string;               // klipper mcu name: "mcu", "toolhead", "carto", ...
  chip: string;               // data dictionary / firmware target, e.g. stm32f446
  what: string;               // human label
  klipperCheck: boolean;      // false when no Klipper data dictionary can exist (Beacon)
  checkDict?: string;         // Klipper check: a dictionary variant built with the board's features (stm32f042-orbitool)
}

export interface Result {
  ok: boolean;
  files: Record<string, string>;
  issues: Issue[];
  wiring: { connections: WireConnection[]; jumpers: string[] };
  links: Link[];
  mcus: McuInfo[];
}

// The data files are hand-maintained YAML. They're typed loosely here on
// purpose; tools/validate.py owns their structure.
export type Rec = Record<string, any>;

export interface Db {
  printers: Record<string, Rec>;
  mainboards: Record<string, Rec>;
  toolboards: Record<string, Rec>;
  motors: Record<string, Rec>;
  drivers: Rec;               // { chips, modules[], run_current_policy }
  modules: Record<string, Rec>;
  extruders: Record<string, Rec>;
  zDrives: Record<string, Rec>;
  hotends: Record<string, Rec>;
  hotendDefaults: Rec;
  flowClasses: Rec;
  toolheads: Record<string, Rec>;
  probes: Record<string, Rec>;
  thermistors: Record<string, Rec>;
  fanRoles: Record<string, Rec>;
  homing: Rec;
  filters: Record<string, Rec>;
  filterDefaults: Rec;
  toolchangers: Record<string, Rec>;
}
