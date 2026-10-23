import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate, loadDb } from '../index.ts';
import { AUTOSAVE_HEADER, carryOverSaveConfig, readAutosave } from '../saveconfig.ts';

const db = loadDb();
const files = (example: string) =>
  generate(JSON.parse(readFileSync(new URL(`../../examples/${example}.json`, import.meta.url), 'utf8')), db, 'test').files;
const old = (body: string, build = '# build: probe=omron-tl-q5mc2 z=nozzle_switch\n') => `${build}[printer]\nkinematics: corexy\n${AUTOSAVE_HEADER}${body}\n`;

test('readAutosave parses sections, options and multi-line values', () => {
  const s = readAutosave(old('#*# [extruder]\n#*# pid_kp = 21.5\n#*#\n#*# [bed_mesh default]\n#*# points =\n#*# \t0.1, 0.2\n#*# \t0.3, 0.4\n#*# x_count = 2'));
  assert.deepEqual(s.map((x) => x.name), ['extruder', 'bed_mesh default']);
  assert.deepEqual(s[1].options.find(([k]) => k === 'points'), ['points', '\n\t0.1, 0.2\n\t0.3, 0.4']);
  assert.deepEqual(readAutosave('[printer]\n'), []);
});

test('no old config or no SAVE_CONFIG block: printer.cfg unchanged', () => {
  const f = files('v24-350-leviathan-sb2209');
  assert.equal(carryOverSaveConfig(f, undefined).printerCfg, f['printer.cfg']);
  assert.equal(carryOverSaveConfig(f, '[printer]\n').printerCfg, f['printer.cfg']);
});

test('keeps sections the new config has, plus SAVE_CONFIG-created ones; drops the rest', () => {
  const f = files('v24-350-leviathan-sb2209');   // Omron probe, nozzle switch Z
  const r = carryOverSaveConfig(f, old([
    '#*# [extruder]', '#*# pid_kp = 21.5', '#*#',
    '#*# [bltouch]', '#*# z_offset = 1.5', '#*#',
    '#*# [input_shaper]', '#*# shaper_freq_x = 58.2', '#*#',
    '#*# [bed_mesh default]', '#*# version = 1', '#*#',
    '#*# [stepper_z]', '#*# position_endstop = 0.5',
  ].join('\n')));
  assert.deepEqual(r.kept, ['extruder', 'input_shaper', 'bed_mesh default', 'stepper_z']);
  assert.deepEqual(r.dropped.map((d) => d.section), ['bltouch']);
  assert.ok(r.printerCfg.startsWith(f['printer.cfg'].trimEnd()));
  assert.equal(r.printerCfg.split(AUTOSAVE_HEADER).length, 2);
  assert.deepEqual(readAutosave(r.printerCfg).map((s) => s.name), r.kept);
});

test('stepper_z position_endstop is dropped when Z homes with the probe', () => {
  const r = carryOverSaveConfig(files('v24-350-leviathan-stealthchanger'), old('#*# [stepper_z]\n#*# position_endstop = 0.5\n#*#\n#*# [tool T1]\n#*# params_park_x = 160.0'));
  assert.deepEqual(r.kept, ['tool T1']);
  assert.deepEqual(r.dropped, [{ section: 'stepper_z', option: 'position_endstop', why: 'unused now that Z homes with the probe' }]);
});

test('a saved Z offset / Z endstop survives only when the probe and Z homing match the old config', () => {
  const f = files('v24-350-leviathan-sb2209');   // Omron probe, nozzle switch Z
  const body = ['#*# [probe]', '#*# z_offset = 1.2', '#*#', '#*# [stepper_z]', '#*# position_endstop = 0.5'].join('\n');
  assert.deepEqual(carryOverSaveConfig(f, old(body)).kept, ['probe', 'stepper_z']);
  const otherProbe = carryOverSaveConfig(f, old(body, '# build: probe=voron-tap z=nozzle_switch\n'));
  assert.deepEqual(otherProbe.kept, ['stepper_z']);
  assert.match(otherProbe.dropped[0].why, /probe changed/);
  const otherZ = carryOverSaveConfig(f, old(body, '# build: probe=omron-tl-q5mc2 z=physical_min\n'));
  assert.deepEqual(otherZ.kept, ['probe']);
  const unknown = carryOverSaveConfig(f, old(body, ''));   // hand-written or older config: can't tell
  assert.deepEqual(unknown.kept, []);
});
