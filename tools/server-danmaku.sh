#!/usr/bin/env bash
# Run all danmaku operations on the Linux application server.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(id -u)" == 0 ]]; then
  exec runuser -u aoe2 -- "$ROOT/tools/server-danmaku.sh" "$@"
fi
cd "$ROOT"
umask 077
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.cache/ms-playwright"
PYTHON="$ROOT/.venv-danmaku/bin/python"
PLATFORM="${DANMAKU_PLATFORM:-douyu}"
case "$PLATFORM" in douyu|bilibili) ;; *) echo 'Unsupported platform' >&2; exit 2;; esac
case "${1:-help}" in
  login)
    exec "$PYTHON" tools/live_danmaku.py --platform "$PLATFORM" login --headless-qr --timeout "${2:-600}"
    ;;
  check)
    exec "$PYTHON" tools/live_danmaku.py --platform "$PLATFORM" check --room "${2:-753676}"
    ;;
  send)
    [[ $# == 3 ]] || { echo 'Usage: server-danmaku.sh send ROOM MESSAGE' >&2; exit 2; }
    exec "$PYTHON" tools/live_danmaku.py --platform "$PLATFORM" send --room "$2" --message "$3"
    ;;
  status)
    systemctl is-active aoe2de.service
    "$PYTHON" - "$PLATFORM" <<'PY'
import json, sys
from pathlib import Path
p = Path('.cache/danmaku') / (sys.argv[1] + '_storage_state.json')
print('Saved login session: ' + ('present (use check to validate)' if p.exists() else 'missing'))
p = Path('.cache/danmaku/realtime-match-added.json')
if p.exists():
    for key, value in json.loads(p.read_text()).items():
        print(key, 'lastMatchId=' + str(value.get('lastMatchId', '-')), 'sentAt=' + str(value.get('sentAt', '-')), 'pendingMatchId=' + str(value.get('pendingMatchId', '-')))
PY
    ;;
  *)
    echo 'Usage: tools/server-danmaku.sh login [TIMEOUT_SECONDS] | check [ROOM] | send ROOM MESSAGE | status'
    echo 'Default: Douyu. Set DANMAKU_PLATFORM=bilibili for Bilibili.'
    echo 'Automatic notifications run inside aoe2de.service and survive SSH disconnect/reboot.'
    ;;
esac
