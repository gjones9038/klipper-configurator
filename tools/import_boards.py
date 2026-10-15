"""Initial import: vendor/Klipper sample configs + hand-written overlays
-> curated data/mainboards/*.yaml and data/toolboards/*.yaml.

The YAML files are the source of truth and get edited by hand afterwards.
Re-running this overwrites them, so use it only to (re)import a board.

Usage: import_boards.py <dir with cloned source repos>
  (expects klipper/, Voron-2/, EBB/, Leviathan/ ... as listed in REPO_URL)
"""
import re
import subprocess
import sys
from pathlib import Path

import yaml

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src")
OUT = Path(__file__).resolve().parent.parent / "data"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from draft_board import draft  # noqa: E402


def commit(repo):
    return subprocess.check_output(["git", "-C", str(SRC / repo), "rev-parse", "HEAD"],
                                   text=True).strip()


REPO_URL = {
    "klipper": "https://github.com/Klipper3d/klipper",
    "Voron-2": "https://github.com/VoronDesign/Voron-2",
    "Voron-Trident": "https://github.com/VoronDesign/Voron-Trident",
    "EBB": "https://github.com/bigtreetech/EBB",
    "BIGTREETECH-OCTOPUS-V1.0": "https://github.com/bigtreetech/BIGTREETECH-OCTOPUS-V1.0",
    "Manta-M8P": "https://github.com/bigtreetech/Manta-M8P",
    "BIGTREETECH-Kraken": "https://github.com/bigtreetech/BIGTREETECH-Kraken",
    "Octopus-Max-EZ": "https://github.com/bigtreetech/Octopus-Max-EZ",
    "SKR-3": "https://github.com/bigtreetech/SKR-3",
    "Leviathan": "https://github.com/MotorDynamicsLab/Leviathan",
    "Nitehawk-SB": "https://github.com/MotorDynamicsLab/Nitehawk-SB",
    "Nitehawk-36": "https://github.com/MotorDynamicsLab/Nitehawk-36",
    "FYSETC-SPIDER": "https://github.com/FYSETC/FYSETC-SPIDER",
}


def source(path):
    repo, rel = path.split("/", 1)
    return {"repo": REPO_URL[repo], "path": rel, "commit": commit(repo)}


def strip_mcu(pin):
    """'EBBCan: PD0' / '!EBBCan:PD0' / 'nhk:gpio23' -> 'PD0' / '!PD0' / 'gpio23'."""
    if pin is None:
        return None
    m = re.match(r"^([!^~]*)\s*(?:[A-Za-z0-9_]+:\s*)?(\S+)$", pin.strip())
    return m.group(1) + m.group(2)


def phys(pin):
    return strip_mcu(pin).lstrip("!^~") if pin else None


# ---------------------------------------------------------------------------
# Mainboards
# ---------------------------------------------------------------------------

STEPSTICK_DRIVERS = ["tmc2209", "tmc2226", "tmc2208", "tmc2130", "tmc5160", "tmc2240"]

