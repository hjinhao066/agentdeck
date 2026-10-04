#!/bin/bash
# Replace the installed AgentDeck with a new build, outside AgentDeck itself.
#   bash scripts/restart-agentdeck.sh --go [--dmg PATH] [--sha256 HEX]
# Without --go it only prints the plan. Quitting AgentDeck ends every terminal in
# it (队长 and its sessions), so run it when that is fine. It detaches itself first
# (own session, nohup), so it survives AgentDeck quitting, even when started from a
# terminal inside AgentDeck. Progress: ~/Library/Logs/AgentDeck-restart.log
# Steps: back up the installed app and the saved conversations -> quit AgentDeck
# normally (never killed) -> install the new app via a staging copy -> open it and
# check it stays up. If any step fails after the backup, it puts the old app back.
# Rollback by hand: bash scripts/rollback-agentdeck.sh
set -u
# the AGENTDECK_* variables exist so the script can be rehearsed on a scratch copy
APP="${AGENTDECK_APP:-/Applications/AgentDeck.app}"
DATA="${AGENTDECK_DATA:-$HOME/Library/Application Support/AgentDeck}"
BACKUPS="${AGENTDECK_BACKUPS:-$HOME/Library/Caches/AgentDeck-install-backups}"
LOG="${AGENTDECK_LOG:-$HOME/Library/Logs/AgentDeck-restart.log}"
OPEN="${AGENTDECK_OPEN:-open}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DMG="$HERE/dist/AgentDeck-1.0.0-arm64.dmg"
SHA=3fb0e16e1705fbba49c7228a7222ab830f0b1cc44143720c3f39c1c02eba707e
GO=0; CHILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;; --child) CHILD=1 ;;
    --dmg) DMG="$2"; shift ;; --sha256) SHA="$2"; shift ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac; shift
done
log() { echo "$(date '+%F %T') $*"; }   # the detached run's stdout is the log file

if [ "$CHILD" = 0 ]; then
  [ -f "$DMG" ] || { echo "no such file: $DMG"; exit 1; }
  echo "Installed : $(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null || echo none)"
  echo "New build : $DMG"
  echo "Backups   : $BACKUPS/<time>-<version>/  (old app + conversations)"
  echo "Log       : $LOG"
  if [ "$GO" != 1 ]; then echo "Nothing done. Add --go to restart AgentDeck onto the new build."; exit 0; fi
  mkdir -p "$(dirname "$LOG")"
  # detach: new session, immune to the hang-up when AgentDeck's terminals close
  nohup /usr/bin/python3 -c 'import os,sys; os.setsid(); os.execv("/bin/bash", ["bash"]+sys.argv[1:])' "$0" --child --dmg "$DMG" --sha256 "$SHA" >>"$LOG" 2>&1 </dev/null &
  echo "Started in the background (pid $!). Follow it with: tail -f \"$LOG\""
  exit 0
fi

# ---- detached part ----
sleep 3
OLDVER="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null || echo none)"
BK="$BACKUPS/$(date +%Y%m%d-%H%M%S)-$OLDVER"
MNT=""; STAGE="$APP.new"
cleanup() { [ -n "$MNT" ] && hdiutil detach "$MNT" -quiet >/dev/null 2>&1; rm -rf "$STAGE"; }
running() { pgrep -f "$APP/Contents/MacOS/AgentDeck" >/dev/null; }
restore() {
  log "restoring the old app from $BK"
  rm -rf "$APP"; ditto "$BK/AgentDeck.app" "$APP" && $OPEN "$APP"
  log "old app back: $(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null)"
}
fail() { log "FAILED: $*"; cleanup; exit 1; }
trap cleanup EXIT

log "== restart $OLDVER -> new build =="
[ "$(shasum -a 256 "$DMG" | cut -d' ' -f1)" = "$SHA" ] || fail "DMG checksum does not match"
MNT="$(hdiutil attach "$DMG" -nobrowse -readonly -noautoopen | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
[ -d "$MNT/AgentDeck.app" ] || fail "no AgentDeck.app inside the DMG"
codesign --verify --deep --strict "$MNT/AgentDeck.app" || fail "new app signature check failed"
NEWVER="$(plutil -extract CFBundleShortVersionString raw "$MNT/AgentDeck.app/Contents/Info.plist")"
log "new build $NEWVER verified"

mkdir -p "$BK/userData" || fail "cannot create backup folder"
ditto "$APP" "$BK/AgentDeck.app" || fail "backup of the old app failed"
for f in config.json chats sessions long-prompts board-control; do
  [ -e "$DATA/$f" ] && ditto "$DATA/$f" "$BK/userData/$f"
done
echo "$OLDVER" > "$BK/VERSION"
log "backup in $BK"

if running; then
  log "quitting AgentDeck normally"
  osascript -e 'tell application "AgentDeck" to quit' >/dev/null 2>&1
  for i in $(seq 1 60); do running || break; sleep 1; done
  running && fail "AgentDeck did not quit within 60s (not killed). Old app untouched; quit it yourself and run again."
fi
sleep 2

rm -rf "$STAGE"
ditto "$MNT/AgentDeck.app" "$STAGE" || { restore; fail "copy to staging failed"; }
xattr -cr "$STAGE"
codesign --verify --deep --strict "$STAGE" || { restore; fail "staged app signature check failed"; }
rm -rf "$APP" && mv "$STAGE" "$APP" || { restore; fail "could not put the new app in place"; }
log "installed $NEWVER"

$OPEN "$APP"
UP=0
for i in $(seq 1 30); do running && { UP=1; break; }; sleep 1; done
[ "$UP" = 1 ] && { sleep 10; running || UP=0; }
if [ "$UP" != 1 ]; then restore; fail "the new version did not stay up; old version restored"; fi
log "AgentDeck $NEWVER is running. Rollback: bash $HERE/scripts/rollback-agentdeck.sh --go"
