// G-code macro files. Kept as plain templates: easy to read and diff against
// what users already know from Voron/Klipper docs.
import type { Plan } from './plan.ts';

const hdr = (lines: string[]) => lines.map((l) => `# ${l}`).join('\n');
const block = (s: string) => s.replace(/^\n/, '').replace(/\n\s*$/, '');

function levelCmd(p: Plan): string {
  return p.printer.z_leveling === 'quad_gantry_level' ? 'QUAD_GANTRY_LEVEL' : 'Z_TILT_ADJUST';
}

export function printMacros(p: Plan, header: string[]): string {
  const [bx, by] = p.size.bed_mm;
  return `${hdr(header)}

${block(`
[gcode_macro PRINT_START]
description: Home, level, mesh and heat. Slicer start G-code: PRINT_START BED=<bed temp> EXTRUDER=<nozzle temp>
gcode:
    {% set BED = params.BED|default(100)|float %}
    {% set EXTRUDER = params.EXTRUDER|default(240)|float %}
    M140 S{BED}
    G28
    M190 S{BED}
    ${levelCmd(p)}
    G28 Z
    BED_MESH_CALIBRATE ADAPTIVE=1
    G90
    G0 X${bx / 2} Y${by / 2} Z10 F6000
    M109 S{EXTRUDER}
`)}

${block(`
[gcode_macro PRINT_END]
description: Retract, park and turn everything off.
gcode:
    {% set max_z = printer.toolhead.axis_maximum.z|float %}
    {% set z = [printer.toolhead.position.z + 10, max_z]|min %}
    M400
    G92 E0
    G1 E-5 F1800
    G90
    G0 Z{z} F3000
    G0 X${bx / 2} Y${by - 10} F6000
    TURN_OFF_HEATERS
    M107
    BED_MESH_CLEAR
`)}
`;
}

export function preflightMacros(p: Plan, header: string[]): string {
  const sensors = ['extruder', 'heater_bed', ...(p.chamberSensor ? ['temperature_sensor chamber'] : [])];
  const motors = p.steppers.map((s) =>
    `    RESPOND MSG="${s.name}: ${s.board === 'toolboard' ? 'toolhead board' : s.slot} (${s.role}${s.position ? ' ' + s.position : ''})"\n    STEPPER_BUZZ STEPPER=${s.name}`).join('\n');
  const fans = p.fans.map((f) => {
    const [kind, name] = f.section.split(' ');
    if (kind === 'fan') return '    RESPOND MSG="Part cooling fan"\n    M106 S255\n    G4 P3000\n    M107';
    if (kind === 'fan_generic') return `    RESPOND MSG="${name}"\n    SET_FAN_SPEED FAN=${name} SPEED=1\n    G4 P3000\n    SET_FAN_SPEED FAN=${name} SPEED=0`;
    return `    RESPOND MSG="${f.section}: starts automatically (heater or stepper driven), check it when heating"`;
  }).join('\n');
  return `${hdr(header)}

${block(`
[gcode_macro PREFLIGHT]
description: First check after wiring: temperatures, endstops and probe. Then run PREFLIGHT_MOTORS and PREFLIGHT_FANS.
gcode:
    {% set ns = namespace(ok=true) %}
    {% for name in ${JSON.stringify(sensors)} %}
        {% set t = printer[name].temperature %}
        {% if t < 5 or t > 45 %}
            RESPOND TYPE=error MSG="{name}: {t|round(1)}C is not room temperature. Check thermistor wiring, port and sensor_type."
            {% set ns.ok = false %}
        {% else %}
            RESPOND MSG="{name}: {t|round(1)}C ok"
        {% endif %}
    {% endfor %}
    QUERY_ENDSTOPS
    RESPOND MSG="Endstops should read 'open'. Press each switch by hand and run QUERY_ENDSTOPS again: it must read 'TRIGGERED'."
${p.probe || p.bltouch ? '    QUERY_PROBE\n    RESPOND MSG="Probe should be open; trigger it by hand and run QUERY_PROBE again."' : ''}
    {% if ns.ok %}
        RESPOND MSG="Sensors look sane. Next: PREFLIGHT_MOTORS with the toolhead centered, then PREFLIGHT_FANS."
    {% endif %}
`)}

${block(`
[gcode_macro PREFLIGHT_MOTORS]
description: STEPPER_BUZZ each motor in turn (1 mm positive, then back, 10 times). Check each moves, and in the right direction (Klipper docs Config_checks).
gcode:
${motors}
    RESPOND MSG="If a motor moved the wrong way, flip the ! on its dir_pin. If one did not move, check its wiring and enable pin."
`)}

${block(`
[gcode_macro PREFLIGHT_FANS]
description: Spin each controllable fan for 3 seconds.
gcode:
${fans}
`)}
`;
}

