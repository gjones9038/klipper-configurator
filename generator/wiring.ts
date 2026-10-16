// Wiring list, jumper checklist and firmware notes derived from a Plan.
import type { Plan } from './plan.ts';
import type { WireConnection } from './types.ts';

const bare = (pin: string) => pin.replace(/^[!^~]*/, '').replace(/^toolhead\d*:/, '');

export function wiring(p: Plan): { connections: WireConnection[]; jumpers: string[] } {
  const c: WireConnection[] = [];
  const add = (x: Omit<WireConnection, 'num'>) => c.push({ num: c.length + 1, ...x });
  const label = (s: { role: string; position?: string; name: string }) =>
    s.role === 'E' ? 'Extruder motor' : /^stepper_[abc]$/.test(s.name) ? `Tower ${s.role} motor` : `${s.role} motor${s.position ? ` · ${s.position}` : ''}`;

  const toolOf = (s: { name: string }) => p.tools?.find((t) => t.stepper.name === s.name);
  for (const s of p.steppers) {
    const t = toolOf(s);
    add({
      component: t ? `T${t.n} extruder motor` : label(s), board: s.board, connector: s.board === 'toolboard' ? 'MOTOR' : s.slot,
      pins: `step ${bare(s.step)} / dir ${bare(s.dir)} / en ${bare(s.enable)}`,
      note: `${s.name}${s.motor ? `, ${s.motor.autotune_name}` : ''}, run_current ${s.runCurrent} A`,
      ...(t ? { tool: t.n } : {}),
    });
  }
  for (const s of p.steppers) {
    if (s.endstop && typeof s.endstop === 'object') {
      add({ component: `${/^stepper_[abc]$/.test(s.name) ? `Tower ${s.name.slice(-1).toUpperCase()}` : s.name.replace('stepper_', '').toUpperCase()} endstop`, board: s.endstop.board,
        connector: s.endstop.port, pins: bare(s.endstop.pin),
        note: s.name === 'stepper_z' ? 'nozzle switch' : 'wire the switch normally closed (NC)' });
    }
  }
  if (!p.tools) {
    add({ component: 'Hotend heater', board: p.hotendHeater.board, connector: p.hotendHeater.port, pins: p.hotendHeater.multi ? p.hotendHeater.multi.pins.map(bare).join(' + ') : bare(p.hotendHeater.pin) });
    add({ component: 'Hotend thermistor', board: p.hotendSensor.board, connector: p.hotendSensor.port, pins: bare(p.hotendSensor.pin), note: p.thermistor.hotend.label });
  }
  const { bedHeater, bedSensor } = p;
  if (!bedHeater || !bedSensor) { /* no heated bed */ }
  else if (p.printer.bed_heater === 'unknown') add({ component: 'Bed heater', board: 'mainboard', connector: bedHeater.port, pins: bare(bedHeater.pin), note: 'stock wiring; check whether your bed is mains (through an SSR) or 24 V before changing it' });
  else if (p.printer.bed_heater === 'dc') add({ component: 'Bed heater', board: 'mainboard', connector: bedHeater.port, pins: bare(bedHeater.pin), note: '24 V bed, wired straight to the board output' });
  else add({ component: 'Bed heater (SSR control input)', board: 'mainboard', connector: bedHeater.port, pins: bare(bedHeater.pin), note: 'mains goes through the SSR, never the board' });
  if (bedSensor) add({ component: 'Bed thermistor', board: 'mainboard', connector: bedSensor.port, pins: bare(bedSensor.pin), note: p.thermistor.bed!.label });
  if (p.chamberSensor) add({ component: 'Chamber thermistor', board: p.chamberSensor.board, connector: p.chamberSensor.port, pins: bare(p.chamberSensor.pin) });
  if (p.printer.hotend_fan === 'always_on' && !p.fans.some((f) => f.role === 'hotend')) {
    add({ component: 'Fan: hotend', board: 'mainboard', connector: '24 V (always on)', pins: '-', note: 'stock wiring: runs whenever the printer is on' });
  }
  for (const f of p.fans) {
    add({ component: `Fan: ${f.role.replace('_', ' ')}`, board: f.board, connector: f.port, pins: (f.multi ? f.multi.pins.map(bare).join(' + ') : bare(f.pin)) + (f.tach ? ` (tach ${bare(f.tach)})` : ''), note: `[${f.section}]` });
  }
  if (p.probe?.port) {
    const out = p.probe.output ? ` (${p.probe.output.toUpperCase()})` : '';
    add({ component: `Probe: ${p.probe.name}${out}`, board: p.probe.port.board, connector: p.probe.port.port, pins: bare(p.probe.port.pin),
      note: p.probe.kind === 'inductive' ? `power the probe from ${p.probe.supply_v?.join('-') ?? '12-24'} V${p.probe.port.board === 'mainboard' && !(p.board.probe_ports?.[0]?.protected) ? '; BAT85 diode on the signal (black band toward the probe)' : ''}` : undefined });
  }
  if (p.probe?.i2c) {
    const port = p.probe.i2c.port;
    add({ component: `Probe: ${p.probe.name}`, board: 'toolboard', connector: port.id, pins: `SCL ${port.scl_pin} / SDA ${port.sda_pin} + 5V / GND`,
      note: `Klipper i2c_bus ${p.probe.i2c.bus}; mount it per the BTT guide and measure x/y offsets` });
  } else if (p.probe?.kind === 'eddy_native' || p.probe?.kind === 'eddy_plugin') {
    const conn = p.probe.connection ?? 'usb';
    add({ component: `Probe: ${p.probe.name}`, board: 'mainboard', connector: conn === 'can' ? 'CAN bus' : 'host USB',
      pins: conn === 'can' ? 'CAN-H / CAN-L + 24V / GND' : 'USB cable to the host (Pi/CB1)', note: 'own MCU; mount it per the vendor guide and measure x/y offsets' });
  }
  for (const e of p.board.activeExtensions ?? []) {
    if (e.buzzer) add({ component: 'Buzzer', board: 'mainboard', connector: `${e.buzzer.id} (on the ${e.name})`, pins: bare(e.buzzer.pin), note: 'built in; M300 S<Hz> P<ms> plays a tone' });
  }
  if (p.bltouch) add({ component: 'BLTouch', board: p.bltouch.board, connector: 'BLTouch', pins: `sensor ${bare(p.bltouch.sensor)} / servo ${bare(p.bltouch.control)}` });
  for (const t of p.tools ?? []) {
    const T = `T${t.n}`;
    add({ component: `${T} hotend heater`, board: 'toolboard', connector: t.heater.port, pins: bare(t.heater.pin), tool: t.n });
    add({ component: `${T} hotend thermistor`, board: 'toolboard', connector: t.sensor.port, pins: bare(t.sensor.pin), note: t.thermistor.label, tool: t.n });
    for (const f of t.fans) add({ component: `${T} fan: ${f.role.replace('_', ' ')}`, board: 'toolboard', connector: f.port, pins: bare(f.pin), note: `[${f.section}]`, tool: t.n });
    add({ component: `${T} Tap sensor`, board: 'toolboard', connector: t.probe.port, pins: bare(t.probe.pin), note: 'Z probe and tool detection (one pin)', tool: t.n });
    if (t.leds) add({ component: `${T} LEDs`, board: 'toolboard', connector: t.leds.port, pins: bare(t.leds.pin), note: `${t.leds.chain} LEDs, ${t.leds.order}`, tool: t.n });
    add({ component: `${T} board link`, board: 'toolboard', connector: t.connection.toUpperCase(), pins: t.connection === 'can' ? 'CAN-H / CAN-L + 24V / GND' : 'USB + 24V / GND', tool: t.n,
      note: t.connection === 'can' ? (p.build.mainboard.connection === 'usb-can-bridge' ? `CAN bus from the mainboard CAN port (${p.board.can_pins ?? 'see manual'})` : 'CAN bus from the USB-CAN adapter') : 'USB to the host' });
  }
  if (p.leds && !p.tools) add({ component: 'Toolhead LEDs', board: 'toolboard', connector: p.leds.port, pins: bare(p.leds.pin), note: `${p.leds.chain} LEDs, ${p.leds.order}` });
  if (p.toolboard && !p.tools) {
    const conn = p.build.toolboard!.connection ?? (p.toolboard.interfaces.includes('can') ? 'can' : 'usb');
    add({ component: 'Toolhead board link', board: 'toolboard', connector: conn.toUpperCase(), pins: conn === 'can' ? 'CAN-H / CAN-L + 24V / GND' : 'USB + 24V / GND',
      note: conn === 'can' ? (p.build.mainboard.connection === 'usb-can-bridge' ? `to the mainboard CAN port (${p.board.can_pins ?? 'see manual'})` : 'to the USB-CAN adapter') : 'USB to the host' });
  }

  const j: string[] = [];
  if (['stepstick', 'ez'].includes(p.board.driver_mount)) {
    const uart = p.steppers.filter((s) => s.board === 'mainboard' && s.driver.iface === 'uart').map((s) => s.slot);
    const spi = p.steppers.filter((s) => s.board === 'mainboard' && s.driver.iface === 'spi').map((s) => s.slot);
    if (uart.length) j.push(`Driver mode UART under ${uart.join(', ')}: the single UART jumper, no SPI jumpers (see the board manual for positions).`);
    if (spi.length) j.push(`Driver mode SPI under ${spi.join(', ')}: the SPI jumper set, no UART jumper (see the board manual for positions).`);
    const sensorless = p.steppers.filter((s) => s.endstop === 'virtual').map((s) => s.slot);
    if (sensorless.length) j.push(`DIAG jumper ON under ${sensorless.join(', ')} (sensorless homing).`);
    const diagRemove = new Set<string>();
    for (const s of p.steppers) {
      if (s.endstop && typeof s.endstop === 'object') {
        const port = s.endstop.port;
        const ep = (p.board.endstops ?? []).find((e: any) => e.id === port);
        if (ep?.diag_of) diagRemove.add(ep.diag_of);
      }
    }
    if (diagRemove.size) j.push(`DIAG jumper OFF under ${[...diagRemove].join(', ')}: those DIAG headers are used for physical switches.`);
  }
  // Extension-board fans share one voltage setting per extension (Leviathan ext: one FAN_V rail).
  const extFan = (f: { board: string; port: string }) => f.board === 'mainboard' && (p.board.fans ?? []).find((x: any) => x.id === f.port)?.extension;
  for (const e of p.board.activeExtensions ?? []) {
    const ports = p.fans.filter((f) => extFan(f) === e.id);
    if (ports.length) j.push(`${e.name} fan voltage: ${e.fans[0].voltage_select}; it applies to ${e.fans.map((x: any) => x.id).join(' and ')} together, so the fans on ${ports.map((f) => `${f.port}${f.voltage ? ` (${f.voltage} V)` : ''}`).join(', ')} must all run at the same voltage.`);
  }
  // Only ports with a voltage selector need a jumper (stock Creality boards have none).
  const portRec = (f: { board: string; port: string }) => (f.board === 'toolboard' ? p.toolboard?.fans : p.board.fans)?.find((x: any) => x.id === f.port);
  const fanPorts = [
    ...p.fans.filter((f) => !extFan(f) && (f.board === 'toolboard' || portRec(f)?.voltage_options)).map((f) => `${f.board === 'toolboard' ? 'toolhead ' : ''}${f.port}${f.voltage ? ` (${f.voltage} V)` : ''}`),
    ...(p.tools ?? []).flatMap((t) => t.fans.map((f) => `T${t.n} ${f.port}`)),
  ];
  if (fanPorts.length) j.push(`Fan voltage: set the voltage jumper for ${fanPorts.join(', ')} to match each fan.`);
  if (p.probe?.kind === 'inductive' && p.probe.port?.board === 'mainboard') {
    j.push(`Probe port ${p.probe.port.port}: set it for an ${p.probe.output === 'npn-no' ? 'NPN' : 'PNP'} probe if the board has a selector jumper, and check its voltage setting.`);
  }
  for (const s of [p.hotendSensor, p.bedSensor]) {
    if (!s) continue;
    if ((s === p.hotendSensor ? p.thermistor.hotend : p.thermistor.bed)?.id === 'pt1000') {
      j.push(`${s.port}: PT1000 selected. If the board has a pull-up jumper for PT1000, set it and update pullup_resistor to match.`);
    }
  }
  if (p.tools) {
    const can = p.tools.filter((t) => t.connection === 'can').map((t) => `T${t.n}`);
    if (can.length) j.push(`CAN termination: exactly two 120 ohm terminators, at the two physical ends of the CAN bus. With several tool boards (${can.join(', ')}) only the board at the far end keeps its jumper; remove it on the others.`);
  } else if (p.toolboard && (p.build.toolboard!.connection ?? 'can') === 'can') {
    j.push('CAN termination: 120 ohm jumper ON at both ends of the CAN bus (mainboard/adapter and toolhead board), off anywhere in between.');
  }
  return { connections: c, jumpers: j };
}

