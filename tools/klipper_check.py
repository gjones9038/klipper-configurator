#!/usr/bin/env python3
"""Check generated configs with Klipper itself (klippy batch mode).

For each output directory: pick MCU data dictionaries from the [mcu] comments
and FIRMWARE.md, run klippy against printer.cfg with a short G-code script
that also executes the generated macros, and report pass/fail.

Setup (once):
  - a Klipper checkout                     --klipper
  - data dictionaries per MCU (<chip>.dict) --dicts   (build test/configs/<chip>.config)
  - klipper_tmc_autotune checkout          --autotune (only needed for autotune builds)
  - klipper-toolchanger checkout           --toolchanger (only needed for toolchanger builds)
  - klippy's Python deps on PYTHONPATH     --site

Usage: klipper_check.py --klipper K --dicts D [--autotune A] [--toolchanger T] [--site S] OUT_DIR [OUT_DIR ...]
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# Exercise macros so Jinja templates are rendered, not just parsed.
GCODE = """
PREFLIGHT
G28
G90
G1 X100 Y100 Z30 F6000
G32
LEVEL_BED
LEVEL_IF_NEEDED
CALC_E_STEPS REMAINING=20
CALC_PA HEIGHT=12.5
PRINT_END
"""

# Eddy probes cannot probe (or home Z) before PROBE_EDDY_CURRENT_CALIBRATE, which
# needs real hardware; check config loading and everything that does not probe.
GCODE_EDDY = """
PREFLIGHT
G28 X Y
CALC_E_STEPS REMAINING=20
CALC_PA HEIGHT=12.5
"""

# Toolchanger builds: home and level with the mounted tool (T0), then change tools
# when the build has docks and safe Y (without them the macros refuse by design).
# kc_test_tool_detect.py stands in for the detection pins batch mode lacks.
GCODE_TOOLCHANGER = """
PREFLIGHT
G28
G90
G1 X100 Y100 Z30 F6000
G32
CALC_E_STEPS REMAINING=20
CALC_PA HEIGHT=12.5
TC_DOCK_ALIGN_START
EXIT_DOCKING_MODE
"""
GCODE_TOOLCHANGES = """
T1
T2
T0
T2
PRINT_END
"""

ERROR_MARKERS = ("Config error", "Internal error", "Error evaluating", "Traceback",
                 "Move out of range", "Unknown command", "Must home", "Option '")


def mcus_for(outdir):
    with open(os.path.join(outdir, "mcus.json")) as f:
        return json.load(f)


def prepare_klipper(klipper, autotune, toolchanger, workdir):
    """Copy klippy/ into workdir and install the autotune / toolchanger extensions if given."""
    dst = os.path.join(workdir, "klipper")
    shutil.copytree(klipper, dst, ignore=shutil.ignore_patterns(".git", "out", "lib", "src", "docs"))
    extras = os.path.join(dst, "klippy", "extras")
    if autotune:
        for f in ("autotune_tmc.py", "motor_constants.py", "motor_database.cfg"):
            shutil.copy(os.path.join(autotune, f), extras)
    if toolchanger:
        src = os.path.join(toolchanger, "klipper", "extras")
        for f in os.listdir(src):
            if f.endswith(".py"):
                shutil.copy(os.path.join(src, f), extras)
        # Test-only: simulate T0 mounted (batch mode has no detection pins).
        shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), "klipper-check", "kc_test_tool_detect.py"), extras)
    return dst


def stage(outdir, work, ui_configs):
    """Copy the output and add the web UI cfg it includes (mainsail.cfg / fluidd.cfg)."""
    dst = os.path.join(work, "cfg")
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(outdir, dst)
    printer = open(os.path.join(dst, "printer.cfg")).read()
    for ui in ("mainsail", "fluidd"):
        if f"[include {ui}.cfg]" in printer:
            src = os.path.join(ui_configs, f"{ui}-config", "client.cfg")
            shutil.copy(src, os.path.join(dst, f"{ui}.cfg"))
    return dst


# Leveling macros exist only when the printer levels (QGL / Z-tilt) or has a probe.
OPTIONAL_MACROS = {"G32", "LEVEL_BED", "LEVEL_IF_NEEDED"}


def defined_macros(cfg):
    names = set()
    for root, _, files in os.walk(cfg):
        for n in files:
            if n.endswith(".cfg"):
                names.update(m.upper() for m in re.findall(r"^\[gcode_macro (\S+)\]", open(os.path.join(root, n)).read(), re.M))
    return names


def script(text, macros):
    return "".join(l + "\n" for l in text.strip().splitlines() if l.split()[0] not in OPTIONAL_MACROS or l.split()[0] in macros)


def check(outdir, klipper, dicts, site, work, ui_configs):
    mcus = mcus_for(outdir)
    if not all(m["klipperCheck"] for m in mcus):
        return None, 0, "", []
    cfg = stage(outdir, work, ui_configs)
    eddy = os.path.exists(os.path.join(cfg, "probe.cfg")) and \
        "[probe_eddy_current" in open(os.path.join(cfg, "probe.cfg")).read()
    tc = os.path.exists(os.path.join(cfg, "toolchanger.cfg"))
    docked = tc and "params_dock_set: 0" not in "".join(
        open(os.path.join(cfg, "tools", n)).read() for n in os.listdir(os.path.join(cfg, "tools")))
    if tc:
        with open(os.path.join(cfg, "printer.cfg"), "a") as f:
            f.write("\n[kc_test_tool_detect]\n")
    with open(os.path.join(work, "test.gcode"), "w") as f:
        if tc and eddy:
            # Shuttle eddy probe: Z cannot home before calibration, so no tool changes either.
            f.write("PREFLIGHT\nG28 X Y\nCALC_E_STEPS REMAINING=20\nCALC_PA HEIGHT=12.5\n")
        elif tc:
            f.write(GCODE_TOOLCHANGER + (GCODE_TOOLCHANGES if docked else "PRINT_END\n"))
        else:
            text = GCODE_EDDY if eddy else script(GCODE, defined_macros(cfg))
            # A delta's bed is centred on 0,0: move to the centre instead of 100,100.
            if "kinematics: delta" in open(os.path.join(cfg, "printer.cfg")).read():
                text = text.replace("G1 X100 Y100 Z30", "G1 X0 Y0 Z30")
            f.write(text)
    args = [sys.executable, os.path.join(klipper, "klippy", "klippy.py"),
            os.path.join(cfg, "printer.cfg"), "-i", os.path.join(work, "test.gcode"),
            "-o", os.path.join(work, "out.serial"), "-l", os.path.join(work, "klippy.log")]
    for m in mcus:
        d = os.path.join(dicts, f"{m.get('checkDict') or m['chip']}.dict")
        args += ["-d", d if m["name"] == "mcu" else f"{m['name']}={d}"]
    log_path = os.path.join(work, "klippy.log")
    if os.path.exists(log_path):
        os.remove(log_path)  # klippy appends; a stale log would leak errors into this case
    env = dict(os.environ, PYTHONPATH=site or "")
    try:
        proc = subprocess.run(args, env=env, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        # A config that never finishes (e.g. a 20 km homing move) fails this case, not the run.
        return False, -1, "", ["klippy did not finish within 300 s"]
    log = open(os.path.join(work, "klippy.log")).read() if os.path.exists(os.path.join(work, "klippy.log")) else ""
    text = proc.stdout + proc.stderr + log
    bad = [ln for ln in text.splitlines() if any(m in ln for m in ERROR_MARKERS) or ln.startswith("!! ")]
    # PREFLIGHT legitimately reports 0C temperatures in batch mode.
    bad = [ln for ln in bad if "is not room temperature" not in ln]
    # Batch mode has no bed: a probe never triggers and reads stepper_z position_min. On printers
    # whose position_min is far below 0 (Anycubic Kobra: -10) that "mesh" exceeds the fade range and
    # Klipper stops. A simulation artifact, not a config error, as long as nothing else went wrong.
    if proc.returncode != 0 and not bad and "Mesh extends outside of the fade range" in text:
        return True, proc.returncode, text, []
    return proc.returncode == 0 and not bad, proc.returncode, text, bad


class _keep:
    def __init__(self, path):
        self.path = path
    def __enter__(self):
        shutil.rmtree(self.path, ignore_errors=True)
        os.makedirs(self.path)
        return self.path
    def __exit__(self, *a):
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--klipper", required=True)
    ap.add_argument("--dicts", required=True)
    ap.add_argument("--autotune")
    ap.add_argument("--toolchanger", help="klipper-toolchanger checkout (repo root)")
    ap.add_argument("--site")
    ap.add_argument("--ui-configs", help="dir containing mainsail-config/ and fluidd-config/ checkouts")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("outdirs", nargs="+")
    a = ap.parse_args()

    failures = skipped = 0
    keep = os.environ.get("KC_KEEP_WORKDIR")   # debugging: keep the staged config and logs here
    with (tempfile.TemporaryDirectory() if not keep else _keep(keep)) as tmp:
        klipper = prepare_klipper(a.klipper, a.autotune, a.toolchanger, tmp)
        for outdir in a.outdirs:
            ok, code, text, bad = check(outdir, klipper, a.dicts, a.site, tmp, a.ui_configs)
            if ok is None:
                skipped += 1
                print(f"SKIP  {outdir}  (an MCU without a Klipper data dictionary, e.g. Beacon)")
                continue
            print(f"{'PASS' if ok else 'FAIL'}  {outdir}" + ("" if ok else f"  (exit {code})"))
            if not ok:
                failures += 1
                tail = bad or text.strip().splitlines()[-15:]
                for ln in tail[:15]:
                    print("      " + ln)
                if a.verbose:
                    print(text)
            elif a.verbose:
                print(text[-2000:])
    checked = len(a.outdirs) - skipped
    print(f"\n{checked - failures}/{checked} passed, {skipped} skipped")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
