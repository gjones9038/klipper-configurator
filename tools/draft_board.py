#!/usr/bin/env python3
"""Turn a vendor/Klipper sample config into a *draft* board data file.

The draft is a starting point for hand curation, not a finished record:
connector labels, voltages, jumpers and MCU details still need a human pass
against the board's pinout diagram. Warnings are printed for things that
look inconsistent (duplicate pins, TMC sections that don't match a stepper).

Usage: draft_board.py <file.cfg> [--hv-prefix HV] > draft.yaml
"""
import re
import sys
from collections import Counter

import yaml

sys.path.insert(0, __import__("os").path.dirname(__file__))
from extract_klipper_pins import parse  # noqa: E402

MOTOR_SECTION = re.compile(r"^(stepper_[a-z0-9]*|extruder\d*)$")
TMC_SECTION = re.compile(r"^(tmc\d+)\s+(\S+)$")
ALIAS = re.compile(r"(EXP\d_\d+)\s*=\s*(<?[A-Za-z0-9_]+>?)")


def first(keys, name):
    vals = keys.get(name)
    if not vals:
        return None
    return min(vals, key=lambda e: e["comment_depth"])


def bare(pin):
    """Strip Klipper pin modifiers (!, ^, ~) to get the physical pin."""
    return pin.lstrip("!^~") if pin else pin


def draft(path):
    sections = parse(path)
    warnings = []
    motors, by_name = [], {}
    for s in sections:
        if MOTOR_SECTION.match(s["section"]) and "step_pin" in s["keys"]:
            k = s["keys"]
            m = {
                "id": f"MOTOR_{len(motors)}",
                "label_hint": s.get("label_hint"),
                "step_pin": bare(first(k, "step_pin")["value"]),
                "dir_pin": bare(first(k, "dir_pin")["value"]),
                "enable_pin": first(k, "enable_pin")["value"],
            }
            es = first(k, "endstop_pin")
            if es:
                m["endstop_pin"] = bare(es["value"])
            for key in ("heater_pin", "sensor_pin"):
                e = first(k, key)
                if e:
                    m["_" + key] = (bare(e["value"]), e.get("note"))
            motors.append(m)
            if s["section"] in by_name:
                warnings.append(f"duplicate stepper section {s['section']}")
            by_name[s["section"]] = m
    for s in sections:
        t = TMC_SECTION.match(s["section"])
        if not t:
            continue
        drv, name = t.groups()
        m = by_name.get(name)
        if m is None:
            warnings.append(f"[{s['section']}] matches no stepper section")
            continue
        k = s["keys"]
        if "uart_pin" in k:
            if "uart_pin" in m and m["uart_pin"] != bare(first(k, "uart_pin")["value"]):
                warnings.append(f"{name}: conflicting uart_pin values")
            m["uart_pin"] = bare(first(k, "uart_pin")["value"])
        if "cs_pin" in k:
            m["cs_pin"] = bare(first(k, "cs_pin")["value"])
            spi = {}
            if "spi_bus" in k:
                spi["bus"] = first(k, "spi_bus")["value"]
            for wire in ("mosi", "miso", "sclk"):
                e = first(k, f"spi_software_{wire}_pin")
                if e:
                    spi[wire] = bare(e["value"])
            m["spi"] = spi
        for dk in ("diag_pin", "diag0_pin", "diag1_pin"):
            e = first(k, dk)
            if e:
                m.setdefault("diag", {})[dk] = bare(e["value"])
        if first(k, "sense_resistor"):
            m["sense_resistor_in_source"] = float(first(k, "sense_resistor")["value"])
        m.setdefault("source_driver_types", []).append(drv)

    heaters, thermistors = [], []
    for m in motors:
        if "_heater_pin" in m:
            pin, note = m.pop("_heater_pin")
            heaters.append({"id": note or f"HE{len(heaters)}", "pin": pin})
        if "_sensor_pin" in m:
            pin, note = m.pop("_sensor_pin")
            thermistors.append({"id": note or f"T{len(thermistors)}", "pin": pin})

    fans, extras = [], {}
    for s in sections:
        k, name = s["keys"], s["section"]
        if name == "heater_bed":
            heaters.append({"id": (first(k, "heater_pin").get("note") or "HB"),
                            "pin": bare(first(k, "heater_pin")["value"]), "role": "bed"})
            e = first(k, "sensor_pin")
            thermistors.append({"id": e.get("note") or "TB", "pin": bare(e["value"]),
                                "role": "bed"})
        elif "fan" in name and "pin" in k:
            e = first(k, "pin")
            f = {"id": e.get("note") or f"FAN{len(fans)}", "pin": bare(e["value"])}
            tach = first(k, "tachometer_pin")
            if tach:
                f["tachometer_pin"] = bare(tach["value"])
            if ":" in f["pin"]:
                f["host_pin"] = True  # e.g. a fan on the CB1/Pi GPIO
            fans.append(f)
        elif name.startswith("temperature_sensor") and "sensor_pin" in k:
            e = first(k, "sensor_pin")
            thermistors.append({"id": e.get("note") or name.split()[-1],
                                "pin": bare(e["value"])})
        elif name in ("probe", "bltouch") or name.startswith("neopixel") \
                or name.startswith("filament_switch_sensor") or name.startswith(("adxl345", "lis2dw", "mpu9250", "tmc_spi")) \
                or name.startswith(("output_pin", "led", "servo", "max31865")):
            extras.setdefault(name.split()[0], []).append(
                {key: bare(first(k, key)["value"]) for key in k
                 if key not in ("aliases",)} | ({"note": n} if (n := next(
                     (first(k, key).get("note") for key in k if first(k, key).get("note")),
                     None)) else {}))

    text = open(path, encoding="utf-8", errors="replace").read()
    aliases = dict(ALIAS.findall(text))

    pins = Counter()
    for m in motors:
        for key in ("step_pin", "dir_pin", "enable_pin", "uart_pin"):
            if m.get(key):
                pins[bare(m[key])] += 1
    for item in heaters + thermistors + fans:
        pins[item["pin"]] += 1
    for pin, n in pins.items():
        if n > 1:
            warnings.append(f"pin {pin} used {n} times")

    return {
        "draft_from": path,
        "motors": motors,
        "heaters": heaters,
        "thermistors": thermistors,
        "fans": fans,
        "extras": extras,
        "exp_aliases": aliases,
    }, warnings


if __name__ == "__main__":
    data, warns = draft(sys.argv[1])
    for w in warns:
        print("WARNING:", w, file=sys.stderr)
    yaml.safe_dump(data, sys.stdout, sort_keys=False, width=100)
