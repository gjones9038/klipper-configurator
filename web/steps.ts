// The wizard steps. Each step renders form fields that edit the Build through
// ctx.update(); plan() / generate() run again on every change.
import type { Build, Db, Rec, Result, Issue, ToolSpec } from '../generator/types.ts';
import type { Plan } from '../generator/plan.ts';
import { h, select, segmented, numberField, checkbox, pill, extLink, type Child, type Option } from './dom.ts';
import { canDevices, driversNeeded, toolchangerFor } from './state.ts';

export interface Ctx {
  db: Db;
  build: Build;
  result: Result;
  plan?: Plan;                 // undefined when plan() threw (e.g. not enough drivers)
  update(fn: (b: Build) => void): void;
}

export interface Step {
  id: string;
  name: string;
  title: string;
  lead: string;
  preview: string;             // file shown in the live preview
  codes: string[];             // issue codes (or prefixes ending in _) that belong to this step
  render(ctx: Ctx): Child;
}

const motorList = (db: Db): Rec[] => [...new Set(Object.values(db.motors))].sort((a, b) => a.id.localeCompare(b.id));
const motorOptions = (db: Db): Option[] => motorList(db).map((m) => ({
  value: m.id, group: m.manufacturer, label: `${m.id.toUpperCase()} · ${m.rated_current_a} A${m.holding_torque_nm ? ` · ${m.holding_torque_nm} Nm` : ''}`,
}));
const statusPill = (status: string) => pill(status === 'reviewed' ? 'Reviewed' : 'Needs review', status === 'reviewed' ? 'ok' : 'warn');

