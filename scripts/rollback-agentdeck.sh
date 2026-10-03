#!/bin/bash
# Put the previous AgentDeck back (the newest backup made by restart-agentdeck.sh).
#   bash scripts/rollback-agentdeck.sh --go [--backup DIR] [--with-data]
# Without --go it only says what it would restore. --with-data also puts back the
# conversations saved in the backup: anything written after the backup is lost, so
# only use it if the new version damaged them. Quits AgentDeck normally, never kills it.
set -u
# the AGENTDECK_* variables exist so the script can be rehearsed on a scratch copy
APP="${AGENTDECK_APP:-/Applications/AgentDeck.app}"
DATA="${AGENTDECK_DATA:-$HOME/Library/Application Support/AgentDeck}"
BACKUPS="${AGENTDECK_BACKUPS:-$HOME/Library/Caches/AgentDeck-install-backups}"
LOG="${AGENTDECK_LOG:-$HOME/Library/Logs/AgentDeck-restart.log}"
OPEN="${AGENTDECK_OPEN:-open}"
GO=0; CHILD=0; WITHDATA=0; BK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;; --child) CHILD=1 ;; --with-data) WITHDATA=1 ;;
    --backup) BK="$2"; shift ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac; shift
done
[ -n "$BK" ] || BK="$(ls -1d "$BACKUPS"/*/ 2>/dev/null | while read -r d; do [ -d "${d}AgentDeck.app" ] && echo "${d%/}"; done | tail -1)"
[ -d "$BK/AgentDeck.app" ] || { echo "no backup with an app found in $BACKUPS"; exit 1; }
log() { echo "$(date '+%F %T') $*"; }   # the detached run's stdout is the log file
if [ "$CHILD" = 0 ]; then
  echo "Would restore $(cat "$BK/VERSION" 2>/dev/null) from $BK$([ $WITHDATA = 1 ] && echo ' (with conversations)')"
  [ "$GO" = 1 ] || { echo "Nothing done. Add --go."; exit 0; }
  mkdir -p "$(dirname "$LOG")"
  args=(--child --go --backup "$BK"); [ $WITHDATA = 1 ] && args+=(--with-data)
  nohup /usr/bin/python3 -c 'import os,sys; os.setsid(); os.execv("/bin/bash", ["bash"]+sys.argv[1:])' "$0" "${args[@]}" >>"$LOG" 2>&1 </dev/null &
  echo "Started in the background. Follow it with: tail -f \"$LOG\""
  exit 0
fi
sleep 3
running() { pgrep -f "$APP/Contents/MacOS/AgentDeck" >/dev/null; }
log "== rollback to $(cat "$BK/VERSION" 2>/dev/null) from $BK =="
if running; then
  osascript -e 'tell application "AgentDeck" to quit' >/dev/null 2>&1
  for i in $(seq 1 60); do running || break; sleep 1; done
  running && { log "FAILED: AgentDeck did not quit within 60s (not killed)"; exit 1; }
fi
sleep 2
if [ $WITHDATA = 1 ]; then
  for f in config.json chats sessions long-prompts board-control; do
    [ -e "$BK/userData/$f" ] && { rm -rf "$DATA/$f"; ditto "$BK/userData/$f" "$DATA/$f"; }
  done
  log "conversations restored from the backup"
fi
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"
ditto "$BK/AgentDeck.app" "$APP" || { log "FAILED: copy failed, putting the current app back"; rm -rf "$APP"; mv "$APP.old" "$APP"; exit 1; }
rm -rf "$APP.old"
$OPEN "$APP"
for i in $(seq 1 30); do running && break; sleep 1; done
running && log "rollback done, AgentDeck $(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist") is running" || log "FAILED: the old app did not start"
