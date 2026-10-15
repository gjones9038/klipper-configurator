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
const EXPECTED_ERRORS = new Set(['not_enough_drivers', 'no_fan_port', 'no_endstop_port', 'sensorless_no_diag', 'no_probe_port']);

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
        const m = /^(\w*pin): *([!^~]*)((?:toolhead:)?P[A-K]\d+|(?:toolhead:)?gpio\d+)/.exec(line);
        if (!m) continue;
        // SPI bus pins are shared by design; endstop pin may equal its slot's DIAG pin.
        if (m[1].startsWith('spi_software')) continue;
        const key = m[3];
        const prev = seen.get(key);
        assert.ok(!prev || (m[1].startsWith('diag') && prev.includes('endstop')),
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
