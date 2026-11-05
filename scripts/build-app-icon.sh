#!/usr/bin/env bash
# Compile the native icon composition and its legacy macOS representation.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! xcrun --find actool >/dev/null 2>&1; then
  echo 'The native app icon needs Xcode, including its asset compiler.' >&2
  exit 1
fi
OUTPUT="$ROOT_DIR/.cache/app-icon"
COMPOSITION="$OUTPUT/MaestroAppIcon.icon"
mkdir -p "$COMPOSITION/Assets"
cp "$ROOT_DIR/desktop/assets/AppIcon.icon.json" "$COMPOSITION/icon.json"
cp "$ROOT_DIR/desktop/assets/AppIcon.png" "$COMPOSITION/Assets/AppIcon.png"
xcrun actool "$COMPOSITION" --compile "$OUTPUT" --platform macosx --minimum-deployment-target 14.0 --app-icon MaestroAppIcon --output-partial-info-plist "$OUTPUT/Info.plist"
cp "$OUTPUT/MaestroAppIcon.icns" "$ROOT_DIR/desktop/assets/AppIcon.icns"
