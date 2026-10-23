#!/usr/bin/env bash
# Regression test for the Pi install path. Stubs apt, uv, curl, node, and npm;
# the "installer" is a local script that records whether it had a terminal.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
export HOME="$TMP/home"
BIN="$TMP/bin"
mkdir -p "$HOME" "$BIN"
export PATH="$BIN:$PATH"

cat > "$BIN/sudo" <<'S'
#!/bin/sh
exec "$@"
S
cat > "$BIN/apt-get" <<'S'
#!/bin/sh
exit 0
S
cat > "$BIN/uv" <<'S'
#!/bin/sh
exit 0
S
cat > "$BIN/node" <<'S'
#!/bin/sh
[ "$1" = "--version" ] && echo v22.22.1
exit 0
S
cat > "$BIN/npm" <<'S'
#!/bin/sh
# Only the bootstrap pin call is expected: npm --prefix <dir> install ...
prefix=
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix=$2; shift 2 ;;
    install) shift; break ;;
    *) shift ;;
  esac
done
[ -n "$prefix" ] || exit 1
mkdir -p "$prefix/node_modules/.bin"
cat > "$prefix/node_modules/.bin/pi" <<'P'
#!/bin/sh
cat "$HOME/.pi/agent/install/current-version"
P
chmod +x "$prefix/node_modules/.bin/pi"
S
cat > "$BIN/curl" <<'S'
#!/bin/sh
out=
url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
[ "$url" = "https://pi.dev/install.sh" ] || exit 1
cat > "$out" <<'I'
#!/bin/sh
if ( : <>/dev/tty ) 2>/dev/null; then echo has-tty > "$HOME/installer-tty"
else echo no-tty > "$HOME/installer-tty"; fi
mkdir -p "$HOME/.local/bin" "$HOME/.pi/agent/bin" "$HOME/.pi/agent/install/releases/latest"
cat > "$HOME/.local/bin/pi" <<'P'
#!/bin/sh
v=$(cat "$HOME/.pi/agent/install/current-version" 2>/dev/null || echo latest)
exec "$HOME/.pi/agent/install/releases/$v/node_modules/.bin/pi" "$@"
P
chmod +x "$HOME/.local/bin/pi"
ln -s "$HOME/.local/bin/pi" "$HOME/.pi/agent/bin/pi"
I
S
chmod +x "$BIN"/*

"$REPO/bootstrap.sh" >"$TMP/bootstrap.log" 2>&1 || { cat "$TMP/bootstrap.log" >&2; fail "bootstrap failed"; }

[ "$(cat "$HOME/installer-tty")" = no-tty ] || fail "installer kept the controlling terminal"
[ -f "$HOME/.pi/agent/install/current-version" ] || fail "current-version missing"
[ "$(cat "$HOME/.pi/agent/install/current-version")" = 1.0.0 ] || fail "Pi was not pinned"
[ "$(wc -l < "$HOME/.pi/agent/install/current-version")" -eq 1 ] \
  || fail "current-version has no trailing newline"
[ "$(readlink "$HOME/.pi/agent/subagents.json")" = "$REPO/pi/agent/subagents.json" ] \
  || fail "subagents.json is not linked"

echo "PASS: pi install"
