#!/usr/bin/env bash
# One-time setup for tools/klipper_check.py. Everything lands in .cache/klipper-check
# (gitignored); nothing needs root.
#   - Klipper + klipper_tmc_autotune checkouts (pinned by commit below)
#   - xPack ARM GCC (via npx xpm) to build MCU data dictionaries
#   - klippy's Python deps unpacked from PyPI wheels (no pip/venv required)
set -euo pipefail

KLIPPER_COMMIT=9cb99754c035b90206ef0a02660f674fc9517e9b
AUTOTUNE_REPO=https://github.com/andrewmcgr/klipper_tmc_autotune.git
CHIPS="stm32f446 stm32f429 stm32f407 stm32h723 stm32h743 stm32g0b1 rp2040"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
C="$ROOT/.cache/klipper-check"
mkdir -p "$C"/{dicts,site,wheels}

if [ ! -d "$C/klipper" ]; then
  git clone -q https://github.com/Klipper3d/klipper.git "$C/klipper"
fi
git -C "$C/klipper" fetch -q origin "$KLIPPER_COMMIT" && git -C "$C/klipper" checkout -q "$KLIPPER_COMMIT"
[ -d "$C/autotune" ] || git clone -q --depth 1 "$AUTOTUNE_REPO" "$C/autotune"

GCC_BIN="$(ls -d "$HOME"/.local/xPacks/@xpack-dev-tools/arm-none-eabi-gcc/*/.content/bin 2>/dev/null | tail -1 || true)"
if [ -z "$GCC_BIN" ]; then
  npx -y xpm@latest install --global @xpack-dev-tools/arm-none-eabi-gcc@latest
  GCC_BIN="$(ls -d "$HOME"/.local/xPacks/@xpack-dev-tools/arm-none-eabi-gcc/*/.content/bin | tail -1)"
fi
export PATH="$GCC_BIN:$PATH"

cd "$C/klipper"
for chip in $CHIPS; do
  [ -f "$C/dicts/$chip.dict" ] && continue
  make clean >/dev/null 2>&1 || true
  cp "test/configs/$chip.config" .config
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
