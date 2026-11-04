#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.tools:$PWD/node_modules/.bin:$PATH"
node --import tsx bridge/src/setup.ts
if ! scripts/herdr.sh agent list >/dev/null 2>&1; then
  mkdir -p .local
  nohup scripts/herdr.sh server > .local/herdr-server.log 2>&1 </dev/null &
  for attempt in {1..30}; do
    if scripts/herdr.sh agent list >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  scripts/herdr.sh agent list >/dev/null
fi
exec node --import tsx bridge/src/main.ts