function sources(rec: Rec): Child {
  const list: Rec[] = rec.sources ?? [];
  if (!list.length && !rec.unverified?.length) return null;
  return h('details', { class: 'hint' },
    h('summary', null, `Sources (${list.length})${rec.unverified?.length ? ` · ${rec.unverified.length} unverified` : ''}`),
    h('ul', { class: 'links' }, list.map((s) => h('li', null,
      extLink(s.repo, s.repo.replace(/^https:\/\/github.com\//, '')), s.path ? ` · ${s.path}` : '', s.commit ? h('span', { class: 'mono' }, ` @ ${String(s.commit).slice(0, 7)}`) : ''))),
    rec.unverified?.length ? h('div', null, h('b', null, 'Unverified: '), rec.unverified.map((u: any) => (typeof u === 'string' ? u : JSON.stringify(u))).join('; ')) : null);
}

function pickTable(head: string[], rows: Array<{ id: string; picked: boolean; name: string; sub: string; cells: Child[]; onPick: () => void }>): HTMLElement {
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, head.map((c) => h('th', { scope: 'col' }, c)))),
    h('tbody', null, rows.map((r) => h('tr', { class: r.picked ? 'picked' : '' },
      h('td', null, h('button', { type: 'button', class: 'pick', 'aria-pressed': String(r.picked), onClick: r.onPick },
        h('span', { class: 'radio-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'pick-name' }, h('b', null, r.name), h('small', null, r.sub)))),
      r.cells.map((c) => h('td', null, c)))))));
}

// --- 1. Printer ----------------------------------------------------------------
const printerStep: Step = {
  id: 'printer', name: 'Printer', title: 'Printer', preview: 'printer.cfg',
  lead: 'Model, size and drive layout. These set travel, leveling and how many drivers the board needs.',
  codes: ['unknown_printer', 'unknown_size', 'unknown_variant', 'unknown_toolhead', 'unknown_zdrive'],
  render({ db, build, update }) {
    const printer = db.printers[build.printer];
    const zDrives = Object.values(db.zDrives).filter((z) => z.applies_to.includes(build.printer));
    return [
      h('div', { class: 'grid' },
        segmented('Printer', build.printer, Object.values(db.printers).map((p) => ({ value: p.id, label: p.name })), (v) => update((b) => { b.printer = v; })),
        segmented('Size', build.size, printer.sizes.map((s: Rec) => ({ value: s.id, label: `${s.id} mm` })), (v) => update((b) => { b.size = v; })),
        segmented('Drive', build.variant ?? 'standard', printer.variants.map((v: Rec) => ({ value: v.id, label: v.name })), (v) => update((b) => { b.variant = v; }))),
      h('div', { class: 'grid' },
        select('Toolhead', build.toolhead ?? '', Object.values(db.toolheads).filter((t) => t.applies_to.includes(build.printer)).map((t) => ({ value: t.id, label: t.name })),
          (v) => update((b) => { b.toolhead = v || undefined; })),
        zDrives.length ? select('Z drive', build.zDrive ?? '', [{ value: '', label: 'Printer default' }, ...zDrives.map((z) => ({ value: z.id, label: `${z.id} · gear ${z.gear_ratio}` }))],
          (v) => update((b) => { if (v) b.zDrive = v; else delete b.zDrive; })) : null,
        printer.leadscrew_options ? segmented('Lead screw', build.leadscrew ?? printer.leadscrew_options.find((l: Rec) => l.default)?.id,
          printer.leadscrew_options.map((l: Rec) => ({ value: l.id, label: `${l.id.toUpperCase()} (${l.rotation_distance} mm)` })), (v) => update((b) => { b.leadscrew = v; })) : null),
      (db.printers[build.printer].variants.find((v: Rec) => v.id === build.variant)?.notes ?? []).length
        ? h('ul', { class: 'hint' }, db.printers[build.printer].variants.find((v: Rec) => v.id === build.variant).notes.map((n: string) => h('li', null, n))) : null,
      sources(printer),
    ];
  },
};

// --- 2. Mainboard --------------------------------------------------------------
const mainboardStep: Step = {
  id: 'mainboard', name: 'Mainboard', title: 'Mainboard', preview: 'mainboard.cfg',
  lead: 'Every board here has pins taken from cited sources. "Needs review" means only one source, or sources that disagree.',
  codes: ['unknown_board', 'unknown_mcu', 'connection_unsupported', 'board_', 'not_enough_drivers', 'enable_polarity', 'bad_override', 'slot_taken'],
  render({ db, build, update }) {
    const need = driversNeeded({ ...build, toolboard: undefined }, db);
    const board = db.mainboards[build.mainboard.id];
    const mcu = board.mcu_variants.find((m: Rec) => m.chip === build.mainboard.mcu) ?? board.mcu_variants[0];
    const fit = (n: number): HTMLElement => n >= need ? pill('Fits', 'ok')
      : n >= need - 1 ? (build.toolboard ? pill('Fits (extruder on toolhead)', 'ok') : pill('Extruder → toolhead board', 'warn'))
      : pill(`${n} of ${need} drivers`, 'bad');
    const boards = Object.values(db.mainboards).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const variant = db.printers[build.printer].variants.find((v: Rec) => v.id === (build.variant ?? 'standard'));
    return [
      pickTable(['Board', 'Rev', 'Drivers', 'Pin data', `${db.printers[build.printer].name}${variant.id === 'awd' ? ' AWD' : ''} fit`], boards.map((b) => ({
        id: b.id, picked: b.id === build.mainboard.id, name: b.name, sub: b.manufacturer,
        onPick: () => update((x) => { x.mainboard = { id: b.id, connection: x.mainboard.connection }; }),
        cells: [h('span', { class: 'mono' }, b.revisions.join(' / ')), `${b.driver_slots.length} × ${b.driver_mount === 'onboard' ? 'onboard' : b.driver_mount === 'ez' ? 'EZ socket' : 'stepstick'}`, statusPill(b.status), fit(b.driver_slots.length)],
      }))),
      h('div', { class: 'grid' },
        select('MCU on your board', mcu.chip, board.mcu_variants.map((m: Rec) => ({ value: m.chip, label: `${m.chip.toUpperCase()} · ${m.crystal_mhz} MHz${m.bootloader_kib ? ` · ${m.bootloader_kib} KiB bootloader` : ''}` })),
          (v) => update((b) => { b.mainboard.mcu = v; })),
        segmented('Host connection', build.mainboard.connection,
          (['usb', 'usb-can-bridge', 'can'] as const).map((c) => ({ value: c, label: c === 'usb' ? 'USB' : c === 'can' ? 'CAN' : 'USB-CAN bridge', disabled: !board.interfaces.includes(c) })),
          (v) => update((b) => { b.mainboard.connection = v; }),
          'USB-CAN bridge: the board talks to the host over USB and forwards CAN to the toolhead board.'),
        numberField('Bootloader offset (KiB)', build.mainboard.bootloaderKib, (v) => update((b) => { if (v === undefined) delete b.mainboard.bootloaderKib; else b.mainboard.bootloaderKib = v; }),
          { min: 0, step: 1, placeholder: String(mcu.bootloader_kib ?? 0), hint: 'Only if your board was reflashed (e.g. Katapult).' })),
      board.notes?.length ? h('ul', { class: 'hint' }, board.notes.map((n: string) => h('li', null, n))) : null,
      sources(board),
    ];
  },
};

// --- 3. Toolhead board -----------------------------------------------------------
const toolboardStep: Step = {
  id: 'toolboard', name: 'Toolhead board', title: 'Toolhead board', preview: 'toolhead.cfg',
  lead: 'A CAN or USB board on the toolhead carries the extruder, hotend, fans and accelerometer, so only one cable runs to the toolhead.',
  codes: ['unknown_toolboard', 'toolboard_connection', 'no_can_path', 'no_led_port', 'unknown_toolchanger', 'toolchanger_printer', 'toolchanger_toolhead',
    'toolchanger_needs_toolboard', 'toolchanger_one_tool', 'toolchanger_module', 'tool_extruder_fit'],
  render({ db, build, update }) {
    const toolhead = build.toolhead ? db.toolheads[build.toolhead] : undefined;
    const tc = toolchangerFor(build, db);
    const tb = build.toolboard ? db.toolboards[build.toolboard.id] : undefined;
    const board = db.mainboards[build.mainboard.id];
    const can = canDevices(build, db);
    const boards = Object.values(db.toolboards).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const ffPill = (ff: string) => !toolhead?.toolboard_form_factors ? h('span', { class: 'mono' }, ff)
      : toolhead.toolboard_form_factors.includes(ff) ? pill(ff, 'ok') : pill(ff, 'info');
    const noTap = (t: Rec) => tc && !t.probe_ports?.length;
    return [
      tc ? h('h2', null, `T0 board (${tc.name}: every tool has its own)`) : null,
      pickTable(['Board', 'MCU', 'Mount', 'Connection', 'Pin data'], [
        ...(tc ? [] : [{ id: '', picked: !tb, name: 'None', sub: 'Extruder, heater and fans wired to the mainboard', cells: ['', '', '', ''],
          onPick: () => update((b) => { delete b.toolboard; }) }]),
        ...boards.map((t) => ({
          id: t.id, picked: t.id === tb?.id, name: t.name, sub: `rev ${t.revisions.join(' / ')}${noTap(t) ? ' · no probe port in the data (Tap sensor)' : ''}`,
          onPick: () => update((b) => { b.toolboard = { id: t.id, connection: t.interfaces[0] }; }),
          cells: [h('span', { class: 'mono' }, String(t.mcu?.chip ?? t.mcu).toUpperCase()), ffPill(t.form_factor), t.interfaces.map((i: string) => i.toUpperCase()).join(' / '), statusPill(t.status)],
        })),
      ]),
      tb ? h('div', { class: 'grid' },
        segmented('Toolhead board connection', build.toolboard!.connection ?? 'can',
          (['can', 'usb'] as const).map((c) => ({ value: c, label: c.toUpperCase(), disabled: !tb.interfaces.includes(c) })),
          (v) => update((b) => { b.toolboard!.connection = v; })),
        toolhead?.leds ? checkbox('Stealthburner LEDs', !!build.leds, (v) => update((b) => { b.leds = v; }), 'Neopixel chain on the toolhead board.') : null) : null,
      can.length ? h('div', { class: 'grid' },
        segmented('CAN path', build.mainboard.connection === 'usb-can-bridge' ? 'bridge' : 'adapter', [
          { value: 'bridge', label: 'Mainboard USB-CAN bridge', disabled: !board.interfaces.includes('usb-can-bridge') },
          { value: 'adapter', label: 'USB-CAN adapter (U2C)' },
        ], (v) => update((b) => {
          if (v === 'bridge') { b.mainboard.connection = 'usb-can-bridge'; delete b.canAdapter; }
          else { if (b.mainboard.connection === 'usb-can-bridge') b.mainboard.connection = 'usb'; b.canAdapter = 'u2c'; }
        }), `On CAN: ${can.join(', ')}.`)) : null,
      tc ? toolList(db, build, update, tc) : null,
      tb ? sources(tb) : null,
    ];
  },
};

function toolList(db: Db, build: Build, update: Ctx['update'], tc: Rec): Child {
  const tools = build.toolchanger?.tools ?? [];
  const boards = Object.values(db.toolboards).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const t0 = db.toolboards[build.toolboard?.id ?? ''];
  return h('div', { class: 'section' },
    h('h2', null, 'Tools'),
    h('p', { class: 'hint', style: 'margin:0' }, `T0 uses the board above and the extruder and hotend from the Hotend step. Each other tool can differ. `,
      `Tool boards need a probe input for the Tap sensor; boards without one in the data can't be used yet.`),
    segmented('Number of tools', String(tools.length + 1), ['2', '3', '4', '5', '6'].map((n) => ({ value: n, label: n })), (v) => update((b) => {
      const want = Number(v) - 1;
      const list = b.toolchanger!.tools;
      while (list.length < want) list.push({ toolboard: { ...(list[list.length - 1]?.toolboard ?? b.toolboard!) } });
      list.length = want;
    })),
    h('div', { class: 'cards' }, tools.map((t, i) => {
      const n = i + 1;
      const tb = db.toolboards[t.toolboard.id];
      const set = (fn: (x: ToolSpec) => void) => update((b) => fn(b.toolchanger!.tools[i]));
      return h('section', { class: 'card' }, h('h2', null, `T${n}`),
        select('Board', t.toolboard.id, boards.map((x) => ({ value: x.id, label: `${x.name} ${x.revisions.join('/')}${x.probe_ports?.length ? '' : ' (no probe port in data)'}`, disabled: !x.probe_ports?.length })),
          (v) => set((x) => { x.toolboard = { id: v, connection: db.toolboards[v].interfaces[0] }; })),
        segmented('Connection', t.toolboard.connection ?? 'can', (['can', 'usb'] as const).map((c) => ({ value: c, label: c.toUpperCase(), disabled: !tb?.interfaces.includes(c) })),
          (v) => set((x) => { x.toolboard.connection = v; })),
        select('Extruder', t.extruder ?? '', [{ value: '', label: `Same as T0 (${db.extruders[build.extruder].name})` }, ...Object.values(db.extruders).map((e) => ({ value: e.id, label: e.name }))],
          (v) => set((x) => { if (v) x.extruder = v; else delete x.extruder; delete x.extruderMotor; })),
        select('Hotend', t.hotend ?? '', [{ value: '', label: `Same as T0 (${db.hotends[build.hotend].name})` }, ...Object.values(db.hotends).map((x) => ({ value: x.id, label: x.name }))],
          (v) => set((x) => { if (v) x.hotend = v; else delete x.hotend; })),
        select('Hotend thermistor', t.hotendThermistor ?? '', [{ value: '', label: 'Same as T0' }, ...Object.values(db.thermistors).map((x) => ({ value: x.id, label: x.label }))],
          (v) => set((x) => { if (v) x.hotendThermistor = v; else delete x.hotendThermistor; })));
    })),
    t0 && !t0.probe_ports?.length ? h('p', { class: 'hint' }, `T0's board has no probe input in the data.`) : null,
    sources(tc));
}

// --- 4. Motors and drivers --------------------------------------------------------
const GROUPS = [['xy', 'A/B (X/Y)'], ['z', 'Z'], ['extruder', 'Extruder']] as const;
const motorsStep: Step = {
  id: 'motors', name: 'Motors', title: 'Motors and drivers', preview: 'mainboard.cfg',
  lead: 'Run current starts from the maker\'s recommendation, capped at the motor rating and the driver limit. Leave the override blank to use it.',
  codes: ['unknown_driver_module', 'driver_', 'no_tmc_spi', 'unknown_motor', 'run_current_high'],
  render({ db, build, plan, update }) {
    const board = db.mainboards[build.mainboard.id];
    const onboard = board.driver_mount === 'onboard';
    const modules = Object.values(db.modules).filter((m) => m.format === board.driver_mount);
    const groups = GROUPS.filter(([g]) => g !== 'extruder' || !build.toolboard);
    const stepperOf = (g: string) => plan?.steppers.find((s) => s.group === g);
    const extruder = db.extruders[build.extruder];
    const mOpts = motorOptions(db);
    return [
      onboard ? h('p', { class: 'hint' }, `${board.name} has its drivers on the board; the chip per slot comes from the board data.`)
        : h('div', { class: 'section' }, h('h2', null, 'Driver modules'), h('div', { class: 'grid' }, groups.map(([g, label]) => {
          const choice = build.drivers[g] ?? build.drivers.xy;
          const chip = db.drivers.chips[db.modules[choice.module]?.chip];
          return h('div', { class: 'section' },
            select(`${label} driver`, choice.module, modules.map((m) => ({ value: m.id, label: `${m.id} · ${m.chip.toUpperCase()}` })),
              (v) => update((b) => { b.drivers[g] = { module: v }; })),
            chip?.interfaces.length > 1 ? segmented(`${label} interface`, choice.interface ?? chip.interfaces[0],
              chip.interfaces.map((i: string) => ({ value: i, label: i.toUpperCase() })),
              (v) => update((b) => { b.drivers[g] = { ...(b.drivers[g] ?? b.drivers.xy), interface: v as 'uart' | 'spi' }; })) : null);
        }))),
      h('div', { class: 'section' }, h('h2', null, 'Motors'), h('div', { class: 'grid' }, GROUPS.map(([g, label]) => {
        const s = stepperOf(g);
        return h('div', { class: 'section' },
          g === 'extruder'
            ? select(`${label} motor`, build.motors.extruder ?? '', [{ value: '', label: `Recommended for ${extruder.name}: ${String(extruder.recommended_motor ?? 'none').toUpperCase()}` }, ...mOpts],
              (v) => update((b) => { if (v) b.motors.extruder = v; else delete b.motors.extruder; }))
            : select(`${label} motor`, build.motors[g], mOpts, (v) => update((b) => { b.motors[g] = v; })),
          numberField(`${label} run current (A)`, build.runCurrent?.[g], (v) => update((b) => {
            b.runCurrent = { ...b.runCurrent };
            if (v === undefined) delete b.runCurrent[g]; else b.runCurrent[g] = v;
            if (!Object.keys(b.runCurrent).length) delete b.runCurrent;
          }), { min: 0.1, max: 3, step: 0.05, placeholder: s ? String(s.runCurrent) : '', hint: s?.currentNote }));
      }))),
      plan ? h('div', { class: 'section' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' },
          h('h2', null, 'Slot assignment'),
          build.slotOverrides ? h('button', { type: 'button', class: 'btn', onClick: () => update((b) => { delete b.slotOverrides; }) }, 'Reset to automatic') : null),
        h('p', { class: 'hint', style: 'margin:0' }, 'Automatic puts A/B on high-voltage slots when the board has them, then fills slots in order. Pick a slot to match your wiring; choosing one that is taken swaps the two motors.'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Stepper', 'Position', 'Board · slot', 'Driver', 'Current'].map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', null, plan.steppers.map((s) => h('tr', null,
            h('td', { class: 'mono' }, s.name), h('td', null, s.position ?? ''),
            h('td', { class: 'mono' }, s.board === 'toolboard' ? `toolhead · ${s.slot}` : slotPicker(board, plan, s.name, s.slot, update)),
            h('td', { class: 'mono' }, `${s.driver.chip.toUpperCase()} ${s.driver.iface.toUpperCase()}${s.driver.hv ? ' · HV' : ''}`),
            h('td', { class: 'mono' }, `${s.runCurrent} A`))))))) : null,
    ];
  },
};

function slotPicker(board: Rec, plan: Plan, stepper: string, current: string, update: Ctx['update']): HTMLElement {
  const holder = (slot: string) => plan.steppers.find((x) => x.board === 'mainboard' && x.slot === slot)?.name;
  return h('select', {
    'aria-label': `Driver slot for ${stepper}`, style: 'min-height:36px;padding:4px 8px;font-family:var(--mono);font-size:13px;width:auto',
    onChange: (e: Event) => {
      const slot = (e.target as HTMLSelectElement).value;
      const other = holder(slot);
      update((b) => {
        const o = { ...b.slotOverrides, [stepper]: slot };
        if (other && other !== stepper) o[other] = current;     // swap
        b.slotOverrides = o;
      });
    },
  }, (board.driver_slots as Rec[]).map((d) => {
    const other = holder(d.id);
    const od = d.onboard_driver;
    return h('option', { value: d.id, selected: d.id === current },
      `${d.id}${od ? ` · ${od.chip}${od.motor_power ? ' HV' : ''}` : ''}${other && other !== stepper ? ` (${other})` : ''}`);
  }));
}

// --- 5. Homing and probe -----------------------------------------------------------
const PROBE_KINDS: Record<string, string> = {
  inductive: 'Inductive (leveling only)', nozzle_contact: 'Nozzle contact', dockable_switch: 'Dockable switch',
  eddy_native: 'Eddy current (Klipper native)', eddy_plugin: 'Eddy current (vendor module)', servo_pin: 'Servo probe',
};
const switchDraft: { x?: number; y?: number } = {};
const homingStep: Step = {
  id: 'homing', name: 'Homing & probe', title: 'Homing and probe', preview: 'printer.cfg',
  lead: 'How each axis finds home, and the probe used for leveling and the bed mesh.',
  codes: ['sensorless_', 'no_endstop_port', 'no_z_switch_xy', 'z_switch_out_of_range', 'no_probe', 'probe_', 'pnp_unsupported_port', 'beacon_sensorless', 'plugin_required', 'no_bltouch_port',
    'toolchanger_probe', 'toolchanger_z_homing', 'tool_dock_unset', 'dock_out_of_range', 'safe_y_out_of_range', 'toolchanger_safe_y', 'toolchanger_travel'],
  render({ db, build, update }) {
    const tc = toolchangerFor(build, db);
    if (tc) return toolchangerHoming(db, build, update, tc);
    const probe = build.probe ? db.probes[build.probe] : undefined;
    const known = probe?.defaults ?? probe?.offsets;
    const zm = db.homing.z_methods;
    const sw = build.homing.zSwitchXY;
    const setSwitch = (axis: 'x' | 'y', v: number | undefined) => update((b) => {
      switchDraft.x = sw?.[0] ?? switchDraft.x; switchDraft.y = sw?.[1] ?? switchDraft.y;
      switchDraft[axis] = v;
      if (switchDraft.x !== undefined && switchDraft.y !== undefined) b.homing.zSwitchXY = [switchDraft.x, switchDraft.y];
      else delete b.homing.zSwitchXY;
    });
    return [
      h('div', { class: 'grid' },
        segmented('X / Y homing', build.homing.xy, Object.entries(db.homing.xy_methods).map(([id, m]: [string, any]) => ({ value: id as 'physical' | 'sensorless', label: m.name })),
          (v) => update((b) => { b.homing.xy = v; }), db.homing.xy_methods[build.homing.xy]?.description),
        select('Probe', build.probe ?? '', [{ value: '', label: 'No probe' },
          ...Object.values(db.probes).map((p) => ({ value: p.id, label: p.name, group: PROBE_KINDS[p.kind] ?? p.kind }))],
          (v) => update((b) => { if (v) b.probe = v; else delete b.probe; delete b.probeOffset; }))),
      probe ? h('div', { class: 'grid' },
        probe.kind === 'inductive' && !probe.output ? segmented('Probe output', build.probeOutput ?? 'npn-no',
          (['npn-no', 'npn-nc', 'pnp-no', 'pnp-nc'] as const).map((o) => ({ value: o, label: o.toUpperCase() })),
          (v) => update((b) => { b.probeOutput = v; }), 'Printed on the probe label or datasheet.') : null,
        probe.kind === 'eddy_native' && Array.isArray(probe.interface) ? segmented('Probe connection', build.probeConnection ?? probe.interface[0],
          probe.interface.map((i: string) => ({ value: i as 'usb' | 'can', label: i.toUpperCase() })), (v) => update((b) => { b.probeConnection = v; })) : null,
        numberField('Probe X offset (mm)', build.probeOffset?.x, (v) => update((b) => { b.probeOffset = { x: v ?? 0, y: b.probeOffset?.y ?? known?.y_offset ?? 0 }; }),
          { step: 0.1, placeholder: String(known?.x_offset ?? 0), hint: known ? 'Blank uses the mount\'s published offset.' : 'Depends on your mount; measure it.' }),
        numberField('Probe Y offset (mm)', build.probeOffset?.y, (v) => update((b) => { b.probeOffset = { x: b.probeOffset?.x ?? known?.x_offset ?? 0, y: v ?? 0 }; }),
          { step: 0.1, placeholder: String(known?.y_offset ?? 0) })) : null,
      probe?.docs?.length ? h('ul', { class: 'links' }, probe.docs.map((d: Rec) => h('li', null, extLink(d.url, d.title)))) : null,
      h('div', { class: 'grid' },
        segmented('Z homing', build.homing.z, Object.entries(zm).map(([id, m]: [string, any]) => ({
          value: id as Build['homing']['z'], label: m.name, disabled: id === 'probe_virtual_endstop' && !probe?.z_endstop_capable,
        })), (v) => update((b) => { b.homing.z = v; }), zm[build.homing.z]?.description)),
      build.homing.z === 'nozzle_switch' ? h('div', { class: 'grid' },
        numberField('Z switch X (mm)', sw?.[0] ?? switchDraft.x, (v) => setSwitch('x', v), { step: 0.1, hint: 'Where the nozzle sits over the switch pin. Measure it on your printer; there is no safe default.' }),
        numberField('Z switch Y (mm)', sw?.[1] ?? switchDraft.y, (v) => setSwitch('y', v), { step: 0.1 })) : null,
      probe ? sources(probe) : null,
    ];
  },
};

const dockDraft: Record<number, Partial<{ x: number; y: number; z: number }>> = {};
function toolchangerHoming(db: Db, build: Build, update: Ctx['update'], tc: Rec): Child {
  const spec = build.toolchanger!;
  const count = spec.tools.length + 1;
  const setDock = (n: number, axis: 'x' | 'y' | 'z', v: number | undefined) => update((b) => {
    const t = b.toolchanger!;
    const cur = { ...(t.docks?.[n] ?? {}), ...dockDraft[n], [axis]: v };
    dockDraft[n] = cur;
    const docks = Array.from({ length: count }, (_, k) => t.docks?.[k] ?? null);
    docks[n] = cur.x !== undefined && cur.y !== undefined && cur.z !== undefined ? { x: cur.x, y: cur.y, z: cur.z } : null;
    if (docks.every((d) => d === null)) delete t.docks; else t.docks = docks;
  });
  const setTravel = (k: 'yMin' | 'zMax', v: number | undefined) => update((b) => {
    const t = b.toolchanger!;
    t.travel = { ...t.travel, [k]: v };
    if (v === undefined) delete t.travel[k];
    if (!Object.keys(t.travel).length) delete t.travel;
  });
  return [
    h('div', { class: 'grid' },
      segmented('X / Y homing', build.homing.xy, Object.entries(db.homing.xy_methods).map(([id, m]: [string, any]) => ({ value: id as 'physical' | 'sensorless', label: m.name })),
        (v) => update((b) => { b.homing.xy = v; }), db.homing.xy_methods[build.homing.xy]?.description)),
    segmented('Z probe', spec.zProbe ?? 'per_tool', [
      { value: 'per_tool', label: 'Tap on every tool' }, { value: 'shuttle', label: 'Eddy probe on the shuttle' }],
    (v) => update((b) => { b.toolchanger!.zProbe = v as 'per_tool' | 'shuttle'; }),
    (spec.zProbe ?? 'per_tool') === 'per_tool'
      ? "The mounted tool's Tap sensor homes Z and probes ([tool_probe] on each tool). PRINT_START levels and meshes with T0, then picks up the first tool."
      : 'One eddy probe on the shuttle homes Z and probes; each tool keeps a switch (its Tap/OptoTap) only to detect that it is mounted. Measure each tool\'s Z offset against T0.'),
    spec.zProbe === 'shuttle' ? h('div', { class: 'grid' },
      select('Shuttle probe', build.probe ?? '', [{ value: '', label: 'Choose an eddy probe' },
        ...Object.values(db.probes).filter((p) => ['eddy_native', 'eddy_plugin'].includes(p.kind) && p.interface !== 'toolboard_i2c').map((p) => ({ value: p.id, label: p.name }))],
        (v) => update((b) => { if (v) b.probe = v; else delete b.probe; delete b.probeOffset; })),
      ...(() => {
        const sp = build.probe ? db.probes[build.probe] : undefined;
        if (!sp) return [];
        const known = sp.defaults ?? sp.offsets;
        return [
          Array.isArray(sp.interface) ? segmented('Probe connection', build.probeConnection ?? sp.interface[0],
            sp.interface.map((i: string) => ({ value: i as 'usb' | 'can', label: i.toUpperCase() })), (v) => update((b) => { b.probeConnection = v; })) : null,
          numberField('Probe X offset (mm)', build.probeOffset?.x, (v) => update((b) => { b.probeOffset = { x: v ?? 0, y: b.probeOffset?.y ?? known?.y_offset ?? 0 }; }),
            { step: 0.1, placeholder: String(known?.x_offset ?? 0), hint: 'From the nozzle of the tools, as mounted on the shuttle.' }),
          numberField('Probe Y offset (mm)', build.probeOffset?.y, (v) => update((b) => { b.probeOffset = { x: b.probeOffset?.x ?? known?.x_offset ?? 0, y: v ?? 0 }; }),
            { step: 0.1, placeholder: String(known?.y_offset ?? 0) }),
        ];
      })()) : null,
    h('div', { class: 'section' }, h('h2', null, 'Docks'),
      h('p', { class: 'hint', style: 'margin:0' }, 'Measure each dock on the printer (TC_DOCK_ALIGN_START, jog, TC_DOCK_ALIGN_SAVE), or enter known positions. ',
        `${tc.dock_z_rule}. Tool changes are refused until a tool's dock and the safe Y are set.`),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Tool', 'Park X', 'Park Y', 'Park Z'].map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', null, Array.from({ length: count }, (_, n) => {
          const d = { ...(spec.docks?.[n] ?? {}), ...dockDraft[n] };
          const cell = (axis: 'x' | 'y' | 'z') => h('td', null, h('input', {
            type: 'number', step: 'any', inputmode: 'decimal', 'aria-label': `T${n} park ${axis.toUpperCase()}`, value: d[axis] === undefined ? '' : String(d[axis]),
            onChange: (e: Event) => { const raw = (e.target as HTMLInputElement).value.trim(); setDock(n, axis, raw === '' ? undefined : Number(raw)); },
          }));
          return h('tr', null, h('td', { class: 'mono' }, `T${n}`), cell('x'), cell('y'), cell('z'));
        }))))),
    h('div', { class: 'grid' },
      numberField('Safe Y (mm)', spec.safeY, (v) => update((b) => { if (v === undefined) delete b.toolchanger!.safeY; else b.toolchanger!.safeY = v; }),
        { step: 0.1, hint: `StealthChanger wiki: ${tc.safe_y_rule}.` }),
      numberField('Y travel minimum (mm)', spec.travel?.yMin, (v) => setTravel('yMin', v),
        { step: 0.1, placeholder: '0', hint: 'stepper_y position_min. Docks usually sit in front of the bed, below Y 0.' }),
      numberField('Z travel maximum (mm)', spec.travel?.zMax, (v) => setTravel('zMax', v),
        { step: 0.1, placeholder: String(db.printers[build.printer].sizes.find((s: Rec) => s.id === build.size)?.position_max.z ?? ''), hint: 'stepper_z position_max, if docks sit above the normal Z travel.' })),
  ];
}

