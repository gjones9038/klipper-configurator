// Build spec: everything the user chooses in the wizard. Ids refer to records
// in data/. Optional fields fall back to printer/toolhead defaults.

export type Interface = 'uart' | 'spi';
export type Connection = 'usb' | 'can' | 'usb-can-bridge';

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
  toolhead?: string;
  extruder: string;
  hotend: string;
  thermistors: { hotend: string; bed: string; chamber?: string };
  bed?: { maxPower?: number; maxTemp?: number };
  fans: FanSpec[];
  leds?: boolean;
  autotune?: boolean;
  nozzleDiameter?: number;
  slotOverrides?: Record<string, string>;    // klipper stepper name -> slot id
}

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
}

export interface Result {
  ok: boolean;
  files: Record<string, string>;
  issues: Issue[];
  wiring: { connections: WireConnection[]; jumpers: string[] };
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
}
