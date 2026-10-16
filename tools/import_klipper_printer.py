#!/usr/bin/env python3
"""Draft printer + board records from a Klipper reference config (config/printer-*.cfg).

Usage: python3 -I tools/import_klipper_printer.py KLIPPER_DIR NAME [NAME ...]
  NAME is the config name without "printer-" and ".cfg", e.g. anet-a8-2019.

Writes data/printers/<id>.yaml and, unless the pins match a board already in the data,
data/mainboards/<id>-board.yaml. Everything is cited to the Klipper file and commit; boards
from this single source are "needs-review". The output is a draft: read it, then run the
tests and the Klipper check.
"""
import json
import os
import re
import subprocess
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# Printer names and makers for the file names (Klipper's file names are lower-case slugs).
NAMES = json.load(open(os.path.join(ROOT, "tools", "klipper_printer_names.json")))

THERMISTORS = {  # Klipper sensor_type -> data/thermistors.yaml id
    "EPCOS 100K B57560G104F": "epcos-b57560",
    "ATC Semitec 104GT-2": "semitec-104gt2",
    "ATC Semitec 104NT-4-R025H42G": "semitec-104nt4",
    "Generic 3950": "ntc100k-3950",
    "Honeywell 100K 135-104LAG-J01": "honeywell-135-104lag",
    "NTC 100K MGB18-104F39050L32": "ntc100k-mgb18",
    "PT100 INA826": "pt100-ina826",
    "PT1000": "pt1000",
}


def parse_cfg(text):
    """Klipper config -> ({section: {key: value}}, [section order], header comment lines)."""
    sections, order, cur = {}, [], None
    header = []
    seen_section = False
    last_key = None
    for raw in text.splitlines():
        if not seen_section and raw.startswith("#"):
            header.append(raw[1:].strip())
        line = re.sub(r"\s+[#;].*$", "", raw).rstrip()
        if not line.strip() or line.lstrip().startswith(("#", ";")):
            continue
        m = re.match(r"^\[([^\]]+)\]", line)
        if m:
            seen_section = True
            cur = m.group(1).strip()
            sections[cur] = {}
            order.append(cur)
            last_key = None
            continue
        if cur is None:
            continue
        if line[0] in " \t" and last_key:  # continuation line
            sections[cur][last_key] += "\n" + line.strip()
            continue
        m = re.match(r"^([A-Za-z0-9_]+)\s*[:=]\s*(.*)$", line)
        if m:
            last_key = m.group(1).lower()
            sections[cur][last_key] = m.group(2).strip()
    return sections, order, header


def num(v):
    try:
        f = float(v)
        return int(f) if f == int(f) else f
    except (TypeError, ValueError):
        return None


def split_pin(p):
    m = re.match(r"^([!^~]*)\s*(.*)$", p.strip())
    return m.group(1), m.group(2)


def aliases_of(sections):
    out = {}
    for name, sec in sections.items():
        if name.startswith("board_pins"):
            for part in re.split(r"[,\n]", sec.get("aliases", "")):
                if "=" in part:
                    k, v = part.split("=", 1)
                    out[k.strip()] = v.strip()
    return out


def resolve(pin, al):
    if pin is None:
        return None
    mods, bare = split_pin(pin)
    return mods + al.get(bare, bare)


def header_info(header):
    h = " ".join(header)
    chip = None
    for pat in [r"\b(atmega\d+\w*)", r"\b(at90usb\d+)", r"\b(STM32[FGH]\d+\w*)", r"\b(GD32F\d+\w*)", r"\b(HC32F460)", r"\b(LPC17\d+)", r"\b(SAM[34]\w+)", r"\b(STM32F0\d+)"]:
        m = re.search(pat, h, re.I)
        if m:
            chip = m.group(1).lower()
            break
    boot = None
    m = re.search(r'(\d+)\s*KiB bootloader', h, re.I)
    if m:
        boot = int(m.group(1))
    elif re.search(r"no bootloader", h, re.I):
        boot = 0
    comm = None
    m = re.search(r"(serial \(on [^)]*\)|serial \(PA\d+ & PA\d+\)|USB \(on [^)]*\)|USB communication|USB for communication)", h, re.I)
    if m:
        comm = m.group(1)
    mhz = None
    m = re.search(r"(\d+)\s*MHz", h, re.I)
    if m:
        mhz = int(m.group(1))
    # Flashing instructions: the sentences that mention flashing, verbatim.
    flash = " ".join(s for s in re.split(r"(?<=\.)\s+", h) if re.search(r"flash|SD card|avrdude|bootloader|firmware\.bin|\.bin", s, re.I) and "menuconfig" not in s)
    return chip, boot, comm, mhz, flash.strip()


