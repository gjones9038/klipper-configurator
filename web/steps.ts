// The wizard steps. Each step renders form fields that edit the Build through
// ctx.update(); plan() / generate() run again on every change.
import type { Build, Db, Rec, Result, Issue, ToolSpec } from '../generator/types.ts';
import type { Plan } from '../generator/plan.ts';
import { h, select, segmented, numberField, checkbox, pill, extLink, type Child, type Option } from './dom.ts';
import { canDevices, driversNeeded, toolchangerFor, switchPrinter } from './state.ts';
import { mainboardFor } from '../generator/dbcore.ts';

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
  const tech: string[] = [...(rec.tech_notes ?? []), ...(rec.discrepancies ?? []).map((d: string) => `Sources disagree: ${d}`)];
  return h('details', { class: 'hint' },
    h('summary', null, `Where this data comes from (${list.length} source${list.length === 1 ? '' : 's'}${rec.unverified?.length ? `, ${rec.unverified.length} unconfirmed detail${rec.unverified.length === 1 ? '' : 's'}` : ''})`),
    h('ul', { class: 'links' }, list.map((s) => h('li', null,
      extLink(s.repo, s.repo.replace(/^https:\/\/github.com\//, '')), s.path ? ` · ${s.path}` : '', s.commit ? h('span', { class: 'mono' }, ` @ ${String(s.commit).slice(0, 7)}`) : ''))),
    rec.unverified?.length ? h('div', null, h('b', null, 'Not confirmed by a source: '), rec.unverified.map((u: any) => (typeof u === 'string' ? u : JSON.stringify(u))).join('; ')) : null,
    tech.length ? h('div', null, h('b', null, 'Technical details'), h('ul', null, tech.map((t) => h('li', null, t)))) : null);
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
  lead: 'Pick your printer. Its size and layout decide how far each axis can move, how the bed is leveled, and how many motor drivers your board needs.',
  codes: ['unknown_printer', 'unknown_size', 'unknown_variant', 'unknown_toolhead', 'unknown_zdrive'],
  render({ db, build, update }) {
    const printer = db.printers[build.printer];
    const zDrives = Object.values(db.zDrives).filter((z) => z.applies_to.includes(build.printer));
    return [
      h('div', { class: 'grid' },
        select('Printer', build.printer, Object.values(db.printers).sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name })),
          (v) => update((b) => {
            const n = switchPrinter(structuredClone(b), db, v);
            for (const k of Object.keys(b)) delete (b as any)[k];
            Object.assign(b, n);
          })),
        printer.sizes.length < 2 ? null : segmented('Size', build.size, printer.sizes.map((s: Rec) => ({ value: s.id, label: `${s.id} mm` })), (v) => update((b) => { b.size = v; })),
        printer.variants.length < 2 ? null : segmented('Motor layout', build.variant ?? 'standard', printer.variants.map((v: Rec) => ({ value: v.id, label: v.name })), (v) => update((b) => { b.variant = v; }))),
      h('div', { class: 'grid' },
        Object.values(db.toolheads).some((t) => t.applies_to.includes(build.printer))
          ? select('Toolhead (the part that carries the hotend)', build.toolhead ?? '', Object.values(db.toolheads).filter((t) => t.applies_to.includes(build.printer)).map((t) => ({ value: t.id, label: t.name })),
            (v) => update((b) => { b.toolhead = v || undefined; })) : null,
        zDrives.length ? select('Z motor gearing', build.zDrive ?? '', [{ value: '', label: 'Printer default' }, ...zDrives.map((z) => ({ value: z.id, label: `${z.id} · gear ${z.gear_ratio}` }))],
          (v) => update((b) => { if (v) b.zDrive = v; else delete b.zDrive; })) : null,
        printer.leadscrew_options ? segmented('Z lead screw', build.leadscrew ?? printer.leadscrew_options.find((l: Rec) => l.default)?.id,
          printer.leadscrew_options.map((l: Rec) => ({ value: l.id, label: `${l.id.toUpperCase()} (${l.rotation_distance} mm)` })), (v) => update((b) => { b.leadscrew = v; })) : null),
      (db.printers[build.printer].variants.find((v: Rec) => v.id === build.variant)?.notes ?? []).length
        ? h('ul', { class: 'hint' }, db.printers[build.printer].variants.find((v: Rec) => v.id === build.variant).notes.map((n: string) => h('li', null, n))) : null,
      printer.notes?.length ? h('ul', { class: 'hint' }, printer.notes.map((n: string) => h('li', null, n))) : null,
      sources(printer),
    ];
  },
};

// --- 2. Mainboard --------------------------------------------------------------
const mainboardStep: Step = {
  id: 'mainboard', name: 'Mainboard', title: 'Mainboard', preview: 'mainboard.cfg',
  lead: 'Pick the control board in your printer. Every board\'s pin list comes from published sources. "Reviewed" means two sources agree. "Needs review" means only one source was found, so check your wiring against the board\'s own pin diagram.',
  codes: ['unknown_board', 'unknown_mcu', 'connection_unsupported', 'board_', 'not_enough_drivers', 'enable_polarity', 'bad_override', 'slot_taken'],
  render({ db, build, update }) {
    const need = driversNeeded({ ...build, toolboard: undefined }, db);
    const board = db.mainboards[build.mainboard.id];
    const exts: Rec[] = board.extensions ?? [];
    const extSlots = (id: string) => (db.mainboards[id].extensions ?? []).reduce((n: number, e: Rec) => n + (e.driver_slots?.length ?? 0), 0);
    const mcu = board.mcu_variants.find((m: Rec) => m.chip === build.mainboard.mcu) ?? board.mcu_variants[0];
    const fit = (n: number): HTMLElement => n >= need ? pill('Fits', 'ok')
      : n >= need - 1 ? (build.toolboard ? pill('Fits (extruder on the toolhead board)', 'ok') : pill('Needs a toolhead board', 'warn'))
      : pill(`Only ${n} of ${need} drivers`, 'bad');
    const stock: string[] = db.printers[build.printer].stock?.mainboards ?? [];
    const boards = Object.values(db.mainboards).sort((a, b) => Number(stock.includes(b.id)) - Number(stock.includes(a.id)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const variant = db.printers[build.printer].variants.find((v: Rec) => v.id === (build.variant ?? 'standard'));
    return [
      pickTable(['Board', 'Version', 'Motor drivers', 'Pin data', `Fits your printer${variant.id === 'awd' ? ' (AWD)' : ''}?`], boards.map((b) => ({
        id: b.id, picked: b.id === build.mainboard.id, name: b.name, sub: [b.name.toLowerCase().startsWith(String(b.manufacturer).toLowerCase().split(/[ (/]/)[0]) ? '' : b.manufacturer, stock.includes(b.id) ? 'stock on this printer' : ''].filter(Boolean).join(' · '),
        onPick: () => update((x) => { x.mainboard = { id: b.id, connection: x.mainboard.connection }; }),
        cells: [h('span', { class: 'mono' }, b.revisions.join(' / ')), `${b.driver_slots.length} × ${b.driver_mount === 'onboard' ? 'built in' : b.driver_mount === 'ez' ? 'plug-in (EZ)' : 'plug-in'}`, statusPill(b.status), b.driver_slots.length >= need || !extSlots(b.id) ? fit(b.driver_slots.length)
          : b.id === build.mainboard.id && build.mainboard.extensions?.length ? fit(mainboardFor(db, build.mainboard).driver_slots.length)
          : b.driver_slots.length + extSlots(b.id) >= need ? pill('Fits with extension board', 'warn') : fit(b.driver_slots.length)],
      }))),
      h('div', { class: 'grid' },
        select('Chip on your board', mcu.chip, board.mcu_variants.map((m: Rec) => ({ value: m.chip, label: `${m.chip.toUpperCase()} · ${m.crystal_mhz} MHz${m.bootloader_kib ? ` · ${m.bootloader_kib} KiB bootloader` : ''}` })),
          (v) => update((b) => { b.mainboard.mcu = v; }), board.mcu_variants.length > 1 ? 'This board was made with more than one chip. Read the marking on the main chip to tell which you have.' : undefined),
        segmented('Connection to your Pi / host computer', build.mainboard.connection,
          (board.interfaces.includes('usb-serial') ? ['usb-serial'] as const : ['usb', 'usb-can-bridge', 'can'] as const).map((c) => ({ value: c, label: c === 'usb' ? 'USB' : c === 'can' ? 'CAN' : c === 'usb-serial' ? `USB (${board.usb_serial?.chip ?? 'serial'} chip)` : 'USB-CAN bridge', disabled: !board.interfaces.includes(c) })),
          (v) => update((b) => { b.mainboard.connection = v; }),
          board.interfaces.includes('usb-serial') ? `A plain USB cable. The board's ${board.usb_serial?.chip ?? 'USB-serial'} chip turns it into a serial port on the host.` : 'USB is the simplest. Choose "USB-CAN bridge" when a toolhead board connects over CAN through this board.'),
        numberField('Bootloader offset (KiB)', build.mainboard.bootloaderKib, (v) => update((b) => { if (v === undefined) delete b.mainboard.bootloaderKib; else b.mainboard.bootloaderKib = v; }),
          { min: 0, step: 1, placeholder: String(mcu.bootloader_kib ?? 0), hint: 'Leave blank unless you replaced the board\'s bootloader (for example with Katapult).' })),
      exts.length ? h('div', { class: 'section' }, h('h2', null, 'Extension boards'), exts.map((e) =>
        h('div', null,
          checkbox(`${e.name} ${e.revisions?.join('/') ?? ''}`, !!build.mainboard.extensions?.includes(e.id),
            (on) => update((b) => {
              const list = (b.mainboard.extensions ?? []).filter((x) => x !== e.id);
              if (on) list.push(e.id);
              if (list.length) b.mainboard.extensions = list; else delete b.mainboard.extensions;
            }),
            [e.note, ' ', statusPill(e.status)]),
          build.mainboard.extensions?.includes(e.id) && e.buzzer ? checkbox('Buzzer tunes', build.beeps !== false, (v) => update((b) => { if (v) delete b.beeps; else b.beeps = false; }),
            `A tune when a print finishes${(build.webUi ?? 'mainsail') !== 'none' ? ' and beeps when it pauses (filament runout included)' : ''}. M300 S<Hz> P<ms> is always available.`) : null,
          build.mainboard.extensions?.includes(e.id) && e.notes?.length ? h('ul', { class: 'hint' }, e.notes.map((n: string) => h('li', null, n))) : null,
          build.mainboard.extensions?.includes(e.id) ? sources(e) : null))) : null,
      board.notes?.length ? h('ul', { class: 'hint' }, board.notes.map((n: string) => h('li', null, n))) : null,
      sources(board),
    ];
  },
};

// --- 3. Toolhead board -----------------------------------------------------------
const toolboardStep: Step = {
  id: 'toolboard', name: 'Toolhead board', title: 'Toolhead board', preview: 'toolhead.cfg',
  lead: 'Optional. A small board on the toolhead runs the extruder, hotend and fans, so one cable (CAN or USB) goes to the toolhead instead of a bundle of wires. Choose "None" if everything is wired to the mainboard.',
  codes: ['unknown_toolboard', 'toolboard_connection', 'no_can_path', 'no_led_port', 'unknown_toolchanger', 'toolchanger_printer', 'toolchanger_toolhead',
    'toolchanger_needs_toolboard', 'toolchanger_one_tool', 'toolchanger_module', 'tool_extruder_fit'],
  render({ db, build, update }) {
    const toolhead = build.toolhead ? db.toolheads[build.toolhead] : undefined;
    const tc = toolchangerFor(build, db);
    const tb = build.toolboard ? db.toolboards[build.toolboard.id] : undefined;
    const board = mainboardFor(db, build.mainboard);
    const can = canDevices(build, db);
    const boards = Object.values(db.toolboards).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const FORM: Record<string, string> = {
      stealthburner: 'Stealthburner', 'nema14-back': 'Back of a NEMA14 motor', 'nema17-back': 'Back of a NEMA17 motor',
      orbiter: 'Orbiter extruder', 'sovol-sv08': 'SV08 toolhead',
    };
    const ffPill = (ff: string) => !toolhead?.toolboard_form_factors ? h('span', null, FORM[ff] ?? ff)
      : toolhead.toolboard_form_factors.includes(ff) ? pill(FORM[ff] ?? ff, 'ok') : pill(FORM[ff] ?? ff, 'info');
    const noTap = (t: Rec) => tc && !t.probe_ports?.length;
    return [
      tc ? h('h2', null, `T0 board (${tc.name}: every tool has its own)`) : null,
      pickTable(['Board', 'Chip', 'Mounts on', 'Connection', 'Pin data'], [
        ...(tc ? [] : [{ id: '', picked: !tb, name: 'None', sub: 'Extruder, heater and fans wired to the mainboard', cells: ['', '', '', ''],
          onPick: () => update((b) => { delete b.toolboard; }) }]),
        ...boards.map((t) => ({
          id: t.id, picked: t.id === tb?.id, name: t.name, sub: `version ${t.revisions.join(' / ')}${noTap(t) ? ' · no probe input listed (needed for Tap)' : ''}`,
          onPick: () => update((b) => { b.toolboard = { id: t.id, connection: t.interfaces[0] }; }),
          cells: [h('span', { class: 'mono' }, String(t.mcu?.chip ?? t.mcu).toUpperCase()), ffPill(t.form_factor), t.interfaces.map((i: string) => i.toUpperCase()).join(' / '), statusPill(t.status)],
        })),
      ]),
      tb ? h('div', { class: 'grid' },
        segmented('Toolhead board connects by', build.toolboard!.connection ?? 'can',
          (['can', 'usb'] as const).map((c) => ({ value: c, label: c.toUpperCase(), disabled: !tb.interfaces.includes(c) })),
          (v) => update((b) => { b.toolboard!.connection = v; })),
        toolhead?.leds ? checkbox('Stealthburner LEDs', !!build.leds, (v) => update((b) => { b.leds = v; }), 'The RGB lights in the Stealthburner, run from the toolhead board.') : null) : null,
      can.length ? h('div', { class: 'grid' },
        segmented('How CAN reaches your Pi', build.mainboard.connection === 'usb-can-bridge' ? 'bridge' : 'adapter', [
          { value: 'bridge', label: 'Through the mainboard (USB-CAN bridge)', disabled: !board.interfaces.includes('usb-can-bridge') },
          { value: 'adapter', label: 'Separate USB-CAN adapter (U2C)' },
        ], (v) => update((b) => {
          if (v === 'bridge') { b.mainboard.connection = 'usb-can-bridge'; delete b.canAdapter; }
          else { if (b.mainboard.connection === 'usb-can-bridge') b.mainboard.connection = 'usb'; b.canAdapter = 'u2c'; }
        }), `On the CAN cable: ${can.join(', ')}.`)) : null,
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
    h('p', { class: 'hint', style: 'margin:0' }, `T0 is the tool set up above (this board, plus the extruder and hotend from the Hotend step). Each extra tool can use different parts. `,
      `Every tool board needs a probe input for its Tap sensor, so boards without one are greyed out.`),
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
    t0 && !t0.probe_ports?.length ? h('p', { class: 'hint' }, `T0's board has no probe input listed, so it can't read a Tap sensor.`) : null,
    sources(tc));
}

// --- 4. Motors and drivers --------------------------------------------------------
const GROUPS = [['xy', 'A/B (X/Y)'], ['z', 'Z'], ['extruder', 'Extruder']] as const;
const motorsStep: Step = {
  id: 'motors', name: 'Motors', title: 'Motors and drivers', preview: 'mainboard.cfg',
  lead: 'Pick the motors on each axis. Their current is set from the maker\'s recommendation and never goes above what the motor or driver can take. Leave a current box empty to use that value.',
  codes: ['unknown_driver_module', 'driver_', 'no_tmc_spi', 'unknown_motor', 'run_current_high'],
  render({ db, build, plan, update }) {
    const board = mainboardFor(db, build.mainboard);
    const onboard = board.driver_mount === 'onboard';
    const modules = Object.values(db.modules).filter((m) => m.format === board.driver_mount);
    const groups = GROUPS.filter(([g]) => g !== 'extruder' || !build.toolboard);
    const stepperOf = (g: string) => plan?.steppers.find((s) => s.group === g);
    const extruder = db.extruders[build.extruder];
    const mOpts = motorOptions(db);
    return [
      onboard ? h('p', { class: 'hint' }, `${board.name} has its motor drivers built in, so there is nothing to choose here.`)
        : h('div', { class: 'section' }, h('h2', null, 'Motor drivers'), h('p', { class: 'hint', style: 'margin:0' }, 'The small driver modules plugged into your board, one per motor.'), h('div', { class: 'grid' }, groups.map(([g, label]) => {
          const choice = build.drivers[g] ?? build.drivers.xy;
          const chip = db.drivers.chips[db.modules[choice.module]?.chip];
          return h('div', { class: 'section' },
            select(`${label} driver`, choice.module, modules.map((m) => ({ value: m.id, label: `${m.id} · ${m.chip.toUpperCase()}` })),
              (v) => update((b) => { b.drivers[g] = { module: v }; })),
            chip?.interfaces.length > 1 ? segmented(`${label} driver mode`, choice.interface ?? chip.interfaces[0],
              chip.interfaces.map((i: string) => ({ value: i, label: i.toUpperCase() })),
              (v) => update((b) => { b.drivers[g] = { ...(b.drivers[g] ?? b.drivers.xy), interface: v as 'uart' | 'spi' }; }), 'How the board talks to the driver. Set the jumpers under it to match.') : null);
        }))),
      h('div', { class: 'section' }, h('h2', null, 'Motors'), h('div', { class: 'grid' }, GROUPS.map(([g, label0]) => {
        const label = g === 'xy' && db.printers[build.printer].kinematics !== 'corexy' ? 'X/Y' : label0;
        const s = stepperOf(g);
        return h('div', { class: 'section' },
          g === 'extruder'
            ? select(`${label} motor`, build.motors.extruder ?? '', [{ value: '', label: extruder.recommended_motor ? `Recommended for ${extruder.name}: ${String(extruder.recommended_motor).toUpperCase()}` : 'Stock / not listed' }, ...mOpts],
              (v) => update((b) => { if (v) b.motors.extruder = v; else delete b.motors.extruder; }))
            : select(`${label} motor`, build.motors[g], [{ value: '', label: 'Stock / not listed' }, ...mOpts], (v) => update((b) => { b.motors[g] = v; })),
          s?.driver.standalone ? h('p', { class: 'hint' }, 'These drivers have no current setting in Klipper; it is fixed on the board.') : numberField(`${label} motor current (A)`, build.runCurrent?.[g], (v) => update((b) => {
            b.runCurrent = { ...b.runCurrent };
            if (v === undefined) delete b.runCurrent[g]; else b.runCurrent[g] = v;
            if (!Object.keys(b.runCurrent).length) delete b.runCurrent;
          }), { min: 0.1, max: 3, step: 0.05, placeholder: s ? String(s.runCurrent) : '', hint: s?.currentNote }));
      }))),
      plan ? h('div', { class: 'section' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' },
          h('h2', null, 'Which socket each motor plugs into'),
          build.slotOverrides ? h('button', { type: 'button', class: 'btn', onClick: () => update((b) => { delete b.slotOverrides; }) }, 'Reset to automatic') : null),
        h('p', { class: 'hint', style: 'margin:0' }, 'Filled in automatically (the main X/Y motors go on the board\'s high-voltage sockets when it has them). If you wired a motor to a different socket, pick it here; picking a socket that is in use swaps the two motors.'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Motor', 'Position', 'Socket', 'Driver', 'Current'].map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', null, plan.steppers.map((s) => h('tr', null,
            h('td', { class: 'mono' }, s.name), h('td', null, s.position ?? ''),
            h('td', { class: 'mono' }, s.board === 'toolboard' ? `toolhead · ${s.slot}` : slotPicker(board, plan, s.name, s.slot, update)),
            h('td', { class: 'mono' }, s.driver.standalone ? 'standalone' : `${s.driver.chip.toUpperCase()} ${s.driver.iface.toUpperCase()}${s.driver.hv ? ' · HV' : ''}`),
            h('td', { class: 'mono' }, s.driver.standalone ? 'set on board' : `${s.runCurrent} A`))))))) : null,
    ];
  },
};

function slotPicker(board: Rec, plan: Plan, stepper: string, current: string, update: Ctx['update']): HTMLElement {
  const holder = (slot: string) => plan.steppers.find((x) => x.board === 'mainboard' && x.slot === slot)?.name;
  return h('select', {
    'aria-label': `Driver slot for ${stepper}`, style: 'min-height:36px;padding:4px 8px;font-family:var(--mono);font-size:14.5px;width:auto',
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
      `${d.id}${od ? ` · ${od.standalone ? 'standalone' : od.chip}${od.motor_power ? ' HV' : ''}` : ''}${other && other !== stepper ? ` (${other})` : ''}`);
  }));
}

// --- 5. Homing and probe -----------------------------------------------------------
const PROBE_KINDS: Record<string, string> = {
  integrated: 'Built into the printer',
  inductive: 'Inductive (senses the metal bed)', nozzle_contact: 'Nozzle touches the bed (Tap-style)', dockable_switch: 'Switch picked up from a dock (Klicky)',
  eddy_native: 'Eddy current (built into Klipper)', eddy_plugin: 'Eddy current (needs the maker\'s plugin)', servo_pin: 'Pin that drops down (BLTouch-style)',
};
const switchDraft: { x?: number; y?: number } = {};
const homingStep: Step = {
  id: 'homing', name: 'Homing & probe', title: 'Homing and probe', preview: 'printer.cfg',
  lead: 'How the printer finds the zero point of each axis ("homing"), and the probe that measures the bed so first layers come out even.',
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
          ...Object.values(db.probes).filter((p) => !p.applies_to || p.applies_to.includes(build.printer)).map((p) => ({ value: p.id, label: p.name, group: PROBE_KINDS[p.kind] ?? p.kind }))],
          (v) => update((b) => { if (v) b.probe = v; else delete b.probe; delete b.probeOffset; }))),
      probe ? h('div', { class: 'grid' },
        probe.kind === 'inductive' && !probe.output ? segmented('Probe output', build.probeOutput ?? 'npn-no',
          (['npn-no', 'npn-nc', 'pnp-no', 'pnp-nc'] as const).map((o) => ({ value: o, label: o.toUpperCase() })),
          (v) => update((b) => { b.probeOutput = v; }), 'Printed on the probe\'s label or listing. NPN/PNP is the output type; NO/NC means normally open or normally closed.') : null,
        probe.kind === 'eddy_native' && Array.isArray(probe.interface) ? segmented('Probe connection', build.probeConnection ?? probe.interface[0],
          probe.interface.map((i: string) => ({ value: i as 'usb' | 'can', label: i.toUpperCase() })), (v) => update((b) => { b.probeConnection = v; })) : null,
        numberField('Probe X offset (mm)', build.probeOffset?.x, (v) => update((b) => { b.probeOffset = { x: v ?? 0, y: b.probeOffset?.y ?? known?.y_offset ?? 0 }; }),
          { step: 0.1, placeholder: String(known?.x_offset ?? 0), hint: known ? 'How far the probe sits from the nozzle. Leave blank to use the published offset for this mount.' : 'How far the probe sits from the nozzle. It depends on your mount, so measure it.' }),
        numberField('Probe Y offset (mm)', build.probeOffset?.y, (v) => update((b) => { b.probeOffset = { x: b.probeOffset?.x ?? known?.x_offset ?? 0, y: v ?? 0 }; }),
          { step: 0.1, placeholder: String(known?.y_offset ?? 0) })) : null,
      probe?.docs?.length ? h('ul', { class: 'links' }, probe.docs.map((d: Rec) => h('li', null, extLink(d.url, d.title)))) : null,
      h('div', { class: 'grid' },
        segmented('Z homing', build.homing.z, Object.entries(zm).map(([id, m]: [string, any]) => ({
          value: id as Build['homing']['z'], label: m.name, disabled: id === 'probe_virtual_endstop' && !probe?.z_endstop_capable,
        })), (v) => update((b) => { b.homing.z = v; }), zm[build.homing.z]?.description)),
      build.homing.z === 'nozzle_switch' ? h('div', { class: 'grid' },
        numberField('Z switch X (mm)', sw?.[0] ?? switchDraft.x, (v) => setSwitch('x', v), { step: 0.1, hint: 'Where the nozzle is when it sits right over the switch pin. Measure it on your printer: a guess could drive the nozzle into the bed.' }),
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
  lead: 'Your extruder and hotend, and the temperature sensors (thermistors) in the hotend and bed. These decide how far the extruder pushes filament and the highest safe temperatures.',
  codes: ['unknown_extruder', 'unknown_hotend', 'unknown_thermistor', 'no_thermistor', 'custom_thermistor', 'thermistor_hw', 'max_temp_capped', 'pa_nozzle'],
  render({ db, build, update }) {
    const toolhead = build.toolhead ? db.toolheads[build.toolhead] : undefined;
    const fits = (id: string) => !toolhead?.compatible_extruders || toolhead.compatible_extruders.includes(id);
    const therm = Object.values(db.thermistors).map((t) => ({ value: t.id, label: t.label }));
    const hotend = db.hotends[build.hotend];
    return [
      h('div', { class: 'grid' },
        select('Extruder', build.extruder, Object.values(db.extruders).map((e) => ({
          value: e.id, label: `${e.name}${e.gear_ratio ? ` · gears ${e.gear_ratio}` : ''}`,
          group: fits(e.id) ? (toolhead ? `Fits ${toolhead.name}` : 'Extruders') : 'Other extruders',
        })).sort((a, b) => Number(!fits(a.value)) - Number(!fits(b.value))), (v) => update((b) => { b.extruder = v; delete b.motors.extruder; })),
        select('Hotend', build.hotend, Object.values(db.hotends).map((x) => ({ value: x.id, label: `${x.name} · ${x.flow_class} flow · ${x.max_temp == null ? 'no published max temp' : x.max_temp_basis === 'metalwork' ? `no heater/thermistor included (metal rated ${x.max_temp} °C)` : `max ${x.max_temp} °C`}` })),
          (v) => update((b) => { b.hotend = v; }), hotend.common_thermistor ? `Usually ships with: ${db.thermistors[hotend.common_thermistor]?.label ?? hotend.common_thermistor}` : undefined)),
      h('div', { class: 'grid' },
        select('Hotend thermistor', build.thermistors.hotend, therm, (v) => update((b) => { b.thermistors.hotend = v; }), 'The temperature sensor in the heater block. The wrong type reads the wrong temperature.'),
        select('Bed thermistor', build.thermistors.bed, therm, (v) => update((b) => { b.thermistors.bed = v; })),
        select('Chamber thermistor', build.thermistors.chamber ?? '', [{ value: '', label: 'None' }, ...therm],
          (v) => update((b) => { if (v) b.thermistors.chamber = v; else delete b.thermistors.chamber; }), 'Optional. Measures the air inside an enclosed printer.')),
      h('div', { class: 'grid' },
        numberField('Bed max power (0-1)', build.bed?.maxPower, (v) => update((b) => { b.bed = { ...b.bed, maxPower: v }; }), { min: 0.1, max: 1, step: 0.05, placeholder: '1.0', hint: '1 means full power. Lower it if a large mains-powered bed trips your fuse.' }),
        numberField('Bed max temp (°C)', build.bed?.maxTemp, (v) => update((b) => { b.bed = { ...b.bed, maxTemp: v }; }), { min: 60, max: 150, step: 1, placeholder: '120', hint: 'Klipper shuts the printer down if the bed goes above this.' }),
        numberField('Nozzle diameter (mm)', build.nozzleDiameter, (v) => update((b) => { b.nozzleDiameter = v; }), { min: 0.1, max: 1.2, step: 0.05, placeholder: '0.4' })),
      sources(db.extruders[build.extruder]),
    ];
  },
};

