# Shared helpers for the AgentDeck VPS scripts. Sourced, not executed.
# Every path and command can be overridden by environment variables so the tests can run the real
# scripts against a temporary directory and stub commands; on the VPS the defaults apply.

ADDRESS="${AGENTDECK_ADDRESS:-agentdeck.18-139-28-180.sslip.io}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
AUTH_FILE="${AGENTDECK_AUTH_FILE:-/etc/caddy/agentdeck-basicauth.caddy}"
GATE_FILE="${AGENTDECK_GATE_FILE:-/etc/caddy/agentdeck-gate.caddy}"
LOG_FILE="${AGENTDECK_LOG_FILE:-/var/log/caddy/agentdeck-access.log}"
HUB_ROOT="${AGENTDECK_HUB_ROOT:-/srv/agentdeck-hub}"
BACKUP_ROOT="${AGENTDECK_BACKUP_ROOT:-/var/backups/agentdeck-three-ends}"
CADDY_BIN="${CADDY_BIN:-caddy}"
RELOAD_CMD="${RELOAD_CMD:-systemctl reload caddy}"
# Validate as the user the service runs as, so validation cannot create root-owned files (e.g. the log file)
# that the running Caddy then cannot open. Empty = current user (tests).
VALIDATE_AS="${VALIDATE_AS-caddy}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNIPPET="$SCRIPT_DIR/Caddyfile.agentdeck"
BLOCK_PY="$SCRIPT_DIR/caddyfile_block.py"
SNIPPET_AUTH_PATH=/etc/caddy/agentdeck-basicauth.caddy
SNIPPET_GATE_PATH=/etc/caddy/agentdeck-gate.caddy
SNIPPET_LOG_PATH=/var/log/caddy/agentdeck-access.log
SNIPPET_HUB_PATH=/srv/agentdeck-hub

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

is_root() { [ "$(id -u)" = 0 ]; }

# Run a command as VALIDATE_AS when we are root and that account exists; otherwise as ourselves.
as_service_user() {
  if [ -n "$VALIDATE_AS" ] && is_root && id "$VALIDATE_AS" >/dev/null 2>&1; then
    if command -v runuser >/dev/null 2>&1; then runuser -u "$VALIDATE_AS" -- "$@"; else su -s /bin/sh "$VALIDATE_AS" -c "$(printf '%q ' "$@")"; fi
  else
    "$@"
  fi
}

# The snippet hard-codes the production paths; substitute only when the environment overrides them.
render_snippet() { # $1 = output file
  python3 - "$SNIPPET" "$1" "$AUTH_FILE" "$LOG_FILE" "$HUB_ROOT" "$SNIPPET_AUTH_PATH" "$SNIPPET_LOG_PATH" "$SNIPPET_HUB_PATH" "$GATE_FILE" "$SNIPPET_GATE_PATH" <<'PY'
import sys
src, out, auth, log, hub, d_auth, d_log, d_hub, gate, d_gate = sys.argv[1:]
text = open(src, encoding="utf-8").read()
for new, old in ((auth, d_auth), (gate, d_gate), (log, d_log), (hub, d_hub)):
    text = text.replace(old, new)
open(out, "w", encoding="utf-8").write(text)
PY
}

validate_caddyfile() { # $1 = file
  local out
  if ! out="$(as_service_user "$CADDY_BIN" validate --config "$1" --adapter caddyfile 2>&1)"; then
    printf '%s\n' "$out" | tail -n 15 >&2
    return 1
  fi
}

# A backup whose old-block is already our own BEGIN/END region came from a re-install; rolling back to it does nothing.
MANAGED_BEGIN_RE='^# BEGIN agentdeck-three-ends'
backup_is_managed() { grep -q "$MANAGED_BEGIN_RE" "$1/old-block.caddy"; }

# Newest backup that holds the block as it was before AgentDeck (or an empty block: the site did not exist).
latest_original_backup() {
  [ -d "$BACKUP_ROOT" ] || return 1
  local d
  while IFS= read -r d; do
    [ -f "$d/old-block.caddy" ] || continue
    if backup_is_managed "$d"; then continue; fi
    printf '%s\n' "$d"
    return 0
  done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort -r)
  return 1
}

# Make a file holding credentials readable only by root and the Caddy service user.
protect_for_caddy() {
  chmod 0640 "$1"
  if is_root && id caddy >/dev/null 2>&1; then chown root:caddy "$1"; else chmod 0600 "$1"; fi
}
