# klipper-configurator

A tool that turns "my printer, board, toolhead, motors, hotend…" into a complete Klipper
config plus wiring diagrams. This repo is currently the **component data** it builds from.

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