MAINBOARDS = [
    dict(
        id="btt-octopus-v1.1", name="BIGTREETECH Octopus", revisions=["1.0", "1.1"],
        draft="klipper/config/generic-bigtreetech-octopus-v1.1.cfg",
        extra_sources=["Voron-2/firmware/klipper_configurations/Octopus/Voron2_Octopus_Config.cfg",
                       "BIGTREETECH-OCTOPUS-V1.0/Firmware/Klipper/README.md"],
        status="reviewed",
        mcu=[dict(chip="stm32f446", crystal_mhz=12, bootloader_kib=32),
             dict(chip="stm32f429", crystal_mhz=8, bootloader_kib=32),
             dict(chip="stm32f407", crystal_mhz=8, bootloader_kib=32)],
        interfaces=["usb", "can", "usb-can-bridge"],
        slot_ids=[f"MOTOR_{i}" for i in range(8)],
        driver_mount="stepstick",
        endstops=[("DIAG_0", "PG6", "MOTOR_0"), ("DIAG_1", "PG9", "MOTOR_1"),
                  ("DIAG_2", "PG10", "MOTOR_2"), ("DIAG_3", "PG11", "MOTOR_3"),
                  ("DIAG_4", "PG12", None), ("DIAG_5", "PG13", None),
                  ("DIAG_6", "PG14", None), ("DIAG_7", "PG15", None)],
        probe=[dict(id="PROBE", pin="PB7", modifier="~!",
                    note="Voron: may need a pull-up to 24V for inductive probes; "
                         "alternatively use DIAG_7 (PG15) with a BAT85 diode.")],
        thermistor_pullup=4700,
        fan_meta=dict(wires=2),
        extras=dict(caselight_pin="PB10"),
        notes=["Driver SPI/UART mode is set with jumpers under each stepstick; see the "
               "board manual for jumper positions.",
               "DIAG jumpers must be removed under a driver if its DIAG header is used as "
               "a physical endstop (DIAG pin is shared)."],
        unverified=["DIAG_4..7 <-> MOTOR_4..7 diag link"],
    ),
    dict(
        id="btt-octopus-pro-v1.0", name="BIGTREETECH Octopus Pro", revisions=["1.0"],
        draft="klipper/config/generic-bigtreetech-octopus-pro-v1.0.cfg",
        extra_sources=["Voron-2/firmware/klipper_configurations/Octopus/Voron2_Octopus_Config.cfg"],
        status="reviewed",
        mcu=[dict(chip="stm32f446", crystal_mhz=12, bootloader_kib=32),
             dict(chip="stm32f429", crystal_mhz=8, bootloader_kib=32),
             dict(chip="stm32h723", crystal_mhz=25, bootloader_kib=128)],
        interfaces=["usb", "can", "usb-can-bridge"],
        slot_ids=[f"MOTOR_{i}" for i in range(8)],
        driver_mount="stepstick",
        endstops=[("DIAG_0", "PG6", "MOTOR_0"), ("DIAG_1", "PG9", "MOTOR_1"),
                  ("DIAG_2", "PG10", "MOTOR_2"), ("DIAG_3", "PG11", "MOTOR_3"),
                  ("DIAG_4", "PG12", None), ("DIAG_5", "PG13", None),
                  ("DIAG_6", "PG14", None), ("DIAG_7", "PG15", None)],
        probe=[dict(id="PROBE", pin="PC5", modifier="~!", pnp_capable=True, protected=True,
                    note="Voron: Octopus Pro PROBE port; NPN and PNP proximity switch types can be set by jumper.")],
        thermistor_pullup=4700,
        fan_meta=dict(wires=2),
        extras=dict(caselight_pin="PB10"),
        notes=["Do NOT use the Octopus Pro v1.1 pin map on this board: HE0/HE2 and the "
               "MOTOR_3 enable pin differ and a heater could be switched on unintentionally."],
        unverified=["HV motor power input rating"],
    ),
    dict(
        id="btt-octopus-pro-v1.1", name="BIGTREETECH Octopus Pro", revisions=["1.1"],
        draft="klipper/config/generic-bigtreetech-octopus-pro-v1.1.cfg",
        extra_sources=["Voron-2/firmware/klipper_configurations/Octopus/Voron2_Octopus_Config.cfg",
                       "BIGTREETECH-OCTOPUS-V1.0/Firmware/Klipper/generic-bigtreetech-octopus-pro-v1.1.cfg"],
        status="reviewed",
        mcu=[dict(chip="stm32h723", crystal_mhz=25, bootloader_kib=128)],
        interfaces=["usb", "can", "usb-can-bridge"],
        slot_ids=[f"MOTOR_{i}" for i in range(8)],
        driver_mount="stepstick",
        endstops=[("DIAG_0", "PG6", "MOTOR_0"), ("DIAG_1", "PG9", "MOTOR_1"),
                  ("DIAG_2", "PG10", "MOTOR_2"), ("DIAG_3", "PG11", "MOTOR_3"),
                  ("DIAG_4", "PG12", None), ("DIAG_5", "PG13", None),
                  ("DIAG_6", "PG14", None), ("DIAG_7", "PG15", None)],
        probe=[dict(id="PROBE", pin="PC5", modifier="~!", pnp_capable=True, protected=True,
                    note="Voron: Octopus Pro PROBE port; NPN and PNP proximity switch types can be set by jumper.")],
        thermistor_pullup=4700,
        fan_meta=dict(wires=2),
        extras=dict(caselight_pin="PB0"),
        notes=["HE0 is PA0 and HE2 is PB0 on v1.1 (swapped vs v1.0); MOTOR_3 enable is PA2."],
        unverified=["HV motor power input rating"],
    ),
    dict(
        id="btt-manta-m8p-v1.0", name="BIGTREETECH Manta M8P", revisions=["1.0"],
        draft="klipper/config/generic-bigtreetech-manta-m8p-v1.0.cfg",
        extra_sources=["Voron-2/firmware/klipper_configurations/M8P/Voron2_M8P-v1.0_config.cfg"],
        status="reviewed",
        mcu=[dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=8)],
        interfaces=["usb"],
        host_socket=["cb1", "cm4"],
        slot_ids=[f"M{i}" for i in range(1, 9)],
        driver_mount="stepstick",
        endstops=[("M1-STOP", "PF3", "M1"), ("M2-STOP", "PF4", "M2"),
                  ("M3-STOP", "PF5", "M3"), ("M4-STOP", "PC0", "M4")],
        thermistor_pullup=4700,
        fan_meta=dict(wires=2),
        notes=["Host (CB1/CM4) mounts on the board; the MCU is reached over internal USB."],
        unverified=["4-wire fan ports"],
    ),
    dict(
        id="btt-manta-m8p-v1.1", name="BIGTREETECH Manta M8P", revisions=["1.1"],
        draft="klipper/config/generic-bigtreetech-manta-m8p-v1.1.cfg",
        extra_sources=["Voron-2/firmware/klipper_configurations/M8P/Voron2_M8P-v1.1_config.cfg"],
        status="reviewed",
        mcu=[dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=8)],
        interfaces=["usb", "can"],
        can_pins="PD12/PD13",
        host_socket=["cb1", "cm4"],
        slot_ids=[f"M{i}" for i in range(1, 9)],
        driver_mount="stepstick",
        endstops=[("M1-STOP", "PF3", "M1"), ("M2-STOP", "PF4", "M2"),
                  ("M3-STOP", "PF5", "M3"), ("M4-STOP", "PC0", "M4")],
        thermistor_pullup=4700,
        fan_meta=dict(wires=2, four_wire=["FAN5", "FAN6"]),
        notes=["M6-M8 pins and FAN4 tach differ from v1.0 - do not mix the two pin maps."],
        unverified=None,
    ),
    dict(
        id="btt-manta-m8p-v2.0", name="BIGTREETECH Manta M8P", revisions=["2.0"],
        draft="Manta-M8P/V2.0/Firmware/generic-bigtreetech-manta-m8p-V2_0.cfg",
        extra_sources=["Voron-2/firmware/klipper_configurations/M8P/Voron2_M8P-v2.0_config.cfg"],
        status="reviewed",
        mcu=[dict(chip="stm32h723", crystal_mhz=25, bootloader_kib=128)],
        interfaces=["usb", "can", "uart"],
        can_pins="PD0/PD1",
        host_socket=["cb1", "cm4", "cb2"],
        slot_ids=[f"M{i}" for i in range(1, 9)],
        driver_mount="stepstick",
        endstops=[("M1-STOP", "PF4", "M1"), ("M2-STOP", "PF3", "M2"),
                  ("M3-STOP", "PF2", "M3"), ("M4-STOP", "PF1", "M4")],
        thermistor_pullup=4700,
        fan_meta=dict(wires=2, four_wire=["FAN5", "FAN6"]),
        notes=["TMC SPI is software SPI on PG6 (MOSI) / PG7 (MISO) / PG8 (SCK)."],
        unverified=None,
    ),
    dict(
        id="btt-octopus-max-ez-v1.0", name="BIGTREETECH Octopus Max EZ", revisions=["1.0"],
        draft="Octopus-Max-EZ/Firmware/Klipper/generic-bigtreetech-octopus-max-ez.cfg",
        extra_sources=["klipper/config/generic-bigtreetech-octopus-max-ez.cfg",
                       "Octopus-Max-EZ/README.md"],
        status="needs-review",
        mcu=[dict(chip="stm32h723", crystal_mhz=25, bootloader_kib=128)],
        interfaces=["usb", "can", "usb-can-bridge"],
        can_pins="PD0/PD1",
        slot_ids=[f"Motor-{i}" for i in range(1, 11)],
        driver_mount="ez",
        endstops=[("M1-STOP", "PF0", "Motor-1"), ("M2-STOP", "PF2", "Motor-2"),
                  ("M3-STOP", "PF4", "Motor-3"), ("M4-STOP", "PF3", "Motor-4"),
                  ("M5-STOP", "PF1", None), ("M6-STOP", "PC15", None)],
        probe=[dict(id="PROBE", pin="PF11", pnp_capable=True, protected=True,
                    note="Optocoupler-isolated; PNP or NPN selected by jumper (vendor README).")],
        thermistor_pullup=4700,
        thermistor_pt1000_jumper_ohms=2200,
        fan_meta=dict(wires=2, four_wire=["FAN4", "FAN5", "FAN6"]),
        notes=["Uses BTT EZ-format drivers (EZ2209, EZ5160 ...), not stepsticks.",
               "All driver, heater and fan signals are level-shifted to 5V on-board."],
        discrepancies=["Motor-4 enable_pin is 'PB7' (not inverted) in both the BTT and Klipper "
                       "sample configs while every other slot is '!'. Likely a copy error - "
                       "confirm on hardware before generating configs that use Motor-4."],
        unverified=None,
    ),
    dict(
        id="btt-kraken-v1.0", name="BIGTREETECH Kraken", revisions=["1.0"],
        draft="BIGTREETECH-Kraken/Firmware/generic-bigtreetech-kraken.cfg",
        extra_sources=["Voron-2/firmware/klipper_configurations/Kraken/Voron2_Kraken_Config.cfg",
                       "BIGTREETECH-Kraken/Firmware/README.md"],
        status="reviewed",
        mcu=[dict(chip="stm32h723", crystal_mhz=25, bootloader_kib=128)],
        interfaces=["usb", "can"],
        can_pins="PD0/PD1",
        slot_ids=[f"S{i}" for i in range(1, 9)],
        driver_mount="onboard",
        onboard_driver=dict(chip="tmc2160", klipper_section="tmc5160"),
        endstops=[("S1-STOP", "PC15", "S1"), ("S2-STOP", "PF0", "S2"),
                  ("S3-STOP", "PF1", "S3"), ("S4-STOP", "PF2", "S4")],
        thermistor_pullup=4700,
        fan_meta=dict(wires=2, four_wire=["FAN6", "FAN7"]),
        notes=["All 8 drivers are on-board TMC2160s configured in Klipper as [tmc5160]. "
               "S1-S4 are high-current (0.022 ohm sense), S5-S8 use 0.075 ohm.",
               "Very high current capability on S1-S4: run_current must still respect the "
               "motor's rating."],
        unverified=["per-slot max current"],
    ),
    dict(
        id="ldo-leviathan-v1.2", name="LDO Leviathan", manufacturer="LDO", revisions=["1.2"],
        draft="Leviathan/Klipper_config/voron2_leviathan.cfg",
        extra_sources=["klipper/config/generic-ldo-leviathan-v1.2.cfg",
                       "Leviathan/Klipper_config/trident_leviathan.cfg",
                       "Leviathan/README.md"],
        status="reviewed",
        mcu=[dict(chip="stm32f446", crystal_mhz=12, bootloader_kib=32)],
        interfaces=["usb", "can", "usb-can-bridge"],
        slot_ids=["HV-STEPPER-0", "HV-STEPPER-1", "STEPPER-0", "STEPPER-1", "STEPPER-2",
                  "STEPPER-3", "STEPPER-4"],
        driver_mount="onboard",
        onboard_per_slot={"HV-STEPPER-0": "tmc5160", "HV-STEPPER-1": "tmc5160"},
        onboard_driver=dict(chip="tmc2209", klipper_section="tmc2209", sense_resistor=0.110,
                            max_current_a=2.0),
        hv_onboard=dict(chip="tmc5160", klipper_section="tmc5160", sense_resistor=0.075,
                        max_current_a=3.0, motor_power="HV input, 24-55V (48V typical)"),
        endstops=[("X-ENDSTOP", "PC1", None), ("Y-ENDSTOP", "PC2", None),
                  ("Z-ENDSTOP", "PC3", None)],
        probe=[dict(id="Z-PROBE", pin="PF1", modifier="^", protected=True,
                    note="Selectable voltage, integrated diode (vendor README). LDO config uses ^PF1.")],
        diag_modifier="^!",  # LDO voron2_leviathan.cfg uses ^! on both TMC5160 and TMC2209 DIAG lines
        thermistor_pullup=2200,
        fan_meta=dict(wires=2, voltage=[5, 24], voltage_select="per-port jumper",
                      tach_all=True),
        extras=dict(caselight_pin="PE6", led_strip="LED-Strip (PE6), flicker-free dimming"),
        power=dict(vin_v=[18, 28], hv_v=[24, 55]),
        notes=["Thermistor pull-ups are 2.2k: every thermistor section needs "
               "'pullup_resistor: 2200'.",
               "HV-STEPPER-0/1 (TMC5160) are intended for A/B; they need the HV input powered."],
        discrepancies=[
            "Klipper's generic-ldo-leviathan-v1.2.cfg has copy errors: stepper_z1 reuses "
            "Z's UART pin (PD5), stepper_z3's TMC section is named stepper_z2, and the extruder "
            "TMC section is named stepper_z. Pins here follow LDO's voron2_leviathan.cfg.",
            "FAN0 tachometer: LDO configs use PB8, Klipper's generic uses PB0 (which Klipper also "
            "lists as EXP3_13). Using PB8 (manufacturer).",
            "Bootloader: Klipper generic says 32KiB bootloader, LDO's config says 'No "
            "bootloader'. Depends on how the board was flashed (stock vs Katapult); the generator "
            "should ask.",
            "LDO README lists an STM32H743, but both v1.2 configs target STM32F446. The README "
            "probably describes a later revision; confirm before adding one."],
        unverified=None,
    ),
    dict(
        id="fysetc-spider-v2.2", name="FYSETC Spider", manufacturer="FYSETC", revisions=["2.2"],
        draft="klipper/config/generic-fysetc-spider.cfg",
        extra_sources=["FYSETC-SPIDER/firmware/Klipper/printer.cfg", "FYSETC-SPIDER/README.md"],
        status="needs-review",
        mcu=[dict(chip="stm32f446", crystal_mhz=12, bootloader_kib=32)],
        interfaces=["usb", "uart"],
        slot_ids=["X-MOT", "Y-MOT", "Z-MOT", "E0-MOT", "E1-MOT", "E2-MOT", "E3-MOT", "E4-MOT"],
        driver_mount="stepstick",
        endstops=[("X-", "PB14", "X-MOT"), ("Y-", "PB13", "Y-MOT"), ("Z-", "PA0", "Z-MOT"),
                  ("E0-DIAG", "PA3", "E0-MOT"), ("E1-DIAG", "PA2", "E1-MOT"),
                  ("E2-DIAG", "PA1", "E2-MOT")],
        thermistor_pullup=4700,
        fan_meta=dict(wires=2, voltage=[5, 12, 24], voltage_select="jumper"),
        notes=["Spider has had several revisions (v1.0/1.1/2.x/3.x) with different thermistor "
               "and HV-slot layouts. This record follows Klipper's generic (F446) pin map."],
        discrepancies=["Klipper generic flashes to 0x08000000 (no bootloader); other guides use a "
                       "32KiB bootloader. Confirm per board.",
                       "README pin tables disagree on TB (PC3 vs PB0) between revisions."],
        probe=[dict(id="E0-DIAG", pin="PA3", note="FYSETC's Voron config uses PA3 for the probe.")],
        neopixel=[dict(id="RGB", pin="PC12", note="From FYSETC's Voron config.")],
        unverified=["revision mapping", "fans[*]", "bootloader"],
    ),
    dict(
        id="btt-skr-3", name="BIGTREETECH SKR 3 / SKR 3 EZ", revisions=["1.0"],
        draft="klipper/config/generic-bigtreetech-skr-3.cfg",
        extra_sources=["SKR-3/Firmware/Klipper/generic-bigtreetech-skr-3.cfg", "SKR-3/README.md"],
        status="reviewed",
        mcu=[dict(chip="stm32h743", crystal_mhz=25, bootloader_kib=128),
             dict(chip="stm32h723", crystal_mhz=25, bootloader_kib=128)],
        interfaces=["usb", "can"],
        slot_ids=["X", "Y", "Z", "E0", "E1"],
        driver_mount="stepstick",
        endstops=[("X-STOP", "PC1", "X"), ("Y-STOP", "PC3", "Y"), ("Z-STOP", "PC0", "Z"),
                  ("E0-STOP", "PC2", "E0"), ("E1-STOP", "PA0", "E1")],
        thermistor_pullup=4700,
        thermistor_pt1000_jumper_ohms=1000,
        fan_meta=dict(wires=2, voltage=[5, 12, 24],
                      voltage_select="one selection shared by all 3 PWM fans"),
        notes=["Only 5 drivers: a Voron 2.4 is not possible; a Trident needs the extruder on a "
               "CAN toolhead board.",
               "SKR 3 EZ takes EZ-format drivers and its PT1000 jumper gives 2.2k (SKR 3: 1k)."],
        unverified=["SKR 3 EZ pin identity with SKR 3"],
    ),
    dict(
        id="btt-manta-m5p-v1.0", name="BIGTREETECH Manta M5P", revisions=["1.0"],
        draft="klipper/config/generic-bigtreetech-manta-m5p.cfg",
        extra_sources=[],
        status="needs-review",
        mcu=[dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=8)],
        interfaces=["usb", "can"],
        host_socket=["cb1", "cm4"],
        slot_ids=["M1", "M2", "M3", "M4", "M5"],
        driver_mount="stepstick",
        endstops=[("M1-STOP", "PD3", "M1"), ("M2-STOP", "PD2", "M2"),
                  ("M3-STOP", "PC3", "M3"), ("M4-STOP", "PC2", "M4")],
        thermistor_pullup=4700,
        fan_meta=dict(wires=2),
        notes=["Only 5 drivers: Trident only, with the extruder on a CAN toolhead board."],
        unverified=["single source (Klipper generic)", "fans[*]"],
    ),
]


