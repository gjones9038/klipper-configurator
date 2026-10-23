// Toolchanger output (klipper-toolchanger): one tools/Tn.cfg per tool and
// toolchanger.cfg with [toolchanger] plus pickup / dropoff / dock alignment
// macros. The macros are written for this generator from the module's
// documented behaviour (toolchanger.md); the upstream examples are GPLv3 and
// not copied. Dock paths come from klipper-toolchanger examples/README.md.
import { CfgFile, Section } from './cfg.ts';
import type { Plan, ToolPlan } from './plan.ts';
import type { Db, Rec } from './types.ts';
import { extruderSec, fanSection, mcuSection, tmcSection } from './emit.ts';

/** Python literal for klipper-toolchanger params_* (parsed with ast.literal_eval). */
function py(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(py).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `'${k}': ${py(x)}`).join(', ')}}`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') return `'${v}'`;
  return String(v);
}

export function toolFile(p: Plan, t: ToolPlan, db: Db, header: string[]): string {
  const tc = p.toolchanger!.rec;
  const f = new CfgFile([...header, '', `Tool T${t.n}: ${t.toolboard.name}, ${t.extruder.name}, ${t.hotend.name}.`]);
  f.add(mcuSection(`mcu ${t.mcu}`, t.toolboard, t.connection, t.toolboard.mcu.chip));
  f.add(new Section(`temperature_sensor ${t.mcu}`).set('sensor_type', 'temperature_mcu').set('sensor_mcu', t.mcu));
  f.add(extruderSec(t.stepper, p, db, {
    heater: t.heater, sensor: t.sensor, thermistor: t.thermistor, hotend: t.hotend,
    extruder: t.extruder, maxTemp: t.maxTemp, pa: t.paBaseline,
  }, `TUNE_PID_HOTEND HEATER=${t.extruderSection}`));
  f.add(tmcSection(t.stepper, p, db));
  for (const fan of t.fans) f.add(fanSection(fan));
  if (t.accel) {
    const a = new Section(`${t.accel.chip} T${t.n}`).set('cs_pin', `${t.mcu}:${t.accel.cs_pin}`);
    if (t.accel.spi_bus) a.set('spi_bus', t.accel.spi_bus);
    else {
      a.set('spi_software_sclk_pin', `${t.mcu}:${t.accel.spi_software.sclk_pin}`)
        .set('spi_software_mosi_pin', `${t.mcu}:${t.accel.spi_software.mosi_pin}`)
        .set('spi_software_miso_pin', `${t.mcu}:${t.accel.spi_software.miso_pin}`);
    }
    f.add(a);
  }
  if (t.leds) {
    f.add(new Section(`neopixel T${t.n}_leds`).set('pin', t.leds.pin)
      .set('chain_count', t.leds.chain).set('color_order', t.leds.order)
      .set('initial_RED', 0.2).set('initial_GREEN', 0.2).set('initial_BLUE', 0.2).set('initial_WHITE', t.leds.order.length === 4 ? 0.2 : undefined));
  }
  const perTool = p.toolchanger!.zProbe === 'per_tool';
  if (perTool) {
    const tp = new Section(`tool_probe T${t.n}`, `Tap sensor, ${t.probe.port} on ${t.toolboard.name}`)
      .set('pin', t.probe.pin)
      .set('z_offset', 0, `probe offset of this tool, not the tool offset: PROBE_CALIBRATE with T${t.n} mounted`);
    for (const [k, v] of Object.entries(tc.tool_probe)) tp.set(k, v as number | string);
    tp.set('activate_gcode', [`_TC_PROBE_TEMP HEATER=${t.extruderSection}`]);
    f.add(tp);
  }

  const tool = new Section(`tool T${t.n}`)
    .set('tool_number', t.n)
    .set('extruder', t.extruderSection)
    .set('fan', `T${t.n}_partfan`)
    .set('tool_probe', perTool ? `tool_probe T${t.n}` : undefined)
    .set('detection_pin', t.probe.pin, perTool ? 'same pin as the Tap sensor (klipper-toolchanger 2026.2.8 semantics)'
      : `mount switch on ${t.probe.port}: triggered = tool absent (klipper-toolchanger 2026.2.8 semantics)`)
    .set('gcode_x_offset', 0, t.n === 0 ? 'T0 is the reference tool' : 'measured against T0 (StealthChanger wiki: Offsets)')
    .set('gcode_y_offset', 0)
    .set('gcode_z_offset', 0, !perTool && t.n > 0 ? 'shuttle probe: measure this against T0' : undefined);
  const d = t.dock;
  tool.set('params_park_x', d?.x ?? 0, d ? 'dock position' : 'not measured: TC_DOCK_ALIGN_START')
    .set('params_park_y', d?.y ?? 0)
    .set('params_park_z', d?.z ?? 0, tc.dock_z_rule)
    .set('params_dock_set', d ? 1 : 0, d ? undefined : 'tool changes with this tool are refused until the dock is measured');
  f.add(tool);
  return f.render();
}

export function toolchangerFile(p: Plan, header: string[]): string {
  const tc = p.toolchanger!;
  const rec = tc.rec;
  const f = new CfgFile([
    ...header, '',
    `${rec.name} with klipper-toolchanger (${rec.module.repo}).`,
    `Install: ${rec.module.install}`,
    'Moonraker update manager entry (moonraker.conf):',
    ...rec.module.update_manager.trimEnd().split('\n').map((l: string) => `  ${l}`),
    '',
    'Dock paths: klipper-toolchanger examples/README.md (StealthChanger). Pickup / dropoff macros',
    'written for this generator from toolchanger.md; the upstream example macros are GPLv3.',
  ]);
  const s = new Section('toolchanger')
    .set('initialize_on', rec.toolchanger.initialize_on)
    .set('require_tool_present', rec.toolchanger.require_tool_present, 'the tool carries the Z probe')
    .set('abort_on_tool_missing', rec.toolchanger.abort_on_tool_missing)
    .set('t_command_restore_axis', rec.toolchanger.t_command_restore_axis, 'StealthChanger wiki')
    .set('params_fast_speed', rec.toolchanger.params_fast_speed)
    .set('params_path_speed', rec.toolchanger.params_path_speed)
    .set('params_safe_y', tc.safeY ?? 0, tc.safeY === undefined ? `not set: ${rec.safe_y_rule}` : rec.safe_y_rule)
    .set('params_close_y', tc.closeY ?? 0, tc.closeY === undefined ? 'set once every dock is measured: park_y + 30' : `largest park_y + ${rec.close_y_offset} (StealthChanger wiki)`)
    // Both are needed: with close_y 0 an empty shuttle would sweep X in front of (or through) the dock row.
    .set('params_layout_set', tc.safeY === undefined || tc.closeY === undefined ? 0 : 1,
      tc.safeY === undefined || tc.closeY === undefined ? 'set to 1 once safe_y and close_y are filled in' : undefined)
    .set('params_dropoff_path', py(rec.dropoff_path))
    .set('params_pickup_path', py(rec.pickup_path))
    .set('error_gcode', ['PAUSE'])
    .set('after_change_gcode', [
      '{% if tool.params_input_shaper_freq_x is defined %}',
      '    SET_INPUT_SHAPER SHAPER_FREQ_X={tool.params_input_shaper_freq_x} SHAPER_FREQ_Y={tool.params_input_shaper_freq_y}',
      '{% endif %}',
    ])
    .set('dropoff_gcode', [
      '{% if not (tool.params_dock_set and tool.params_layout_set) %}',
      '    SELECT_TOOL_ERROR MESSAGE="{tool.name}: dock position, safe_y or close_y not set. Measure the dock with TC_DOCK_ALIGN_START, then in toolchanger.cfg set params_close_y (largest park_y + 30) and params_layout_set: 1."',
      '{% else %}',
      '    {% set x = tool.params_park_x|float %}',
      '    {% set y = tool.params_park_y|float %}',
      '    {% set z = tool.params_park_z|float %}',
      '    {% set fast = tool.params_fast_speed|float %}',
      '    {% set path = tool.params_dropoff_path %}',
      '    RESPOND MSG="Dropping off {tool.name}"',
      '    G90',
      '    G0 Z{[printer.toolhead.position.z + 1, printer.toolhead.axis_maximum.z]|min} F{fast}',
      '    G0 Y{tool.params_safe_y} F{fast}',
      '    G0 X{x} F{fast}',
      '    G0 Z{z + path[0].z} F{fast}',
      '    G0 Y{y + path[0].y} F{fast}',
      '    {% for pos in path %}',
      '        G0 Y{y + pos.y} Z{z + pos.z} F{tool.params_path_speed * pos.f|default(1)}',
      '    {% endfor %}',
      '    {% if pickup_tool is none %}',
      '        G0 Y{tool.params_safe_y} F{fast}',
      '    {% endif %}',
      '{% endif %}',
    ])
    .set('pickup_gcode', [
      '{% if not (tool.params_dock_set and tool.params_layout_set) %}',
      '    SELECT_TOOL_ERROR MESSAGE="{tool.name}: dock position or safe Y not set. Measure it with TC_DOCK_ALIGN_START."',
      '{% else %}',
      '    {% set x = tool.params_park_x|float %}',
      '    {% set y = tool.params_park_y|float %}',
      '    {% set z = tool.params_park_z|float %}',
      '    {% set fast = tool.params_fast_speed|float %}',
      '    {% set path = tool.params_pickup_path %}',
      '    RESPOND MSG="Picking up {tool.name}"',
      '    G90',
      '    {% if dropoff_tool is none %}',
      '        G0 Y{tool.params_safe_y} F{fast}',
      '    {% else %}',
      '        G0 Y{tool.params_close_y} F{fast}',
      '    {% endif %}',
      '    G0 X{x} Z{z + path[0].z} F{fast}',
      '    G0 Y{y + path[0].y} F{fast}',
      '    {% if tool.extruder %}',
      '        M109 T{tool.tool_number} S{printer[tool.extruder].target|int}',
      '    {% endif %}',
      '    {% for pos in path %}',
      '        G0 Y{y + pos.y} Z{z + pos.z} F{tool.params_path_speed * pos.f|default(1)}',
      '        {% if pos.verify %}',
      '            VERIFY_TOOL_DETECTED T={tool.tool_number}',
      '        {% endif %}',
      '    {% endfor %}',
      '    G0 Y{tool.params_safe_y} F{fast}',
      '{% endif %}',
    ]);
  f.add(s);

  f.add(`# Measuring a dock (StealthChanger wiki, Dock Positions):
