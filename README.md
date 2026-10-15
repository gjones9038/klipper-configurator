# klipper-configurator

A tool that turns "my printer, board, toolhead, motors, hotend…" into a complete Klipper
config plus wiring diagrams. This repo holds the **component data**, the **generator** and a
**web app** that runs the generator in the browser.

## Generator

```sh
npm install
npm run generate -- examples/v24-350-leviathan-sb2209.json out/my-printer
npm test                       # unit tests + the 96-case build matrix
```

A build file (see `generator/types.ts` → `Build`) names the printer, size, variant (incl. AWD),
mainboard and connection, toolhead board, driver modules (UART or SPI), motors, homing
(physical or sensorless), probe, extruder, hotend, thermistors, fans and whether to use
klipper_tmc_autotune, the web UI (Mainsail / Fluidd / none) and an optional Nevermore filter.
Probes: Omron TL-Q5MC2, PL-08N or any inductive probe (NPN/PNP, NO/NC), Voron Tap, Klicky, BLTouch,
BTT Eddy USB and Cartographer V3 (Klipper's native `[probe_eddy_current]`), Beacon (vendor module).
Output:

| File | Contents |
|---|---|
| `printer.cfg` | web UI include, kinematics, every `[safe_z_home]` / `[quad_gantry_level]` or `[z_tilt]` / `[bed_mesh]` setting, input shaper / resonance tester, doc links |
| `mainboard.cfg`, `toolhead.cfg` | MCUs, steppers + TMC sections, heaters, sensors, fans (incl. Nevermore), probe, accelerometer, LEDs |
| `probe.cfg` | eddy probes: probe MCU, `[probe_eddy_current]` + temperature probe (BTT Eddy, Cartographer V3) or `[beacon]` |
| `autotune.cfg` | `[autotune_tmc]` per motor (when enabled) |
| `homing.cfg` | sensorless homing override with reduced homing current (when sensorless) |
| `macros/print.cfg` | `PRINT_START` (flow of jontek2's "better print_start": soak, level, adaptive mesh, purge), `PURGE_LINE`, `PRINT_END`, Nevermore run-on |
| `macros/leveling.cfg` | `G32`, `LEVEL_IF_NEEDED`, `LEVEL_BED`, `_HOME_IF_NEEDED` |
| `macros/preflight.cfg`, `macros/tuning.cfg` | `PREFLIGHT*`; `TUNE_*` / `CALC_*` incl. eddy / Beacon calibration |
| `WIRING.md`, `wiring.json` | every connection with connector + pins, jumpers to set, reference links |
| `FIRMWARE.md` | `make menuconfig` settings per MCU (incl. probe MCUs) |
| `SLICER.md` | start / end G-code for OrcaSlicer, SuperSlicer, PrusaSlicer, Cura |
| `LINKS.md` | every documentation link for the build, by topic (the web UI opens these in a new tab) |
| `WARNINGS.md` | data caveats for the chosen parts (unreviewed boards, source conflicts, probe wiring) |
| `mcus.json` | MCU name -> chip, used by the Klipper check |

How it decides: `generator/plan.ts` resolves the build (slot assignment, drivers, currents,
ports, homing, probe) and collects errors/warnings; `emit.ts`, `macros.ts` and `wiring.ts` only
format the plan.

### Toolchangers (StealthChanger)

Choosing the `stealthchanger-sb` toolhead adds `toolchanger` to the build (see
`examples/v24-350-leviathan-stealthchanger.json`): T0 is the main toolhead, `toolchanger.tools`
lists T1..Tn (board, and optionally extruder / hotend / thermistor per tool), `docks` and `safeY`
are measured per printer, and `travel` sets the stepper limits that reach the docks. Output follows
viesturz/klipper-toolchanger (`data/toolchangers.yaml`, every value cited):

| File | Contents |
|---|---|
| `toolchanger.cfg` | `[toolchanger]`, StealthChanger dock paths, pickup / dropoff macros, `TC_DOCK_ALIGN_*` dock measuring |
| `tools/Tn.cfg` | per tool: MCU, `[extruderN]`, fans, accelerometer, LEDs, `[tool_probe Tn]` (Tap = Z probe + tool detection), `[tool Tn]` |
| `homing.cfg` | `INITIALIZE_TOOLCHANGER`, Z homing with the mounted tool's Tap, `ADJUST_Z_AFTER_TOOL_NOZZLE_HOME` |

Tool changes are refused (by the generated macros) until a tool's dock and the safe Y are set.
The pickup / dropoff macros are written for this repo from klipper-toolchanger's documentation; the
upstream example macros are GPLv3. Only the Voron 2.4 (fixed docks) is modelled; Trident needs a liftbar.

> klipper-toolchanger `main` (94756df) does not load on Klipper after its 2026-05-25 probe rework.
> The generator warns about it; the Klipper check runs against the open fix, PR #174.

## Web app

```sh
npm run web:dev       # build into dist/web, rebuild on change, serve on http://localhost:8080
npm run web:build     # one-off static build into dist/web (serve it from any static host)
npm run typecheck     # tsc over generator/, web/ and tools/
```

A static, client-side app: `tools/build_web.ts` bundles `web/main.ts` with esbuild and writes
`db.json` (the raw data files plus the data revision). The browser runs the same `plan()` /
`generate()` as the CLI on every change, so the zip it downloads matches
`npm run generate` for the same `build.json` byte for byte. Nothing leaves the browser; the build is
remembered in localStorage and can be saved or opened as `build.json`.

Steps: printer, mainboard, toolhead board, motors and drivers, homing and probe, hotend,
fans and filter, software, export. The side panel shows errors (which block output), warnings,
a live preview of the relevant file and the driver slot assignment. The export step lists every
file, the wiring table, jumpers, MCUs and documentation links (opened in a new tab), and offers
the config as a .zip.

**Upload to the printer.** The export step can send the config straight to Moonraker
(`web/moonraker.ts`, endpoints from Moonraker's `docs/external_api`): it checks the printer
(`/server/info`, `/server/files/list`, print state), shows what will be replaced, zips those files
into `config/klipper-configurator-backup-<time>.zip` (`/server/files/zip`), then uploads each file
(`/server/files/upload`, SHA-256 checksum where the browser allows) and offers a firmware restart.
Guides and JSON go to `config/klipper-configurator/`. The SAVE_CONFIG block of the existing
`printer.cfg` is carried over (`generator/saveconfig.ts`): saved sections for hardware the new
config lacks are dropped and listed, because Klipper refuses to start with them. Uploads are
blocked while printing. The browser talks to Moonraker directly, so the page's origin must be in
`cors_domains` under `[authorization]` in moonraker.conf; an API key is optional (`X-Api-Key`).

### Checking output with real Klipper

`tools/klipper_check.py` runs Klipper itself in batch mode against generated configs
(`klippy.py printer.cfg -d <mcu>.dict -d toolhead=<mcu>.dict`) and executes `PREFLIGHT`, `G28`
(including sensorless homing overrides) and the tuning macros. Toolchanger builds load
klipper-toolchanger (pinned to PR #174) and, when docks are set, change tools; batch mode has no
detection pins, so a test-only extra (`tools/klipper-check/kc_test_tool_detect.py`) marks T0 mounted. A bad pin, unknown option, Jinja
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
  toolchangers.yaml StealthChanger: klipper-toolchanger settings, dock paths, known issues
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
  build_web.ts             bundle the web app into dist/web
generator/                 TypeScript, run directly by Node >= 23.6 (no build step)
                           generate.ts / dbcore.ts have no Node imports and also run in the browser
web/                       the web app (vanilla TypeScript, no framework)
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