// --- 7. Fans and filter ------------------------------------------------------------------
const FAN_HINTS: Record<string, string> = {
  part_cooling: 'Cools the plastic as it is printed. Your slicer controls its speed.',
  hotend: 'Keeps the top of the hotend cool. Runs automatically whenever the hotend is hot; it is not optional.',
  controller: 'Cools the electronics. Runs while the motors or the bed are on.',
  exhaust: 'Pulls air out of an enclosure. Turns on with the bed heater.',
  bed_fans: 'Circulates warm air from the bed around the enclosure. Turned on by your macros or by hand.',
  chamber_circulation: 'Moves air inside the enclosure. Turned on by your macros or by hand.',
};
const FAN_LABELS: Record<string, string> = {
  part_cooling: 'Part cooling', hotend: 'Hotend fan', controller: 'Electronics bay', exhaust: 'Exhaust',
  bed_fans: 'Bed fans', chamber_circulation: 'Chamber circulation',
};
const fansStep: Step = {
  id: 'fans', name: 'Fans & filter', title: 'Fans and filter', preview: 'mainboard.cfg',
  lead: 'Tick the fans your printer has. Each one is given a free fan port automatically (toolhead fans go on the toolhead board if you have one). Pick a port yourself if your wiring is different.',
  codes: ['no_fan_port', 'fan_port_', 'no_hotend_fan', 'toolchanger_fan_board', 'no_toolboard', 'two_part_fans', 'unknown_fan_role', 'nevermore_twice', 'no_tach', 'filter_', 'unknown_filter'],
  render({ db, build, plan, update }) {
    const nm = build.nevermore;
    const model = nm ? db.filters[nm.model] : undefined;
    const portOf = (role: string) => plan?.fans.filter((f) => f.role === role).map((f) => `${f.port} on the ${f.board === 'toolboard' ? 'toolhead board' : 'mainboard'}`).join(', ');
    const boardFans = (kind: 'mainboard' | 'toolboard'): Rec[] =>
      kind === 'toolboard' ? db.toolboards[build.toolboard?.id ?? '']?.fans ?? [] : mainboardFor(db, build.mainboard).fans ?? [];
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
            [FAN_HINTS[role] ?? '', f && portOf(role) ? h('span', { style: 'display:block' }, `Connected to ${portOf(role)}.`) : null]),
          f && build.toolboard ? segmented('Plugged into', f.board ?? 'auto', [
            { value: 'auto', label: 'Automatic' }, { value: 'mainboard', label: 'Mainboard' }, { value: 'toolboard', label: 'Toolhead board' }],
          (v) => update((b) => { const x = b.fans.find((y) => y.role === role)!; delete x.port; if (v === 'auto') delete x.board; else x.board = v as 'mainboard' | 'toolboard'; })) : null,
          f ? portSelect(`${FAN_LABELS[role] ?? role} port`, kindOf(role, f), f.port, role,
            (v) => update((b) => { const x = b.fans.find((y) => y.role === role)!; if (v) x.port = v; else delete x.port; })) : null);
      })),
      h('div', { class: 'section' }, h('h2', null, 'Nevermore air filter'), h('p', { class: 'hint', style: 'margin:0' }, 'Optional. A carbon filter inside the enclosure that cleans the air while printing materials like ABS and ASA.'),
        h('div', { class: 'grid' },
          select('Filter', nm?.model ?? '', [{ value: '', label: 'None' }, ...Object.values(db.filters).map((x) => ({ value: x.id, label: x.name }))],
            (v) => update((b) => { if (v) b.nevermore = { ...b.nevermore, model: v, voltage: db.filters[v].voltage_options.includes(b.nevermore?.voltage) ? b.nevermore!.voltage : db.filters[v].voltage_options[0] }; else delete b.nevermore; }),
            model ? `${model.fans.count} × ${model.fans.size}; ${model.fans.wiring}.` : undefined),
          model ? segmented('Fan voltage', String(nm!.voltage ?? model.voltage_options[0]), model.voltage_options.map((v: number) => ({ value: String(v), label: `${v} V` })),
            (v) => update((b) => { b.nevermore!.voltage = Number(v) as 12 | 24; })) : null,
          model ? portSelect('Filter fan port (mainboard)', 'mainboard', nm!.port, 'nevermore',
            (v) => update((b) => { if (v) b.nevermore!.port = v; else delete b.nevermore!.port; })) : null,
          model ? segmented('Turns on', nm!.mode ?? db.filterDefaults.mode, [{ value: 'hot_bed', label: `When the bed is ${db.filterDefaults.hot_bed_threshold_c} °C or hotter` }, { value: 'always', label: 'Every print' }],
            (v) => update((b) => { b.nevermore!.mode = v as 'always' | 'hot_bed'; })) : null),
        model ? h('div', { class: 'grid' },
          numberField('Fan speed (0-1)', nm!.speed, (v) => update((b) => { b.nevermore!.speed = v; }), { min: 0.1, max: 1, step: 0.05, placeholder: String(db.filterDefaults.speed) }),
          numberField('Keep running after a print (minutes)', nm!.postPrintMinutes, (v) => update((b) => { b.nevermore!.postPrintMinutes = v; }), { min: 0, max: 120, step: 1, placeholder: String(db.filterDefaults.post_print_minutes) })) : null,
        model?.docs?.length ? h('ul', { class: 'links' }, model.docs.map((d: Rec) => h('li', null, extLink(d.url, d.title)))) : null),
    ];
  },
};

