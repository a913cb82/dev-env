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
grep -qF 'shell/bashrc.d/*.sh' "$HOME/.bashrc" 2>/dev/null \
  || echo "$LOADER" >> "$HOME/.bashrc"
link "$REPO/shell/tmux.conf" "$HOME/.tmux.conf"

section "git"
link "$REPO/git/gitconfig" "$HOME/.gitconfig"
link "$REPO/git/gitignore_global" "$HOME/.gitignore_global"

section "ssh"
if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
  [ -z "$CHECK_ONLY" ] && ssh-keygen -t ed25519 -N "" -f "$HOME/.ssh/id_ed25519"
  echo "Add this key to GitHub:"
  cat "$HOME/.ssh/id_ed25519.pub"
fi

section "pi"
if ! command -v pi >/dev/null; then
  echo "TODO: install pi (requires Node, kept outside this env)"
fi
mkdir -p "$PI/skills" "$PI/extensions"
link "$REPO/pi/agent/AGENTS.md" "$PI/AGENTS.md"
link "$REPO/pi/agent/keybindings.json" "$PI/keybindings.json"
link "$REPO/pi/agent/settings.json" "$PI/settings.json"
for s in "$REPO"/pi/agent/skills/*/; do link "$s" "$PI/skills/$(basename "$s")"; done
for e in "$REPO"/pi/agent/extensions/*; do link "$e" "$PI/extensions/$(basename "$e")"; done

section "verify"
command -v git gh rg tmux python3 pi >/dev/null && echo "tools present"
test -L "$HOME/.gitconfig" && echo "gitconfig linked"
test -f "$HOME/.ssh/id_ed25519" && echo "ssh key present"
gh auth status >/dev/null 2>&1 && echo "gh authed" || echo "TODO: gh auth login"
test -f "$PI/auth.json" && echo "pi authed" || echo "TODO: pi auth"
echo "DONE"
