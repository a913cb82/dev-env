# dev-env

Configures WSL Ubuntu for development. It installs tools, shell defaults, Git defaults, SSH, and the Pi agent.

## Use

This section is for PCs that run the environment. It makes no changes to this repo.

### Install on a new PC

1. Install Git and gh: `sudo apt-get update && sudo apt-get install -y git gh`
2. Authenticate with GitHub: `gh auth login`
3. Clone the repo: `git clone git@github.com:a913cb82/dev-env.git ~/dev-env`
4. Run bootstrap: `cd ~/dev-env && ./bootstrap.sh`
5. Enable the commit hook: `git config core.hooksPath "$PWD/hooks"`
6. Complete the checklist that bootstrap prints. It covers gh auth, Pi auth, and the SSH key.

### Update an existing PC

1. Receive updates: `git pull --ff-only`
2. Link new files and prune stale links: `./bootstrap.sh --check-only`
3. Confirm the state: `./sync.sh --check`

Pi itself updates independently: `pi update` installs the newest release and
bootstrap never downgrades it (the pin is a floor, not an exact version).
After `pi update`, verify the extensions' assumptions still hold:

1. `./tests/pi-internals.test.sh` pins the Pi internals the collapse view patches.
2. `./tests/*.test.sh` covers bootstrap links, the Pi install path and the skills.
3. `node pi/agent/extensions/collapse/*.test.cjs` and
   `node pi/agent/extensions/subagents/*.test.cjs` exercise the extensions directly
   (each prints `ok -` lines; any `FAIL -` is a real break).
4. `node pi/agent/extensions/collapse/replay/parity.cjs <session.jsonl>` replays a real
   transcript and diffs stock vs collapse rendering.
5. `./sync.sh --check` for drift.

Dependency layout moves between releases (deps were nested under the pi package
before 1.5.x and are hoisted to the release root afterwards; `~/.pi/agent/bin/pi`
is a launcher script, so `realpath` of it is not the package). The tests resolve
through Node and `install/current-version` rather than assuming a layout.

Use `./bootstrap.sh` without flags only when you also want new tools. It calls `apt-get`, installs uv and Pi if missing, and can ask for `sudo`.

### After you move the clone

Paths are absolute. The move breaks symlinks, the `~/.bashrc` loader, and `core.hooksPath`.

1. Run bootstrap from the new location: `cd <new-location> && ./bootstrap.sh --check-only`
2. Reset the hook path: `git config core.hooksPath "$PWD/hooks"`
3. Fix the loader line in `~/.bashrc`. Change the old path to the new path.
4. Confirm the state: `./sync.sh --check`

## Develop

This section is for changes to this repo itself.

Live files are symlinks into this repo. Edits to linked files write directly to the repo. Only new or deleted skills and extensions can drift.

### Send a change

1. Adopt live files into the repo: `./sync.sh`
2. Review the result: `git status -sb`
3. Commit and push. The pre-commit hook blocks the commit when `./sync.sh --check` reports drift.

Edit repo files first when possible. Avoid direct edits under `~/.pi`. Run `./sync.sh --check` before you commit. Run the regression tests with `./tests/*.test.sh`.

### Contents

- `bootstrap.sh`: installs packages, uv, and Pi (pinned via `PI_VERSION`), then links live files. It is safe to run more than once.
- `sync.sh`: adopts live files into the repo. `--check` reports drift without writing.
- `tests/`: regression tests for bootstrap links and the Pi install path.
- `hooks/pre-commit`: blocks commits with drift. Enable it with `core.hooksPath`.
- `shell/`: `tmux.conf` for WSL and `bashrc.d/` shell defaults.
- `git/`: commit identity, gh credential helper, global ignores.
- `pi/agent/`: agent instructions, settings, keybindings, skills, and extensions.
- `pi/agent/extensions/collapse/`: one-line tool rows and a thinking preview while thinking is hidden. See its `README.md` for the run, boundary, and click-depth rules.