// --- 6. Hotend and extruder ----------------------------------------------------------
const hotendStep: Step = {
  id: 'hotend', name: 'Hotend', title: 'Extruder, hotend and heaters', preview: 'toolhead.cfg',
  lead: 'Extruder gearing, hotend limits and the thermistors on both heaters.',
  codes: ['unknown_extruder', 'unknown_hotend', 'unknown_thermistor', 'no_thermistor', 'custom_thermistor', 'thermistor_hw', 'max_temp_capped', 'pa_nozzle'],
  render({ db, build, update }) {
    const toolhead = build.toolhead ? db.toolheads[build.toolhead] : undefined;
    const fits = (id: string) => !toolhead?.compatible_extruders || toolhead.compatible_extruders.includes(id);
    const therm = Object.values(db.thermistors).map((t) => ({ value: t.id, label: t.label }));
    const hotend = db.hotends[build.hotend];
    return [
      h('div', { class: 'grid' },
        select('Extruder', build.extruder, Object.values(db.extruders).map((e) => ({
          value: e.id, label: `${e.name} · rd ${e.rotation_distance}${e.gear_ratio ? ` · ${e.gear_ratio}` : ''}`,
          group: fits(e.id) ? (toolhead ? `Fits ${toolhead.name}` : 'Extruders') : 'Other extruders',
        })).sort((a, b) => Number(!fits(a.value)) - Number(!fits(b.value))), (v) => update((b) => { b.extruder = v; delete b.motors.extruder; })),
        select('Hotend', build.hotend, Object.values(db.hotends).map((x) => ({ value: x.id, label: `${x.name} · ${x.flow_class} flow · ${x.max_temp == null ? 'no published max temp' : x.max_temp_basis === 'metalwork' ? `no heater/thermistor included (metal rated ${x.max_temp} °C)` : `max ${x.max_temp} °C`}` })),
          (v) => update((b) => { b.hotend = v; }), hotend.common_thermistor ? `Usually ships with: ${db.thermistors[hotend.common_thermistor]?.label ?? hotend.common_thermistor}` : undefined)),
      h('div', { class: 'grid' },
        select('Hotend thermistor', build.thermistors.hotend, therm, (v) => update((b) => { b.thermistors.hotend = v; })),
        select('Bed thermistor', build.thermistors.bed, therm, (v) => update((b) => { b.thermistors.bed = v; })),
        select('Chamber thermistor', build.thermistors.chamber ?? '', [{ value: '', label: 'None' }, ...therm],
          (v) => update((b) => { if (v) b.thermistors.chamber = v; else delete b.thermistors.chamber; }))),
      h('div', { class: 'grid' },
        numberField('Bed max power (0-1)', build.bed?.maxPower, (v) => update((b) => { b.bed = { ...b.bed, maxPower: v }; }), { min: 0.1, max: 1, step: 0.05, placeholder: '1.0', hint: 'Lower it for large AC beds on small fuses.' }),
        numberField('Bed max temp (°C)', build.bed?.maxTemp, (v) => update((b) => { b.bed = { ...b.bed, maxTemp: v }; }), { min: 60, max: 150, step: 1, placeholder: '120' }),
        numberField('Nozzle diameter (mm)', build.nozzleDiameter, (v) => update((b) => { b.nozzleDiameter = v; }), { min: 0.1, max: 1.2, step: 0.05, placeholder: '0.4' })),
      sources(db.extruders[build.extruder]),
    ];
  },
};