#  1. TC_DOCK_ALIGN_START with the tool to measure mounted.
#  2. Jog it into its dock. ${rec.dock_z_rule}.
#  3. TC_DOCK_ALIGN_TEST docks and undocks it at that position.
#  4. TC_DOCK_ALIGN_SAVE, then SAVE_CONFIG.`);
  f.add(new Section('gcode_macro TC_DOCK_ALIGN_START')
    .set('description', 'Dock alignment, step 1: docking mode for the mounted tool (offsets cleared). Then jog it into its dock.')
    .set('gcode', [
      'INITIALIZE_TOOLCHANGER',
      'ENTER_DOCKING_MODE',
      'RESPOND MSG="Docking mode for {printer.toolchanger.tool}. Jog it into its dock, then TC_DOCK_ALIGN_TEST or TC_DOCK_ALIGN_SAVE."',
    ]));
  f.add(new Section('gcode_macro TC_DOCK_ALIGN_TEST')
    .set('description', 'Dock alignment, step 2: use the current position as the dock and run one dropoff and pickup.')
    .set('gcode', [
      '{% set pos = printer.gcode_move.gcode_position %}',
      'SET_TOOL_PARAMETER PARAMETER=params_park_x VALUE={pos.x}',
      'SET_TOOL_PARAMETER PARAMETER=params_park_y VALUE={pos.y}',
      'SET_TOOL_PARAMETER PARAMETER=params_park_z VALUE={pos.z}',
      'SET_TOOL_PARAMETER PARAMETER=params_dock_set VALUE=1',
      // Tool changes stay locked until safe_y and close_y are set; say so instead of tripping the error state.
      '{% if printer.toolchanger.params_layout_set|default(0)|int %}',
      '    TEST_TOOL_DOCKING RESTORE_AXIS=XYZ',
      '{% else %}',
      '    RESPOND TYPE=error MSG="Docking test skipped: set params_safe_y, params_close_y and params_layout_set: 1 in toolchanger.cfg first (measure every dock with TC_DOCK_ALIGN_SAVE, then FIRMWARE_RESTART)."',
      '{% endif %}',
    ]));
  f.add(new Section('gcode_macro TC_DOCK_ALIGN_SAVE')
    .set('description', 'Dock alignment, step 3: store the current position as the dock of the mounted tool. Then SAVE_CONFIG.')
    .set('gcode', [
      '{% set pos = printer.gcode_move.gcode_position %}',
      'SET_TOOL_PARAMETER PARAMETER=params_park_x VALUE={pos.x}',
      'SET_TOOL_PARAMETER PARAMETER=params_park_y VALUE={pos.y}',
      'SET_TOOL_PARAMETER PARAMETER=params_park_z VALUE={pos.z}',
      'SET_TOOL_PARAMETER PARAMETER=params_dock_set VALUE=1',
      'SAVE_TOOL_PARAMETER PARAMETER=params_park_x',
      'SAVE_TOOL_PARAMETER PARAMETER=params_park_y',
      'SAVE_TOOL_PARAMETER PARAMETER=params_park_z',
      'SAVE_TOOL_PARAMETER PARAMETER=params_dock_set',
      // Leave the dock straight backwards first (close_y = park_y + 30), so a later G28 lift is clear of it.
      'G90',
      `G0 Y{pos.y + ${rec.close_y_offset}} F3000`,
      'EXIT_DOCKING_MODE',
      'RESPOND MSG="Dock of {printer.toolchanger.tool} stored. Run SAVE_CONFIG. Set params_close_y to the largest park_y + 30 once all docks are measured."',
    ]));
  if (tc.zProbe === 'per_tool') f.add(new Section('gcode_macro _TC_PROBE_TEMP')
    .set('description', `Keep the probing nozzle at or below ${rec.probe_max_temp_c}C so Tap does not mark the bed.`)
    .set('gcode', [
      '{% set heater = params.HEATER %}',
      `{% set limit = ${rec.probe_max_temp_c} %}`,
      '{% if printer[heater].target > limit %}',
      '    RESPOND MSG="{heater} target {printer[heater].target}C is too hot for probing; lowering to {limit}C"',
      '    SET_HEATER_TEMPERATURE HEATER={heater} TARGET={limit}',
      '{% endif %}',
      '{% if printer[heater].temperature > limit + 5 %}',
      '    RESPOND MSG="Waiting for {heater} to cool below {limit + 5}C"',
      '    TEMPERATURE_WAIT SENSOR={heater} MAXIMUM={limit + 5}',
      '{% endif %}',
    ]));
  return f.render();
}

export function toolchangerLinks(rec: Rec): string[] {
  return (rec.docs ?? []).map((d: Rec) => `${d.title}: ${d.url}`);
}