def chip_id(chip):
    """Header chip text -> our MCU id (Klipper build target)."""
    if not chip:
        return None
    c = chip.lower()
    for k in ["atmega1284p", "atmega2560", "atmega644p", "atmega1280", "at90usb1286", "hc32f460", "lpc1768", "lpc1769", "sam3x8e", "sam4e8e"]:
        if c.startswith(k):
            return k
    m = re.match(r"(stm32[fgh]\d{3})", c)
    if m:
        return m.group(1)
    m = re.match(r"gd32f(\d{3})", c)
    if m:
        return "gd32f" + m.group(1)
    return c


def git_commit(klipper):
    return subprocess.check_output(["git", "-C", klipper, "rev-parse", "HEAD"], text=True).strip()


def existing_boards():
    out = {}
    for f in os.listdir(os.path.join(DATA, "mainboards")):
        text = open(os.path.join(DATA, "mainboards", f)).read()
        if text.startswith("# Imported from Klipper"):
            continue  # only hand-curated boards can be reused
        b = yaml.safe_load(text)
        out[b["id"]] = b
    return out


def signature(b):
    """Everything a stock config relies on: every motor, driver, heater, sensor, fan and endstop pin."""
    bare = lambda p: split_pin(p or "")[1]
    slots = tuple(sorted((s["step_pin"], bare(s["dir_pin"]), s["enable_pin"], (s.get("onboard_driver") or {}).get("chip"),
                          s.get("uart_pin"), s.get("uart_address"), s.get("spi_cs_pin")) for s in b["driver_slots"]))
    return (slots,
            tuple(sorted(h.get("pin") or ",".join(h["pins"]) for h in b.get("heaters", []))),
            tuple(sorted(t["pin"] for t in b.get("thermistors", []))),
            tuple(sorted(f.get("pin") or ",".join(f["pins"]) for f in b.get("fans", []))),
            tuple(sorted((e["pin"], e.get("modifier", "^")) for e in b.get("endstops", []))))


def covers(curated, draft):
    """A hand-curated board can stand in for a draft when every pin the draft uses is on it, the same way."""
    c, d = signature(curated), signature(draft)
    return (c[0] == d[0] and c[1] == d[1] and set(d[2]) <= set(c[2]) and set(d[3]) <= set(c[3])
            and all(e in c[4] for e in d[4]))


