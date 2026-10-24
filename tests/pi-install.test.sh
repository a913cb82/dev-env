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
case "$url" in
  https://pi.dev/install.sh)
    [ -n "$out" ] || exit 1
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
    ;;
  https://ketch.run/install)
    # Piped to `sh -s -- --version X --bin-dir Y`.
    [ -z "$out" ] || exit 1
    cat <<'I'
#!/bin/sh
BIN_DIR="$HOME/.local/bin"
while [ $# -gt 0 ]; do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --bin-dir=*) BIN_DIR="${1#*=}"; shift ;;
    *) shift ;;
  esac
done
mkdir -p "$BIN_DIR"
printf '#!/bin/sh\necho "ketch stub"\n' > "$BIN_DIR/ketch"
chmod +x "$BIN_DIR/ketch"
I
    ;;
esac
S
chmod +x "$BIN"/*

"$REPO/bootstrap.sh" >"$TMP/bootstrap.log" 2>&1 || { cat "$TMP/bootstrap.log" >&2; fail "bootstrap failed"; }

[ "$(cat "$HOME/installer-tty")" = no-tty ] || fail "installer kept the controlling terminal"
[ -f "$HOME/.pi/agent/install/current-version" ] || fail "current-version missing"
[ "$(cat "$HOME/.pi/agent/install/current-version")" = 1.0.0 ] || fail "Pi was not pinned"
# A user-run `pi update` plants a newer release: re-running bootstrap must
# neither downgrade nor wipe it.
mkdir -p "$HOME/.pi/agent/install/releases/9.9.9/node_modules/.bin"
cat > "$HOME/.pi/agent/install/releases/9.9.9/node_modules/.bin/pi" <<'P'
#!/bin/sh
echo 9.9.9
P
chmod +x "$HOME/.pi/agent/install/releases/9.9.9/node_modules/.bin/pi"
printf '%s\n' 9.9.9 > "$HOME/.pi/agent/install/current-version"
"$REPO/bootstrap.sh" >"$TMP/bootstrap2.log" 2>&1 || { cat "$TMP/bootstrap2.log" >&2; fail "bootstrap after pi update failed"; }
[ "$(cat "$HOME/.pi/agent/install/current-version")" = 9.9.9 ] || fail "bootstrap downgraded a pi update"
[ -x "$HOME/.pi/agent/install/releases/9.9.9/node_modules/.bin/pi" ] || fail "bootstrap wiped the updated release"
[ -d "$HOME/.pi/agent/install/releases/1.0.0" ] || fail "bootstrap wiped the pinned release"
[ "$(wc -l < "$HOME/.pi/agent/install/current-version")" -eq 1 ] \
  || fail "current-version has no trailing newline"
[ "$(readlink "$HOME/.pi/agent/subagents.json")" = "$REPO/pi/agent/subagents.json" ] \
  || fail "subagents.json is not linked"

echo "PASS: pi install"