def build_mainboard(ov):
    d, warnings = draft(str(SRC / ov["draft"]))
    slots = []
    for slot_id, m in zip(ov["slot_ids"], d["motors"]):
        s = {"id": slot_id, "step_pin": m["step_pin"], "dir_pin": m["dir_pin"],
             "enable_pin": m["enable_pin"]}
        if ov["driver_mount"] in ("stepstick", "ez"):
            s["uart_pin"] = m.get("uart_pin") or m.get("cs_pin")
            s["spi_cs_pin"] = m.get("cs_pin") or m.get("uart_pin")
        else:
            chip = ov.get("onboard_per_slot", {}).get(slot_id)
            od = dict(ov["hv_onboard"] if chip and "hv_onboard" in ov else ov["onboard_driver"])
            if m.get("sense_resistor_in_source"):
                od["sense_resistor"] = m["sense_resistor_in_source"]
            s["onboard_driver"] = od
            if m.get("uart_pin"):
                s["uart_pin"] = m["uart_pin"]
            if m.get("cs_pin"):
                s["spi_cs_pin"] = m["cs_pin"]
                if m.get("spi", {}).get("bus"):
                    s["spi_bus"] = m["spi"]["bus"]
        diag = m.get("diag") or {}
        dpin = diag.get("diag_pin") or diag.get("diag1_pin") or diag.get("diag0_pin")
        if dpin:
            s["diag_pin"] = dpin
            if ov["driver_mount"] == "onboard":
                # onboard drivers: the source config tells us which DIAG output is wired
                s["diag_pin_key"] = next(k for k in ("diag0_pin", "diag1_pin", "diag_pin")
                                         if diag.get(k))
            if ov.get("diag_modifier"):
                s["diag_modifier"] = ov["diag_modifier"]
        slots.append(s)
    if len(d["motors"]) != len(ov["slot_ids"]):
        warnings.append(f"slot count mismatch {len(d['motors'])} vs {len(ov['slot_ids'])}")

    spi = {}
    for m in d["motors"]:
        if m.get("spi"):
            spi = m["spi"]
            break
    tmc_spi = None
    if spi.get("bus"):
        tmc_spi = {"bus": spi["bus"]}
    elif spi:
        tmc_spi = {"software": {"mosi_pin": spi["mosi"], "miso_pin": spi["miso"],
                                "sclk_pin": spi["sclk"]}}

    heaters = []
    he = 0
    for h in d["heaters"]:
        if h.get("role") == "bed":
            heaters.append({"id": "HB" if h["id"] in ("HB", "HEATBED") else h["id"],
                            "pin": h["pin"], "role": "bed"})
        else:
            heaters.append({"id": h["id"] if h["id"].startswith("HE") else f"HE{he}",
                            "pin": h["pin"], "role": "hotend"})
            he += 1
    therm = []
    for t in d["thermistors"]:
        e = {"id": t["id"] if not t["id"].startswith(("TE0 ", "TB ")) else t["id"].split()[0],
             "pin": t["pin"], "pullup_ohms": ov["thermistor_pullup"]}
        if t.get("role") == "bed":
            e["typical_use"] = "bed"
        if ov.get("thermistor_pt1000_jumper_ohms"):
            e["alt_pullup_ohms_by_jumper"] = ov["thermistor_pt1000_jumper_ohms"]
        therm.append(e)
    # Leviathan: the LDO V2.4 config only lists TH0/TB; take all four ports from Klipper's.
    if ov["id"] == "ldo-leviathan-v1.2":
        therm = [{"id": f"TH{i}", "pin": p, "pullup_ohms": 2200}
                 for i, p in enumerate(["PA1", "PA2", "PA0", "PA3"])]
        heaters = [{"id": "HEATER", "pin": "PG10", "role": "hotend"},
                   {"id": "HEATBED", "pin": "PG11", "role": "bed"}]

    fans, n = [], 0
    fm = ov.get("fan_meta", {})
    for f in d["fans"]:
        if f.get("host_pin"):
            continue
        fid = f"FAN{n}"
        n += 1
        e = {"id": fid, "pin": f["pin"]}
        if f.get("tachometer_pin"):
            e["tachometer_pin"] = f["tachometer_pin"]
        e["wires"] = 4 if fid in fm.get("four_wire", []) else (
            3 if fm.get("tach_all") else fm.get("wires", 2))
        if fm.get("voltage"):
            e["voltage_options"] = fm["voltage"]
            e["voltage_select"] = fm.get("voltage_select")
        fans.append(e)

    x = d["extras"]
    probe = ov.get("probe")
    if not probe and x.get("probe"):
        probe = [{"id": "PROBE", "pin": phys(x["probe"][0].get("pin") or x["probe"][0].get("sensor_pin"))}]
    out = {
        "schema": "mainboard/1",
        "id": ov["id"],
        "name": ov["name"],
        "manufacturer": ov.get("manufacturer", "BIGTREETECH"),
        "revisions": ov["revisions"],
        "status": ov["status"],
        "mcu_variants": ov["mcu"],
        "interfaces": ov["interfaces"],
    }
    if ov.get("can_pins"):
        out["can_pins"] = ov["can_pins"]
    if ov.get("host_socket"):
        out["host_socket"] = ov["host_socket"]
    if ov.get("power"):
        out["power"] = ov["power"]
    out["driver_mount"] = ov["driver_mount"]
    if ov["driver_mount"] in ("stepstick", "ez"):
        out["supported_drivers"] = STEPSTICK_DRIVERS
    if tmc_spi:
        out["tmc_spi"] = tmc_spi
    out["driver_slots"] = slots
    out["endstops"] = [dict(id=i, pin=p, **({"diag_of": s} if s else {}))
                       for i, p, s in ov["endstops"]]
    out["heaters"] = heaters
    out["thermistors"] = therm
    out["fans"] = fans
    if probe:
        out["probe_ports"] = probe
    if x.get("bltouch"):
        b = x["bltouch"][0]
        out["bltouch"] = {"sensor_pin": phys(b["sensor_pin"]), "control_pin": phys(b["control_pin"])}
    if x.get("neopixel"):
        nps = [phys(p["pin"]) for p in x["neopixel"] if not p["pin"].startswith("EXP")]
        out["neopixel_ports"] = [{"id": f"RGB{i+1}" if len(nps) > 1 else "RGB", "pin": p}
                                 for i, p in enumerate(nps)]
    elif ov.get("neopixel"):
        out["neopixel_ports"] = ov["neopixel"]
    fs = x.get("filament_switch_sensor")
    used_endstops = {p for _, p, _ in ov["endstops"]}
    if fs:
        pins = [phys(f["switch_pin"]) for f in fs if phys(f["switch_pin"]) not in used_endstops]
        if pins:
            out["filament_sensor_ports"] = [{"id": f"FIL{i}", "pin": p} for i, p in enumerate(pins)]
    accel = x.get("adxl345") or x.get("lis2dw")
    if accel:
        a = accel[0]
        out["accelerometer_header"] = {"cs_pin": phys(a["cs_pin"]), "spi_bus": a.get("spi_bus")}
    if ov.get("extras"):
        out["misc"] = ov["extras"]
    if d["exp_aliases"]:
        out["exp_aliases"] = d["exp_aliases"]
    out["notes"] = ov.get("notes", [])
    if ov.get("discrepancies"):
        out["discrepancies"] = ov["discrepancies"]
    if ov.get("unverified"):
        out["unverified"] = ov["unverified"]
    out["sources"] = [source(ov["draft"])] + [source(s) for s in ov["extra_sources"]]
    return out, warnings


