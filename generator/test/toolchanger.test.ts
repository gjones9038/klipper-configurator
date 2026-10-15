import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate, loadDb } from '../index.ts';
import type { Build } from '../types.ts';

const db = loadDb();
const example = (): Build => JSON.parse(readFileSync(new URL('../../examples/v24-350-leviathan-stealthchanger.json', import.meta.url), 'utf8'));
const errors = (b: Build) => generate(b, db, 'test').issues.filter((i) => i.level === 'error').map((i) => i.code);
const section = (text: string, name: string) => {
  const m = new RegExp(`^\\[${name.replace(/[[\]]/g, '\\$&')}\\][^\\n]*\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
  assert.ok(m, `[${name}] missing`);
  return m[1];
};
const value = (body: string, key: string) => new RegExp(`^${key}: *(\\S+)`, 'm').exec(body)?.[1];

test('StealthChanger example: one file per tool, toolchanger.cfg, homing override', () => {
  const r = generate(example(), db, 'test');
  assert.equal(r.ok, true, JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  for (const f of ['toolchanger.cfg', 'tools/T0.cfg', 'tools/T1.cfg', 'tools/T2.cfg', 'homing.cfg']) assert.ok(r.files[f], f);
  assert.equal(r.files['toolhead.cfg'], undefined);
  assert.match(r.files['printer.cfg'], /\[include tools\/T2\.cfg\]/);
  assert.doesNotMatch(r.files['printer.cfg'], /\[safe_z_home\]/);
  assert.match(section(r.files['mainboard.cfg'], 'stepper_z'), /endstop_pin: probe:z_virtual_endstop/);
  assert.match(r.files['homing.cfg'], /INITIALIZE_TOOLCHANGER[\s\S]*G28 Z\n\s*ADJUST_Z_AFTER_TOOL_NOZZLE_HOME/);
  assert.deepEqual(r.mcus.map((m) => m.name), ['mcu', 'toolhead', 'toolhead1', 'toolhead2']);
});

test('each tool: own extruder, fans, Tap probe shared with detection_pin', () => {
  const r = generate(example(), db, 'test');
  for (const n of [0, 1, 2]) {
    const f = r.files[`tools/T${n}.cfg`];
    const ext = n === 0 ? 'extruder' : `extruder${n}`;
    const tool = section(f, `tool T${n}`);
    assert.equal(value(tool, 'extruder'), ext);
    assert.equal(value(tool, 'tool_number'), String(n));
    assert.equal(value(tool, 'fan'), `T${n}_partfan`);
    assert.match(tool, new RegExp(`^tool_probe: tool_probe T${n}$`, 'm'));
    assert.equal(value(tool, 'detection_pin'), value(section(f, `tool_probe T${n}`), 'pin'));
    assert.equal(value(tool, 'params_dock_set'), '0');
    assert.match(section(f, `heater_fan T${n}_hotend_fan`), new RegExp(`^heater: ${ext}$`, 'm'));
    assert.ok(section(f, `fan_generic T${n}_partfan`));
    const mcu = n === 0 ? 'toolhead' : `toolhead${n}`;
    assert.match(section(f, ext), new RegExp(`^step_pin: ${mcu}:`, 'm'));
  }
  // The part fan belongs to the tools now: no [fan] anywhere.
  assert.ok(!Object.values(r.files).some((t) => /^\[fan\]/m.test(t)));
});

test('per-tool extruder and hotend override T0', () => {
  const r = generate(example(), db, 'test');
  const t2 = r.files['tools/T2.cfg'];
  assert.match(t2, /Galileo 2/);
  assert.match(t2, /E3D Revo Voron/);
  assert.match(section(t2, 'tmc2240 extruder2'), /cs_pin: toolhead2:/);
});

test('toolchanger rules: no separate probe, Z homes with the tool probe, 2.4 only', () => {
  const b1 = example(); b1.probe = 'voron-tap';
  assert.ok(errors(b1).includes('toolchanger_probe'));
  const b2 = example(); b2.homing = { xy: 'physical', z: 'nozzle_switch', zSwitchXY: [200, 350] };
  assert.ok(errors(b2).includes('toolchanger_z_homing'));
  const b3 = example(); b3.printer = 'voron-trident'; b3.size = '300';
  assert.ok(errors(b3).includes('toolchanger_printer'));
  const b4 = example(); b4.toolhead = 'stealthburner';
  assert.ok(errors(b4).includes('toolchanger_toolhead'));
});

test('tool board without a recorded probe port is refused, not guessed', () => {
  const b = example();
  b.toolchanger!.tools[0].toolboard.id = 'btt-ebb36-can-v1.2';
  assert.ok(errors(b).includes('no_probe_port'));
});

test('docks: unreachable docks are errors; measured docks enable tool changes', () => {
  const b = example();
  b.toolchanger!.docks = [{ x: 50, y: -8, z: 320 }, { x: 150, y: -8, z: 320 }, { x: 250, y: -8, z: 320 }];
  b.toolchanger!.safeY = 60;
  assert.ok(errors(b).includes('dock_out_of_range'));          // Y below position_min 0, Z+path above 310
  b.toolchanger!.travel = { yMin: -10, zMax: 330 };
  const r = generate(b, db, 'test');
  assert.equal(r.ok, true, JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  assert.equal(value(section(r.files['tools/T1.cfg'], 'tool T1'), 'params_dock_set'), '1');
  const tc = section(r.files['toolchanger.cfg'], 'toolchanger');
  assert.equal(value(tc, 'params_close_y'), '22');              // largest park_y (-8) + 30, StealthChanger wiki
  assert.equal(value(tc, 'params_layout_set'), '1');
  assert.equal(value(section(r.files['mainboard.cfg'], 'stepper_y'), 'position_min'), '-10');
  assert.equal(value(section(r.files['mainboard.cfg'], 'stepper_z'), 'position_max'), '330');
  assert.ok(!r.issues.some((i) => i.code === 'tool_dock_unset'));
});