def importer(klipper, name, commit, boards):
    path = os.path.join(klipper, "config", f"printer-{name}.cfg")
    text = open(path, errors="replace").read()
    S, order, header = parse_cfg(text)
    al = aliases_of(S)
    meta = NAMES[name]
    if meta.get("skip"):
        raise SystemExit(f"{name}: {meta['skip']}")
    pid = meta["id"]
    src = {"repo": "https://github.com/Klipper3d/klipper", "path": f"config/printer-{name}.cfg", "commit": commit}
    kin = S.get("printer", {}).get("kinematics", "cartesian")
    delta = kin == "delta"
    if kin not in ("cartesian", "corexy", "delta"):
        raise SystemExit(f"{name}: kinematics {kin} not supported yet")
    if any(re.match(r"extruder\d+$", s) for s in S):
        raise SystemExit(f"{name}: more than one extruder not supported yet")

    chip, boot, comm, mhz, flash = header_info([l.lstrip("#").strip() for l in header])
    mcu_chip = chip_id(chip)
    if not mcu_chip:
        raise SystemExit(f"{name}: no MCU named in the header comment")
    avr = mcu_chip.startswith(("atmega", "at90"))

    # --- driver slots -------------------------------------------------------------
    slots, steppers, roles = [], [], []
    tmc_of = {}
    for sec_name, sec in S.items():
        m = re.match(r"(tmc\d+) (\S+)$", sec_name)
        if m:
            tmc_of[m.group(2)] = (m.group(1), sec)
    stepper_names = [s for s in order if re.match(r"stepper_([xyz]\d*|[abc])$", s)] + ["extruder"]
    corexy = kin == "corexy"
    xy_role = {"stepper_a": "A", "stepper_b": "B", "stepper_c": "C"} if delta else {"stepper_x": "B" if corexy else "X", "stepper_y": "A" if corexy else "Y"}
    for sn in stepper_names:
        sec = S[sn]
        sid = {"stepper_x": "X", "stepper_y": "Y", "stepper_z": "Z", "extruder": "E"}.get(sn, sn.replace("stepper_", "").upper())
        step = resolve(sec["step_pin"], al)
        dmods, dpin = split_pin(resolve(sec["dir_pin"], al))
        slot = {"id": sid, "step_pin": step, "dir_pin": dpin, "enable_pin": resolve(sec.get("enable_pin", ""), al)}
        if sn in tmc_of:
            chipname, t = tmc_of[sn]
            od = {"chip": chipname, "klipper_section": chipname}
            if num(t.get("sense_resistor")):
                od["sense_resistor"] = num(t["sense_resistor"])
            slot["onboard_driver"] = od
            if t.get("uart_pin"):
                slot["uart_pin"] = resolve(t["uart_pin"], al)
            if t.get("tx_pin"):
                slot["tx_pin"] = resolve(t["tx_pin"], al)
            if t.get("uart_address") is not None:
                slot["uart_address"] = num(t["uart_address"])
            if t.get("cs_pin"):
                slot["spi_cs_pin"] = resolve(t["cs_pin"], al)
                if t.get("spi_bus"):
                    slot["spi_bus"] = t["spi_bus"]
                elif t.get("spi_software_sclk_pin"):
                    slot["spi_software"] = {k: resolve(t[f"spi_software_{k}"], al) for k in ("sclk_pin", "mosi_pin", "miso_pin")}
            for key in ("diag_pin", "diag0_pin", "diag1_pin"):
                if t.get(key):
                    m2, p2 = split_pin(resolve(t[key], al))
                    slot.update(diag_pin=p2, diag_pin_key=key, diag_modifier=m2)
        else:
            slot["onboard_driver"] = {"chip": None, "standalone": True, "microsteps": num(sec.get("microsteps")) or 16,
                                      "note": "No TMC section in Klipper's config: Klipper does not set this driver's current."}
        slots.append(slot)
        if sn == "extruder":
            continue
        role = xy_role.get(sn) or ("Z" + (sn[9:] or "0"))
        stp = {"klipper": sn, "role": role, "rotation_distance": num(sec.get("rotation_distance"))}
        if sec.get("gear_ratio"):
            stp["gear_ratio"] = sec["gear_ratio"]
        if dmods.count("!") % 2:
            stp["dir_inverted"] = True
        steppers.append(stp)

    # --- endstops, homing ---------------------------------------------------------
    endstops = []
    axes, homing_xy, homing_z = {}, "physical", "physical_min"
    for sn, axis in ((("stepper_a", "a"), ("stepper_b", "b"), ("stepper_c", "c")) if delta else (("stepper_x", "x"), ("stepper_y", "y"), ("stepper_z", "z"))):
        sec = S.get(sn, {})
        ep = resolve(sec.get("endstop_pin", ""), al)
        if not ep:
            continue
        if "virtual_endstop" in ep:
            if ep.startswith("probe:"):
                homing_z = "probe_virtual_endstop"
            else:
                homing_xy = "sensorless"
            continue
        mods, pin = split_pin(ep)
        endstops.append({"id": f"{axis.upper()}-STOP", "pin": pin, "modifier": mods})
    def axis_cfg(sec):
        pmax, pend = num(sec.get("position_max")), num(sec.get("position_endstop"))
        pmin = num(sec.get("position_min")) if sec.get("position_min") else 0
        out = {}
        at_max = pend is not None and pmax is not None and pend >= pmax
        out["endstop_at_max"] = at_max
        # Klipper (stepper.py): with no homing_positive_dir, an endstop in the top quarter of the
        # travel homes toward max, in the bottom quarter toward min.
        positive = pend is not None and pmax is not None and pend >= pmax - (pmax - pmin) / 4.0
        out["homing_positive_dir"] = sec.get("homing_positive_dir", "true" if positive else "false").lower() == "true"
        if not at_max:
            out["position_endstop"] = pend if pend is not None else 0
        out["position_min"] = pmin if sec.get("position_min") else (min(0, pend) if pend is not None else 0)
        if sec.get("homing_speed"):
            out["homing_speed"] = num(sec["homing_speed"])
        if sec.get("homing_retract_dist"):
            out["homing_retract_dist"] = num(sec["homing_retract_dist"])
        return out
    axes = {} if delta else {"x": axis_cfg(S["stepper_x"]), "y": axis_cfg(S["stepper_y"])}
    zsec = S["stepper_a"] if delta else S["stepper_z"]
    zmax, zend = num(zsec.get("position_max")), num(zsec.get("position_endstop"))
    if delta:
        homing_z, zmax = "physical_max", zend
    elif homing_z != "probe_virtual_endstop" and zend is not None and zmax is not None and zend >= zmax:
        homing_z = "physical_max"

    # --- heaters, sensors, fans ---------------------------------------------------
    ex, bed = S["extruder"], S.get("heater_bed", {})
    custom = {}
    for sec_name, sec in S.items():
        m = re.match(r"thermistor (\S+)$", sec_name)
        if m:
            custom[m.group(1)] = {k: num(v) if num(v) is not None else v for k, v in sec.items()}
    def therm_id(sensor_type):
        st = sensor_type.split("#")[0].strip()
        if st in THERMISTORS:
            return THERMISTORS[st], None
        if st in custom:
            tid = f"{pid}-{st.lower().replace('_', '-')}"
            return tid, {"id": tid, "max_temp_c": None, "label": f"{meta['name']} stock thermistor ({st})", "sensor_type": f"{pid.replace('-', '_')}_{st}".lower(),
                         "custom_definition_required": True, "definition": custom[st], "applies_to": [pid],
                         "sources": [src], "note": f"Defined in Klipper's {meta['name']} config as [thermistor {st}]."}
        raise SystemExit(f"{name}: unknown sensor_type {st!r}")
    therms = []
    multi = {n.split(" ", 1)[1]: [resolve(x.strip(), al) for x in sec["pins"].split(",")] for n, sec in S.items() if n.startswith("multi_pin ")}
    def out_pin(raw):
        """A pin, or the pins of the [multi_pin] it names (Geeetech 301: heater on three outputs)."""
        raw = resolve(raw, al)
        return ("pins", multi[raw.split(":", 1)[1]]) if raw.startswith("multi_pin:") else ("pin", raw)
    k, v = out_pin(ex["heater_pin"])
    heaters = [{"id": "HEATER", k: v, "role": "hotend"}]
    if bed.get("heater_pin"):
        heaters.append({"id": "BED", "pin": resolve(bed["heater_pin"], al), "role": "bed"})
    def therm_port(id_, sec, use):
        t = {"id": id_, "pin": resolve(sec["sensor_pin"], al), "typical_use": use}
        if num(sec.get("pullup_resistor")):
            t["pullup_ohms"] = num(sec["pullup_resistor"])
        return t
    thermistor_ports = [therm_port("TH0", ex, "hotend")]
    if bed.get("sensor_pin"):
        thermistor_ports.append(therm_port("TB", bed, "bed"))
    hot_t, hot_custom = therm_id(ex["sensor_type"])
    bed_t, bed_custom = therm_id(bed.get("sensor_type", ex["sensor_type"]))
    for c in (hot_custom, bed_custom):
        if c and c["id"] not in [x["id"] for x in therms]:
            therms.append(c)

    fans, stock_fans = [], []
    hotend_fan = "always_on"
    for sec_name in order:
        sec = S[sec_name]
        kind = sec_name.split(" ")[0]
        if kind not in ("fan", "heater_fan", "controller_fan", "fan_generic") or "pin" not in sec:
            continue
        if kind == "heater_fan" and sec.get("heater", "extruder") != "extruder":
            role = None
        else:
            role = {"fan": "part_cooling", "heater_fan": "hotend", "controller_fan": "controller"}.get(kind)
        k, v = out_pin(sec["pin"])
        if k == "pins":
            port = {"id": f"FAN{len(fans)}", "pins": v}
        else:
            mods, pin = split_pin(v)
            port = {"id": f"FAN{len(fans)}", "pin": mods + pin}
        if role:
            port["typical_use"] = role
            if role not in stock_fans:
                stock_fans.append(role)
        if sec.get("tachometer_pin"):
            port["tachometer_pin"] = resolve(sec["tachometer_pin"], al)
        fans.append(port)
        if role == "hotend":
            hotend_fan = None

    # --- probe --------------------------------------------------------------------
    probe_ports, bltouch, stock_probe, probe_rec, probe_offset = [], None, None, None, None
    if "bltouch" in S:
        b = S["bltouch"]
        bltouch = {"sensor_pin": split_pin(resolve(b["sensor_pin"], al))[1], "control_pin": resolve(b["control_pin"], al)}
        stock_probe = "bltouch"
        probe_offset = {"x": num(b.get("x_offset", 0)), "y": num(b.get("y_offset", 0))}
    elif "probe" in S:
        p = S["probe"]
        mods, pin = split_pin(resolve(p["pin"], al))
        probe_ports.append({"id": "PROBE", "pin": pin, "modifier": mods})
        stock_probe = f"{pid}-probe"
        defaults = {"x_offset": num(p.get("x_offset", 0)), "y_offset": num(p.get("y_offset", 0)), "z_offset": 0}
        for k in ("speed", "samples", "samples_result", "sample_retract_dist", "samples_tolerance", "samples_tolerance_retries", "lift_speed"):
            if p.get(k) is not None:
                defaults[k] = num(p[k]) if num(p[k]) is not None else p[k]
        probe_rec = {"id": stock_probe, "name": f"{meta['name']} built-in probe", "kind": "integrated", "applies_to": [pid],
                     "z_endstop_capable": homing_z == "probe_virtual_endstop", "defaults": defaults, "sources": [src]}
    if homing_z == "probe_virtual_endstop" and not stock_probe:
        raise SystemExit(f"{name}: homes Z with a probe but has no probe section")

    # --- display ------------------------------------------------------------------
    display = None
    if "display" in S:
        d = S["display"]
        display = {k: resolve(v, al) if k.endswith("_pin") else (", ".join(resolve(x.strip(), al) for x in v.split(",")) if k.endswith("_pins") else v) for k, v in d.items()}
        for k in list(display):
            if num(display[k]) is not None:
                display[k] = num(display[k])

    # --- board record -------------------------------------------------------------
    board_id = f"{pid}-board"
    serial = S.get("mcu", {}).get("serial", "")
    usb_serial = avr or "1a86" in serial or "ttyUSB" in serial or (comm or "").lower().startswith("serial")
    mcu = {"chip": mcu_chip}
    if avr:
        mcu.update(arch="avr", cpu_mhz=mhz or 16)
    else:
        mcu.update(crystal_mhz=8, bootloader_kib=boot if boot is not None else 0)
        # Klipper check: a dictionary built the way this firmware is (serial boards keep PA11/PA12 free).
        if mcu_chip.startswith(("stm32", "gd32")) and usb_serial:
            u = re.search(r"usart\s*(\d)", f"{comm} {flash}", re.I)
            n = u.group(1) if u else "1"  # Klipper's STM32 serial default is USART1
            chip = "stm32f103" if mcu_chip == "gd32f103" else mcu_chip
            mcu["check_dict"] = "stm32f103-serial" if (chip, n) == ("stm32f103", "1") else f"{chip}-usart{n}"
        if mcu_chip == "hc32f460" and not (comm and "pa3" in comm.lower()):
            mcu["check_dict"] = "hc32f460-serial-PA7PA8"
            comm = comm or "Serial (PA7 & PA8): Klipper's menuconfig default for the HC32F460 (the source does not say which)"
        if mcu_chip.startswith("gd32f1"):
            mcu.update(chip="gd32f103", build_as="stm32f103", menuconfig_extra=["Disable SWD at startup"])
    board = {
        "schema": "mainboard/1", "id": board_id, "name": f"{meta['name']} mainboard", "manufacturer": meta["maker"],
        "revisions": ["stock"], "status": "needs-review", "stock_only": True, "mcu_variants": [mcu],
        "interfaces": ["usb-serial" if usb_serial else "usb"],
    }
    if usb_serial and "/dev/serial/by-id/" in serial:
        board["usb_serial"] = {"chip": "CH340" if "1a86" in serial else "USB-serial", "serial_path": serial}
    fw = {}
    if comm:
        fw["interface"] = comm[0].upper() + comm[1:]
    elif avr:
        fw["interface"] = "Serial (UART0), 250000 baud (Klipper's AVR default)"
    if flash:
        fw["flash"] = flash
    if fw:
        board["firmware"] = fw
    if any(s.get("spi_cs_pin") and not s.get("spi_bus") and not s.get("spi_software") for s in slots):
        board["tmc_spi"] = {"default": True}  # Klipper's config names no spi_bus: the MCU's default bus
    board.update({"driver_mount": "onboard", "driver_slots": slots, "endstops": endstops, "heaters": heaters,
                  "thermistors": thermistor_ports, "fans": fans, "probe_ports": probe_ports})
    if bltouch:
        board["bltouch"] = bltouch
    standalone = all(s["onboard_driver"].get("standalone") for s in slots)
    board["notes"] = ([] if not standalone else ["The motor drivers on this board can't be adjusted from Klipper. Motor current is set on the board, and sensorless homing (homing without switches) isn't possible."])
    board["unverified"] = ["Only one source (Klipper's reference config for this printer). Check the pins against your board before powering on.",
                           "Thermistor pull-ups not given in the source use Klipper's default (4.7k).",
                           *([] if avr else ["crystal_mhz 8 is Klipper's default; the source does not state it."])]
    board["sources"] = [src]
    # Reuse a curated board only when the source names it (pin-compatible boards with another
    # or no stated name, e.g. the Aquila's FFP0173, keep their own record so the name is right).
    htxt = " ".join(header).lower()
    match = next((b["id"] for b in boards.values() if covers(b, board)
                  and any(r.lower().lstrip("v") in htxt for r in b.get("revisions", []))), None)

    # --- printer record -----------------------------------------------------------
    pr = S.get("printer", {})
    dgeom = None
    if delta:
        # Klipper: print_radius defaults to delta_radius; tower angles default to 210/330/90.
        dr = num(pr.get("delta_radius"))
        prad = num(pr.get("print_radius")) or dr
        dc = S.get("delta_calibrate", {})
        dgeom = {"delta_radius": dr, "print_radius": prad, "arm_length": num(S["stepper_a"].get("arm_length")),
                 "position_endstop": num(S["stepper_a"].get("position_endstop"))}
        if pr.get("minimum_z_position"):
            dgeom["minimum_z_position"] = num(pr["minimum_z_position"])
        angles = {sn: num(S[sn]["angle"]) for sn in ("stepper_a", "stepper_b", "stepper_c") if S[sn].get("angle")}
        if angles:
            dgeom["tower_angles"] = angles
        dgeom["calibrate_radius"] = num(dc.get("radius")) or round(prad * 0.8)
        if dc.get("horizontal_move_z"):
            dgeom["calibrate_horizontal_move_z"] = num(dc["horizontal_move_z"])
        if dc.get("speed"):
            dgeom["calibrate_speed"] = num(dc["speed"])
        pmax = {"x": prad, "y": prad, "z": dgeom["position_endstop"]}
        size = {"id": "stock", "bed_radius": prad, "bed_mm": [prad * 2, prad * 2], "position_max": pmax}
    else:
        pmax = {"x": num(S["stepper_x"].get("position_max")), "y": num(S["stepper_y"].get("position_max")), "z": zmax}
        size = {"id": "stock", "bed_mm": [pmax["x"], pmax["y"]], "position_max": pmax}
    if "bed_screws" in S:
        screws = [S["bed_screws"][k] for k in sorted(S["bed_screws"], key=lambda k: int(re.sub(r"\D", "", k) or 0)) if re.match(r"screw\d+$", k)]
        size["bed_screws"] = [[num(x) for x in s.split(",")] for s in screws]
    tmc_slots = [s for s in slots if not s["onboard_driver"].get("standalone")]
    def run_current(sn, default):
        t = tmc_of.get(sn)
        return num(t[1].get("run_current")) if t and num(t[1].get("run_current")) else default
    xsec = S["stepper_a"] if delta else S["stepper_x"]
    xy0 = {"microsteps": num(xsec.get("microsteps")) or 16, "full_steps_per_rotation": 200,
           "homing_speed": num(xsec.get("homing_speed")) or 50, "homing_retract_dist": num(xsec.get("homing_retract_dist")) or 5,
           **({"second_homing_speed": num(xsec.get("second_homing_speed")) or (num(xsec.get("homing_speed")) or 50) / 2} if delta else {}),
           "homing_positive_dir": False, "position_min": 0, "endstop_at_max": False, "position_endstop": 0,
           "run_current": run_current("stepper_a" if delta else "stepper_x", 0.58)}
    defaults = {
        "printer": {k: num(pr[k]) for k in ("max_velocity", "max_accel", "max_z_velocity", "max_z_accel", "square_corner_velocity") if pr.get(k)},
        "stepper_xy": xy0, "axes": axes,
        "stepper_z": {"microsteps": num(zsec.get("microsteps")) or 16, "position_endstop": zend if zend is not None else 0,
                      "position_min": num(zsec.get("position_min")) if zsec.get("position_min") else 0,
                      "homing_speed": num(zsec.get("homing_speed")) or 5, "second_homing_speed": num(zsec.get("second_homing_speed")) or (num(zsec.get("homing_speed")) or 5) / 2,
                      "homing_retract_dist": num(zsec.get("homing_retract_dist")) or 5, "run_current": run_current("stepper_z", 0.58)},
        "tmc": {"interpolate": False, "stealthchop_threshold": 0},
        "extruder": {"run_current": run_current("extruder", 0.5)},
        "bed": {"max_power": num(bed.get("max_power")) or 1.0, "max_temp": num(bed.get("max_temp")) or 100},
        "safe_z_home": {"home_xy_position": "user", "speed": 100, "z_hop": 10},
        "idle_timeout": 1800,
    }
    if bed.get("pid_kp") and bed.get("pid_ki") and bed.get("pid_kd"):
        defaults["bed"]["pid"] = {"pid_kp": num(bed["pid_kp"]), "pid_ki": num(bed["pid_ki"]), "pid_kd": num(bed["pid_kd"])}
    thr = {sn: num(t.get("driver_sgthrs") or t.get("driver_sgt")) for sn, (_, t) in tmc_of.items() if (t.get("driver_sgthrs") or t.get("driver_sgt")) and sn in ("stepper_x", "stepper_y")}
    if thr:
        defaults["sensorless_thresholds"] = thr
    ext = {"id": f"{pid}-extruder", "name": f"{meta['name']} stock extruder", "drive": "unknown",
           "rotation_distance": num(ex["rotation_distance"]), "microsteps": num(ex.get("microsteps")) or 16, "full_steps_per_rotation": 200,
           "pa_baseline": {"start": 0, "range": [0, 1]}, "confidence": "medium", "applies_to": [pid], "sources": [src],
           "unverified": ["Klipper's config does not say whether this is a direct-drive or Bowden extruder, so pressure advance starts at 0: tune it (TUNE_PA)."]}
    if ex.get("gear_ratio"):
        ext["gear_ratio"] = ex["gear_ratio"]
    if split_pin(resolve(ex["dir_pin"], al))[0].count("!") % 2:
        ext["dir_inverted"] = True
    hot = {"id": f"{pid}-hotend", "name": f"{meta['name']} stock hotend", "maker": meta["maker"], "flow_class": "standard",
           "max_temp": num(ex.get("max_temp")) or 250, "max_temp_basis": "hotend", "includes": {"heater": True, "thermistor": True},
           "common_thermistor": hot_t, "applies_to": [pid], "sources": [dict(src, note=f"[extruder] max_temp: {ex.get('max_temp')}")]}
    if ex.get("pid_kp") and ex.get("pid_ki") and ex.get("pid_kd"):
        hot["pid_seed"] = {"pid_kp": num(ex["pid_kp"]), "pid_ki": num(ex["pid_ki"]), "pid_kd": num(ex["pid_kd"])}
    stock = {"mainboards": [match or board_id], "toolhead": None, "extruder": ext["id"], "hotend": hot["id"],
             "thermistors": {"hotend": hot_t, "bed": bed_t}, "probe_options": [stock_probe] if stock_probe else [],
             "homing_xy": homing_xy, "homing_z": homing_z, "fans": stock_fans or ["part_cooling"]}
    if stock_probe:
        stock["probe"] = stock_probe
        if probe_offset:
            stock["probe_offsets"] = {stock_probe: probe_offset}
    if display:
        stock["display"] = display
    zcount = sum(1 for s in steppers if s["role"].startswith("Z"))
    printer = {
        "schema": "printer/1", "id": pid, "name": meta["name"], "manufacturer": meta["maker"], "status": "needs-review",
        "docs": [{"title": f"Klipper: {meta['name']} reference config", "url": f"https://github.com/Klipper3d/klipper/blob/master/config/printer-{name}.cfg"},
                 {"title": "Klipper: configuration checks (first power-on)", "url": "https://www.klipper3d.org/Config_checks.html"}],
        "kinematics": kin, "z_leveling": None, "bed_heater": "unknown",
    }
    if dgeom:
        printer["delta"] = dgeom
    if "heater_bed" not in S:
        printer["heated_bed"] = False
    if hotend_fan:
        printer["hotend_fan"] = hotend_fan
    if dgeom and not S.get("delta_calibrate", {}).get("radius"):
        printer["unverified"] = [f"Klipper's config has no [delta_calibrate] radius; {dgeom['calibrate_radius']} (80% of the print radius) is used. Keep it inside the area the probe or nozzle can reach."]
    printer.update({
        "imported_from": src,
        "sizes": [size], "steppers": steppers,
        "variants": [{"id": "standard", "name": "Stock", "drivers_required": {"motion": len(steppers), "extruder": 1}}],
        "defaults": defaults, "stock": stock,
        "stock_parts": {"extruders": [ext], "hotends": [hot], "probes": [probe_rec] if probe_rec else [], "thermistors": therms},
        "notes": [n for n in [
            "Made from Klipper's reference config for this printer. Check the pins against your printer before powering on, and run PREFLIGHT first." ,
            "The stock motor drivers can't be adjusted from Klipper, so the motor current settings and sensorless homing don't apply." if standalone else None,
            "Both Z motors run from separate drivers but nothing levels them automatically; if the X axis is tilted, level it by hand." if zcount > 1 else None,
            "This printer has no heated bed, so the bed settings are left out and print start ignores the bed temperature." if "heater_bed" not in S else None,
            "A delta printer: before the first print, run CALIBRATE_DELTA (it measures the printer's geometry), then SAVE_CONFIG." if delta else None,
        ] if n],
        "sources": [src],
    })
    if match:
        printer["tech_notes"] = [f"Pins match the existing board record {match}."]
    return printer, (None if match else board)


