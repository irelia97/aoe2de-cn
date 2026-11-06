#!/bin/bash
set -euo pipefail
umask 077
base=/opt/aoe2de-cn/.cache
profile="$base/aoe2recs-browser-profile"
mkdir -p "$profile"
printf '%s\n' "$DISPLAY" > "$base/aoe2recs-browser-display"
exec /usr/bin/google-chrome-stable \
  --user-data-dir="$profile" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9228 \
  --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --window-position=0,0 --window-size=1365,900 about:blank
