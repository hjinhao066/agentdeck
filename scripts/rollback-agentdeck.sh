#!/bin/bash
# Uses the same bounded, verified transaction; preserves user data by default.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$HERE/install-agentdeck.js" ]] || { echo 'Missing install-agentdeck.js' >&2; exit 1; }
exec node "$HERE/install-agentdeck.js" --rollback "$@"
