#!/usr/bin/env bash
# Pull live state into this repo. Run before every commit:
#   ./sync.sh          # adopt live changes into the repo
#   ./sync.sh --check  # report drift without writing (used by hooks/pre-commit)
# Direction is live -> repo. New and changed files are adopted; deletions
# are reported, never applied. Live symlinks that already point into this
# repo are skipped (they cannot drift by construction).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI="$HOME/.pi/agent"
CHECK="${1:-}"

drift() { echo "DRIFT: $1"; DIRTY=1; }
note() { [ -n "$CHECK" ] || echo "=== $1"; }
DIRTY=0

copy_dir() { # copy_dir <live> <repo>: exact mirror minus git/node debris
  if [ -n "$CHECK" ]; then
    diff -r -x .git -x node_modules "$1" "$2" >/dev/null 2>&1 || drift "$1"
    return
  fi
  [ -d "$2/node_modules" ] && mv "$2/node_modules" /tmp/sync-keep-nm
  rm -rf "$2"
  cp -r "$1" "$2"
  rm -rf "$2/.git" "$2/node_modules"
  [ -d /tmp/sync-keep-nm ] && mv /tmp/sync-keep-nm "$2/node_modules"
}

in_repo() { [[ "$(readlink -f "$1")" == "$REPO"* ]]; }

note "pi files"
for f in AGENTS.md keybindings.json settings.json; do
  if [ -n "$CHECK" ]; then
    cmp -s "$PI/$f" "$REPO/pi/agent/$f" || drift "$f"
  else
    cp "$PI/$f" "$REPO/pi/agent/$f"
  fi
done

note "skills and extensions"
for area in skills extensions; do
  for live in "$PI/$area"/*; do
    [ -e "$live" ] || continue
    name="$(basename "$live")"
    if { [ -L "$live" ] && in_repo "$live"; } || [ "$name" = "*" ]; then continue; fi
    dest="$REPO/pi/agent/$area/$name"
    if [ -n "$CHECK" ] && [ ! -e "$dest" ]; then drift "new $area/$name"; continue; fi
    if [ -d "$live" ] && [ ! -L "$live" ]; then
      copy_dir "$live" "$dest"
      if [ -z "$CHECK" ]; then rm -rf "$live"; ln -s "$dest" "$live"; fi
    elif [ -n "$CHECK" ]; then
      cmp -s "$live" "$dest" || drift "$area/$name"
    else
      cp "$live" "$dest"
    fi
  done
  if [ -n "$CHECK" ]; then
    for dest in "$REPO"/pi/agent/$area/*; do
      [ -e "$dest" ] || continue
      [ -L "$dest" ] && continue
      [ -e "$PI/$area/$(basename "$dest")" ] \
        || drift "deleted live, present in repo: $area/$(basename "$dest")"
    done
  fi
done

[ -z "$CHECK" ] && echo DONE
[ -n "$CHECK" ] && exit "$DIRTY"
