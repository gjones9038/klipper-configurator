#!/usr/bin/env bash
# One-time setup for tools/klipper_check.py. Everything lands in .cache/klipper-check
# (gitignored); nothing needs root.
#   - Klipper + klipper_tmc_autotune + klipper-toolchanger checkouts (pinned by commit below)
#   - xPack ARM GCC (via npx xpm) to build MCU data dictionaries
#   - klippy's Python deps unpacked from PyPI wheels (no pip/venv required)
set -euo pipefail

KLIPPER_COMMIT=9cb99754c035b90206ef0a02660f674fc9517e9b
AUTOTUNE_REPO=https://github.com/andrewmcgr/klipper_tmc_autotune.git
AUTOTUNE_COMMIT=b6c7cfa98c2ef880812d5279a9117cbe67d6d4d5
# klipper-toolchanger main (94756df) does not load on this Klipper (probe API change of
# 2026-05-25); check against PR #174, the open fix. Switch to main once it is merged.
TOOLCHANGER_REPO=https://github.com/viesturz/klipper-toolchanger.git
TOOLCHANGER_REF=pull/174/head
TOOLCHANGER_COMMIT=0bded502b27dae5b9261789e03b0c8a0b84f48fb
# A name with a suffix (stm32f042-orbitool) is a variant: the base chip's config plus
# tools/klipper-check/<name>.overrides.
CHIPS="stm32f042 stm32f042-orbitool stm32f072 stm32f103 stm32f401 stm32f446 stm32f429 stm32f407 stm32h723 stm32h743 stm32g0b1 rp2040 atmega2560 atmega1284p stm32f070 hc32f460 stm32f103-serial hc32f460-serial-PA7PA8 stm32f103-usart3 stm32f401-usart1 stm32f446-usart1 stm32h750-usbcan-PB8PB9 stm32f103-can-PB8PB9 sam4e8e"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
C="$ROOT/.cache/klipper-check"
mkdir -p "$C"/{dicts,site,wheels}

if [ ! -d "$C/klipper" ]; then
  git clone -q https://github.com/Klipper3d/klipper.git "$C/klipper"
fi
git -C "$C/klipper" fetch -q origin "$KLIPPER_COMMIT" && git -C "$C/klipper" checkout -q "$KLIPPER_COMMIT"
[ -d "$C/autotune" ] || git clone -q "$AUTOTUNE_REPO" "$C/autotune"
git -C "$C/autotune" fetch -q origin "$AUTOTUNE_COMMIT" && git -C "$C/autotune" checkout -q "$AUTOTUNE_COMMIT"
[ -d "$C/toolchanger" ] || git clone -q "$TOOLCHANGER_REPO" "$C/toolchanger"
git -C "$C/toolchanger" fetch -q origin "$TOOLCHANGER_REF" && git -C "$C/toolchanger" checkout -q "$TOOLCHANGER_COMMIT"
# web UI client configs, so [include mainsail.cfg] / [include fluidd.cfg] resolve in checks
[ -d "$C/ui/mainsail-config" ] || git clone -q --depth 1 https://github.com/mainsail-crew/mainsail-config.git "$C/ui/mainsail-config"
[ -d "$C/ui/fluidd-config" ] || git clone -q --depth 1 https://github.com/fluidd-core/fluidd-config.git "$C/ui/fluidd-config"

GCC_BIN="$(ls -d "$HOME"/.local/xPacks/@xpack-dev-tools/arm-none-eabi-gcc/*/.content/bin 2>/dev/null | tail -1 || true)"
if [ -z "$GCC_BIN" ]; then
  npx -y xpm@latest install --global @xpack-dev-tools/arm-none-eabi-gcc@latest
  GCC_BIN="$(ls -d "$HOME"/.local/xPacks/@xpack-dev-tools/arm-none-eabi-gcc/*/.content/bin | tail -1)"
fi
export PATH="$GCC_BIN:$PATH"

