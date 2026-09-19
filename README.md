# dev-env

Full dev environment in a repo. New machine (WSL2 Ubuntu) to working setup:

```sh
sudo apt-get update && sudo apt-get install -y git gh
gh auth login
git clone git@github.com:a913cb82/dev-env.git ~/dev-env
cd ~/dev-env && ./bootstrap.sh
```

## The two flows (the core of this repo)

Everything in `~/.pi/agent` is a symlink into this repo, so file *content*
is always in sync in both directions — editing a skill edits the repo file
directly. The only thing that can drift is the file *set* (new or deleted
skills/extensions). The two scripts cover exactly that:

**Pull (repo → machine): `./bootstrap.sh`**
Links every repo entry live. Safe by construction: live real files are never
touched (reported as KEEP/UNADOPTED instead), stale live symlinks are pruned.
Re-run after every `git pull`.

**Push (machine → live): `./sync.sh`**
Adopts new live skills/extensions into the repo (and re-links them),
refreshes changed files. Deletions are reported, never applied. Run before
every commit — `hooks/pre-commit` enforces it (enabled via
`git config core.hooksPath "$PWD/hooks"`).

So: pull + bootstrap to receive, sync + commit + push to send. Content never
needs syncing; structure syncs through these two commands.

## Manual steps (never automated, never stored here)

- `gh auth login` (if the verify step nags)
- pi auth (if the verify step nags)
- Add `~/.ssh/id_ed25519.pub` to GitHub (printed by bootstrap on first run)

## Layout

- `shell/` — bash snippets sourced from stock `.bashrc` (one appended line),
  tmux config. Bash only, general tooling only.
- `git/` — gitconfig (noreply identity, gh credential helper, global
  ignores, `main` default) + global ignores.
- `pi/` — AGENTS.md, settings, keybindings, all skills, all extensions.
- `apt-requirements.txt` — system packages. Python only by choice: no
  nvm/cargo/Go here.
- `bootstrap.sh` / `sync.sh` / `hooks/` — above.

## Out of scope on purpose

No VS Code settings, no credentials of any kind (`.aws`, `.kaggle`,
`auth.json`, private keys), no caches or shell history, nothing
project-specific.

Tested with pi 0.85.1 on Ubuntu 24.04 (WSL2).