export function wiringMarkdown(p: Plan, w: ReturnType<typeof wiring>): string {
  const rows = w.connections.map((x) => `| ${x.num} | ${x.component} | ${x.board} | ${x.connector} | \`${x.pins}\` | ${x.note ?? ''} |`);
  return [
    `# Wiring: ${p.board.name} ${p.board.revisions.join('/')}${(p.board.activeExtensions ?? []).map((e: any) => ` + ${e.name}`).join('')}${p.tools ? ` + ${p.tools.length} tools` : p.toolboard ? ` + ${p.toolboard.name}` : ''}`,
    '',
    'Connector names come from the vendor sample configs. Check them against the silkscreen before plugging anything in.',
    '',
    '## Jumpers before power-on',
    '',
    ...w.jumpers.map((x) => `- ${x}`),
    '',
    '## Connections',
    '',
    '| # | Component | Board | Connector | Pins | Note |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    ...linkSection(p, ['mainboard', 'toolhead board', 'probe', 'filter', 'wiring', 'toolchanger']),
  ].join('\n');
}

/** Markdown "References" list. Links are absolute; the web UI opens them in a new tab. */
export function linkSection(p: Plan, topics?: string[]): string[] {
  const ls = p.links.filter((l) => !topics || topics.includes(l.topic));
  if (!ls.length) return [];
  return ['## References', '', ...ls.map((l) => `- [${l.title}](${l.url})`), ''];
}