# ---------------------------------------------------------------------------
# Toolhead boards
# ---------------------------------------------------------------------------

TOOLBOARDS = [
    dict(id="btt-ebb36-can-v1.1", name="BIGTREETECH EBB36 CAN", revisions=["1.1"],
         draft="EBB/EBB CAN V1.1 and V1.2 (STM32G0B1)/sample-bigtreetech-ebb-canbus-v1.1.cfg",
         mcu=dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=0),
         interfaces=["can", "usb"], can_pins="PB0/PB1", form_factor="nema14-back",
         accel="adxl345",
         notes=["EBB36 and EBB42 v1.1 share this pin map.",
                "Thermistor pull-up and fan voltage are selected by jumpers on the board."]),
    dict(id="btt-ebb42-can-v1.1", name="BIGTREETECH EBB42 CAN", revisions=["1.1"],
         draft="EBB/EBB CAN V1.1 and V1.2 (STM32G0B1)/sample-bigtreetech-ebb-canbus-v1.1.cfg",
         mcu=dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=0),
         interfaces=["can", "usb"], can_pins="PB0/PB1", form_factor="nema17-back",
         accel="adxl345", notes=["EBB36 and EBB42 v1.1 share this pin map."]),
    dict(id="btt-ebb36-can-v1.2", name="BIGTREETECH EBB36 CAN", revisions=["1.2"],
         draft="EBB/EBB CAN V1.1 and V1.2 (STM32G0B1)/sample-bigtreetech-ebb-canbus-v1.2.cfg",
         mcu=dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=0),
         interfaces=["can", "usb"], can_pins="PB0/PB1", form_factor="nema14-back",
         accel="adxl345",
         notes=["Heater moved from PA2 (v1.1) to PB13 (v1.2): using the v1.1 map on a v1.2 "
                "board leaves the heater pin wrong."]),
    dict(id="btt-ebb42-can-v1.2", name="BIGTREETECH EBB42 CAN", revisions=["1.2"],
         draft="EBB/EBB CAN V1.1 and V1.2 (STM32G0B1)/sample-bigtreetech-ebb-canbus-v1.2.cfg",
         mcu=dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=0),
         interfaces=["can", "usb"], can_pins="PB0/PB1", form_factor="nema17-back",
         accel="adxl345", notes=["Shares the EBB36 v1.2 pin map."]),
    dict(id="btt-ebb36-gen2-v1.0", name="BIGTREETECH EBB36 Gen2", revisions=["1.0"],
         draft="EBB/EBB_GEN2/EBB36_GEN2/sample-bigtreetech-ebb36-gen2-v1.0.cfg",
         mcu=dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=0),
         interfaces=["can", "usb"], can_pins="PB12/PB13", form_factor="nema14-back",
         accel="lis2dw", thermistor_pullup=2200,
         notes=["Sample config uses pullup_resistor: 2200 for the hotend thermistor."]),
    dict(id="btt-ebb42-gen2-v1.0", name="BIGTREETECH EBB42 Gen2", revisions=["1.0"],
         draft="EBB/EBB_GEN2/EBB42_GEN2/sample-bigtreetech-ebb42-gen2-v1.0.cfg",
         mcu=dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=0),
         interfaces=["can", "usb"], can_pins="PB12/PB13", form_factor="nema17-back",
         accel="lis2dw", thermistor_pullup=2200, notes=[]),
    dict(id="btt-ebb-sb2209-can-v1.0", name="BIGTREETECH EBB SB2209 CAN (STM32)", revisions=["1.0"],
         draft="EBB/EBB SB2240_2209 CAN/sample-bigtreetech-ebb-sb-canbus-v1.0.cfg",
         mcu=dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=0),
         interfaces=["can", "usb"], can_pins="PB0/PB1", form_factor="stealthburner",
         accel="adxl345", driver_override=dict(chip="tmc2209", interface="uart"),
         notes=["Mounts on the Stealthburner; has a probe input for Tap/inductive (PC13)."]),
    dict(id="btt-ebb-sb2240-can-v1.0", name="BIGTREETECH EBB SB2240 CAN", revisions=["1.0"],
         draft="EBB/EBB SB2240_2209 CAN/sample-bigtreetech-ebb-sb-canbus-v1.0.cfg",
         mcu=dict(chip="stm32g0b1", crystal_mhz=8, bootloader_kib=0),
         interfaces=["can", "usb"], can_pins="PB0/PB1", form_factor="stealthburner",
         accel="adxl345", driver_override=dict(chip="tmc2240", interface="spi"),
         notes=["Same board as SB2209 but with a TMC2240 on SPI (cs PA15, spi2_PB2_PB11_PB10).",
                "klipper_tmc_autotune: set overvoltage_vth to measured toolhead voltage + 0.8V."]),
    dict(id="btt-ebb-sb2209-rp2040-v1.0", name="BIGTREETECH EBB SB2209 CAN (RP2040)", revisions=["1.0"],
         draft="EBB/EBB SB2209 CAN (RP2040)/sample-bigtreetech-ebb-sb-rp2040-canbus-v1.0.cfg",
         mcu=dict(chip="rp2040"), interfaces=["can", "usb"], form_factor="stealthburner",
         accel="adxl345", notes=[]),
    dict(id="btt-ebb-sb2209-usb-v1.0", name="BIGTREETECH EBB SB2209 USB (RP2040)", revisions=["1.0"],
         draft="EBB/EBB_SB2209_USB/sample-bigtreetech-ebb-sb-usb-v1.0.cfg",
         mcu=dict(chip="rp2040"), interfaces=["usb"], form_factor="stealthburner",
         accel="lis2dw", notes=["USB only - no CAN transceiver."]),
    dict(id="ldo-nitehawk-sb", name="LDO Nitehawk-SB", manufacturer="LDO", revisions=["1.0"],
         draft="Nitehawk-SB/Firmware/Klipper Configs/nitehawk-sb.cfg",
         mcu=dict(chip="rp2040"), interfaces=["usb"], form_factor="stealthburner",
         accel="adxl345", thermistor_pullup=2200,
         notes=["USB toolhead board with a USB adapter board on the frame; not CAN.",
                "Has an on-board chamber thermistor input (gpio28) and board NTC (gpio26)."]),
    dict(id="ldo-nitehawk-36", name="LDO Nitehawk-36", manufacturer="LDO", revisions=["1.0"],
         draft="Nitehawk-36/Configs/nitehawk-36.cfg",
         mcu=dict(chip="rp2040"), interfaces=["usb"], form_factor="nema14-back",
         accel="adxl345", thermistor_pullup=2200, notes=["USB toolhead board."]),
]


