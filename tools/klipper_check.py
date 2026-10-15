#!/usr/bin/env python3
"""Check generated configs with Klipper itself (klippy batch mode).

For each output directory: pick MCU data dictionaries from the [mcu] comments
and FIRMWARE.md, run klippy against printer.cfg with a short G-code script
that also executes the generated macros, and report pass/fail.

Setup (once):
  - a Klipper checkout                     --klipper
  - data dictionaries per MCU (<chip>.dict) --dicts   (build test/configs/<chip>.config)
  - klipper_tmc_autotune checkout          --autotune (only needed for autotune builds)
  - klippy's Python deps on PYTHONPATH     --site

Usage: klipper_check.py --klipper K --dicts D [--autotune A] [--site S] OUT_DIR [OUT_DIR ...]
"""
import argparse
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
CALC_E_STEPS REMAINING=20
CALC_PA HEIGHT=12.5
PRINT_END
"""

ERROR_MARKERS = ("Config error", "Internal error", "Error evaluating", "Traceback",
                 "Move out of range", "Unknown command", "Must home", "Option '")


def chips_for(outdir):
    fw = open(os.path.join(outdir, "FIRMWARE.md")).read()
    chips = re.findall(r"Micro-controller: (\w+)", fw)
    return [c.lower() for c in chips]


def prepare_klipper(klipper, autotune, workdir):
    """Copy klippy/ into workdir and install the autotune extension if given."""
    dst = os.path.join(workdir, "klipper")
    shutil.copytree(klipper, dst, ignore=shutil.ignore_patterns(".git", "out", "lib", "src", "docs"))
    if autotune:
        extras = os.path.join(dst, "klippy", "extras")
        for f in ("autotune_tmc.py", "motor_constants.py", "motor_database.cfg"):
            shutil.copy(os.path.join(autotune, f), extras)
    return dst


def check(outdir, klipper, dicts, site, work):
    chips = chips_for(outdir)
    args = [sys.executable, os.path.join(klipper, "klippy", "klippy.py"),
            os.path.join(outdir, "printer.cfg"), "-i", os.path.join(work, "test.gcode"),
            "-o", os.path.join(work, "out.serial"), "-l", os.path.join(work, "klippy.log"),
            "-d", os.path.join(dicts, f"{chips[0]}.dict")]
    if len(chips) > 1:
        args += ["-d", f"toolhead={os.path.join(dicts, chips[1] + '.dict')}"]
    log_path = os.path.join(work, "klippy.log")
    if os.path.exists(log_path):
        os.remove(log_path)  # klippy appends; a stale log would leak errors into this case
    env = dict(os.environ, PYTHONPATH=site or "")
    proc = subprocess.run(args, env=env, capture_output=True, text=True, timeout=300)
    log = open(os.path.join(work, "klippy.log")).read() if os.path.exists(os.path.join(work, "klippy.log")) else ""
    text = proc.stdout + proc.stderr + log
    bad = [ln for ln in text.splitlines() if any(m in ln for m in ERROR_MARKERS) or ln.startswith("!! ")]
    # PREFLIGHT legitimately reports 0C temperatures in batch mode.
    bad = [ln for ln in bad if "is not room temperature" not in ln]
    return proc.returncode == 0 and not bad, proc.returncode, text, bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--klipper", required=True)
    ap.add_argument("--dicts", required=True)
    ap.add_argument("--autotune")
    ap.add_argument("--site")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("outdirs", nargs="+")
    a = ap.parse_args()

    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        klipper = prepare_klipper(a.klipper, a.autotune, tmp)
        with open(os.path.join(tmp, "test.gcode"), "w") as f:
            f.write(GCODE)
        for outdir in a.outdirs:
            ok, code, text, bad = check(outdir, klipper, a.dicts, a.site, tmp)
            print(f"{'PASS' if ok else 'FAIL'}  {outdir}")
            if not ok:
                failures += 1
                tail = bad or text.strip().splitlines()[-15:]
                for ln in tail[:15]:
                    print("      " + ln)
            elif a.verbose:
                print(text[-2000:])
    print(f"\n{len(a.outdirs) - failures}/{len(a.outdirs)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
