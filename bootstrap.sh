#!/usr/bin/env bash
# Bootstrap a full dev environment from this repo. Idempotent: safe to
# re-run after `git pull`. Usage: ./bootstrap.sh [--check-only]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI="$HOME/.pi/agent"
CHECK_ONLY="${1:-}"

link() { # link <source> <dest>: symlink file/dir, creating parents.
  # A real (non-symlink) directory at dest is removed first: repo content
  # originates from live, so this only ever discards a stale duplicate.
  mkdir -p "$(dirname "$2")"
  if [ -d "$2" ] && [ ! -L "$2" ]; then rm -rf "$2"; fi
  ln -sfn "$1" "$2"
}

section() { echo "=== $1"; }

section "packages"
if [ -z "$CHECK_ONLY" ]; then
  sudo apt-get update -qq
  xargs -a "$REPO/apt-requirements.txt" sudo apt-get install -y -qq
fi

section "shell"
LOADER="for f in \"$REPO\"/shell/bashrc.d/*.sh; do . \"\$f\"; done"
if ! grep -qF 'shell/bashrc.d/*.sh' "$HOME/.bashrc" 2>/dev/null; then
  echo "$LOADER" >> "$HOME/.bashrc"
fi
link "$REPO/shell/tmux.conf" "$HOME/.tmux.conf"

section "git"
link "$REPO/git/gitconfig" "$HOME/.gitconfig"
link "$REPO/git/gitignore_global" "$HOME/.gitignore_global"

section "ssh"
if [ ! -f "$HOME/.ssh/id_ed25519" ] && [ -z "$CHECK_ONLY" ]; then
  ssh-keygen -t ed25519 -N "" -f "$HOME/.ssh/id_ed25519"
fi
if [ ! -f "$HOME/.ssh/id_ed25519.pub" ]; then
  echo "Add this key to GitHub:"; cat "$HOME/.ssh/id_ed25519.pub"
fi

section "pi"
if ! command -v pi >/dev/null; then
  echo "TODO: install pi (requires Node, kept outside this env)"
fi
mkdir -p "$PI/skills" "$PI/extensions"
link "$REPO/pi/agent/AGENTS.md" "$PI/AGENTS.md"
link "$REPO/pi/agent/keybindings.json" "$PI/keybindings.json"
link "$REPO/pi/agent/settings.json" "$PI/settings.json"
link_area() { # link_area <repo-dir> <live-dir>: link every repo entry live.
  # Live real files/dirs are never touched (unadopted work?): sync.sh owns
  # that direction. Stale live symlinks (gone from repo) are pruned.
  for src in "$1"/*; do
    [ -e "$src" ] || continue
    dst="$2/$(basename "$src")"
    if [ -e "$dst" ] && [ ! -L "$dst" ]; then
      echo "KEEP: $dst is real, not linked — run ./sync.sh first"
      continue
    fi
    link "$src" "$dst"
  done
  for dst in "$2"/*; do
    { [ -e "$dst" ] || [ -L "$dst" ]; } || continue
    if [ ! -e "$1/$(basename "$dst")" ]; then
      if [ -L "$dst" ]; then echo "PRUNE: stale link $dst"; rm "$dst";
      else echo "UNADOPTED: $dst — run ./sync.sh to adopt it"; fi
    fi
  done
}
for s in skills extensions; do link_area "$REPO/pi/agent/$s" "$PI/$s"; done

section "verify"
if command -v git >/dev/null && command -v gh >/dev/null && command -v rg >/dev/null && command -v tmux >/dev/null && command -v python3 >/dev/null && command -v pi >/dev/null; then echo "tools present"; fi
if [ -L "$HOME/.gitconfig" ]; then echo "gitconfig linked"; fi
if [ -f "$HOME/.ssh/id_ed25519" ]; then echo "ssh key present"; fi
gh auth status >/dev/null 2>&1 && echo "gh authed" || echo "TODO: gh auth login"
test -f "$PI/auth.json" && echo "pi authed" || echo "TODO: pi auth"
echo "DONE"
