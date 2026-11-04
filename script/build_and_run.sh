#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
case "$MODE" in run|--verify|--debug|--logs|--telemetry) ;; *) echo "Usage: $0 [--verify|--debug|--logs|--telemetry]" >&2; exit 2 ;; esac
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/dist/Maestro.app"
RESOURCES="$APP_BUNDLE/Contents/Resources"
cd "$ROOT_DIR"

# Stop the app's bundled bridge before its parent exits.
for maestro_pid in $(pgrep -x Maestro || true); do
  pkill -TERM -P "$maestro_pid" -f 'bridge/src/desktop.js' >/dev/null 2>&1 || true
done
pkill -x Maestro >/dev/null 2>&1 || true
if [[ ! -x "$RESOURCES/.tools/node/bin/node" ]]; then
  npm run app:build
else
  # Reuse the packaged runtimes and the project's stable compiler cache for UI work.
  npm run check
  cp -R bridge/public/. "$RESOURCES/bridge/public/"
  cp desktop/assets/AppIcon.icns "$RESOURCES/AppIcon.icns"
  /usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile AppIcon' "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string AppIcon' "$APP_BUNDLE/Contents/Info.plist"
  node_modules/.bin/tsc --noEmit false --rootDir bridge --outDir "$RESOURCES/bridge"
  rm -rf "$RESOURCES/bridge/test"
  swiftc -parse-as-library -target arm64-apple-macos14.0 -module-cache-path "$ROOT_DIR/.cache/swift" -O -framework AppKit -framework WebKit desktop/Maestro.swift -o "$APP_BUNDLE/Contents/MacOS/Maestro"
  codesign --force --deep --sign - "$APP_BUNDLE"
  codesign --verify --deep --strict "$APP_BUNDLE"
fi

case "$MODE" in
  --debug) lldb -- "$APP_BUNDLE/Contents/MacOS/Maestro" ;;
  --logs|--telemetry)
    /usr/bin/open -n "$APP_BUNDLE"
    /usr/bin/log stream --info --style compact --predicate 'process == "Maestro"'
    ;;
  --verify)
    /usr/bin/open -n "$APP_BUNDLE"
    for attempt in {1..20}; do
      if pgrep -x Maestro >/dev/null; then echo "Maestro built and launched."; exit 0; fi
      sleep 0.25
    done
    echo "Maestro built, but its process did not stay open." >&2
    exit 1
    ;;
  run) /usr/bin/open -n "$APP_BUNDLE" ;;
esac
