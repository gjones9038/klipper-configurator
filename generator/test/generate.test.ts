import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate, loadDb } from '../index.ts';
import { plan } from '../plan.ts';
import { matrix } from './matrix.ts';
import type { Build } from '../types.ts';

const db = loadDb();
const example = (): Build => JSON.parse(readFileSync(new URL('../../examples/v24-350-leviathan-sb2209.json', import.meta.url), 'utf8'));

// Errors a matrix case may legitimately end in; anything else is a bug.
const EXPECTED_ERRORS = new Set(['not_enough_drivers', 'no_fan_port', 'no_endstop_port', 'sensorless_no_diag', 'no_probe_port',
  // matrix deliberately includes combinations the generator must refuse:
  'pnp_unsupported_port', 'beacon_sensorless', 'fan_port_voltage', 'no_can_path', 'probe_supply']);

test('matrix: every case generates or fails with an expected reason', () => {
  const cases = matrix(db);
  let ok = 0;
  for (const c of cases) {
    const r = generate(c.build, db, 'test');
    if (r.ok) { ok++; continue; }
    const unexpected = r.issues.filter((i) => i.level === 'error' && !EXPECTED_ERRORS.has(i.code));
    assert.deepEqual(unexpected, [], `${c.name}: ${JSON.stringify(unexpected)}`);
  }
  assert.ok(ok > cases.length / 2, `only ${ok}/${cases.length} cases generated`);
});

test('no physical pin is used twice in a generated config', () => {
  for (const c of matrix(db)) {
    const r = generate(c.build, db, 'test');
    if (!r.ok) continue;
    for (const [name, text] of Object.entries(r.files)) {
      if (!name.endsWith('.cfg') || name.startsWith('macros/')) continue;
      const seen = new Map<string, string>();
      let section = '';
      for (const line of text.split('\n')) {
        const s = /^\[(.+?)\]/.exec(line);
        if (s) { section = s[1]; continue; }
        const m = /^(\w*pin): *([!^~]*)((?:toolhead\d*:)?P[A-K]\d+|(?:toolhead\d*:)?gpio\d+)/.exec(line);
        if (!m) continue;
        // SPI bus pins are shared by design; endstop pin may equal its slot's DIAG pin.
        if (m[1].startsWith('spi_software')) continue;
        const key = m[3];
        const prev = seen.get(key);
        // A toolchanger tool's Tap pin is both [tool_probe] pin and [tool] detection_pin (tool_probe.py allows it).
        const tapShare = (m[1] === 'detection_pin' && prev?.includes('[tool_probe')) ?? false;
        // Klipper allows one enable line shared by several steppers (Creality boards).
        const sharedEnable = m[1] === 'enable_pin' && !!prev?.endsWith('enable_pin');
        assert.ok(!prev || tapShare || sharedEnable || (m[1].startsWith('diag') && prev.includes('endstop')),
          `${c.name} ${name}: ${key} in [${section}] ${m[1]} and ${prev}`);
        seen.set(key, `[${section}] ${m[1]}`);
      }
    }
  }
});

test('Leviathan puts A/B on the HV TMC5160 slots', () => {
  const p = plan(example(), db);
  assert.equal(p.steppers.find((s) => s.name === 'stepper_x')!.slot, 'HV-STEPPER-0');
  assert.equal(p.steppers.find((s) => s.name === 'stepper_y')!.slot, 'HV-STEPPER-1');
  assert.equal(p.hotendSensor.pullup, 4700); // on the toolboard
  assert.equal(p.bedSensor.pullup, 2200);    // Leviathan 2.2k
});

test('run current: maker recommendation wins, capped by motor rating', () => {
  const p = plan(example(), db);
  assert.equal(p.steppers.find((s) => s.name === 'extruder')!.runCurrent, 0.6); // Galileo 2 README
  const b = example();
  b.runCurrent = { xy: 3.0 };
  const p2 = plan(b, db);
  assert.ok(p2.issues.some((i) => i.code === 'run_current_high'));
});

