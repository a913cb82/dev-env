# dev-env

Full dev environment in a repo. New machine (WSL2 Ubuntu) to working setup:

```sh
sudo apt-get update && sudo apt-get install -y git gh
gh auth login
git clone git@github.com:a913cb82/dev-env.git ~/dev-env
cd ~/dev-env && ./bootstrap.sh
```

`bootstrap.sh` is idempotent — re-run it after every `git pull`. It symlinks
everything into place (repo stays source of truth), installs apt packages,
generates an ssh key if missing, installs pi if missing, and ends with a
verification checklist.

## Manual steps (never automated, never stored here)

- `gh auth login` (if the verify step nags)
- pi auth (if the verify step nags)
- Add `~/.ssh/id_ed25519.pub` to GitHub (printed by bootstrap on first run)

## Layout

- `shell/` — bash snippets sourced from stock `.bashrc` (one appended line),
  tmux config. Bash only, by choice.
- `git/` — gitconfig (noreply identity, LFS, gh credential helper, global
  ignores, `main` default) + global ignores.
- `pi/` — AGENTS.md, settings, keybindings, all skills, all extensions, and
  a vendored snapshot of pi-subagents (re-snapshot from GitHub to update).
  `settings.json` is the one file copied rather than symlinked: bootstrap
  injects the machine-local package path.
- `apt-requirements.txt` — system packages. Python only by choice: no
  nvm/cargo/Go here.
- `bootstrap.sh` — the whole setup, re-runnable.

## Out of scope on purpose

No VS Code settings, no credentials of any kind (`.aws`, `.kaggle`,
`auth.json`, private keys), no caches or shell history.

Tested with pi 0.85.1 on Ubuntu 24.04 (WSL2).
