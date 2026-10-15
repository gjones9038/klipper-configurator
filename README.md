# klipper-configurator

A tool that turns "my printer, board, toolhead, motors, hotend…" into a complete Klipper
config plus wiring diagrams. This repo holds the **component data** and the **generator**;
the web UI comes next.

## Generator

```sh
npm install
npm run generate -- examples/v24-350-leviathan-sb2209.json out/my-printer
npm test                       # unit tests + the 96-case build matrix
```

A build file (see `generator/types.ts` → `Build`) names the printer, size, variant (incl. AWD),
mainboard and connection, toolhead board, driver modules (UART or SPI), motors, homing
(physical or sensorless), probe, extruder, hotend, thermistors, fans and whether to use
klipper_tmc_autotune. Output:

| File | Contents |
|---|---|
| `printer.cfg` | includes, kinematics, leveling, mesh, safe_z_home, input shaper / resonance tester |
| `mainboard.cfg`, `toolhead.cfg` | MCUs, steppers + TMC sections, heaters, sensors, fans, probe, accelerometer, LEDs |
| `autotune.cfg` | `[autotune_tmc]` per motor (when enabled) |
| `homing.cfg` | sensorless homing override with reduced homing current (when sensorless) |
| `macros/` | `PRINT_START/END`, `PREFLIGHT*`, `TUNE_*` / `CALC_*` tuning flow |
| `WIRING.md`, `wiring.json` | every connection with connector + pins, and jumpers to set |
| `FIRMWARE.md` | `make menuconfig` settings per MCU |
| `WARNINGS.md` | data caveats for the chosen parts (unreviewed boards, source conflicts) |

How it decides: `generator/plan.ts` resolves the build (slot assignment, drivers, currents,
ports, homing, probe) and collects errors/warnings; `emit.ts`, `macros.ts` and `wiring.ts` only
format the plan.

### Checking output with real Klipper

`tools/klipper_check.py` runs Klipper itself in batch mode against generated configs
(`klippy.py printer.cfg -d <mcu>.dict -d toolhead=<mcu>.dict`) and executes `PREFLIGHT`, `G28`
(including sensorless homing overrides) and the tuning macros. A bad pin, unknown option, Jinja
error or out-of-range move fails the case.

```sh
npm run setup-klipper-check          # once: Klipper @ pinned commit, ARM GCC, MCU dicts, deps
npm run matrix                       # write every generatable matrix case to out/matrix
npm run klipper-check -- out/matrix/*/
```

## Layout

```
data/
  printers/        voron-2.4.yaml, voron-trident.yaml (sizes, steppers, AWD variants, defaults)
  mainboards/      one file per board revision (pins per driver slot, heaters, fans, ...)
  toolboards/      CAN/USB toolhead boards (extruder driver, heater, fans, accelerometer)
  motors/          motors.yaml - generated from klipper_tmc_autotune's motor database
  drivers.yaml     TMC chips (UART/SPI, sensorless keys, autotune support) + driver modules
  homing.yaml      physical vs sensorless X/Y, Z homing methods, and their rules
  extruders.yaml   rotation_distance, gear_ratio, PA baselines; Z drive options
  hotends.yaml     flow class, max temp, heater options
  toolheads.yaml   Stealthburner / StealthChanger: fans, LEDs, input shaper baseline
  probes.yaml      inductive, Tap, Klicky, Beacon, Cartographer, Eddy, BLTouch
  thermistors.yaml exact Klipper sensor_type strings + user-facing choices
  fans.yaml        fan roles -> Klipper sections + defaults
  tuning.yaml      baselines + post-preflight tuning flow
tools/
  extract_klipper_pins.py  parse any Klipper .cfg into pin JSON
  draft_board.py           .cfg -> draft board YAML (for adding a new board)
  import_boards.py         initial import of all boards (overwrites data/*boards)
  import_motor_db.py       regenerate data/motors/motors.yaml
  validate.py              pin-conflict + reference checks; --matrix prints compatibility
  klipper_check.py         run generated configs through Klipper (batch mode)
  setup_klipper_check.sh   one-time setup for klipper_check.py
generator/                 TypeScript, run directly by Node >= 23.6 (no build step)
examples/                  sample build files
```

## Data conventions

- **Pins are physical.** `dir_pin` has no `!`, because direction inversion belongs to the
  printer and the wiring. `enable_pin` keeps its `!`, because that's a board property.
  The board's MCU prefix (`EBBCan:`, `nhk:`) is stripped; the generator adds the user's MCU name.
- **UART and SPI.** On stepstick/EZ boards each slot's `uart_pin` is also its SPI CS pin
  (`spi_cs_pin`). The SPI bus is the board-level `tmc_spi` (hardware `bus` or `software` pins).
  The chip's `interfaces` in `drivers.yaml` decide which one the generator emits.
- **Every record cites its sources** (repo, path, commit). Values that weren't confirmed by a
  source are listed under `unverified`. Disagreements between sources are listed under
  `discrepancies`, along with which value was chosen.
- **`status: reviewed`** means two sources agree on the pins (vendor and Klipper, or vendor
  and Voron). **`needs-review`** means a single source or known conflicts; don't ship configs
  for these boards without a hardware check.

## Adding a board

```sh
python3 tools/draft_board.py path/to/vendor-sample.cfg > /tmp/draft.yaml   # read the warnings
# add an overlay entry to tools/import_boards.py (labels, MCU, endstops, notes), or hand-write
python3 tools/validate.py --matrix
```