// --- 8. Software ---------------------------------------------------------------------
const softwareStep: Step = {
  id: 'software', name: 'Software', title: 'Web UI and extras', preview: 'macros/print.cfg',
  lead: 'Pick the web interface you use to run your printer. The generated print start routine heats and soaks the printer, levels it, maps the bed and primes the nozzle before printing.',
  codes: ['autotune_', 'plugin_required'],
  render({ build, update }) {
    return [
      h('div', { class: 'grid' },
        segmented('Web UI', build.webUi ?? 'mainsail', [{ value: 'mainsail', label: 'Mainsail' }, { value: 'fluidd', label: 'Fluidd' }, { value: 'none', label: 'None' }],
          (v) => update((b) => { b.webUi = v; }), 'Includes the interface\'s ready-made pause, resume and cancel macros.')),
      checkbox(['Use ', extLink('https://github.com/andrewmcgr/klipper_tmc_autotune', 'klipper_tmc_autotune')], !!build.autotune, (v) => update((b) => { b.autotune = v; }),
        'Fine-tunes each motor driver for its motor, for quieter and smoother motion. Install the klipper_tmc_autotune plugin on your printer first.'),
      h('p', { class: 'hint' }, 'The print start routine follows ', extLink('https://github.com/jontek2/A-better-print_start-macro', 'jontek2\'s "A better print_start macro"'), '; the macros themselves are written for this tool.'),
    ];
  },
};

export const STEPS: Step[] = [printerStep, mainboardStep, toolboardStep, motorsStep, homingStep, hotendStep, fansStep, softwareStep];

export function stepOf(issue: Issue): Step | undefined {
  return STEPS.find((s) => s.codes.some((c) => (c.endsWith('_') ? issue.code.startsWith(c) : issue.code === c)));
}