export function linksMarkdown(p: Plan): string {
  const topics = [...new Set(p.links.map((l) => l.topic))];
  const out = ['# Documentation for this build', '', 'Everything referenced by the generated files, grouped by topic.', ''];
  for (const t of topics) {
    out.push(`## ${t[0].toUpperCase()}${t.slice(1)}`, '');
    for (const l of p.links.filter((x) => x.topic === t)) out.push(`- [${l.title}](${l.url})`);
    out.push('');
  }
  return out.join('\n');
}

export function slicerMarkdown(p: Plan): string {
  if (p.tools) return toolchangerSlicer(p);
  const chamber = p.chamberSensor ? '' : '\n> No chamber sensor configured: CHAMBER is ignored and PRINT_START soaks for SOAK minutes instead (default 10 for beds at 90C+).\n';
  const block = (name: string, where: string, line: string) =>
    [`## ${name}`, '', `${where}:`, '', '```', `M104 S0 ; stop the slicer sending its own temperature waits`, 'M140 S0', line, '```', ''];
  return [
    '# Slicer start G-code',
    '',
    'PRINT_START takes the temperatures from the slicer. Replace your start G-code with the block for your slicer.',
    chamber,
    ...block('OrcaSlicer', 'Printer settings -> Machine G-code -> Machine start G-code', 'PRINT_START EXTRUDER=[first_layer_temperature] BED=[first_layer_bed_temperature] CHAMBER=[chamber_temperature]'),
    ...block('SuperSlicer', 'Printer settings -> Custom G-code -> Start G-code', 'PRINT_START EXTRUDER=[first_layer_temperature] BED=[first_layer_bed_temperature] CHAMBER=[chamber_temperature]'),
    ...block('PrusaSlicer', 'Printer settings -> Custom G-code -> Start G-code', 'PRINT_START EXTRUDER=[first_layer_temperature[initial_extruder]] BED=[first_layer_bed_temperature] CHAMBER=[chamber_temperature] CHAMBER_MINIMAL=[chamber_minimal_temperature]'),
    ...block('Cura', 'Preferences -> Printers -> Machine Settings -> Start G-code', 'PRINT_START EXTRUDER={material_print_temperature_layer_0} BED={material_bed_temperature_layer_0} CHAMBER={build_volume_temperature}'),
    'End G-code for all slicers: `PRINT_END`',
    '',
    'Placeholder names follow "A better print_start macro" by jontek2: https://github.com/jontek2/A-better-print_start-macro',
    '',
  ].join('\n');
}

