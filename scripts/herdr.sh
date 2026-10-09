#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.tools:$PWD/node_modules/.bin:$PATH"
export HERDR_CONFIG_PATH="$PWD/.local/herdr/config.toml"
exec "$PWD/.tools/herdr" --session maestro "$@"
