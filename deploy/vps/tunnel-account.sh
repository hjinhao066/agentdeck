#!/usr/bin/env bash
# Create or remove the restricted VPS account used by the Windows reverse tunnel. Run on the VPS as root.
#
#   tunnel-account.sh create --pubkey FILE [--dry-run]   FILE = the Windows PUBLIC key (one ed25519 line)
#   tunnel-account.sh remove [--dry-run]
#
# create: system user agentdeck-tunnel-win (nologin, no password), authorized_keys with
#   restrict,port-forwarding,permitlisten="127.0.0.1:43123", sshd drop-in, `sshd -t`, then reload ssh.
#   Existing SSH sessions survive a reload. The Mac account/config is never touched.
# remove: delete the drop-in and the account, `sshd -t`, reload.
# Private keys are refused. Nothing secret is printed.
set -euo pipefail

ACCOUNT=agentdeck-tunnel-win
PORT=43123
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_SRC="$SCRIPT_DIR/sshd_agentdeck-tunnel-win.conf"
# ROOT lets the tests run the real script against a scratch tree with stub commands.
ROOT="${AGENTDECK_ROOT:-}"
CONF_DIR="$ROOT/etc/ssh/sshd_config.d"
CONF="$CONF_DIR/agentdeck-tunnel-win.conf"
SSHD_MAIN="$ROOT/etc/ssh/sshd_config"
HOME_DIR="$ROOT/var/lib/$ACCOUNT"
BACKUP_ROOT="${AGENTDECK_BACKUP_ROOT:-$ROOT/var/backups/agentdeck-three-ends}"
SSHD_BIN="${SSHD_BIN:-sshd}"
RELOAD_SSH="${RELOAD_SSH:-}"
AUTH_OPTS="restrict,port-forwarding,permitlisten=\"127.0.0.1:$PORT\""

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

ACTION="${1:-}"; [ $# -gt 0 ] && shift
PUBKEY=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pubkey) PUBKEY="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ "$ACTION" = create ] || [ "$ACTION" = remove ] || { usage; exit 1; }
if [ "$DRY" = 0 ] && [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then die "run as root (sudo)"; fi

run() { if [ "$DRY" = 1 ]; then say "[dry-run] $*"; else "$@"; fi; }

reload_ssh() {
  if [ -n "$RELOAD_SSH" ]; then $RELOAD_SSH; return; fi
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
}

check_sshd() { "$SSHD_BIN" -t; }

verify_effective() {
  local out
  out="$("$SSHD_BIN" -T -C "user=$ACCOUNT,host=localhost,addr=127.0.0.1" 2>/dev/null)" || die "sshd -T failed"
  printf '%s\n' "$out" | grep -qx "permitlisten 127.0.0.1:$PORT" || die "effective config lacks permitlisten 127.0.0.1:$PORT"
  printf '%s\n' "$out" | grep -qx "allowtcpforwarding remote" || die "effective config: allowtcpforwarding is not remote"
  printf '%s\n' "$out" | grep -qx "maxsessions 0" || die "effective config: maxsessions is not 0"
  printf '%s\n' "$out" | grep -qx "gatewayports no" || die "effective config: gatewayports is not no"
  say "effective sshd settings for $ACCOUNT verified"
}

validate_pubkey() {
  [ -n "$PUBKEY" ] || die "--pubkey FILE is required"
  [ -f "$PUBKEY" ] || die "no such file: $PUBKEY"
  grep -q 'PRIVATE KEY' "$PUBKEY" && die "that is a PRIVATE key. Give the .pub file; never copy a private key to the VPS"
  [ "$(grep -c . "$PUBKEY")" = 1 ] || die "the public key file must contain exactly one key line"
  KEY_LINE="$(grep . "$PUBKEY" | head -n 1 | tr -d '\r')"
  case "$KEY_LINE" in ssh-ed25519\ *) ;; *) die "only ssh-ed25519 public keys are accepted (line must start with 'ssh-ed25519 ')" ;; esac
  KEY_TYPE_AND_BLOB="$(printf '%s' "$KEY_LINE" | awk '{print $1" "$2}')"
  printf '%s\n' "$KEY_TYPE_AND_BLOB" | ssh-keygen -l -f /dev/stdin >/dev/null 2>&1 || die "not a valid public key"
  say "public key ok: $(printf '%s\n' "$KEY_TYPE_AND_BLOB" | ssh-keygen -l -f /dev/stdin | awk '{print $2}')"
}