export function firmwareMarkdown(p: Plan): string {
  const b = p.build.mainboard;
  const boot = b.bootloaderKib ?? p.mcu.bootloader_kib;
  const iface = b.connection === 'usb-serial' ? (p.board.firmware?.interface ?? 'Serial (see the board manual for the USART)')
    : b.connection === 'usb' ? 'USB (on PA11/PA12)'
    : b.connection === 'usb-can-bridge' ? `USB to CAN bus bridge (USB on PA11/PA12), CAN bus on ${p.board.can_pins ?? 'the board CAN pins (see manual)'}`
    : `CAN bus (on ${p.board.can_pins ?? 'the board CAN pins'})`;
  const lines = [
    '# Firmware build (make menuconfig)',
    '',
    `## ${p.board.name} ${p.board.revisions.join('/')}`,
    '',
    '- Enable extra low-level configuration options',
    ...(p.mcu.arch === 'avr' ? [
      '- Micro-controller Architecture: Atmega AVR',
      `- Processor model: ${p.mcu.chip}`,
      `- Processor speed: ${p.mcu.cpu_mhz} MHz`,
    ] : [
      `- Micro-controller: ${(p.mcu.build_as ?? p.mcu.chip).toUpperCase()}${p.mcu.build_as ? ` (the ${p.mcu.chip.toUpperCase()} is built as ${p.mcu.build_as.toUpperCase()})` : ''}`,
      `- Bootloader offset: ${boot ? `${boot}KiB bootloader` : 'No bootloader'}${p.mcu.bootloader_note ? ` (${p.mcu.bootloader_note})` : ''}`,
      `- Clock reference: ${p.mcu.crystal_mhz} MHz crystal`,
    ]),
    `- Communication interface: ${iface}`,
    ...(['can', 'usb-can-bridge'].includes(b.connection) ? ['- CAN bus speed: 1000000'] : []),
    ...(p.mcu.menuconfig_extra ?? []).map((x: string) => `- ${x}`),
    '',
    ...(p.board.firmware?.flash ? [`Flashing: ${p.board.firmware.flash}`, ''] : []),
  ];
  if (p.board.discrepancies?.some((d: string) => /bootloader/i.test(d))) {
    lines.push('> Sources disagree on this board\'s bootloader. If yours was flashed with Katapult or a stock bootloader, use that offset.', '');
  }
  const toolBoards = p.tools
    ? p.tools.map((t) => ({ t: t.toolboard, conn: t.connection, title: `T${t.n}: ` }))
    : p.toolboard ? [{ t: p.toolboard, conn: p.build.toolboard!.connection ?? (p.toolboard.interfaces.includes('can') ? 'can' : 'usb'), title: '' }] : [];
  for (const { t, conn, title } of toolBoards) {
    lines.push(`## ${title}${t.name} ${t.revisions.join('/')}`, '',
      '- Enable extra low-level configuration options',
      `- Micro-controller: ${t.mcu.chip.toUpperCase()}`,
      ...(t.mcu.menuconfig_extra ?? []).map((x: string) => `- ${x}`),
      ...(t.mcu.crystal_mhz ? [`- Clock reference: ${t.mcu.crystal_mhz} MHz crystal`] : []),
      t.mcu.bootloader_kib
        ? `- Bootloader offset: ${t.mcu.bootloader_kib}KiB bootloader${t.mcu.bootloader_note ? ` (${t.mcu.bootloader_note})` : ''}`
        : `- Bootloader offset: no bootloader when flashing over DFU/USB; the Katapult offset if you installed Katapult`,
      `- Communication interface: ${conn === 'can' ? `CAN bus (on ${t.can_pins ?? 'the board CAN pins'})` : 'USB'}`,
      ...(conn === 'can' && t.mcu.chip === 'rp2040' && /^gpio\d+\/gpio\d+$/.test(t.can_pins ?? '')
        ? [`- CAN RX gpio number: ${t.can_pins.split('/')[0].slice(4)}, CAN TX gpio number: ${t.can_pins.split('/')[1].slice(4)}`] : []),
      ...(conn === 'can' ? ['- CAN bus speed: 1000000 (must match the mainboard / adapter)'] : []),
      ...(t.mcu.startup_pins ? [`- GPIO pins to set at micro-controller startup: ${t.mcu.startup_pins}${t.mcu.startup_pins_note ? ` (${t.mcu.startup_pins_note})` : ''}`] : []),
      '');
  }
  const pr = p.probe;
  if (pr?.kind === 'eddy_native' && pr.mcu) {
    const m = pr.mcu;
    const conn = pr.connection ?? 'usb';
    lines.push(`## ${pr.name}`, '',
      '- Enable extra low-level configuration options',
      `- Micro-controller: ${m.chip.toUpperCase()}`,
      ...(m.crystal_mhz ? [`- Clock reference: ${m.crystal_mhz} MHz crystal`] : []),
      `- Communication interface: ${conn === 'can' ? `CAN bus (on ${m.can_pins ?? 'see vendor docs'})` : `USB${m.usb_pins ? ` (on ${m.usb_pins})` : ''}`}`,
      ...(conn === 'can' && m.can_note ? [`- ${m.can_note}`] : []),
      '- Bootloader and flashing: follow the vendor guide (links below); many ship with Katapult or a pre-flashed Klipper',
      '');
  }
  if (pr?.kind === 'eddy_plugin') {
    lines.push(`## ${pr.name}`, '', `Beacon runs its own firmware (not Klipper). Install the Klipper module from ${pr.plugin.repo}; it updates the probe firmware itself.`, '');
  }
  lines.push(...linkSection(p, ['mainboard', 'toolhead board', 'probe', 'wiring']));
  return lines.join('\n');
}