# AVR toolchain for 8-bit boards (Prusa Einsy: ATmega2560): ZakKemble/avr-gcc-build,
# pinned and checked against the release's SHA256SUMS.
AVR_VER=15.2.0
AVR_SHA=d90765e6d975950afa235aa998122f97aae8b00504399068b6c9d0bf4994b0fe
if [ ! -x "$C/avr-gcc/bin/avr-gcc" ]; then
  mkdir -p "$C/avr-gcc-dl" "$C/avr-gcc"
  curl -fsSL -o "$C/avr-gcc-dl/avr-gcc.tar.bz2" \
    "https://github.com/ZakKemble/avr-gcc-build/releases/download/v$AVR_VER-1/avr-gcc-$AVR_VER-x64-linux.tar.bz2"
  echo "$AVR_SHA  $C/avr-gcc-dl/avr-gcc.tar.bz2" | sha256sum -c - >/dev/null
  tar -xjf "$C/avr-gcc-dl/avr-gcc.tar.bz2" -C "$C/avr-gcc" --strip-components=1
fi
export PATH="$PATH:$C/avr-gcc/bin"

cd "$C/klipper"
for chip in $CHIPS; do
  [ -f "$C/dicts/$chip.dict" ] && continue
  make clean >/dev/null 2>&1 || true
  # Klipper's test config, or a repo-local base config for chips it has none for (F072).
  base_chip="${chip%%-*}"
  # A variant Klipper ships a test config for (stm32f103-serial) uses it as-is.
  BASE="test/configs/$chip.config"
  [ -f "$BASE" ] || BASE="test/configs/$base_chip.config"
  # Some chips only have suffixed test configs (hc32f460-serial-PA3PA2.config): take the first.
  [ -f "$BASE" ] || BASE="$(ls test/configs/$base_chip-*.config 2>/dev/null | head -1 || true)"
  [ -f "$BASE" ] || BASE="$ROOT/tools/klipper-check/$base_chip.config"
  cp "$BASE" .config
  # Per-chip overrides (e.g. Cartographer's F042 needs the LDC1612 driver). Override keys
  # are removed from the base config first so Kconfig sees each key once.
  OVR="$ROOT/tools/klipper-check/$chip.overrides"
  if [ -f "$OVR" ]; then
    keys="$(grep -oE '^CONFIG_[A-Z0-9_]+' "$OVR" | paste -sd'|')"
    grep -vE "^($keys)=" "$BASE" > .config
    grep -v '^#' "$OVR" >> .config
  fi
  make olddefconfig >/dev/null
  make -j"$(nproc)" >/dev/null
  cp out/klipper.dict "$C/dicts/$chip.dict"
  echo "built $chip.dict"
done

# klippy deps (versions from scripts/klippy-requirements.txt, Python 3.12)
python3 -I - "$C/wheels" <<'EOF'
import json, sys, urllib.request, os
dest = sys.argv[1]
want = {"greenlet": "3.3.2", "cffi": "2.1.1", "pycparser": None, "Jinja2": "2.11.3",
        "MarkupSafe": "2.0.1", "pyserial": "3.4", "msgspec": "0.19.0"}
tag = "cp%d%d" % sys.version_info[:2]
for name, ver in want.items():
    url = f"https://pypi.org/pypi/{name}/{ver}/json" if ver else f"https://pypi.org/pypi/{name}/json"
    files = json.load(urllib.request.urlopen(url))["urls"]
    pick = next((f for f in files if tag in f["filename"] and "manylinux" in f["filename"]
                 and "x86_64" in f["filename"]), None) \
        or next((f for f in files if f["filename"].endswith("none-any.whl")), None) \
        or next(f for f in files if f["filename"].endswith(".tar.gz"))
    path = os.path.join(dest, pick["filename"])
    if not os.path.exists(path):
        urllib.request.urlretrieve(pick["url"], path)
EOF
cd "$C/wheels"
for w in *.whl; do python3 -I -m zipfile -e "$w" "$C/site/"; done
tar xzf MarkupSafe-*.tar.gz && cp -r MarkupSafe-*/src/markupsafe "$C/site/" && rm -f "$C/site/markupsafe/_speedups.c"

echo "ready: npm run klipper-check -- <out-dir> [...]"
