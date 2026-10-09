#!/usr/bin/env bash
# Create or remove the restricted VPS account used by the Windows reverse tunnel. Run on the VPS as root.
#
#   tunnel-account.sh create --pubkey FILE [--dry-run]   FILE = the Windows PUBLIC key (one ed25519 line)
#   tunnel-account.sh remove [--dry-run]
#   tunnel-account.sh verify                             read-only: re-check what sshd really applies
#
# create: first refuses unless the Mac tunnel account (agentdeck-tunnel) is itself limited by sshd to
#   127.0.0.1:43122 (`sshd -T`), otherwise a compromised Mac could grab 43123 and pose as Windows.
#   Then: system user agentdeck-tunnel-win (nologin, no password), authorized_keys with
#   restrict,port-forwarding,permitlisten="127.0.0.1:43123", sshd drop-in, `sshd -t`, a before/after
#   `sshd -T` comparison for root (the drop-in must not leak outside its Match), then reload ssh.
#   Existing SSH sessions survive a reload. The Mac account/config is never touched.
#   If anything fails after the first change (a check, a command, Ctrl-C, the reload), everything this run
#   changed is put back: the drop-in, authorized_keys, and an account that this run created.
# verify: read-only. Fails unless sshd limits the Mac account to 127.0.0.1:43122 and, once the drop-in is
#   installed, applies the restricted settings to the Windows account. Run it after any sshd change.
# remove: delete the drop-in, end the account's sessions, delete the account, `sshd -t`, reload.
# Private keys are refused. Nothing secret is printed.
set -euo pipefail