export function tuningMacros(p: Plan, header: string[]): string {
  const factor = p.extruder.drive === 'bowden' ? 0.02 : 0.005;
  const accel = !!p.accel;
  return `${hdr(header)}
# Run order after PREFLIGHT passes: TUNE_ALL (automatic steps), then the guided steps
# TUNE_E_STEPS -> Z offset -> TUNE_PA. See tuning.yaml for the reasoning.

${block(`
[gcode_macro TUNE_PID_HOTEND]
description: PID-tune the hotend with the part fan at 25%. TEMP=245 by default.
gcode:
    {% set T = params.TEMP|default(245)|float %}
    M106 S64
    PID_CALIBRATE HEATER=extruder TARGET={T}
    M107
    RESPOND MSG="Hotend PID done. Run SAVE_CONFIG to keep it."
`)}

${block(`
[gcode_macro TUNE_PID_BED]
description: PID-tune the bed. TEMP=100 by default.
gcode:
    {% set T = params.TEMP|default(100)|float %}
    PID_CALIBRATE HEATER=heater_bed TARGET={T}
    RESPOND MSG="Bed PID done. Run SAVE_CONFIG to keep it."
`)}
${accel ? `
${block(`
[gcode_macro TUNE_SHAPER]
description: Measure resonances with the toolhead accelerometer and pick input shapers.
gcode:
    G28
    ${levelCmd(p)}
    G28 Z
    SHAPER_CALIBRATE
    RESPOND MSG="Input shaper measured. Run SAVE_CONFIG to keep it."
`)}
` : ''}
${block(`
[gcode_macro TUNE_ALL]
description: Every automatic tuning step in order, then SAVE_CONFIG (Klipper restarts).
gcode:
    TUNE_PID_HOTEND
    TUNE_PID_BED${accel ? '\n    TUNE_SHAPER' : ''}
    SAVE_CONFIG
`)}

${block(`
[gcode_macro TUNE_E_STEPS]
description: Mark the filament 120 mm above the extruder inlet, then run this. Heats and extrudes 100 mm at 1 mm/s.
gcode:
    {% set T = params.TEMP|default(240)|float %}
    M109 S{T}
    M83
    G1 E100 F60
    M400
    RESPOND MSG="Measure from the inlet to your mark, then run: CALC_E_STEPS REMAINING=<mm>"
`)}

${block(`
[gcode_macro CALC_E_STEPS]
description: Compute rotation_distance from the TUNE_E_STEPS measurement.
gcode:
    {% set remaining = params.REMAINING|float %}
    {% set extruded = 120 - remaining %}
    {% if extruded <= 0 %}
        RESPOND TYPE=error MSG="REMAINING must be less than 120 mm"
    {% else %}
        {% set rd = printer.configfile.settings.extruder.rotation_distance|float %}
        {% set new_rd = rd * extruded / 100 %}
        RESPOND MSG="Extruded {extruded|round(2)} mm of 100. New rotation_distance: {new_rd|round(4)} (was {rd})"
        RESPOND MSG="Set it in [extruder] rotation_distance and restart, then repeat once to confirm."
    {% endif %}
`)}

${block(`
[gcode_macro TUNE_PA]
description: Pressure advance tuning tower (Klipper docs/Pressure_Advance.md). Print docs/prints/square_tower.stl right after running this.
variable_start: 0
variable_factor: ${factor}
gcode:
    {% set START = params.START|default(0)|float %}
    {% set FACTOR = params.FACTOR|default(${factor})|float %}
    SET_GCODE_VARIABLE MACRO=TUNE_PA VARIABLE=start VALUE={START}
    SET_GCODE_VARIABLE MACRO=TUNE_PA VARIABLE=factor VALUE={FACTOR}
    SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=1 ACCEL=500
    TUNING_TOWER COMMAND=SET_PRESSURE_ADVANCE PARAMETER=ADVANCE START={START} FACTOR={FACTOR}
    RESPOND MSG="Print the tower now. Then measure the height with the sharpest corners and run CALC_PA HEIGHT=<mm>"
`)}

${block(`
[gcode_macro CALC_PA]
description: Turn the best tower height into a pressure_advance value and apply it.
gcode:
    {% set H = params.HEIGHT|float %}
    {% set v = printer["gcode_macro TUNE_PA"] %}
    {% set pa = v.start + H * v.factor %}
    SET_PRESSURE_ADVANCE ADVANCE={pa}
    RESPOND MSG="pressure_advance = {pa|round(4)}. Put it in [extruder] pressure_advance (baseline was ${p.paBaseline})."
`)}
`;
}

