#!/usr/bin/env bash
# Compile the native icon composition and its legacy macOS representation.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! xcrun --find actool >/dev/null 2>&1; then
  echo 'The native app icon needs Xcode 26 or later, including its asset compiler.' >&2
  exit 1
fi
XCODE_MAJOR="$(xcodebuild -version | awk '/^Xcode / { print int($2) }')"
if [[ "$XCODE_MAJOR" -lt 26 ]]; then
  echo 'Select Xcode 26 or later with DEVELOPER_DIR before building the app icon.' >&2
  exit 1
fi
OUTPUT="$ROOT_DIR/.cache/app-icon"
COMPOSITION="$OUTPUT/MaestroAppIcon.icon"
mkdir -p "$COMPOSITION/Assets"
cp "$ROOT_DIR/desktop/assets/AppIcon.icon.json" "$COMPOSITION/icon.json"
cp "$ROOT_DIR/desktop/assets/AppIcon.png" "$COMPOSITION/Assets/AppIcon.png"
rm -f "$OUTPUT/Assets.car" "$OUTPUT/MaestroAppIcon.icns" "$OUTPUT/Info.plist"
xcrun actool "$COMPOSITION" --compile "$OUTPUT" --platform macosx --minimum-deployment-target 14.0 --app-icon MaestroAppIcon --output-partial-info-plist "$OUTPUT/Info.plist"
for artifact in Assets.car MaestroAppIcon.icns Info.plist; do
  if [[ ! -s "$OUTPUT/$artifact" ]]; then
    echo "The icon compiler did not produce $artifact." >&2
    exit 1
  fi
done
cp "$OUTPUT/MaestroAppIcon.icns" "$ROOT_DIR/desktop/assets/AppIcon.icns"
