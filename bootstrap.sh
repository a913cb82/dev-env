#!/usr/bin/env bash
# Bootstrap a full dev environment from this repo. Idempotent: safe to
# re-run after `git pull`. Usage: ./bootstrap.sh [--check-only]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI="$HOME/.pi/agent"
CHECK_ONLY="${1:-}"

link() { # link <source> <dest>: symlink file/dir, creating parents
  mkdir -p "$(dirname "$2")"
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
  [ -z "$CHECK_ONLY" ] && npm install -g @earendil-works/pi-coding-agent
fi
mkdir -p "$PI/skills" "$PI/extensions"
link "$REPO/pi/agent/AGENTS.md" "$PI/AGENTS.md"
link "$REPO/pi/agent/keybindings.json" "$PI/keybindings.json"
for s in "$REPO"/pi/agent/skills/*/; do link "$s" "$PI/skills/$(basename "$s")"; done
for e in "$REPO"/pi/agent/extensions/*; do link "$e" "$PI/extensions/$(basename "$e")"; done
# settings.json is copied (not linked): the packages path is machine-local.
python3 - "$REPO/pi/agent/settings.json" "$PI/settings.json" \
  "$REPO/pi/packages/pi-subagents" <<'EOF'
import json, sys
repo_settings, live_settings, package = sys.argv[1], sys.argv[2], sys.argv[3]
settings = json.load(open(repo_settings))
settings["packages"] = [package]
json.dump(settings, open(live_settings, "w"), indent=2)
EOF

section "verify"
command -v git gh rg tmux python3 pi >/dev/null && echo "tools present"
test -L "$HOME/.gitconfig" && echo "gitconfig linked"
test -f "$HOME/.ssh/id_ed25519" && echo "ssh key present"
gh auth status >/dev/null 2>&1 && echo "gh authed" || echo "TODO: gh auth login"
test -f "$PI/auth.json" && echo "pi authed" || echo "TODO: pi auth"
echo "DONE"
