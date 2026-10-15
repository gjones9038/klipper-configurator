#!/usr/bin/env python3
"""Validate data/ and print the board x printer-variant compatibility matrix.

Checks:
  - ids are unique within each collection
  - no physical pin is assigned to two different functions on one board
    (allowed overlaps: uart_pin == spi_cs_pin, diag_pin == shared endstop pin)
  - cross-file references resolve (extruder motors, toolhead extruders,
    hotend thermistors, toolhead/probe ids used by printers)

Usage: validate.py [--matrix]
Exit code 1 on errors; warnings don't fail.
"""
import sys
from collections import defaultdict
from pathlib import Path

import yaml

DATA = Path(__file__).resolve().parent.parent / "data"
errors, warnings = [], []


def load(p):
    with open(p) as f:
        return yaml.safe_load(f)


def bare(pin):
    return str(pin).lstrip("!^~") if pin else None


def check_unique(kind, ids):
    seen = set()
    for i in ids:
        if i in seen:
            errors.append(f"{kind}: duplicate id {i}")
        seen.add(i)


def board_pin_conflicts(b):
    uses = defaultdict(set)

    def use(pin, what):
        p = bare(pin)
        if p and not p.startswith("<"):
            uses[p].add(what)

    for s in b.get("driver_slots", []):
        for k in ("step_pin", "dir_pin", "enable_pin"):
            use(s.get(k), f"{s['id']}.{k}")
        # uart and SPI CS are the same physical line on stepstick boards
        use(s.get("uart_pin") or s.get("spi_cs_pin"), f"{s['id']}.uart/cs")
    if "extruder_driver" in b:
        d = b["extruder_driver"]
        for k in ("step_pin", "dir_pin", "enable_pin"):
            use(d.get(k), f"extruder.{k}")
        use(d.get("uart_pin") or d.get("spi_cs_pin"), "extruder.uart/cs")
    for group in ("heaters", "thermistors", "fans"):
        for item in b.get(group, []):
            use(item["pin"], f"{group}.{item['id']}")
            if item.get("tachometer_pin"):
                use(item["tachometer_pin"], f"{group}.{item['id']}.tach")
    for item in b.get("neopixel_ports", []):
        use(item["pin"], f"neopixel.{item['id']}")
    for pin, what in uses.items():
        if len(what) > 1:
            errors.append(f"{b['id']}: pin {pin} used by {sorted(what)}")


def main():
    printers = [load(p) for p in sorted((DATA / "printers").glob("*.yaml"))]
    boards = [load(p) for p in sorted((DATA / "mainboards").glob("*.yaml"))]
    toolboards = [load(p) for p in sorted((DATA / "toolboards").glob("*.yaml"))]
    motors = load(DATA / "motors" / "motors.yaml")["motors"]
    extruders = load(DATA / "extruders.yaml")["extruders"]
    hotends = load(DATA / "hotends.yaml")["hotends"]
    toolheads = load(DATA / "toolheads.yaml")["toolheads"]
    probes = load(DATA / "probes.yaml")["probes"]
    therm = load(DATA / "thermistors.yaml")["user_choices"]
    drivers = load(DATA / "drivers.yaml")

    for kind, items in (("printer", printers), ("mainboard", boards), ("toolboard", toolboards),
                        ("motor", motors), ("extruder", extruders), ("hotend", hotends),
                        ("toolhead", toolheads), ("probe", probes), ("thermistor", therm)):
        check_unique(kind, [i["id"] for i in items])

    motor_ids = {m["id"] for m in motors}
    ext_ids = {e["id"] for e in extruders}
    therm_ids = {t["id"] for t in therm}
    th_ids = {t["id"] for t in toolheads}
    probe_ids = {p["id"] for p in probes}

    for e in extruders:
        if e.get("recommended_motor") and e["recommended_motor"] not in motor_ids:
            errors.append(f"extruder {e['id']}: unknown motor {e['recommended_motor']}")
    for t in toolheads:
        for e in t.get("compatible_extruders", []):
            if e not in ext_ids:
                errors.append(f"toolhead {t['id']}: unknown extruder {e}")
    for h in hotends:
        if h.get("common_thermistor") not in therm_ids:
            errors.append(f"hotend {h['id']}: unknown thermistor {h.get('common_thermistor')}")
    for p in printers:
        if p["stock"]["toolhead"] not in th_ids:
            errors.append(f"printer {p['id']}: unknown toolhead")
        if p["stock"]["extruder"] not in ext_ids:
            errors.append(f"printer {p['id']}: unknown extruder")
        for pr in p["stock"]["probe_options"]:
            if pr not in probe_ids:
                errors.append(f"printer {p['id']}: unknown probe {pr}")

    for b in boards:
        board_pin_conflicts(b)
        for s in b["driver_slots"]:
            od = s.get("onboard_driver")
            if od and od["chip"] not in drivers["chips"]:
                errors.append(f"{b['id']}.{s['id']}: unknown driver chip {od['chip']}")
        for d in b.get("discrepancies", []):
            warnings.append(f"{b['id']}: discrepancy: {d[:90]}...")
        if b["status"] != "reviewed":
            warnings.append(f"{b['id']}: status {b['status']}")
    for b in toolboards:
        board_pin_conflicts(b)
        if b["extruder_driver"]["chip"] not in drivers["chips"]:
            errors.append(f"{b['id']}: unknown driver chip")

    for w in warnings:
        print("WARN ", w)
    for e in errors:
        print("ERROR", e)
    print(f"\n{len(printers)} printers, {len(boards)} mainboards, {len(toolboards)} toolboards, "
          f"{len(motors)} motors, {len(extruders)} extruders, {len(hotends)} hotends, "
          f"{len(probes)} probes; {len(errors)} errors, {len(warnings)} warnings")

    if "--matrix" in sys.argv:
        print_matrix(printers, boards)
    return 1 if errors else 0


def print_matrix(printers, boards):
    cols = [(p, v) for p in printers for v in p["variants"]]
    head = ["board (slots)"] + [f"{p['id']} {v['id']}" for p, v in cols]
    print("\n| " + " | ".join(head) + " |")
    print("|" + "---|" * len(head))
    for b in boards:
        n = len(b["driver_slots"])
        row = [f"{b['id']} ({n})"]
        for p, v in cols:
            need_motion = v["drivers_required"]["motion"]
            need_all = need_motion + v["drivers_required"]["extruder"]
            if n >= need_all:
                row.append("yes")
            elif n >= need_motion:
                row.append("toolboard E")
            else:
                row.append("no")
        print("| " + " | ".join(row) + " |")
    print("\n'toolboard E' = fits only with the extruder driver on a CAN/USB toolhead board.")


if __name__ == "__main__":
    sys.exit(main())
