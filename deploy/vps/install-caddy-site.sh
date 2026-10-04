#!/usr/bin/env bash
# Put the AgentDeck three-ends site block into /etc/caddy/Caddyfile. Run on the VPS as root.
#
#   install-caddy-site.sh --check    build and validate the new Caddyfile; change nothing
#   install-caddy-site.sh            back up, replace ONLY this site's block, validate, reload Caddy
#
# Only the block for the AgentDeck address is replaced (first run) or the BEGIN/END region (later runs);
# every other site stays byte-for-byte. The entry basicauth hash is taken from the existing block into
# /etc/caddy/agentdeck-basicauth.caddy and is never printed. Roll back with rollback-caddy-site.sh.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODE=apply
case "${1:-}" in
  --check) MODE=check ;;
  "") ;;
  -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown argument: $1" ;;
esac

need_cmd python3; need_cmd "$CADDY_BIN"
[ -f "$CADDYFILE" ] || die "Caddyfile not found: $CADDYFILE"
[ -f "$SNIPPET" ] || die "snippet not found: $SNIPPET"
if [ "$MODE" = apply ] && ! is_root && [ -z "${AGENTDECK_ALLOW_NON_ROOT:-}" ]; then die "run as root (sudo)"; fi

TMP="$(mktemp -d)"
CAND="$(dirname "$CADDYFILE")/.Caddyfile.agentdeck-candidate.$$"
STAGED_AUTH="$(dirname "$CADDYFILE")/.agentdeck-basicauth.candidate.$$"
trap 'rm -rf "$TMP"; rm -f "$CAND" "$STAGED_AUTH"' EXIT

render_snippet "$TMP/site.caddy"
LOG_DIR="$(dirname "$LOG_FILE")"
[ -d "$LOG_DIR" ] || die "log directory missing: $LOG_DIR"

# 1. Entry credentials: keep the existing file; otherwise lift them from the current block.
AUTH_CREATED=0
if [ -f "$AUTH_FILE" ]; then
  say "auth file exists: $AUTH_FILE (kept)"
  ( umask 077; cp "$AUTH_FILE" "$STAGED_AUTH" )
else
  python3 "$BLOCK_PY" auth --caddyfile "$CADDYFILE" --address "$ADDRESS" --out "$TMP/auth.caddy" \
    || die "cannot take the basicauth entry from the current Caddyfile; create $AUTH_FILE by hand (see README)"
  AUTH_CREATED=1
  ( umask 077; cp "$TMP/auth.caddy" "$STAGED_AUTH" )
fi
protect_for_caddy "$STAGED_AUTH"

# 2. Candidate Caddyfile = current file with this one block swapped.
python3 "$BLOCK_PY" replace --caddyfile "$CADDYFILE" --address "$ADDRESS" --new "$TMP/site.caddy" \
  --out "$TMP/Caddyfile.new" --old-out "$TMP/old-block.caddy" || die "could not build the new Caddyfile; nothing changed"

# 3. Validate the candidate where the live file lives (relative imports resolve), with the staged auth file.
cp -p "$CADDYFILE" "$CAND"
sed "s#$AUTH_FILE#$STAGED_AUTH#g" "$TMP/Caddyfile.new" > "$CAND"
validate_caddyfile "$CAND" || die "caddy validate failed; nothing was changed"
say "caddy validate: ok"
OLD_LINES="$(wc -l < "$TMP/old-block.caddy" | tr -d ' ')"
say "plan: replace $OLD_LINES existing line(s) of the $ADDRESS block; all other sites untouched"
if [ "$MODE" = check ]; then say "check only: no files were changed"; exit 0; fi

# 4. Back up first, then create the auth file / log file, validate the real thing, write, reload.
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BDIR="$BACKUP_ROOT/$TS"
( umask 077; mkdir -p "$BACKUP_ROOT" "$BDIR" )
chmod 0700 "$BACKUP_ROOT" "$BDIR"
cp -p "$CADDYFILE" "$BDIR/Caddyfile"
cp "$TMP/old-block.caddy" "$BDIR/old-block.caddy"; chmod 0600 "$BDIR/old-block.caddy"
{ echo "created_utc=$TS"; echo "caddyfile=$CADDYFILE"; echo "auth_file_created=$AUTH_CREATED"; } > "$BDIR/STATE"
say "backup: $BDIR (root-only; the old block holds the entry hash)"

if [ "$AUTH_CREATED" = 1 ]; then
  ( umask 077; cp "$TMP/auth.caddy" "$AUTH_FILE" )
  protect_for_caddy "$AUTH_FILE"
  say "auth file created: $AUTH_FILE"
fi
# The access log must belong to the service user, not be root-owned from a root-run command.
if [ ! -e "$LOG_FILE" ]; then : > "$LOG_FILE"; fi
if is_root && id caddy >/dev/null 2>&1; then chown caddy:caddy "$LOG_FILE"; chmod 0640 "$LOG_FILE"; fi

cat "$TMP/Caddyfile.new" > "$CAND"
validate_caddyfile "$CAND" || die "validation with the real auth/log paths failed; Caddyfile untouched (backup kept)"
cat "$TMP/Caddyfile.new" > "$CADDYFILE"   # in place: keeps owner, mode, inode
say "Caddyfile updated"

if ! $RELOAD_CMD; then
  say "reload FAILED; restoring the previous block" >&2
  python3 "$BLOCK_PY" restore --caddyfile "$CADDYFILE" --old "$BDIR/old-block.caddy" --out "$TMP/Caddyfile.restored"
  cat "$TMP/Caddyfile.restored" > "$CADDYFILE"
  $RELOAD_CMD || say "reload after restore also failed: check 'journalctl -u caddy' now" >&2
  die "install aborted and rolled back"
fi
say "caddy reloaded. Next: README 'checks after reload'. Roll back: rollback-caddy-site.sh"
