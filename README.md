# dev-env

Start from a factory-reset WSL2 Ubuntu PC. End with a full dev setup.
Run these commands:

```sh
sudo apt-get update && sudo apt-get install -y git gh
gh auth login
git clone git@github.com:a913cb82/dev-env.git ~/dev-env
cd ~/dev-env && ./bootstrap.sh
```

## What you get

**System tools.** `bootstrap.sh` installs git, gh, tmux, ripgrep, curl,
jq, Python 3 with pip. No Node, no Rust, no Go. Python is sufficient.

**Shell.** Bash reads two new files at startup. `10-env.sh` adds
`~/.local/bin` to PATH. `20-aliases.sh` adds `ll`, `gs`, `gp`.
Your `.bashrc` stays stock except one loader line.

**Terminal.** `tmux.conf` turns on mouse support, scroll-to-copy-mode,
drag-to-copy through Windows clipboard, true color, long scrollback.
It targets WSL specifically.

**Git.** `gitconfig` sets the commit identity, uses `gh` for passwords,
ignores junk files globally (`*.pyc`, `.DS_Store`, `node_modules`,
`.env`), and makes `main` the default branch.

**SSH.** `bootstrap.sh` creates an `ed25519` key if none exists. It shows
the public key. Add it to GitHub by hand.

**Pi agent.** `bootstrap.sh` links AGENTS.md, settings, and keybindings.
It links four skills: `selphy-print` (print photos on Canon SELPHY),
`asd-ste100` (rewrite text in Simple Technical English), `web-fetch`
(read URLs as clean text), `web-search` (search the live web).
It links four extensions: `btw` (ask side questions in parallel),
`fullscreen-scroll` (scroll the fullscreen UI), `goal` (track session
goals), `subagents` (run background subagents). Pi starts with the
opencode provider, fullscreen UI, and high thinking level.

## Sync

Live files are symlinks into this repo. Edits sync automatically.
Only new or deleted skills/extensions can drift. Two commands fix that.

Receive: `git pull`, then `./bootstrap.sh`. It links new repo files,
prunes stale links, and never touches real live files.

Send: `./sync.sh`, then commit and push. It adopts new live files and
reports deletions. The pre-commit hook blocks unsynced commits. Enable it:

```sh
git config core.hooksPath "$PWD/hooks"
```

## Manual steps

`bootstrap.sh` ends with a checklist. It never stores credentials.
Complete `gh auth login`, pi auth, and GitHub ssh key setup by hand.

## Out of scope

No VS Code settings, no credentials, no caches, nothing project-specific.
