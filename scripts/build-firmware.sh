#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
MAESTRO_ROOT="$PWD"
export IDF_TOOLS_PATH="$MAESTRO_ROOT/.tools/espressif"
export PATH="$MAESTRO_ROOT/.tools/python/bin:/opt/homebrew/opt/python@3.13/libexec/bin:$PATH"
python3 scripts/prepare-firmware.py
source "$MAESTRO_ROOT/.cache/esp-idf/export.sh" >/dev/null
cd firmware/build/sdk/esp32
idf.py -B build-maestro -DIDF_TARGET=esp32s3 \
  -DSDKCONFIG=build-maestro/sdkconfig \
  '-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;devices/sdkconfig.muse;devices/sdkconfig.muse-m5stack-stopwatch;sdkconfig.maestro' build
