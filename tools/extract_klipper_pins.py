#!/usr/bin/env python3
"""Extract pin assignments from a Klipper sample/generic config into JSON.

Commented-out sections and keys are kept (most generic configs ship spare
drivers, heaters and fans commented out). Each value records how deeply it
was commented so a human can tell defaults from alternatives.

Usage: extract_klipper_pins.py <file.cfg> [...]
"""
import json
import re
import sys

SECTION = re.compile(r"^\[([^\]]+)\]")
KEY = re.compile(r"^([A-Za-z0-9_]+)\s*[:=]\s*(.*?)\s*$")


def strip_comment_prefix(line):
    depth = 0
    line = line.strip()
    while line.startswith("#"):
        depth += 1
        line = line[1:].lstrip()
    return depth, line


def parse(path):
    sections = []
    cur = None
    last_comment = None  # nearest comment line above a section, e.g. "# Driver0"
    for raw in open(path, encoding="utf-8", errors="replace"):
        depth, line = strip_comment_prefix(raw)
        if not line:
            continue
        m = SECTION.match(line)
        if m and depth <= 1:
            cur = {"section": m.group(1).strip(), "commented": depth > 0, "keys": {}}
            if last_comment:
                cur["label_hint"] = last_comment
            last_comment = None
            sections.append(cur)
            continue
        if depth and not KEY.match(line.split("#")[0].strip()):
            last_comment = line.strip("# ").strip()
        if cur is None:
            continue
        # trailing inline comment, e.g. "heater_pin: PA2 # HE0"
        value_comment = None
        if "#" in line:
            line, value_comment = line.split("#", 1)
            line = line.strip()
            value_comment = value_comment.strip()
        m = KEY.match(line)
        if m and (m.group(1).endswith("pin") or m.group(1).startswith("spi")
                  or m.group(1) in ("sense_resistor", "aliases", "pullup_resistor")):
            entry = {"value": m.group(2), "comment_depth": depth}
            if value_comment:
                entry["note"] = value_comment
            cur["keys"].setdefault(m.group(1), []).append(entry)
    return [s for s in sections if s["keys"]]


if __name__ == "__main__":
    out = {p: parse(p) for p in sys.argv[1:]}
    json.dump(out, sys.stdout, indent=1)