ACCOUNT=agentdeck-tunnel-win
PORT=43123
MAC_ACCOUNT=agentdeck-tunnel
MAC_PORT=43122
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
# Create a fresh, root-only backup directory: BASE, or BASE-01, BASE-02 ... when runs share a second.
# Never reused, so a restore can only ever see files written by the current run.
new_backup_dir() { # $1 = BASE; prints the directory
  local base="$1" d="$1" n=0
  ( umask 077; mkdir -p "$BACKUP_ROOT" ); chmod 0700 "$BACKUP_ROOT"
  until ( umask 077; mkdir "$d" ) 2>/dev/null; do
    n=$((n + 1)); [ "$n" -le 99 ] || die "cannot create a backup directory under $BACKUP_ROOT"
    d="$base-$(printf '%02d' "$n")"
  done
  printf '%s' "$d"
}
usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; }

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
[ "$ACTION" = create ] || [ "$ACTION" = remove ] || [ "$ACTION" = verify ] || { usage; exit 1; }
if [ "$DRY" = 0 ] && [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then die "run as root (sudo)"; fi

run() { if [ "$DRY" = 1 ]; then say "[dry-run] $*"; else "$@"; fi; }

reload_ssh() {
  if [ -n "$RELOAD_SSH" ]; then $RELOAD_SSH; return; fi
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
}

check_sshd() { "$SSHD_BIN" -t; }

# What sshd would apply to a user (one "keyword value" line per setting, as `sshd -T` prints it).
effective_for() { "$SSHD_BIN" -T -C "user=$1,host=localhost,addr=127.0.0.1" 2>/dev/null; }

fail() { printf 'ERROR: %s\n' "$*" >&2; return 1; }

# The Mac account's port limit is not managed by this package, so check what sshd really applies to it.
verify_mac_account() {
  local out got
  out="$(effective_for "$MAC_ACCOUNT")" || die "sshd -T failed for $MAC_ACCOUNT; is sshd installed and its config valid?"
  if ! grep -qx "permitlisten 127.0.0.1:$MAC_PORT" <<<"$out"; then
    got="$(printf '%s\n' "$out" | grep '^permitlisten ' || true)"
    die "the Mac tunnel account $MAC_ACCOUNT is not limited to 127.0.0.1:$MAC_PORT by sshd (effective: ${got:-no permitlisten line}). A compromised Mac could take port $PORT and pose as Windows. Add 'Match User $MAC_ACCOUNT' + 'PermitListen 127.0.0.1:$MAC_PORT' to the sshd config first (README), then run this again"
  fi
  say "Mac account $MAC_ACCOUNT is limited to 127.0.0.1:$MAC_PORT by sshd"
}

# Returns non-zero (and says why) instead of exiting, so the caller can put the old drop-in back.
verify_effective() {
  local out
  out="$(effective_for "$ACCOUNT")" || { fail "sshd -T failed"; return 1; }
  grep -qx "permitlisten 127.0.0.1:$PORT" <<<"$out" || { fail "effective config lacks permitlisten 127.0.0.1:$PORT"; return 1; }
  grep -qx "allowtcpforwarding remote" <<<"$out" || { fail "effective config: allowtcpforwarding is not remote"; return 1; }
  grep -qx "maxsessions 0" <<<"$out" || { fail "effective config: maxsessions is not 0"; return 1; }
  grep -qx "gatewayports no" <<<"$out" || { fail "effective config: gatewayports is not no"; return 1; }
  grep -qx "permitopen none" <<<"$out" || { fail "effective config: permitopen is not none"; return 1; }
  say "effective sshd settings for $ACCOUNT verified"
}

# Put the drop-in back to what it was before this run (the previous file, or none).
restore_conf() { # $1 = backup dir
  rm -f "$CONF"
  if [ -e "$1/agentdeck-tunnel-win.conf.previous" ]; then cp -p "$1/agentdeck-tunnel-win.conf.previous" "$CONF"; fi
}

# ---- create is all-or-nothing -------------------------------------------------------------------------
# Armed once the first change is about to be made, disarmed after a successful reload. Any exit in between
# (die, a failing command under set -e, Ctrl-C) undoes what this run changed.
CREATE_ARMED=0; CREATE_BDIR=""; CREATE_ACCOUNT_NEW=0

undo_create() {
  restore_conf "$CREATE_BDIR"
  say "rolled back: sshd drop-in is back to what it was before this run" >&2
  if [ "$CREATE_ACCOUNT_NEW" = 1 ]; then
    # The account was created by this run: take it away again (door first, then any session, then the account).
    rm -f "$HOME_DIR/.ssh/authorized_keys"
    if command -v pkill >/dev/null 2>&1; then pkill -KILL -u "$ACCOUNT" || true; fi
    if id "$ACCOUNT" >/dev/null 2>&1; then
      userdel -r "$ACCOUNT" || say "userdel reported a problem: remove $ACCOUNT and $HOME_DIR by hand" >&2
    fi
    say "rolled back: account $ACCOUNT, created by this run, removed" >&2
  else
    if [ -e "$CREATE_BDIR/authorized_keys.previous" ]; then cp -p "$CREATE_BDIR/authorized_keys.previous" "$HOME_DIR/.ssh/authorized_keys"
    else rm -f "$HOME_DIR/.ssh/authorized_keys"; fi
    say "rolled back: authorized_keys of the existing account $ACCOUNT is back to what it was" >&2
  fi
}

on_create_exit() {
  local rc=$?
  trap - EXIT
  set +e
  if [ "$CREATE_ARMED" = 1 ] && [ "$rc" -ne 0 ]; then
    CREATE_ARMED=0
    say "create failed (exit $rc); undoing what this run changed" >&2
    undo_create
  fi
  exit "$rc"
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
  verify_mac_account
  local root_before=""
  if [ "$DRY" = 0 ]; then root_before="$(effective_for root)" || die "sshd -T failed for user root; is sshd installed and its config valid?"; fi
  if command -v ss >/dev/null 2>&1 && grep -q "127.0.0.1:$PORT " <<<"$(ss -ltn 2>/dev/null || true)"; then
    say "warning: something already listens on 127.0.0.1:$PORT"
  fi
  local ts bdir
  ts="$(date -u +%Y%m%dT%H%M%SZ)"; bdir="$BACKUP_ROOT/tunnel-account-$ts"
  run mkdir -p "$CONF_DIR"
  if [ "$DRY" = 0 ]; then
    bdir="$(new_backup_dir "$bdir")"
    if [ -e "$CONF" ]; then cp -p "$CONF" "$bdir/agentdeck-tunnel-win.conf.previous"; fi
    if [ -e "$HOME_DIR/.ssh/authorized_keys" ]; then ( umask 077; cp -p "$HOME_DIR/.ssh/authorized_keys" "$bdir/authorized_keys.previous" ); fi
    CREATE_BDIR="$bdir"
    trap on_create_exit EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    CREATE_ARMED=1
  fi

  if ! id "$ACCOUNT" >/dev/null 2>&1; then
    [ "$DRY" = 1 ] || CREATE_ACCOUNT_NEW=1
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
  check_sshd || die "sshd config invalid (sshd -t failed); nothing reloaded"
  # The Match block must stay limited to this account: root's effective settings may not change at all.
  [ "$(effective_for root)" = "$root_before" ] || die "installing the drop-in changed the effective sshd settings of user root (Match scope leaked?); nothing reloaded"
  verify_effective || die "effective settings wrong; nothing reloaded"
  reload_ssh || die "ssh reload failed"
  CREATE_ARMED=0
  say "ssh reloaded. Test from Windows: ssh -N -R 127.0.0.1:$PORT:127.0.0.1:43121 $ACCOUNT@<vps> (see README)"
  say "undo: tunnel-account.sh remove"
}

# Read-only. Meant for the go-live checklist and for every time sshd configuration changes afterwards:
# the Mac account's limit is not managed here, so someone loosening it later would otherwise go unnoticed.
verify() {
  verify_mac_account
  if [ -e "$CONF" ]; then
    verify_effective || die "the Windows drop-in is installed but sshd does not apply it as intended"
  else
    say "Windows drop-in not installed ($CONF): nothing more to verify yet"
  fi
  say "verify ok (read-only, nothing was changed)"
}

remove() {
  local ts bdir
  ts="$(date -u +%Y%m%dT%H%M%SZ)"; bdir="$BACKUP_ROOT/tunnel-account-remove-$ts"
  if [ "$DRY" = 0 ]; then
    bdir="$(new_backup_dir "$bdir")"
    [ -e "$CONF" ] && cp -p "$CONF" "$bdir/" || true
    [ -e "$HOME_DIR/.ssh/authorized_keys" ] && cp -p "$HOME_DIR/.ssh/authorized_keys" "$bdir/" || true
  fi
  run rm -f "$CONF"
  if id "$ACCOUNT" >/dev/null 2>&1; then
    # userdel fails while the tunnel is up (the account still owns a running sshd process): close the door first
    # so the Windows side cannot reconnect in between, then end its sessions.
    run rm -f "$HOME_DIR/.ssh/authorized_keys"
    if command -v pkill >/dev/null 2>&1; then run pkill -KILL -u "$ACCOUNT" || true; fi
    run userdel -r "$ACCOUNT" || say "userdel reported a problem (home may need manual removal)"
  fi
  if [ "$DRY" = 1 ]; then say "[dry-run] sshd -t, reload ssh"; return; fi
  check_sshd || die "sshd -t failed after removal: restore $bdir/agentdeck-tunnel-win.conf if needed; nothing reloaded"
  reload_ssh
  say "removed $ACCOUNT and its sshd drop-in; the Mac account (agentdeck-tunnel) was not touched"
}

"$ACTION"
