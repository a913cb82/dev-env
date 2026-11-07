---
name: autoresearch
description: Improve code against a repeatable score. Parallel explorer subagents each propose one change in a git worktree; the coordinator lands each change on the current champion, scores it, and keeps only confirmed gains. Use for measurable optimization (benchmarks, test metrics, game ratings). Not for one-off fixes or subjective quality.
---

# autoresearch

**Terms.** *Target*: folder explorers may edit. *Frozen*: paths nobody edits. *Gate*: fast pass/fail, no score. *Exam*: scored command, valid when exit 0 and last line `SCORE <number>`. *Loop branch*: where keeps land. *Champion*: its HEAD. *Margin*: keep if gain > `max(noise, min gain)`, noise = max-min of baselines.

`<skill>` is the folder holding this file (pi: `~/.pi/agent/skills/autoresearch`). Run commands from the repo root.

## Setup (once)

1. `git status --porcelain` clean. `git switch -c <loop> <base>` (or `git switch <loop>`).
2. `mkdir <run> <run>/results <worktrees>` outside the repo. Copy `templates/EXAM.md`, `QUEUE.md`, `PROGRESS.jsonl` into `<run>`. Fill `QUEUE.md`, best idea first. Fill `<run>/EXAM.md`; `grep TODO` empty.
3. Baseline: `git worktree add --detach <worktrees>/baseline <loop>`. Setup, gate, exam 3x to `<run>/results/`. Mean = baseline, noise = max-min, margin into `EXAM.md`. Append `baseline` row, remove worktree. Stop and ask if gate/exam fail or noise > min gain.

## Loop

Keep up to `explorers` (from `EXAM.md`) running. Wait for any to finish (pi: `check_subagents`, mode any):

1. **Spawn.** First `open` idea. `git worktree add --detach <worktrees>/<name> <loop>` (unique name). Mark `trying` + base + worktree. Fill `templates/BRIEF.md`, spawn subagent (pi: `spawn_agent`, `cwd` = worktree, tools `read,bash,edit,write,grep,find,ls`).
2. **Land.** `land.sh <worktree> <base> <champion> <target> <frozen...>`, champion = `git rev-parse <loop>`. `ok <sha> <tree>`: continue. `conflict`: back to `open`, no attempt. `reject: <reason>` / `duplicate`: discard.
3. **Validate.** Tree already in `PROGRESS.jsonl`: discard seen. Else gate, then exam to `results/<sha>-1.log` in worktree. Fail / invalid: discard.
4. **Confirm.** Beat champion by > margin in `direction`? No: discard. Yes: exam again (`-2.log`); keep only if mean still beats by > margin. Champion score = `score` of last `baseline` / `keep`.
5. **Keep.** `git merge --ff-only <sha>` from root (fail: stop). Champion = `<sha>`. Append `PROGRESS.jsonl` row, `git worktree remove --force <worktree>`. Keep → `done`; discard → `dropped` after 3 attempts else `open`. Refill slot.

Cancelled/crashed = `lost`: remove worktree, reopen with no attempt. Stop spawning after `candidate budget` returns or no `open`. Let runners finish; cancel past `explorer budget` (pi: `cancel_subagent`). Empty queue but more worth trying: add from `learned` + code.

## Finish

1. Score baseline commit + champion with `holdout`. Append `holdout` rows.
2. Remove worktrees, `git worktree prune`. Report champion, baseline vs champion both sets, keeps, drops, loop branch. Push only if asked. Never merge into the base branch.

## Rules

- Explorers run gate only; they never run the exam, read logs/scores; briefs carry `learned` lines only. Only you score and move the loop.
- Land (rebase) first, then score the kept tree; keep with `--ff-only`.
- Exam/inputs fixed per run dir; change = new run dir. Run dir + worktrees outside the repo; logs append-only.
- Timing depends on load: prefer a count, else min gain above noise.
- State in `QUEUE.md` + `PROGRESS.jsonl` (schema: `references/progress.md`). After a restart, re-read both and `git worktree list`, clean up as `lost`.
