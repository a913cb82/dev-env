#!/usr/bin/env bash
# Regression tests for linking repo config into a fresh Pi agent dir.
# Runs against a throwaway HOME; no network, packages, or Pi install.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

export HOME="$TMP/home"
mkdir -p "$HOME/.ssh"
ssh-keygen -q -t ed25519 -N "" -f "$HOME/.ssh/id_ed25519"

# --check-only still links repo files, so it covers the fresh-PC path.
if ! "$REPO/bootstrap.sh" --check-only >"$TMP/bootstrap.log" 2>&1; then
  cat "$TMP/bootstrap.log" >&2
  fail "bootstrap --check-only exited non-zero"
fi

for f in AGENTS.md keybindings.json settings.json subagents.json; do
  dest="$HOME/.pi/agent/$f"
  [ -L "$dest" ] || fail "$f is not a symlink"
  [ "$(readlink -f "$dest")" = "$REPO/pi/agent/$f" ] \
    || fail "$f points to $(readlink -f "$dest")"
done

for area in skills extensions; do
  for src in "$REPO/pi/agent/$area"/*; do
    dest="$HOME/.pi/agent/$area/$(basename "$src")"
    [ -L "$dest" ] || fail "$area/$(basename "$src") is not linked"
  done
done

# sync.sh must not abort when a live file is missing (fresh agent dir):
# there is nothing to adopt, so report it and keep going.
rm -f "$HOME/.pi/agent/subagents.json"
if ! "$REPO/sync.sh" >"$TMP/sync.log" 2>&1; then
  cat "$TMP/sync.log" >&2
  fail "sync.sh aborted on a missing live file"
fi
grep -q "MISSING: subagents.json" "$TMP/sync.log" \
  || fail "sync.sh did not report the missing live file"

if "$REPO/sync.sh" --check >"$TMP/check.log" 2>&1; then
  cat "$TMP/check.log" >&2
  fail "sync.sh --check did not report drift for a missing live file"
fi

echo "PASS: config links"
