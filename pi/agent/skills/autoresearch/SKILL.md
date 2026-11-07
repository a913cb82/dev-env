---
name: autoresearch
description: Improve code against a repeatable score. Parallel explorer subagents each propose one change in a git worktree; the coordinator lands each change on the current champion, scores it, and keeps only confirmed gains. Use for measurable optimization (benchmarks, test metrics, game ratings). Not for one-off fixes or subjective quality.
---

# autoresearch

**Terms.** *Target*: the folder explorers may edit. *Frozen*: paths nobody edits (exam, gate, tests, data). *Gate*: fast pass/fail check that prints no score. *Exam*: scored command; valid when it exits 0 and its last line is `SCORE <number>`. *Loop branch*: where kept changes land. *Champion*: its current commit. *Margin*: gain needed to keep, `max(noise, min gain)`, where noise = max − min of baseline runs.

`<skill>` is the folder holding this file (pi: `~/.pi/agent/skills/autoresearch`). Run commands from the repo root.

## Setup (once)

1. `git status --porcelain` must print nothing. Then `git switch -c <loop> <base>` (or `git switch <loop>` if it exists).
2. `mkdir <run> <run>/results <worktrees>`, outside the repo. Copy `<skill>/templates/EXAM.md`, `QUEUE.md`, and `PROGRESS.jsonl` into `<run>`.
3. Fill `<run>/EXAM.md`. `grep TODO <run>/EXAM.md` must print nothing.
4. Baseline: `git worktree add --detach <worktrees>/baseline <loop>`. In it, run setup, the gate, then the exam 3 times, logging each run to `<run>/results/`. Baseline = mean of runs. Write the margin into `EXAM.md`. Append a `baseline` row to `PROGRESS.jsonl`. Remove the worktree.
5. Fill `QUEUE.md`, best idea first.

Stop and ask the user if the gate or exam fails on baseline, or if noise is larger than min gain.

## Loop

Keep up to `explorers` (from `EXAM.md`) explorers running. Wait for any to finish (pi: `check_subagents`, mode any), then handle it:

1. **Spawn.** Take the first `open` idea. `git worktree add --detach <worktrees>/<name> <loop>`, with a unique name. Mark the row `trying` and record its base (the loop commit now) and worktree. Fill a copy of `templates/BRIEF.md`, then spawn a subagent (pi: `spawn_agent`) with `cwd` set to the worktree and tools `read,bash,edit,write,grep,find,ls`.
2. **Land.** Run `<skill>/scripts/land.sh <worktree> <base> <champion> <target> <frozen...>`, where champion = `git rev-parse <loop>` now.
   - `ok <sha> <tree>`: continue.
   - `conflict`: status `open`, no attempt.
   - `reject: <reason>` or `duplicate`: discard.
3. **Seen?** If `<tree>` already appears in `PROGRESS.jsonl`, discard as `seen`.
4. **Gate** in the worktree. Fail: discard.
5. **Exam** in the worktree, logged to `results/<sha>-1.log`. Not valid: discard.
6. **Confirm.** Does it beat the champion's score by more than margin, in the `direction`? If not, discard. If yes, run the exam again (`-2.log`). Keep only if the mean of both runs still beats the champion by more than margin. The champion's score is the `score` of its last `baseline` or `keep` row.
7. **Keep.** From the repo root, `git merge --ff-only <sha>`. If that fails, stop and report. The champion is now `<sha>`.
8. **Record.** Append one `PROGRESS.jsonl` row, then `git worktree remove --force <worktree>`. Each keep or discard is one attempt. Keep → `done`. Discard → `dropped` after 3 attempts, else `open`.
9. **Refill** the free slot.

A cancelled or crashed explorer is `lost`: remove its worktree and reopen the idea with no attempt. Stop spawning after `candidate budget` returned explorers, or when no `open` ideas remain. Let running explorers finish. Cancel any past `explorer budget` (pi: `cancel_subagent`). If the queue is empty but more is worth trying, add ideas from the `learned` lines and the code.

## Finish

1. Score the baseline commit and the champion with the `holdout` command. Append `holdout` rows.
2. Remove every worktree under `<worktrees>`, then run `git worktree prune`.
3. Report the champion, baseline vs champion on both input sets, keeps, drops, and the loop branch. Push only if asked. Never merge into the base branch.

## Rules

- Explorers run only the gate. They never run the exam, read logs, or see scores. Their briefs carry only `learned` lines.
- Only you score and move the loop branch.
- Score the tree you keep: land (rebase) first, then gate and exam. Keep with `--ff-only`.
- Exam and inputs are fixed per run dir. A change means a new run dir.
- Keep the run dir and worktrees outside the repo. Logs are append-only.
- Timing scores depend on load. Prefer a count; otherwise set min gain above the noise you see.
- State lives in `QUEUE.md` and `PROGRESS.jsonl`. After a restart, re-read both and `git worktree list`, then clean up as for `lost`.

A `PROGRESS.jsonl` row, one per decision (`decision`: `baseline`, `keep`, `discard`, `stale`, `holdout`):

```json
{"date":"2025-01-02","idea":"cache lookups","decision":"keep","why":"confirmed","sha":"ab12cd3","tree":"9f8e7d6","runs":[4.10,4.02],"score":4.06,"champion":"ab12cd3","learned":"Lookups dominate the profile; caching cut them."}
```
