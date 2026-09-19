# dev-env

Reproduce this dev environment on any WSL2 Ubuntu machine:

```sh
sudo apt-get update && sudo apt-get install -y git gh
gh auth login
git clone git@github.com:a913cb82/dev-env.git ~/dev-env
cd ~/dev-env && ./bootstrap.sh
```

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

## Contents

`shell/` (bash snippets, tmux), `git/` (gitconfig, global ignores),
`pi/` (AGENTS.md, settings, keybindings, skills, extensions),
`apt-requirements.txt` (system packages, Python only).

No VS Code settings, no credentials, no caches, nothing project-specific.
