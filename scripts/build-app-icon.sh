#!/usr/bin/env bash
# Export the macOS icon representations from the 1024px master.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICONSET="$ROOT_DIR/.cache/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$ROOT_DIR/desktop/assets/AppIcon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  retina_size=$((size * 2))
  sips -s format png -z "$retina_size" "$retina_size" "$ROOT_DIR/desktop/assets/AppIcon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$ROOT_DIR/desktop/assets/AppIcon.icns"
