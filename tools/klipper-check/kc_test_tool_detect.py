# Test-only Klipper extra for tools/klipper_check.py. NOT for printers.
#
# Batch mode has no MCU, so a toolchanger's detection pins never report and
# require_tool_present stops homing. At ready this marks T0 as mounted (and the
# other tools as docked), then turns detection off so VERIFY_TOOL_DETECTED is a
# no-op while the check runs tool changes.
from . import toolchanger


class KcTestToolDetect:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.printer.register_event_handler("klippy:ready", self._ready)

    def _ready(self):
        tc = self.printer.lookup_object("toolchanger")
        now = self.printer.get_reactor().monotonic()
        for name, tool in self.printer.lookup_objects("tool"):
            tool.detect_state = toolchanger.DETECT_PRESENT if tool.tool_number == 0 else toolchanger.DETECT_ABSENT
        tc.note_detect_change(None, now)
        tc.has_detection = False


def load_config(config):
    return KcTestToolDetect(config)
