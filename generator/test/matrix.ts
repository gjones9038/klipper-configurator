// Build matrix covering every mainboard and toolhead board with both printers,
// both variants and rotating homing / driver interface / autotune choices.
// Used by the unit tests and by tools (write-matrix) for the Klipper check.
import type { Build, Db } from '../types.ts';

const TOOLBOARD_ROTATION = [
  null,
  'btt-ebb-sb2209-can-v1.0',
  'btt-ebb36-can-v1.2',
  'ldo-nitehawk-sb',
  'btt-ebb-sb2240-can-v1.0',
  'btt-ebb36-gen2-v1.0',
  'btt-ebb-sb2209-rp2040-v1.0',
  'btt-ebb42-can-v1.1',
  'btt-ebb42-gen2-v1.0',
  'ldo-nitehawk-36',
  'btt-ebb-sb2209-usb-v1.0',
  'btt-ebb36-can-v1.1',
  'btt-ebb42-can-v1.2',
];

// Probe rotation: [probe id, extra build fields]. Eddy probes home Z with the probe.
const PROBES: Array<[string, Partial<Build>]> = [
  ['omron-tl-q5mc2', {}],
  ['voron-tap', {}],
  ['btt-eddy-usb', {}],
  ['pl-08n', {}],
  ['cartographer-v3', { probeConnection: 'usb', probeOffset: { x: 0, y: 20 } }],
  ['generic-inductive', { probeOutput: 'npn-no' }],
  ['beacon', { probeOffset: { x: 0, y: 20 } }],
  ['cartographer-v3', { probeConnection: 'can', probeOffset: { x: 0, y: 20 } }],
  ['generic-inductive', { probeOutput: 'pnp-nc' }],
];
const FILTERS = [undefined, 'nevermore-micro-v6', 'nevermore-stealthmax', 'nevermore-micro-v5-duo', 'nevermore-max'];

export interface Case { name: string; build: Build }

export function matrix(db: Db): Case[] {
  const cases: Case[] = [];
  let n = 0;
  for (const boardId of Object.keys(db.mainboards).sort()) {
    const board = db.mainboards[boardId];
    for (const printerId of ['voron-2.4', 'voron-trident']) {
      for (const variant of ['standard', 'awd']) {
        // Two toolboard choices per combo so every toolboard is exercised several times.
        for (const k of [0, 1]) {
          const tb = TOOLBOARD_ROTATION[(n + k * 5) % TOOLBOARD_ROTATION.length];
          n++;
          const toolboard = tb ? db.toolboards[tb] : undefined;
          const tconn = toolboard ? (toolboard.interfaces.includes('can') ? 'can' : 'usb') : undefined;
          const bridge = board.interfaces.includes('usb-can-bridge');
          const sensorless = n % 2 === 0;
          const spi = n % 3 === 0;
          const stepstick = board.driver_mount !== 'onboard';
          const mod = board.driver_mount === 'ez' ? (spi ? 'btt-ez5160-pro' : 'btt-ez2209') : spi ? 'btt-tmc5160-pro' : 'btt-tmc2209';
          const size = ['250', '300', '350'][n % 3];
          const [probeId, probeExtra] = PROBES[n % PROBES.length];
          const probeRec = db.probes[probeId];
          // Z: probe-capable probes home Z on half the cases; inductive always uses the nozzle switch.
          const probeHomes = probeRec.z_endstop_capable && (probeRec.kind.startsWith('eddy') || sensorless || n % 4 === 1);
          const filter = FILTERS[n % FILTERS.length];
          const build: Build = {
            printer: printerId, size, variant,
            mainboard: { id: boardId, connection: tconn === 'can' && bridge ? 'usb-can-bridge' : 'usb' },
            ...(toolboard ? { toolboard: { id: tb!, connection: tconn as 'can' | 'usb' } } : {}),
            ...(tconn === 'can' && !bridge ? { canAdapter: 'u2c' as const } : {}),
            toolhead: 'stealthburner',
            drivers: { xy: { module: mod }, z: { module: stepstick ? (board.driver_mount === 'ez' ? 'btt-ez2209' : 'btt-tmc2209') : 'btt-tmc2209' } },
            motors: { xy: 'ldo-42sth48-2504ac', z: printerId === 'voron-2.4' ? 'ldo-42sth48-2004ac' : 'ldo-42sth48-2004ac', extruder: 'ldo-36sth20-1004ahg' },
            homing: probeHomes
              ? { xy: sensorless ? 'sensorless' : 'physical', z: 'probe_virtual_endstop' }
              : { xy: sensorless ? 'sensorless' : 'physical', z: 'nozzle_switch', zSwitchXY: [Number(size) - 50, Number(size)] },
            probe: probeId,
            ...probeExtra,
            ...(filter ? { nevermore: { model: filter, voltage: (filter === 'nevermore-stealthmax' ? 12 : 24) as 12 | 24 } } : {}),
            webUi: (['mainsail', 'fluidd', 'none'] as const)[n % 3],
            extruder: n % 2 ? 'galileo2' : 'clockwork2',
            hotend: ['rapido2-hf', 'revo-voron', 'dragon-sf'][n % 3],
            thermistors: { hotend: n % 2 ? 'semitec-104nt4' : 'ntc100k-3950', bed: 'ntc100k-3950', ...(n % 5 === 0 ? { chamber: 'ntc100k-3950' } : {}) },
            fans: [
              { role: 'part_cooling' }, { role: 'hotend' }, { role: 'controller' },
              ...(n % 2 ? [{ role: 'exhaust' }] : [{ role: 'bed_fans' }]),
            ],
            leds: !!toolboard,
            autotune: n % 3 !== 1,
          };
          cases.push({ name: `${String(cases.length).padStart(3, '0')}-${boardId}-${printerId}-${variant}-${tb ?? 'none'}`, build });
        }
      }
    }
  }
  return cases;
}