def build_toolboard(ov):
    d, warnings = draft(str(SRC / ov["draft"]))
    m = d["motors"][0]
    drv = ov.get("driver_override") or {"chip": m["source_driver_types"][0], "interface": "uart"}
    driver = {"chip": drv["chip"], "interface": drv["interface"],
              "step_pin": strip_mcu(m["step_pin"]), "dir_pin": strip_mcu(m["dir_pin"]),
              "enable_pin": strip_mcu(m["enable_pin"])}
    if drv["interface"] == "uart":
        driver["uart_pin"] = phys(m["uart_pin"])
    else:
        driver["spi_cs_pin"] = phys(m["cs_pin"])
        driver["spi_bus"] = m["spi"]["bus"]
    if drv["chip"] == "tmc2209":
        driver["sense_resistor"] = m.get("sense_resistor_in_source") or 0.110
    else:
        driver["rref_ohms"] = 12000
        driver["unverified"] = ["rref value (Klipper default assumed)"]
    out = {"schema": "toolboard/1", "id": ov["id"], "name": ov["name"],
           "manufacturer": ov.get("manufacturer", "BIGTREETECH"),
           "revisions": ov["revisions"], "status": "reviewed",
           "mcu": ov["mcu"], "interfaces": ov["interfaces"]}
    if ov.get("can_pins"):
        out["can_pins"] = ov["can_pins"]
    out["form_factor"] = ov["form_factor"]
    out["extruder_driver"] = driver
    out["heaters"] = [{"id": "HE0", "pin": phys(h["pin"]), "role": "hotend"} for h in d["heaters"]]
    therm = []
    for t in d["thermistors"]:
        tid = t["id"]
        e = {"id": tid if tid == "T0" else ("BOARD_NTC" if tid in ("EBB_NTC", "nh_temp", "EBB36", "EBB42")
                                            else tid.upper()),
             "pin": phys(t["pin"])}
        if tid == "T0":
            e["pullup_ohms"] = ov.get("thermistor_pullup", 4700)
            e["typical_use"] = "hotend"
        elif tid == "chamber_temp":
            e["typical_use"] = "chamber"
        else:
            e["typical_use"] = "board"
        therm.append(e)
    out["thermistors"] = therm
    out["fans"] = [{"id": f"FAN{i}", "pin": phys(f["pin"]),
                    **({"tachometer_pin": phys(f["tachometer_pin"]), "wires": 4}
                       if f.get("tachometer_pin") else {"wires": 2})}
                   for i, f in enumerate(d["fans"])]
    x = d["extras"]
    if x.get("probe"):
        p = x["probe"][0]
        out["probe_ports"] = [{"id": "PROBE", "pin": phys(p.get("pin") or p.get("sensor_pin"))}]
    if x.get("bltouch"):
        b = x["bltouch"][0]
        out["bltouch"] = {"sensor_pin": phys(b["sensor_pin"]), "control_pin": phys(b["control_pin"])}
    if x.get("neopixel"):
        out["neopixel_ports"] = [{"id": "RGB", "pin": phys(x["neopixel"][0]["pin"])}]
    fs = x.get("filament_switch_sensor")
    if fs:
        out["filament_sensor_ports"] = [{"id": "FIL0", "pin": phys(fs[0]["switch_pin"])}]
    a = (x.get(ov["accel"]) or [None])[0]
    if a:
        acc = {"chip": ov["accel"], "cs_pin": phys(a["cs_pin"])}
        if a.get("spi_bus"):
            acc["spi_bus"] = a["spi_bus"]
        else:
            acc["spi_software"] = {"sclk_pin": phys(a["spi_software_sclk_pin"]),
                                   "mosi_pin": phys(a["spi_software_mosi_pin"]),
                                   "miso_pin": phys(a["spi_software_miso_pin"])}
        out["accelerometer"] = acc
    out["notes"] = ov["notes"]
    out["unverified"] = ["connector labels (taken from sample config order)"]
    out["sources"] = [source(ov["draft"])]
    return out, warnings


if __name__ == "__main__":
    for kind, items, fn in (("mainboards", MAINBOARDS, build_mainboard),
                            ("toolboards", TOOLBOARDS, build_toolboard)):
        (OUT / kind).mkdir(parents=True, exist_ok=True)
        for ov in items:
            data, warns = fn(ov)
            for w in warns:
                print(f"{ov['id']}: WARNING {w}")
            with open(OUT / kind / f"{ov['id']}.yaml", "w") as f:
                yaml.safe_dump(data, f, sort_keys=False, width=100, allow_unicode=True)
            print("wrote", kind, ov["id"])
