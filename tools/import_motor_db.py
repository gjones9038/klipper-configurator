#!/usr/bin/env python3
"""Import klipper_tmc_autotune's motor_database.cfg into data/motors/motors.yaml.

Each motor keeps the exact autotune name, so the generator can emit
`[autotune_tmc <stepper>] motor: <name>` for any motor in this file.

Usage: import_motor_db.py <path/to/klipper_tmc_autotune> > data/motors/motors.yaml
"""
import configparser
import re
import subprocess
import sys
from pathlib import Path

import yaml

repo = Path(sys.argv[1])
text = (repo / "motor_database.cfg").read_text()
commit = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()

# "### LDO Motors ###" headers group the sections by vendor.
vendor_of, vendor = {}, None
for line in text.splitlines():
    m = re.match(r"^###\s*(.+?)\s*###", line)
    if m:
        vendor = re.sub(r"\s*\(.*\)|\s*[Mm]otors?$", "", m.group(1)).strip()
    m = re.match(r"^\[motor_(?:constants|alias)\s+(.+?)\]", line)
    if m:
        vendor_of[m.group(1)] = vendor

cp = configparser.ConfigParser(inline_comment_prefixes=("#", ";"), strict=False)
cp.read_string(text)
motors, aliases = [], {}
for sec in cp.sections():
    kind, name = sec.split(None, 1)
    s = cp[sec]
    if kind == "motor_alias":
        if s.get("deprecated", "false").lower() != "true":
            aliases.setdefault(s["motor"], []).append(name)
        continue
    steps = int(s.get("steps_per_revolution", "200"))
    motors.append({
        "id": name.lower(),
        "autotune_name": name,
        "manufacturer": vendor_of.get(name),
        "step_angle_deg": round(360 / steps, 2),
        "rated_current_a": float(s["max_current"]),
        "resistance_ohm": float(s["resistance"]),
        "inductance_h": float(s["inductance"]),
        "holding_torque_nm": float(s["holding_torque"]),
    })
for m in motors:
    if m["autotune_name"] in aliases:
        m["aliases"] = aliases[m["autotune_name"]]

yaml.safe_dump({
    "schema": "motors/1",
    "source": {"repo": "https://github.com/andrewmcgr/klipper_tmc_autotune",
               "path": "motor_database.cfg", "commit": commit},
    "notes": ["rated_current_a is the datasheet rated (RMS) phase current.",
              "Generated file - re-run tools/import_motor_db.py instead of editing by hand; "
              "add motors missing from autotune to motors_extra.yaml."],
    "motors": motors,
}, sys.stdout, sort_keys=False, width=100)