test('AWD on the 7-slot Leviathan is refused with a clear reason', () => {
  const b = example();
  b.variant = 'awd';
  const r = generate(b, db, 'test');
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'not_enough_drivers');
  assert.match(r.issues[0].message, /LDO Leviathan Extension Board adds 2 driver slots/);
});

test('AWD on the Leviathan with its extension board: B1/A1 on the extension HV slots (LDO layout)', () => {
  const b = example();
  b.variant = 'awd';
  b.mainboard.extensions = ['ldo-leviathan-ext'];
  const p = plan(b, db);
  const slot = (n: string) => p.steppers.find((s) => s.name === n)!;
  assert.equal(slot('stepper_x').slot, 'HV-STEPPER-0');
  assert.equal(slot('stepper_y').slot, 'HV-STEPPER-1');
  assert.equal(slot('stepper_x1').slot, 'EXT-HV-STEPPER-2');
  assert.equal(slot('stepper_y1').slot, 'EXT-HV-STEPPER-3');
  assert.equal(slot('stepper_x1').step, 'PD15');
  assert.deepEqual(slot('stepper_y1').driver.pins, { cs_pin: 'PG5', spi_bus: 'spi2' });
  const r = generate(b, db, 'test');
  assert.ok(r.ok, JSON.stringify(r.issues));
  const mb = r.files['mainboard.cfg'];
  assert.match(mb, /\[tmc5160 stepper_x1\][^[]*cs_pin: PB12[^[]*spi_bus: spi2/);
  assert.match(mb, /\[tmc5160 stepper_x\][^[]*spi_bus: spi4/);
  assert.match(mb, /\[pwm_cycle_time _beeper\][^[]*pin: PB1/);
  assert.match(mb, /\[gcode_macro M300\][\s\S]*?SET_PIN PIN=_beeper VALUE=0\.5 CYCLE_TIME=/);
  assert.doesNotMatch(generate(example(), db, 'test').files['mainboard.cfg'], /_beeper/);   // no extension, no buzzer
  const pm = r.files['macros/print.cfg'];
  assert.match(pm, /\[gcode_macro PRINT_END\][\s\S]*?_BEEP_DONE/);
  assert.match(pm, /variable_user_pause_macro: "_BEEP_ATTENTION"/);
  assert.doesNotMatch(generate(example(), db, 'test').files['macros/print.cfg'], /_BEEP|_CLIENT_VARIABLE/);
  const quiet = generate({ ...b, beeps: false }, db, 'test').files;
  assert.doesNotMatch(quiet['macros/print.cfg'], /_BEEP|_CLIENT_VARIABLE/);
  assert.match(quiet['mainboard.cfg'], /gcode_macro M300/);
  const noUi = generate({ ...b, webUi: 'none' }, db, 'test').files['macros/print.cfg'];
  assert.match(noUi, /_BEEP_DONE/);
  assert.doesNotMatch(noUi, /_CLIENT_VARIABLE/);
});

test('Leviathan extension: 9 drivers fit AWD without a toolhead board; its fans and thermistors are usable', () => {
  const b = example();
  b.variant = 'awd';
  delete b.toolboard;
  b.mainboard.extensions = ['ldo-leviathan-ext'];
  b.fans = [{ role: 'part_cooling' }, { role: 'hotend' }, { role: 'controller' }, { role: 'exhaust', port: 'EXT-FAN4' }];
  b.thermistors.chamber = 'ntc100k-3950';
  const p = plan(b, db);
  assert.equal(p.issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(p.issues));
  assert.equal(p.steppers.length, 9);
  assert.equal(p.fans.find((f) => f.role === 'exhaust')!.pin, 'PF5');
});

test('an unknown mainboard extension is refused', () => {
  const b = example();
  b.mainboard.extensions = ['nope'];
  assert.throws(() => plan(b, db), /no extension board "nope"/);
});

test('CAN toolboard without a CAN path is an error', () => {
  const b = example();
  b.mainboard.connection = 'usb';
  const r = generate(b, db, 'test');
  assert.ok(r.issues.some((i) => i.code === 'no_can_path'));
});

test('nozzle switch outside travel is an error', () => {
  const b = example();
  b.homing.zSwitchXY = [232, 355];
  const r = generate(b, db, 'test');
  assert.ok(r.issues.some((i) => i.code === 'z_switch_out_of_range'));
});

test('sensorless homing uses virtual endstops, DIAG pins and homing_override', () => {
  const b = example();
  b.homing = { xy: 'sensorless', z: 'nozzle_switch', zSwitchXY: [232, 350] };
  b.autotune = false;
  const r = generate(b, db, 'test');
  assert.ok(r.ok, JSON.stringify(r.issues));
  const mb = r.files['mainboard.cfg'];
  assert.match(mb, /endstop_pin: tmc5160_stepper_x:virtual_endstop/);
  assert.match(mb, /diag0_pin: \^!PG1/);        // LDO: ^! on TMC5160 DIAG0
  assert.match(mb, /homing_retract_dist: 0/);
  assert.match(mb, /driver_SGT: 1/);
  assert.ok(r.files['homing.cfg'].includes('[homing_override]'));
  assert.ok(!r.files['printer.cfg'].includes('[safe_z_home]'));
});

test('SPI drivers on a stepstick board emit cs_pin and the board SPI bus', () => {
  const b = example();
  b.mainboard = { id: 'btt-octopus-pro-v1.1', connection: 'usb-can-bridge' };
  b.drivers = { xy: { module: 'btt-tmc5160-pro' }, z: { module: 'btt-tmc2209' } };
  b.homing = { xy: 'physical', z: 'nozzle_switch', zSwitchXY: [232, 350] };
  const r = generate(b, db, 'test');
  assert.ok(r.ok, JSON.stringify(r.issues));
  assert.match(r.files['mainboard.cfg'], /\[tmc5160 stepper_x\][^[]*cs_pin: PC4\nspi_bus: spi1\nsense_resistor: 0.075/);
  assert.match(r.files['mainboard.cfg'], /\[tmc2209 stepper_z\][^[]*uart_pin: PF9|\[tmc2209 stepper_z\][^[]*uart_pin: PC6/);
  assert.ok(r.wiring.jumpers.some((j) => j.startsWith('Driver mode SPI')));
});

test('inductive probes: NC uses the port modifier, NO flips it, PNP needs a PNP-capable port', () => {
  const b = example();                                   // Leviathan Z-PROBE, LDO modifier ^
  assert.match(generate(b, db, 't').files['mainboard.cfg'], /\[probe\][^[]*pin: \^PF1/);
  b.probe = 'generic-inductive';
  b.probeOutput = 'npn-no';
  const no = generate(b, db, 't');
  assert.match(no.files['mainboard.cfg'], /pin: \^!PF1/);
  assert.ok(no.issues.some((i) => i.code === 'probe_no'));
  b.probeOutput = 'pnp-nc';
  assert.ok(generate(b, db, 't').issues.some((i) => i.code === 'pnp_unsupported_port'));
  b.mainboard = { id: 'btt-octopus-pro-v1.1', connection: 'usb-can-bridge' };
  b.drivers = { xy: { module: 'btt-tmc2209' }, z: { module: 'btt-tmc2209' } };
  const pnp = generate(b, db, 't');
  assert.ok(pnp.ok, JSON.stringify(pnp.issues));
  assert.ok(pnp.issues.some((i) => i.code === 'probe_port_jumper' && i.message.includes('PNP')));
  b.probeOutput = undefined;
  assert.ok(generate(b, db, 't').issues.some((i) => i.code === 'probe_output_needed'));
});

test('eddy probes: native Klipper config with its own MCU, scan meshes and calibration macros', () => {
  const b = example();
  b.probe = 'btt-eddy-usb';
  b.homing = { xy: 'physical', z: 'probe_virtual_endstop' };
  const r = generate(b, db, 't');
  assert.ok(r.ok, JSON.stringify(r.issues));
  const pc = r.files['probe.cfg'];
  assert.match(pc, /\[mcu eddy\]/);
  assert.match(pc, /\[probe_eddy_current btt_eddy\][^[]*i2c_bus: i2c0f[^[]*descend_z: 0.5/);
  assert.match(pc, /\[temperature_probe btt_eddy\][^[]*sensor_pin: eddy:gpio26/);
  assert.match(r.files['printer.cfg'], /\[include probe.cfg\]/);
  assert.match(r.files['printer.cfg'], /\[force_move\]/);
  assert.match(r.files['printer.cfg'], /zero_reference_position: 175, 175/);
  assert.match(r.files['macros/print.cfg'], /BED_MESH_CALIBRATE ADAPTIVE=1 METHOD=scan/);
  assert.match(r.files['macros/tuning.cfg'], /LDC_CALIBRATE_DRIVE_CURRENT CHIP=btt_eddy/);
  assert.match(r.files['macros/tuning.cfg'], /SET_KINEMATIC_POSITION Z=25/);
  assert.deepEqual(r.mcus.map((m) => m.name), ['mcu', 'toolhead', 'eddy']);
  assert.ok(r.links.some((l) => l.url === 'https://www.klipper3d.org/Eddy_Probe.html'));
});

test('Cartographer V3 over CAN and Beacon homing', () => {
  const b = example();
  b.probe = 'cartographer-v3';
  b.probeConnection = 'can';
  b.homing = { xy: 'physical', z: 'probe_virtual_endstop' };
  const c = generate(b, db, 't');
  assert.ok(c.issues.some((i) => i.code === 'probe_offset_default'));
  assert.match(c.files['probe.cfg'], /\[mcu carto\]\s*# Cartographer V3[^[]*canbus_uuid: REPLACE_WITH_CARTO_UUID/);
  assert.match(c.files['probe.cfg'], /\[static_pwm_clock ldc1612_clk_in\]/);
  assert.match(c.files['FIRMWARE.md'], /PA1 set at micro-controller start-up/);
  b.probe = 'beacon';
  const bc = generate(b, db, 't');
  assert.match(bc.files['probe.cfg'], /\[beacon\][^[]*home_xy_position: 175, 175/);
  assert.ok(!bc.files['printer.cfg'].includes('[safe_z_home]'));
  assert.equal(bc.mcus.find((m) => m.name === 'beacon')!.klipperCheck, false);
  b.homing = { xy: 'sensorless', z: 'probe_virtual_endstop' };
  assert.ok(generate(b, db, 't').issues.some((i) => i.code === 'beacon_sensorless'));
});

test('Nevermore: fan_generic, print start/end control, voltage and current checks', () => {
  const r = generate(example(), db, 't');
  assert.match(r.files['mainboard.cfg'], /\[fan_generic nevermore\]/);
  assert.match(r.files['macros/print.cfg'], /\{% if BED >= 90 %\}\s*SET_FAN_SPEED FAN=nevermore SPEED=1/);
  assert.match(r.files['macros/print.cfg'], /UPDATE_DELAYED_GCODE ID=_NEVERMORE_OFF DURATION=600/);
  assert.ok(r.wiring.jumpers.some((j) => j.includes('(24 V)')));
  const b = example();
  b.nevermore = { model: 'nevermore-stealthmax', voltage: 12 };
  const sm = generate(b, db, 't');                       // Leviathan fan ports are 5/24 V only
  assert.ok(sm.issues.some((i) => i.code === 'fan_port_voltage'));
});

test('printer.cfg carries every bed mesh / leveling setting and the leveling macros exist', () => {
  const r = generate(example(), db, 't');
  for (const key of ['speed', 'horizontal_move_z', 'mesh_min', 'mesh_max', 'probe_count', 'algorithm', 'bicubic_tension',
    'mesh_pps', 'fade_start', 'fade_end', 'split_delta_z', 'move_check_distance', 'adaptive_margin']) {
    assert.match(r.files['printer.cfg'], new RegExp(`\\[bed_mesh\\][^[]*\\n${key}:`), key);
  }
  for (const key of ['gantry_corners', 'points', 'speed', 'horizontal_move_z', 'retries', 'retry_tolerance', 'max_adjust']) {
    assert.match(r.files['printer.cfg'], new RegExp(`\\[quad_gantry_level\\][^[]*\\n${key}:`), key);
  }
  for (const m of ['G32', 'LEVEL_IF_NEEDED', 'LEVEL_BED', '_HOME_IF_NEEDED']) assert.match(r.files['macros/leveling.cfg'], new RegExp(`\\[gcode_macro ${m}\\]`));
  assert.match(r.files['macros/leveling.cfg'], /printer\.quad_gantry_level\.applied/);
  const b = example();
  b.webUi = 'none';
  const n = generate(b, db, 't');
  for (const s of ['virtual_sdcard', 'pause_resume', 'display_status']) assert.match(n.files['printer.cfg'], new RegExp(`\\[${s}\\]`));
  assert.ok(n.files['SLICER.md'].includes('PRINT_START EXTRUDER='));
});

test('inductive probe cannot be powered from a 5 V toolboard port', () => {
  // Every mainboard in the data has a probe port, so remove it to force the toolboard fallback.
  const db2 = structuredClone(db);
  delete db2.mainboards['ldo-leviathan-v1.2'].probe_ports;
  const b = example();
  b.toolboard = { id: 'btt-ebb36-can-v1.2', connection: 'can' };
  const r = generate(b, db2, 'test');
  const e = r.issues.find((i) => i.code === 'probe_supply');
  assert.ok(e, JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  assert.match(e.message, /needs \d+-\d+ V.*ENDSTOP.*5 V/);
});

test('SKR 3: inductive probe on PC13, powered from elsewhere (2-pin Probe connector)', () => {
  const b = example();
  b.printer = 'voron-trident'; b.size = '300';                        // 5 drivers: fits the SKR 3
  b.homing.zSwitchXY = [200, 300];
  b.mainboard = { id: 'btt-skr-3', connection: 'usb' };
  b.canAdapter = 'u2c';
  b.drivers = { xy: { module: 'btt-tmc2209' }, z: { module: 'btt-tmc2209' } };
  const r = generate(b, db, 'test');
  assert.equal(r.ok, true, JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  assert.match(r.files['mainboard.cfg'], /^\[probe\][^\n]*\npin: [~^!]*PC13$/m);
  assert.ok(r.issues.some((i) => i.code === 'probe_power_elsewhere' && /PROBE on BIGTREETECH SKR 3/.test(i.message)));
});

test('BTT Eddy Coil: probe_eddy_current on the toolhead board I2C bus, no MCU of its own', () => {
  const b = example();
  b.toolboard = { id: 'btt-ebb36-can-v1.2', connection: 'can' };
  b.probe = 'btt-eddy-coil';
  const r = generate(b, db, 'test');
  assert.equal(r.ok, true, JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  const pc = r.files['probe.cfg'];
  assert.match(pc, /^\[probe_eddy_current btt_eddy\]$/m);
  assert.match(pc, /^i2c_mcu: toolhead$/m);
  assert.match(pc, /^i2c_bus: i2c3_PB3_PB4$/m);
  assert.doesNotMatch(pc, /^\[mcu /m);
  assert.doesNotMatch(pc, /^\[temperature_probe /m);
  assert.ok(!r.mcus.some((m) => m.name === 'eddy'));
  assert.ok(r.wiring.connections.some((c) => c.connector === 'I2C' && c.pins.startsWith('SCL PB3 / SDA PB4')));
});

test('BTT Eddy Coil needs a toolhead board with an I2C header', () => {
  const b = example();
  b.probe = 'btt-eddy-coil';                                          // SB2209 CAN: no I2C header (BTT pin diagram)
  const e = generate(b, db, 'test').issues.find((i) => i.code === 'probe_needs_i2c');
  assert.match(e!.message, /has no I2C header, so/);
  delete b.toolboard;
  assert.ok(generate(b, db, 'test').issues.some((i) => i.code === 'probe_needs_toolboard'));
});

test('hotend max_temp: sourced rating, thermistor cap, bare hotends, unknown rating', () => {
  const maxTemp = (hotend: string, thermistor: string) => {
    const b = example(); b.hotend = hotend; b.thermistors.hotend = thermistor;
    const r = generate(b, db, 'test');
    const m = /^\[extruder\][\s\S]*?^max_temp: (\d+)/m.exec(r.files['toolhead.cfg']);
    return { t: Number(m![1]), codes: r.issues.map((i) => i.code) };
  };
  assert.equal(maxTemp('rapido2-hf', 'semitec-104nt4').t, 290);            // retailer-sourced 290, below the thermistor's 300
  assert.equal(maxTemp('revo-voron', 'semitec-104nt4').t, 300);            // E3D: 300
  const bare = maxTemp('dragon-sf', 'ntc100k-3950');                       // ships without heater/thermistor
  assert.equal(bare.t, 280);
  assert.ok(bare.codes.includes('max_temp_capped'));
  const ace = maxTemp('dragon-ace', 'semitec-104nt4');                     // no published rating
  assert.equal(ace.t, 300);
  assert.ok(ace.codes.includes('hotend_max_temp_unknown'));
});

test('slot overrides and pinned fan ports are honoured', () => {
  const b = example();
  b.slotOverrides = { stepper_z: 'HV-STEPPER-0', stepper_x: 'STEPPER-0' };
  b.fans = b.fans.map((f) => (f.role === 'controller' ? { ...f, port: 'FAN2' } : f));
  const r = generate(b, db, 'test');
  assert.equal(r.ok, true, JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  assert.match(r.files['mainboard.cfg'], /^\[stepper_z\]\s+# HV-STEPPER-0/m);
  assert.match(r.files['mainboard.cfg'], /^\[stepper_x\]\s+# STEPPER-0/m);
  assert.match(r.files['mainboard.cfg'], /^\[controller_fan controller_fan\]\s+# mainboard FAN2\npin: PF7$/m);
  const dup = example();
  dup.slotOverrides = { stepper_z: 'STEPPER-1', stepper_z1: 'STEPPER-1' };
  assert.ok(generate(dup, db, 'test').issues.some((i) => i.code === 'slot_taken'));
});

// --- stock printers (fixed board, cartesian) ---------------------------------
const ender = (): Build => JSON.parse(readFileSync(new URL('../../examples/ender3-v2-stock.json', import.meta.url), 'utf8'));

test('Ender 3 V2 stock: Klipper reference pins, no TMC sections, no leveling', () => {
  const r = generate(ender(), db, 'test');
  assert.ok(r.ok, JSON.stringify(r.issues));
  const mb = r.files['mainboard.cfg'];
  // printer-creality-ender3-v2-2020.cfg
  assert.match(mb, /\[stepper_x\][^[]*step_pin: PC2\ndir_pin: PB9[^\n]*\nenable_pin: !PC3/);
  assert.match(mb, /\[stepper_z\][^[]*dir_pin: !PB5[^[]*endstop_pin: \^PA7/);
  assert.match(mb, /\[extruder\][^[]*rotation_distance: 34\.406[^[]*max_temp: 250/);
  assert.match(mb, /serial: \/dev\/serial\/by-id\/usb-1a86_USB_Serial-if00-port0/);
  assert.match(mb, /\[heater_bed\][^[]*max_power: 1\b/);
  assert.doesNotMatch(mb, /\[tmc/);
  const pc = r.files['printer.cfg'];
  assert.match(pc, /kinematics: cartesian/);
  assert.doesNotMatch(pc, /safe_z_home|z_tilt|quad_gantry|bed_mesh/);
  assert.doesNotMatch(r.files['macros/print.cfg'], /BED_MESH|Z_TILT|QUAD_GANTRY/);
  assert.match(r.files['FIRMWARE.md'], /Serial \(on USART1 PA10\/PA9\)[\s\S]*28KiB bootloader|28KiB bootloader[\s\S]*Serial \(on USART1 PA10\/PA9\)/);
  assert.match(r.files['FIRMWARE.md'], /SD card/);
});

test('Creality v4.2.7 swaps step and dir against the v4.2.2 (Klipper generic-creality-v4.2.7.cfg)', () => {
  const b = ender();
  b.mainboard.id = 'creality-v4.2.7';
  const mb = generate(b, db, 'test').files['mainboard.cfg'];
  assert.match(mb, /\[stepper_x\][^[]*step_pin: PB9\ndir_pin: PC2/);
  assert.match(mb, /\[extruder\][^[]*step_pin: PB3\ndir_pin: PB4/);
});

test('GD32F103 v4.2.2: built as STM32F103 with SWD disabled', () => {
  const b = ender();
  b.mainboard.mcu = 'gd32f103';
  const r = generate(b, db, 'test');
  assert.match(r.files['FIRMWARE.md'], /Micro-controller: STM32F103 \(the GD32F103 is built as STM32F103\)[\s\S]*Disable SWD at startup/);
});

test('Ender 3 V2 Neo: CR Touch homes Z at the bed centre with its stock offset', () => {
  const b = ender();
  b.probe = 'bltouch';
  b.probeOffset = { x: -45, y: -10 };
  b.homing.z = 'probe_virtual_endstop';
  const r = generate(b, db, 'test');
  assert.ok(r.ok, JSON.stringify(r.issues));
  assert.match(r.files['mainboard.cfg'] + r.files['printer.cfg'], /\[bltouch\][^[]*sensor_pin: \^PB1\ncontrol_pin: PB0/);
  assert.match(r.files['printer.cfg'], /\[safe_z_home\]/);
  assert.match(r.files['macros/print.cfg'], /BED_MESH_CALIBRATE ADAPTIVE=1/);
});

test('sensorless homing is refused on standalone drivers', () => {
  const b = ender();
  b.homing.xy = 'sensorless';
  const p = plan(b, db);
  assert.ok(p.issues.some((i) => i.code === 'sensorless_unsupported' && /standalone/.test(i.message)));
});

test('Ender 3 S1: inverted endstops at negative positions, switched hotend fan, CR Touch homing', () => {
  const b: Build = JSON.parse(readFileSync(new URL('../../examples/ender3-s1-stock.json', import.meta.url), 'utf8'));
  const r = generate(b, db, 'test');
  assert.ok(r.ok, JSON.stringify(r.issues));
  const mb = r.files['mainboard.cfg'];
  // printer-creality-ender3-s1-2021.cfg
  assert.match(mb, /\[stepper_x\][^[]*endstop_pin: !PA5[^[]*position_min: -15\nposition_endstop: -10/);
  assert.match(mb, /\[stepper_y\][^[]*endstop_pin: !PA6[^[]*position_min: -13\nposition_endstop: -8\nposition_max: 238/);
  assert.match(mb, /\[extruder\][^[]*rotation_distance: 26\.359\ngear_ratio: 42:12[^[]*max_temp: 260/);
  assert.match(mb, /\[heater_bed\][^[]*heater_pin: PA7[^[]*max_temp: 100/);
  assert.match(mb, /\[heater_fan hotend_fan\][^[]*pin: PC0/);
  assert.match(mb, /\[fan\][^[]*pin: PA0/);
  assert.match(r.files['printer.cfg'], /\[bed_screws\]\s*#[^\n]*\nscrew1: 20, 29/);
  // nozzle at bed centre minus the probe offset (Klipper's file uses 147, 154)
  assert.match(r.files['printer.cfg'], /home_xy_position: 149\.3, 158/);
  const pro = generate({ ...b, printer: 'creality-ender3-s1-pro', hotend: 'creality-sprite-s1-pro' }, db, 'test').files['mainboard.cfg'];
  assert.match(pro, /\[extruder\][^[]*max_temp: 300/);
  assert.match(pro, /\[heater_bed\][^[]*max_temp: 110/);
});

test('Orbitool O2S: inverted part fan with enable pin and the maker\'s 10 kHz PWM, TMC2240 UART', () => {
  const b = example();
  b.toolboard = { id: 'orbiter-orbitool-o2s', connection: 'usb' };
  b.extruder = 'orbiter2';
  const r = generate(b, db, 'test');
  assert.ok(r.ok, JSON.stringify(r.issues));
  const th = r.files['toolhead.cfg'];
  // Orbitool_O2S.cfg
  assert.match(th, /\[fan\][^[]*pin: !toolhead:PA10\nenable_pin: toolhead:PB14[^[]*cycle_time: 0\.0001/);
  assert.match(th, /\[heater_fan hotend_fan\][^[]*pin: !toolhead:PB15[^[]*cycle_time: 0\.0001/);
  assert.match(th, /\[tmc2240 extruder\][^[]*uart_pin: toolhead:PC13\nrref: 12000/);
  assert.match(th, /serial: \/dev\/serial\/by-id\/usb-Klipper_stm32f072xb_Orbitool_O2S-if00/);
  assert.equal((th.match(/^cycle_time:/gm) ?? []).length, 2);   // maker setting replaces, never duplicates
  assert.ok(!r.issues.some((i) => i.code === 'toolboard_extruder'));
});

test('Orbitool O2: heater capped at 99.5% for its short-circuit recovery; wrong extruder warns', () => {
  const b = example();
  b.toolboard = { id: 'orbiter-orbitool-o2', connection: 'usb' };
  const r = generate(b, db, 'test');   // example uses a Galileo 2
  assert.match(r.files['toolhead.cfg'], /\[extruder\][^[]*heater_pin: toolhead:PA0[^[]*max_power: 0\.995/);
  assert.ok(r.issues.some((i) => i.code === 'toolboard_extruder' && /Orbiter 2\.0/.test(i.message)));
});

test('Ender 5 Pro: X/Y home at max, 4 mm Z lead, metal Bowden extruder (Klipper ender5pro-2020)', () => {
  const b = { ...ender(), printer: 'creality-ender5-pro', extruder: 'creality-ender5pro-bowden', hotend: 'creality-ender5pro' };
  const r = generate(b, db, 'test');
  assert.ok(r.ok, JSON.stringify(r.issues));
  const mb = r.files['mainboard.cfg'];
  assert.match(mb, /\[stepper_x\][^[]*position_endstop: 220\nposition_max: 220[^[]*homing_positive_dir: True/);
  assert.match(mb, /\[stepper_z\][^[]*dir_pin: PB5[^[]*rotation_distance: 4\n/);
  assert.match(mb, /\[extruder\][^[]*rotation_distance: 32\.342[^[]*max_temp: 260/);
  assert.match(mb, /\[heater_bed\][^[]*max_temp: 135/);
});

test('Sovol SV06: TMC2209 UART at address 3, sensorless X/Y with maker thresholds, built-in probe homes Z', () => {
  const b: Build = JSON.parse(readFileSync(new URL('../../examples/sovol-sv06-stock.json', import.meta.url), 'utf8'));
  const r = generate(b, db, 'test');
  assert.ok(r.ok, JSON.stringify(r.issues));
  const mb = r.files['mainboard.cfg'];
  // printer-sovol-sv06-2022.cfg / Sovol pins_SOVOL_V131.h
  assert.match(mb, /\[stepper_x\][^[]*dir_pin: !PB9[^[]*endstop_pin: tmc2209_stepper_x:virtual_endstop/);
  assert.match(mb, /\[tmc2209 stepper_x\][^[]*uart_pin: PC1\nuart_address: 3\nsense_resistor: 0\.15[^[]*diag_pin: PA5[^\n]*\ndriver_SGTHRS: 81/);
  assert.match(mb, /\[tmc2209 stepper_y\][^[]*uart_pin: PC0[^[]*driver_SGTHRS: 82/);
  assert.match(mb, /\[tmc2209 extruder\][^[]*uart_pin: PC14\nuart_address: 3/);
  assert.match(mb, /\[extruder\][^[]*dir_pin: !PB3[^[]*rotation_distance: 4\.56/);
  assert.match(mb, /\[probe\][^[]*pin: PB1\nx_offset: 27\ny_offset: -20/);
  assert.match(r.files['homing.cfg'], /G0 X83 Y130 F6000\n\s*G28 Z/);
  assert.ok(!r.issues.some((i) => /probe_voltage|probe_output|probe_modifier/.test(i.code)));
});
