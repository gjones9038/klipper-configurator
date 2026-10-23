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
    assert.doesNotMatch(tool, /params_dock_set/);               // SAVE_CONFIG-managed: lives in printer.cfg
    assert.equal(value(section(r.files['printer.cfg'], `tool T${n}`), 'params_dock_set'), '0');
    assert.match(section(r.files['printer.cfg'], `tool_probe T${n}`), /^z_offset: /m);
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

test('EBB36/42 tools: Tap on the sourced probe input of each board', () => {
  const b = example();
  b.toolchanger!.tools[0].toolboard.id = 'btt-ebb36-can-v1.2';      // Endstop connector PB6
  b.toolchanger!.tools[1].toolboard.id = 'btt-ebb42-gen2-v1.0';     // PROBE connector PA5
  const r = generate(b, db, 'test');
  assert.equal(r.ok, true, JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  assert.equal(value(section(r.files['tools/T1.cfg'], 'tool_probe T1'), 'pin'), '^toolhead1:PB6');
  assert.equal(value(section(r.files['tools/T2.cfg'], 'tool_probe T2'), 'pin'), '^toolhead2:PA5');
});

test('Tap on an RP2040 tool board warns about 5 V sensor outputs', () => {
  const b = example();
  b.toolchanger!.tools[0].toolboard.id = 'btt-ebb-sb2209-rp2040-v1.0';
  const issues = generate(b, db, 'test').issues;
  assert.ok(issues.some((i) => i.code === 'tap_5v_signal' && i.message.startsWith('T1:')));
  assert.ok(!issues.some((i) => i.code === 'tap_5v_signal' && i.message.startsWith('T0:')));
});

test('docks: unreachable docks are errors; measured docks enable tool changes', () => {
  const b = example();
  b.toolchanger!.docks = [{ x: 50, y: -8, z: 320 }, { x: 150, y: -8, z: 320 }, { x: 250, y: -8, z: 320 }];
  b.toolchanger!.safeY = 60;
  assert.ok(errors(b).includes('dock_out_of_range'));          // Y below position_min 0, Z+path above 310
  b.toolchanger!.travel = { yMin: -10, zMax: 330 };
  const r = generate(b, db, 'test');
  assert.equal(r.ok, true, JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  assert.equal(value(section(r.files['printer.cfg'], 'tool T1'), 'params_dock_set'), '1');
  const tc = section(r.files['toolchanger.cfg'], 'toolchanger');
  assert.equal(value(tc, 'params_close_y'), '22');              // largest park_y (-8) + 30, StealthChanger wiki
  assert.equal(value(tc, 'params_layout_set'), '1');
  assert.equal(value(section(r.files['mainboard.cfg'], 'stepper_y'), 'position_min'), '-10');
  assert.equal(value(section(r.files['mainboard.cfg'], 'stepper_z'), 'position_max'), '330');
  assert.ok(!r.issues.some((i) => i.code === 'tool_dock_unset'));
});

test('shuttle eddy probe: no tool probes, detection switches only, eddy homes Z', () => {
  const b = example();
  b.toolchanger!.zProbe = 'shuttle';
  b.probe = 'cartographer-v3'; b.probeConnection = 'usb'; b.probeOffset = { x: 0, y: 20 };
  const r = generate(b, db, 'test');
  assert.equal(r.ok, true, JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  for (const n of [0, 1, 2]) {
    const f = r.files[`tools/T${n}.cfg`];
    assert.doesNotMatch(f, /^\[tool_probe /m);
    const tool = section(f, `tool T${n}`);
    assert.doesNotMatch(tool, /^tool_probe:/m);
    assert.ok(value(tool, 'detection_pin'));
  }
  assert.ok(r.files['probe.cfg']);
  assert.match(section(r.files['mainboard.cfg'], 'stepper_z'), /endstop_pin: probe:z_virtual_endstop/);
  assert.doesNotMatch(r.files['homing.cfg'], /ADJUST_Z_AFTER_TOOL_NOZZLE_HOME/);
  assert.doesNotMatch(r.files['toolchanger.cfg'], /_TC_PROBE_TEMP/);
  assert.ok(r.issues.some((i) => i.code === 'toolchanger_z_offsets'));
  const bad = example(); bad.toolchanger!.zProbe = 'shuttle'; bad.probe = 'omron-tl-q5mc2';
  assert.ok(errors(bad).includes('toolchanger_shuttle_probe'));
});

test('StealthChanger with another supported toolhead (Dragon Burner): no Stealthburner LEDs or shaper guess, dock spacing checked', () => {
  const b = example();
  b.toolhead = 'stealthchanger-dragonburner';
  b.leds = true;
  b.toolchanger!.docks = [{ x: 50, y: -8, z: 320 }, { x: 100, y: -8, z: 320 }, { x: 160, y: -8, z: 320 }];
  b.toolchanger!.safeY = 60;
  b.toolchanger!.travel = { yMin: -10, zMax: 330 };
  const r = generate(b, db, 'test');
  assert.equal(r.ok, true, JSON.stringify(r.issues.filter((i) => i.level === 'error')));
  assert.ok(r.issues.some((i) => i.code === 'dock_spacing' && /50 mm apart/.test(i.message)));   // 50 < 60 mm
  assert.doesNotMatch(Object.values(r.files).join('\n'), /\[neopixel /);
  b.toolhead = 'stealthburner';                                   // not a StealthChanger toolhead
  assert.ok(errors(b).includes('toolchanger_toolhead') || errors(b).length > 0);
});

test('safe Y too close to the docks is refused (wiki: close_y + thickest tool + 10)', () => {
  const b = example();
  b.toolchanger!.docks = [{ x: 50, y: -5, z: 320 }, { x: 130, y: -5, z: 320 }, { x: 210, y: -5, z: 320 }];
  b.toolchanger!.travel = { yMin: -10, zMax: 330 };
  b.toolchanger!.safeY = 10;                                     // close_y = -5 + 30 = 25
  assert.ok(errors(b).includes('safe_y_too_small'));
  b.toolchanger!.safeY = 80;
  assert.ok(!errors(b).includes('safe_y_too_small'));
});
