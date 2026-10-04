#!/usr/bin/env bash
# Undo install-caddy-site.sh: put back the block it replaced (or remove the block if there was none).
# Only the BEGIN/END region is touched, so other sites edited since then are kept. Run on the VPS as root.
#
#   rollback-caddy-site.sh [BACKUP_DIR]    default: the newest backup of the ORIGINAL block under /var/backups/agentdeck-three-ends
#                                          (a backup that holds our own managed block is refused)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

case "${1:-}" in -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
need_cmd python3; need_cmd "$CADDY_BIN"
if ! is_root && [ -z "${AGENTDECK_ALLOW_NON_ROOT:-}" ]; then die "run as root (sudo)"; fi
if [ -n "${1:-}" ]; then
  BDIR="$1"
else
  BDIR="$(latest_original_backup)" || die "no backup of the original block under $BACKUP_ROOT; restore the Caddyfile from its own backup by hand"
fi
[ -f "$BDIR/old-block.caddy" ] || die "not a backup dir: $BDIR"
if backup_is_managed "$BDIR"; then die "$BDIR holds the managed agentdeck-three-ends block, not the original one; rolling back to it would change nothing"; fi
[ -f "$CADDYFILE" ] || die "Caddyfile not found: $CADDYFILE"

TMP="$(mktemp -d)"
CAND="$(dirname "$CADDYFILE")/.Caddyfile.agentdeck-candidate.$$"
trap 'rm -rf "$TMP"; rm -f "$CAND"' EXIT

python3 "$BLOCK_PY" restore --caddyfile "$CADDYFILE" --old "$BDIR/old-block.caddy" --out "$TMP/Caddyfile.restored"
if grep -q "$MANAGED_BEGIN_RE" "$TMP/Caddyfile.restored"; then die "the managed block would still be in the Caddyfile after the restore; nothing was changed"; fi
cp -p "$CADDYFILE" "$CAND"; cat "$TMP/Caddyfile.restored" > "$CAND"
validate_caddyfile "$CAND" || die "the restored Caddyfile does not validate; nothing was changed"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
( umask 077; cp -p "$CADDYFILE" "$BDIR/Caddyfile.before-rollback.$TS" )
cat "$TMP/Caddyfile.restored" > "$CADDYFILE"
$RELOAD_CMD || die "Caddyfile restored but reload failed: check 'journalctl -u caddy'"
say "rolled back using $BDIR; caddy reloaded"
say "kept (harmless): $AUTH_FILE, $LOG_FILE, the static hub directory"
say "on each machine, delete basePath and label together from endpoint.json (Mac: ~/.config/agentdeck-remote/endpoint.json; Windows: %USERPROFILE%\\.config\\agentdeck-remote\\endpoint.json), then toggle that machine's web service off and on. Deleting only one of the two fields is not a rollback."