// --- 7. Fans and filter ------------------------------------------------------------------
const FAN_LABELS: Record<string, string> = {
  part_cooling: 'Part cooling', hotend: 'Hotend fan', controller: 'Electronics bay', exhaust: 'Exhaust',
  bed_fans: 'Bed fans', chamber_circulation: 'Chamber circulation',
};
const fansStep: Step = {
  id: 'fans', name: 'Fans & filter', title: 'Fans and filter', preview: 'mainboard.cfg',
  lead: 'Ports are picked automatically (toolhead fans go to the toolhead board when there is one); pick one yourself to match your wiring.',
  codes: ['no_fan_port', 'fan_port_', 'no_hotend_fan', 'toolchanger_fan_board', 'no_toolboard', 'two_part_fans', 'unknown_fan_role', 'nevermore_twice', 'no_tach', 'filter_', 'unknown_filter'],
  render({ db, build, plan, update }) {
    const nm = build.nevermore;
    const model = nm ? db.filters[nm.model] : undefined;
    const portOf = (role: string) => plan?.fans.filter((f) => f.role === role).map((f) => `${f.port} on the ${f.board === 'toolboard' ? 'toolhead board' : 'mainboard'}`).join(', ');
    const boardFans = (kind: 'mainboard' | 'toolboard'): Rec[] =>
      kind === 'toolboard' ? db.toolboards[build.toolboard?.id ?? '']?.fans ?? [] : db.mainboards[build.mainboard.id].fans ?? [];
    // Which board a fan lands on when left on Auto (plan.ts: prefer_board, if that board exists).
    const kindOf = (role: string, f: { board?: string }) => (f.board as 'mainboard' | 'toolboard' | undefined)
      ?? (db.fanRoles[role]?.prefer_board === 'toolboard' && build.toolboard ? 'toolboard' : 'mainboard');
    const usedBy = (kind: string, port: string, self: string) => plan?.fans.find((x) => x.board === kind && x.port === port && x.role !== self)?.role;
    const portSelect = (label: string, kind: 'mainboard' | 'toolboard', value: string | undefined, self: string, set: (v: string | undefined) => void) =>
      select(label, value ?? '', [{ value: '', label: 'Automatic (first free port)' }, ...boardFans(kind).map((p) => {
        const other = usedBy(kind, p.id, self);
        return { value: p.id, label: `${p.id} · ${p.pin}${p.voltage_options ? ` · ${p.voltage_options.join('/')} V` : ''}${other ? ` (now: ${FAN_LABELS[other] ?? other})` : ''}` };
      })], (v) => set(v || undefined));
    return [
      h('div', { class: 'grid' }, Object.entries(db.fanRoles).filter(([r]) => r !== 'nevermore').map(([role, def]: [string, any]) => {
        const f = build.fans.find((x) => x.role === role);
        return h('div', { class: 'section' },
          checkbox(FAN_LABELS[role] ?? role, !!f, (on) => update((b) => { b.fans = on ? [...b.fans, { role }] : b.fans.filter((x) => x.role !== role); }),
            [h('span', { class: 'mono' }, `[${def.klipper_section}]`), f && portOf(role) ? ` → ${portOf(role)}` : '', def.safety ? h('span', { style: 'display:block' }, def.safety) : null]),
          f && build.toolboard ? segmented('Board', f.board ?? 'auto', [
            { value: 'auto', label: 'Auto' }, { value: 'mainboard', label: 'Mainboard' }, { value: 'toolboard', label: 'Toolhead' }],
          (v) => update((b) => { const x = b.fans.find((y) => y.role === role)!; delete x.port; if (v === 'auto') delete x.board; else x.board = v as 'mainboard' | 'toolboard'; })) : null,
          f ? portSelect(`${FAN_LABELS[role] ?? role} port`, kindOf(role, f), f.port, role,
            (v) => update((b) => { const x = b.fans.find((y) => y.role === role)!; if (v) x.port = v; else delete x.port; })) : null);
      })),
      h('div', { class: 'section' }, h('h2', null, 'Nevermore filter'),
        h('div', { class: 'grid' },
          select('Filter', nm?.model ?? '', [{ value: '', label: 'None' }, ...Object.values(db.filters).map((x) => ({ value: x.id, label: x.name }))],
            (v) => update((b) => { if (v) b.nevermore = { ...b.nevermore, model: v, voltage: db.filters[v].voltage_options.includes(b.nevermore?.voltage) ? b.nevermore!.voltage : db.filters[v].voltage_options[0] }; else delete b.nevermore; }),
            model ? `${model.fans.count} × ${model.fans.size}; ${model.fans.wiring}.` : undefined),
          model ? segmented('Fan voltage', String(nm!.voltage ?? model.voltage_options[0]), model.voltage_options.map((v: number) => ({ value: String(v), label: `${v} V` })),
            (v) => update((b) => { b.nevermore!.voltage = Number(v) as 12 | 24; })) : null,
          model ? portSelect('Nevermore port (mainboard)', 'mainboard', nm!.port, 'nevermore',
            (v) => update((b) => { if (v) b.nevermore!.port = v; else delete b.nevermore!.port; })) : null,
          model ? segmented('Runs', nm!.mode ?? db.filterDefaults.mode, [{ value: 'hot_bed', label: `Bed ≥ ${db.filterDefaults.hot_bed_threshold_c} °C` }, { value: 'always', label: 'Every print' }],
            (v) => update((b) => { b.nevermore!.mode = v as 'always' | 'hot_bed'; })) : null),
        model ? h('div', { class: 'grid' },
          numberField('Speed (0-1)', nm!.speed, (v) => update((b) => { b.nevermore!.speed = v; }), { min: 0.1, max: 1, step: 0.05, placeholder: String(db.filterDefaults.speed) }),
          numberField('Run on after print (min)', nm!.postPrintMinutes, (v) => update((b) => { b.nevermore!.postPrintMinutes = v; }), { min: 0, max: 120, step: 1, placeholder: String(db.filterDefaults.post_print_minutes) })) : null,
        model?.docs?.length ? h('ul', { class: 'links' }, model.docs.map((d: Rec) => h('li', null, extLink(d.url, d.title)))) : null),
    ];
  },
};

