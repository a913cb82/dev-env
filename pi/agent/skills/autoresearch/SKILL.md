---
name: autoresearch
description: Improve code against a repeatable score. Parallel generator subagents each work in a git worktree; the coordinator lands each candidate on the champion, scores it serially, and keeps only confirmed gains. Use for measurable optimization (benchmarks, test metrics, game ratings). Not for one-off fixes or subjective quality.
---

# autoresearch

**Terms.** *Target*: folder generators may edit (`blocks` narrows it to marked regions). *Frozen*: paths nobody edits. *Stages*: cheap checks first, costly scoring last. *Exam*: scoring command, exit 0, last line `SCORE <number>` (extra `SCORE <name> <number>` lines allowed; qualitative / model-graded checks fold into scores). *Database*: `PROGRESS.jsonl`, every evaluated program. *Champion*: best primary score. *Margin*: keep if gain > `max(noise, min gain)`, noise = max-min of baselines.

`<skill>` is the folder holding this file (pi: `~/.pi/agent/skills/autoresearch`). Run commands from the repo root.

## Setup (once)

1. `git status --porcelain` clean. `git switch -c <loop> <base>` (or `git switch <loop>`).
2. `mkdir <run> <run>/results <worktrees>` outside the repo. Copy `templates/EXAM.md`, `PROGRESS.jsonl` into `<run>`. Fill `<run>/EXAM.md`; `grep TODO` empty.
3. Baseline: `git worktree add --detach <worktrees>/baseline <loop>`. Setup, stages, exam 3x to `<run>/results/`. Mean = baseline, noise = max-min, margin into `EXAM.md`. Append `baseline` row, remove worktree. Stop and ask if stages/exam fail or noise > min gain.

## Loop

Keep up to `explorers` generators running; score one candidate at a time. Wait for any to finish (pi: `check_subagents`, mode any):

1. **Spawn.** Draft the idea from database priors (champion + best-per-metric + recent diverse) + code; no human queue. `git worktree add --detach <worktrees>/<name> <loop>`. Fill `templates/BRIEF.md` with priors (sha/score/learned) + thinking level (`levels`: bulk low, every Nth high). Spawn (pi: `spawn_agent`, `cwd` = worktree, tools `read,bash,edit,write,grep,find,ls`, `thinking` = level).
2. **Land.** `land.sh <worktree> <base> <champion> <target> <frozen...>`, champion = `git rev-parse <loop>`. `ok <sha> <tree>`: continue. `conflict`: discard. `reject: <reason>` / `duplicate`: discard row.
3. **Validate.** Tree already in database → discard seen. Stages, then exam with `timeout` at 5× the slowest baseline run; overruns record `stale` (retryable). Fail / invalid → discard row. Log to `results/<sha>-1.log`.
4. **Confirm/Keep.** Valid run beats the champion primary by > margin in `direction` with no metric regressions → exam again (`-2.log`); keep only if the mean still beats by > margin. Champion score = last `baseline` / `keep` score. `git merge --ff-only <sha>` from root (fail: stop). Champion = `<sha>`. Append row with metrics + priors used (lineage). Remove the worktree. Every evaluated row stays, so subset-best lines remain future priors. Refill.

Generator lost → remove the worktree, no record. Cancel past `explorer budget` (pi: `cancel_subagent`). Stop spawning after `candidate budget` returns; let runners finish.

## Finish

1. Score the baseline commit + champion with `holdout`. Append `holdout` rows.
2. Remove worktrees, `git worktree prune`. Report the champion, baseline vs champion on both sets, per-metric bests, loop branch. Push only if asked. Never merge into the base branch.

## Rules

- Generators run cheap stages and never the scoring exam; briefs carry priors only and may read prior results logs. Only you score and move the loop branch.
- Commits are diffs: one SEARCH/REPLACE-sized focused change each. Land first, then score; keep with `--ff-only`.
- Exams tolerate concurrent stage runs (unique tmp/ports).
- Unit may be a search program with a time budget + best-so-far input; state it in `inputs`.
- Exam/inputs fixed per run dir; change = new run dir. Run dir + worktrees outside the repo; logs append-only.
- Timing depends on load: prefer a count, else min gain above noise.
- State is the database (schema: `references/progress.md`). After a restart, re-read EXAM + database and `git worktree list`, clean up as `lost`.
