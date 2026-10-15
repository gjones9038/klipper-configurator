// Wiring list, jumper checklist and firmware notes derived from a Plan.
import type { Plan } from './plan.ts';
import type { WireConnection } from './types.ts';

const bare = (pin: string) => pin.replace(/^[!^~]*/, '').replace(/^toolhead:/, '');

export function wiring(p: Plan): { connections: WireConnection[]; jumpers: string[] } {
  const c: WireConnection[] = [];
  const add = (x: Omit<WireConnection, 'num'>) => c.push({ num: c.length + 1, ...x });
  const label = (s: { role: string; position?: string; name: string }) =>
    s.role === 'E' ? 'Extruder motor' : `${s.role} motor${s.position ? ` · ${s.position}` : ''}`;

  for (const s of p.steppers) {
    add({
      component: label(s), board: s.board, connector: s.board === 'toolboard' ? 'MOTOR' : s.slot,
      pins: `step ${bare(s.step)} / dir ${bare(s.dir)} / en ${bare(s.enable)}`,
      note: `${s.name}${s.motor ? `, ${s.motor.autotune_name}` : ''}, run_current ${s.runCurrent} A`,
    });
  }
  for (const s of p.steppers) {
    if (s.endstop && typeof s.endstop === 'object') {
      add({ component: `${s.name === 'stepper_z' ? 'Z' : s.name === 'stepper_x' ? 'X' : 'Y'} endstop`, board: s.endstop.board,
        connector: s.endstop.port, pins: bare(s.endstop.pin),
        note: s.name === 'stepper_z' ? 'nozzle switch' : 'wire the switch normally closed (NC)' });
    }
  }
  add({ component: 'Hotend heater', board: p.hotendHeater.board, connector: p.hotendHeater.port, pins: bare(p.hotendHeater.pin) });
  add({ component: 'Hotend thermistor', board: p.hotendSensor.board, connector: p.hotendSensor.port, pins: bare(p.hotendSensor.pin), note: p.thermistor.hotend.label });
  add({ component: 'Bed heater (SSR control input)', board: 'mainboard', connector: p.bedHeater.port, pins: bare(p.bedHeater.pin), note: 'mains goes through the SSR, never the board' });
  add({ component: 'Bed thermistor', board: 'mainboard', connector: p.bedSensor.port, pins: bare(p.bedSensor.pin), note: p.thermistor.bed.label });
  if (p.chamberSensor) add({ component: 'Chamber thermistor', board: p.chamberSensor.board, connector: p.chamberSensor.port, pins: bare(p.chamberSensor.pin) });
  for (const f of p.fans) {
    add({ component: `Fan: ${f.role.replace('_', ' ')}`, board: f.board, connector: f.port, pins: bare(f.pin) + (f.tach ? ` (tach ${bare(f.tach)})` : ''), note: `[${f.section}]` });
  }
  if (p.probe?.port) add({ component: `Probe: ${p.probe.name}`, board: p.probe.port.board, connector: p.probe.port.port, pins: bare(p.probe.port.pin) });
  if (p.bltouch) add({ component: 'BLTouch', board: p.bltouch.board, connector: 'BLTouch', pins: `sensor ${bare(p.bltouch.sensor)} / servo ${bare(p.bltouch.control)}` });
  if (p.leds) add({ component: 'Toolhead LEDs', board: 'toolboard', connector: p.leds.port, pins: bare(p.leds.pin), note: `${p.leds.chain} LEDs, ${p.leds.order}` });
  if (p.toolboard) {
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
  const fanPorts = p.fans.map((f) => `${f.board === 'toolboard' ? 'toolhead ' : ''}${f.port}`);
  if (fanPorts.length) j.push(`Fan voltage: set the voltage jumper for ${fanPorts.join(', ')} to match each fan.`);
  if (p.probe?.kind === 'inductive' && p.probe.port?.board === 'mainboard') {
    j.push(`Probe port ${p.probe.port.port}: set it for an ${p.probe.output === 'npn-no' ? 'NPN' : 'PNP'} probe if the board has a selector jumper, and check its voltage setting.`);
  }
  for (const s of [p.hotendSensor, p.bedSensor]) {
    if ((s === p.hotendSensor ? p.thermistor.hotend : p.thermistor.bed).id === 'pt1000') {
      j.push(`${s.port}: PT1000 selected. If the board has a pull-up jumper for PT1000, set it and update pullup_resistor to match.`);
    }
  }
  if (p.toolboard && (p.build.toolboard!.connection ?? 'can') === 'can') {
    j.push('CAN termination: 120 ohm jumper ON at both ends of the CAN bus (mainboard/adapter and toolhead board), off anywhere in between.');
  }
  return { connections: c, jumpers: j };
}

export function wiringMarkdown(p: Plan, w: ReturnType<typeof wiring>): string {
  const rows = w.connections.map((x) => `| ${x.num} | ${x.component} | ${x.board} | ${x.connector} | \`${x.pins}\` | ${x.note ?? ''} |`);
  return [
    `# Wiring: ${p.board.name} ${p.board.revisions.join('/')}${p.toolboard ? ` + ${p.toolboard.name}` : ''}`,
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
  ].join('\n');
}

export function firmwareMarkdown(p: Plan): string {
  const b = p.build.mainboard;
  const boot = b.bootloaderKib ?? p.mcu.bootloader_kib;
  const iface = b.connection === 'usb' ? 'USB (on PA11/PA12)'
    : b.connection === 'usb-can-bridge' ? `USB to CAN bus bridge (USB on PA11/PA12), CAN bus on ${p.board.can_pins ?? 'the board CAN pins (see manual)'}`
    : `CAN bus (on ${p.board.can_pins ?? 'the board CAN pins'})`;
  const lines = [
    '# Firmware build (make menuconfig)',
    '',
    `## ${p.board.name} ${p.board.revisions.join('/')}`,
    '',
    '- Enable extra low-level configuration options',
    `- Micro-controller: ${p.mcu.chip.toUpperCase()}`,
    `- Bootloader offset: ${boot ? `${boot}KiB bootloader` : 'No bootloader'}`,
    `- Clock reference: ${p.mcu.crystal_mhz} MHz crystal`,
    `- Communication interface: ${iface}`,
    ...(b.connection !== 'usb' ? ['- CAN bus speed: 1000000'] : []),
    '',
  ];
  if (p.board.discrepancies?.some((d: string) => /bootloader/i.test(d))) {
    lines.push('> Sources disagree on this board\'s bootloader. If yours was flashed with Katapult or a stock bootloader, use that offset.', '');
  }
  if (p.toolboard) {
    const t = p.toolboard;
    const conn = p.build.toolboard!.connection ?? (t.interfaces.includes('can') ? 'can' : 'usb');
    lines.push(`## ${t.name} ${t.revisions.join('/')}`, '',
      '- Enable extra low-level configuration options',
      `- Micro-controller: ${t.mcu.chip.toUpperCase()}`,
      ...(t.mcu.crystal_mhz ? [`- Clock reference: ${t.mcu.crystal_mhz} MHz crystal`] : []),
      `- Bootloader offset: no bootloader when flashing over DFU/USB; the Katapult offset if you installed Katapult`,
      `- Communication interface: ${conn === 'can' ? `CAN bus (on ${t.can_pins ?? 'the board CAN pins'})` : 'USB'}`,
      ...(conn === 'can' ? ['- CAN bus speed: 1000000 (must match the mainboard / adapter)'] : []),
      '');
  }
  return lines.join('\n');
}