// Toolchanger slicer setup: the start line passes the first tool, and the
// tool-change / layer-change lines are klipper-toolchanger's (examples/README.md).
function toolchangerSlicer(p: Plan): string {
  const sl = p.toolchanger!.rec.slicer;
  const start = 'PRINT_START EXTRUDER={first_layer_temperature[initial_tool]} BED=[first_layer_bed_temperature] CHAMBER=[chamber_temperature] TOOL=[initial_tool]';
  const code = (title: string, where: string, line: string) => [`### ${title}`, '', `${where}:`, '', '```', line, '```', ''];
  return [
    '# Slicer G-code (toolchanger)',
    '',
    `PRINT_START homes, levels and meshes with T0, then picks up the slicer's first tool (TOOL).${p.chamberSensor ? '' : ' No chamber sensor: CHAMBER is ignored and PRINT_START soaks for SOAK minutes instead.'}`,
    '',
    '## OrcaSlicer, PrusaSlicer, SuperSlicer',
    '',
    ...code('Start G-code', 'Printer settings -> Machine start G-code', `M104 S0 ; stop the slicer sending its own temperature waits\nM140 S0\n${start}`),
    ...code('Tool change G-code', 'Printer settings -> Change filament G-code (Orca: Machine G-code -> Change filament G-code)', sl.tool_change),
    ...code('After layer change G-code', 'Printer settings -> After layer change G-code', sl.after_layer_change),
    'End G-code: `PRINT_END`',
    '',
    `Set the printer's extruder count to ${p.tools!.length} in the slicer; T0..T${p.tools!.length - 1} map to [tool T0]..[tool T${p.tools!.length - 1}].`,
    '',
    '> Cura is not covered for toolchangers here; its placeholders differ.',
    '',
    'Source: klipper-toolchanger examples/README.md (Slicer setup); PRINT_START flow after "A better print_start macro" by jontek2: https://github.com/jontek2/A-better-print_start-macro',
    '',
  ].join('\n');
}