// --- 8. Software ---------------------------------------------------------------------
const softwareStep: Step = {
  id: 'software', name: 'Software', title: 'Web UI and extras', preview: 'macros/print.cfg',
  lead: 'PRINT_START follows the flow of jontek2\'s "better print_start": heat soak, level, adaptive mesh, purge.',
  codes: ['autotune_', 'plugin_required'],
  render({ build, update }) {
    return [
      h('div', { class: 'grid' },
        segmented('Web UI', build.webUi ?? 'mainsail', [{ value: 'mainsail', label: 'Mainsail' }, { value: 'fluidd', label: 'Fluidd' }, { value: 'none', label: 'None' }],
          (v) => update((b) => { b.webUi = v; }), 'Includes the UI\'s own macros (PAUSE / RESUME / CANCEL_PRINT).')),
      checkbox(['Use ', extLink('https://github.com/andrewmcgr/klipper_tmc_autotune', 'klipper_tmc_autotune')], !!build.autotune, (v) => update((b) => { b.autotune = v; }),
        'Tunes TMC registers per motor from the motor database. Install the module on the host first.'),
      h('p', { class: 'hint' }, 'Credit: macro flow from ', extLink('https://github.com/jontek2/A-better-print_start-macro', 'jontek2/A-better-print_start-macro'), '. The macros are written fresh for this tool.'),
    ];
  },
};

export const STEPS: Step[] = [printerStep, mainboardStep, toolboardStep, motorsStep, homingStep, hotendStep, fansStep, softwareStep];

export function stepOf(issue: Issue): Step | undefined {
  return STEPS.find((s) => s.codes.some((c) => (c.endsWith('_') ? issue.code.startsWith(c) : issue.code === c)));
}