class Dumper(yaml.SafeDumper):
    def ignore_aliases(self, data):
        return True


def _none(d, _):
    return d.represent_scalar("tag:yaml.org,2002:null", "null")


Dumper.add_representer(type(None), _none)


def main():
    klipper = sys.argv[1]
    commit = git_commit(klipper)
    boards = existing_boards()
    for name in sys.argv[2:]:
        try:
            printer, board = importer(klipper, name, commit, boards)
        except SystemExit as e:
            print(f"SKIP {e}")
            continue
        pfile = os.path.join(DATA, "printers", f"{printer['id']}.yaml")
        with open(pfile, "w") as f:
            f.write(f"# Imported from Klipper's config/printer-{name}.cfg by tools/import_klipper_printer.py (only source: needs review).\n")
            yaml.dump(printer, f, Dumper=Dumper, sort_keys=False, allow_unicode=True, width=120, default_flow_style=None)
        msg = f"OK   {name} -> {printer['id']}"
        if board:
            with open(os.path.join(DATA, "mainboards", f"{board['id']}.yaml"), "w") as f:
                f.write(f"# Imported from Klipper's config/printer-{name}.cfg by tools/import_klipper_printer.py.\n")
                yaml.dump(board, f, Dumper=Dumper, sort_keys=False, allow_unicode=True, width=120, default_flow_style=None)
            msg += f" + {board['id']}"
        else:
            msg += f" (board {printer['stock']['mainboards'][0]})"
        print(msg)


if __name__ == "__main__":
    main()
