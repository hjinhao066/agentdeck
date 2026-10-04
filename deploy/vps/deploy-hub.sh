#!/usr/bin/env bash
# Publish the static phone hub (mobile-web/hub/) to the VPS as an atomic release, or roll back.
#
#   deploy-hub.sh push SRC_DIR TARGET     upload SRC_DIR as a new release and switch to it
#   deploy-hub.sh rollback TARGET         switch back to the previous release
#   deploy-hub.sh list TARGET             show releases and the current one
#
# TARGET is [user@host:]PARENT, e.g. admin@vps:/srv  or just a local directory (used by the tests).
# Layout under PARENT:  agentdeck-hub -> agentdeck-hub-releases/<UTC timestamp>/   (Caddy serves agentdeck-hub)
# Refuses to replace a real directory at PARENT/agentdeck-hub. Keeps the last 5 releases.
# The hub must not use inline <script>/<style>/style=/on*= (the site CSP forbids them): push checks index.html
# and every *.html; set DEPLOY_HUB_SKIP_CSP_LINT=1 to override. Dotfiles, *.map, tests and node_modules are not uploaded.
set -euo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

CMD="${1:-}"; [ $# -gt 0 ] && shift
KEEP=5
split_target() { # sets HOST (maybe empty) and PARENT
  case "$1" in
    *:*) HOST="${1%%:*}"; PARENT="${1#*:}" ;;
    *) HOST=""; PARENT="$1" ;;
  esac
  [ -n "$PARENT" ] || die "empty target path"
  case "$PARENT" in /*) ;; *) die "target path must be absolute: $PARENT" ;; esac
}
# Run a shell snippet on the target. $1 is the snippet; extra args become $1.. inside it. stdin passes through.
on_target() {
  if [ -n "$HOST" ]; then
    local cmd
    cmd="bash -c $(printf '%q' "set -euo pipefail
$1") bash"
    local a; for a in "${@:2}"; do cmd="$cmd $(printf '%q' "$a")"; done
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$HOST" "$cmd"
  else
    bash -c "set -euo pipefail
$1" bash "${@:2}"
  fi
}

lint_csp() {
  [ "${DEPLOY_HUB_SKIP_CSP_LINT:-}" = 1 ] && return 0
  python3 - "$1" <<'PY' || die "CSP lint failed (override with DEPLOY_HUB_SKIP_CSP_LINT=1 only if you know why)"
import os, re, sys
bad = []
for root, dirs, files in os.walk(sys.argv[1]):
    dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
    for name in files:
        if not name.endswith(".html"):
            continue
        path = os.path.join(root, name)
        html = open(path, encoding="utf-8", errors="replace").read()
        if any(not re.search(r"\bsrc\s*=", m.group(1), re.I) for m in re.finditer(r"<script\b([^>]*)>", html, re.I)):
            bad.append(f"{path}: inline <script>")
        if re.search(r"<style[\s>]", html, re.I):
            bad.append(f"{path}: inline <style>")
        if re.search(r"\sstyle\s*=", html, re.I):
            bad.append(f"{path}: style= attribute")
        if re.search(r"\son[a-z]+\s*=", html, re.I):
            bad.append(f"{path}: on*= event handler attribute")
for line in bad:
    print("CSP lint:", line, "(blocked by the site Content-Security-Policy)", file=sys.stderr)
sys.exit(1 if bad else 0)
PY
}

push() {
  [ $# -eq 2 ] || { usage; exit 1; }
  local src="$1"; split_target "$2"
  [ -f "$src/index.html" ] || die "$src/index.html not found"
  lint_csp "$src"
  local ts rel
  ts="${DEPLOY_HUB_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"; rel="agentdeck-hub-releases/$ts"
  on_target '
cd "$1"
if [ -e agentdeck-hub ] && [ ! -L agentdeck-hub ]; then echo "ERROR: $1/agentdeck-hub is a real directory; move it away first" >&2; exit 1; fi
mkdir -p "$2"' "$PARENT" "$PARENT/$rel"
  # regular files only; dotfiles, *.map, tests/ and node_modules/ stay behind
  ( cd "$src" && find . -type f ! -path '*/.*' ! -name '*.map' ! -path '*/node_modules/*' ! -path './tests/*' -print0 \
      | tar --null -T - -cf - ) \
    | on_target 'tar -C "$1" -xf - && chmod -R a+rX,go-w "$1"' "$PARENT/$rel"
  on_target '
cd "$1"
test -f "$2/index.html"
prev="$(readlink agentdeck-hub 2>/dev/null || true)"
ln -sfn "$2" agentdeck-hub.next
mv -T agentdeck-hub.next agentdeck-hub 2>/dev/null || mv -fh agentdeck-hub.next agentdeck-hub
# keep the newest $3 releases
ls -1d agentdeck-hub-releases/20* 2>/dev/null | sort -r | tail -n +"$(($3 + 1))" | while read -r old; do [ "$old" = "$2" ] || rm -rf "$old"; done || true
echo "current: $(readlink agentdeck-hub)   previous: ${prev:-none}"' "$PARENT" "$rel" "$KEEP"
}

rollback() {
  [ $# -eq 1 ] || { usage; exit 1; }
  split_target "$1"
  on_target '
cd "$1"
[ -L agentdeck-hub ] || { echo "ERROR: agentdeck-hub is not a symlink; nothing to roll back" >&2; exit 1; }
cur="$(readlink agentdeck-hub)"
prev="$(ls -1d agentdeck-hub-releases/20* | sort | grep -B1 -Fx "$cur" | head -n 1)"
if [ -z "$prev" ] || [ "$prev" = "$cur" ]; then echo "ERROR: no previous release before $cur" >&2; exit 1; fi
ln -sfn "$prev" agentdeck-hub.next
mv -T agentdeck-hub.next agentdeck-hub 2>/dev/null || mv -fh agentdeck-hub.next agentdeck-hub
echo "current: $(readlink agentdeck-hub)   (was: $cur)"' "$PARENT"
}

list() {
  [ $# -eq 1 ] || { usage; exit 1; }
  split_target "$1"
  on_target 'cd "$1"; echo "current: $(readlink agentdeck-hub 2>/dev/null || echo none)"; ls -1d agentdeck-hub-releases/20* 2>/dev/null || true' "$PARENT"
}

case "$CMD" in
  push) push "$@" ;;
  rollback) rollback "$@" ;;
  list) list "$@" ;;
  *) usage; exit 1 ;;
esac
