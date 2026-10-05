#!/bin/bash
# One-shot detached installer; no launchd/KeepAlive. --go is required.
# bash scripts/restart-agentdeck.sh --go --dmg PATH --sha256 HEX --version VERSION
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$HERE/install-agentdeck.js" ]] || { echo 'Missing install-agentdeck.js' >&2; exit 1; }
exec node "$HERE/install-agentdeck.js" "$@"