create() {
  [ -f "$CONF_SRC" ] || die "missing $CONF_SRC"
  validate_pubkey
  if [ -z "$ROOT" ] && ! grep -Eqs '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' "$SSHD_MAIN"; then
    die "$SSHD_MAIN does not Include /etc/ssh/sshd_config.d/*.conf; add that line by hand first"
  fi
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT "; then
    say "warning: something already listens on 127.0.0.1:$PORT"
  fi
  local ts bdir
  ts="$(date -u +%Y%m%dT%H%M%SZ)"; bdir="$BACKUP_ROOT/tunnel-account-$ts"
  run mkdir -p "$CONF_DIR"
  if [ "$DRY" = 0 ]; then
    ( umask 077; mkdir -p "$BACKUP_ROOT" "$bdir" )
    if [ -e "$CONF" ]; then cp -p "$CONF" "$bdir/agentdeck-tunnel-win.conf.previous"; fi
  fi

  if ! id "$ACCOUNT" >/dev/null 2>&1; then
    run useradd --system --home-dir "${HOME_DIR#"$ROOT"}" --create-home --shell /usr/sbin/nologin "$ACCOUNT"
    # '*' (not '!'): the account stays without any password but is not "locked", so sshd accepts its key.
    run usermod -p '*' "$ACCOUNT"
    say "account created: $ACCOUNT"
  else
    say "account exists: $ACCOUNT (kept)"
  fi

  if [ "$DRY" = 1 ]; then
    say "[dry-run] write $HOME_DIR/.ssh/authorized_keys: $AUTH_OPTS <key>"
    say "[dry-run] install $CONF (from $CONF_SRC), sshd -t, verify effective settings, reload ssh"
    return
  fi
  mkdir -p "$HOME_DIR/.ssh"
  ( umask 077; printf '%s %s\n' "$AUTH_OPTS" "$KEY_LINE" > "$HOME_DIR/.ssh/authorized_keys" )
  chmod 0700 "$HOME_DIR/.ssh"; chmod 0600 "$HOME_DIR/.ssh/authorized_keys"
  chown -R "$ACCOUNT:$ACCOUNT" "$HOME_DIR" 2>/dev/null || chown -R "$ACCOUNT" "$HOME_DIR"
  chmod 0755 "$HOME_DIR"

  cp "$CONF_SRC" "$CONF"; chmod 0644 "$CONF"
  if ! check_sshd; then
    say "sshd -t FAILED; removing the new drop-in" >&2
    rm -f "$CONF"
    [ -e "$bdir/agentdeck-tunnel-win.conf.previous" ] && cp -p "$bdir/agentdeck-tunnel-win.conf.previous" "$CONF"
    die "sshd config invalid; nothing reloaded"
  fi
  verify_effective || { rm -f "$CONF"; die "effective settings wrong; drop-in removed, nothing reloaded"; }
  reload_ssh
  say "ssh reloaded. Test from Windows: ssh -N -R 127.0.0.1:$PORT:127.0.0.1:43121 $ACCOUNT@<vps> (see README)"
  say "undo: tunnel-account.sh remove"
}

remove() {
  local ts bdir
  ts="$(date -u +%Y%m%dT%H%M%SZ)"; bdir="$BACKUP_ROOT/tunnel-account-remove-$ts"
  if [ "$DRY" = 0 ]; then
    ( umask 077; mkdir -p "$BACKUP_ROOT" "$bdir" )
    [ -e "$CONF" ] && cp -p "$CONF" "$bdir/" || true
    [ -e "$HOME_DIR/.ssh/authorized_keys" ] && cp -p "$HOME_DIR/.ssh/authorized_keys" "$bdir/" || true
  fi
  run rm -f "$CONF"
  if id "$ACCOUNT" >/dev/null 2>&1; then run userdel -r "$ACCOUNT" || say "userdel reported a problem (home may need manual removal)"; fi
  if [ "$DRY" = 1 ]; then say "[dry-run] sshd -t, reload ssh"; return; fi
  check_sshd || die "sshd -t failed after removal: restore $bdir/agentdeck-tunnel-win.conf if needed; nothing reloaded"
  reload_ssh
  say "removed $ACCOUNT and its sshd drop-in; the Mac account (agentdeck-tunnel) was not touched"
}

"$ACTION"