export function homingMacros(p: Plan, header: string[]): string {
  const [bx, by] = p.size.bed_mm;
  const zxy = p.build.homing.z === 'probe_virtual_endstop' ? [bx / 2, by / 2] : p.build.homing.zSwitchXY ?? [bx / 2, by / 2];
  const cur = p.homingCurrent;
  const run = Object.fromEntries(p.steppers.map((s) => [s.name, s.runCurrent]));
  const names = Object.keys(cur);
  const setAll = (vals: Record<string, number>) =>
    names.map((n) => `    SET_TMC_CURRENT STEPPER=${n} CURRENT=${vals[n]}`).join('\n');
  const homeAxis = (axis: 'X' | 'Y') => block(`
[gcode_macro _HOME_${axis}]
description: Sensorless ${axis} home at reduced current (Klipper TMC_Drivers.md).
gcode:
${setAll(cur)}
    G4 P2000
    G28 ${axis}
    G91
    G1 ${axis}-10 F1200
    G90
${setAll(run)}
`);
  return `${hdr(header)}
# Sensorless X/Y. homing_override replaces safe_z_home, so Z homing lives here too.
# CoreXY moves both A and B motors for either axis, so every A/B motor drops current together.

${homeAxis('X')}

${homeAxis('Y')}

${block(`
[gcode_macro _HOME_Z]
gcode:
    G90
    G0 X${zxy[0]} Y${zxy[1]} F6000
    G28 Z
    G0 Z10 F1200
`)}

[force_move]
enable_force_move: True   # for SET_KINEMATIC_POSITION below

# If Z is unhomed, pretend it is 0 just long enough to lift the nozzle clear of
# the bed, then clear the homed flag again unless Z was homed too.
# (set_position_z would do this on every G28 X as well, corrupting a homed Z.)
# Note: no {# #} comments inside macros - Klipper's template syntax uses { }.
${block(`
[homing_override]
axes: xyz
gcode:
    {% set home_all = 'X' not in params and 'Y' not in params and 'Z' not in params %}
    {% set z_homed = 'z' in printer.toolhead.homed_axes %}
    {% if z_homed %}
        {% set z = [printer.toolhead.position.z + 10, printer.toolhead.axis_maximum.z]|min %}
        G90
        G0 Z{z} F1200
    {% else %}
        SET_KINEMATIC_POSITION Z=0 SET_HOMED=z
        G91
        G0 Z10 F1200
        G90
    {% endif %}
    {% if home_all or 'X' in params %}
        _HOME_X
    {% endif %}
    {% if home_all or 'Y' in params %}
        _HOME_Y
    {% endif %}
    {% if home_all or 'Z' in params %}
        _HOME_Z
    {% elif not z_homed %}
        SET_KINEMATIC_POSITION CLEAR_HOMED=z
    {% endif %}
`)}
`;
}
