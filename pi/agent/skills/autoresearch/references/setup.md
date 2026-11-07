# Setup

Run setup once for each codebase. You can repeat it safely. Do not start explorers until the checklist passes.

## When to run setup

- The run folder, `EXAM.md`, or `PROGRESS.jsonl` is missing.
- The target moved or the test changed.
- Otherwise skip to [run](run.md).

## Inputs

- Target folder. Explorers edit this folder only.
- Run folder. Example: `runs/<date>-<slug>/`. One run uses one folder.
- Test command. This is the only way to score a change.
- Loop branch name. It is never `main`.

## Steps

1. Name what can change and what cannot. Explorers edit the target only. They never edit the test, the notes, or other explorers' files.
2. Write `EXAM.md` in the run folder. Copy `templates/EXAM.md` and fill it: blind gate and scored exam commands, budget, tag, stop rule, baseline, noise floor, limits.
3. Copy the notes (missing files only — never clobber a live run):
   `RUN=runs/<date>-<slug> && mkdir -p $RUN && cp -n templates/EXAM.md templates/QUEUE.md templates/WORKLOG.md templates/PROGRESS.jsonl $RUN/`
   Fill the starting backlog. Statuses live in `QUEUE.md`.
4. Measure the baseline. Run the scored exam on unchanged code. Repeat at least 3 times back to back on one box. Use the spread to set a noise bar. Smaller gains are not real. Confirm the blind gate runs inside a fresh work area quickly. Write both numbers in `EXAM.md`. Paste them into `BRIEF.md`.
5. Prepare one work area per explorer. Run `git worktree add --detach <path>` for each one. Install deps and build inside each area before you spawn. Keep one spare area ready. Do not create a branch for untested code. See [worktrees](worktrees.md).
6. Set share, N, and budgets in `EXAM.md` per its N formula; reserve peak headroom.
7. Write the pass rule in `EXAM.md`. Start with: blind gate passes in the explorer tree, suite passes, output is stable, only the score changes. List past failures below it.

## Exit checklist

Setup passes when all hold:

- [ ] `EXAM.md` names a blind gate that passes in a fresh work area quickly, plus a scored exam that runs end to end on the baseline.
- [ ] The same commit replays zero tests.
- [ ] Baseline and noise floor are in `EXAM.md` and `BRIEF.md`.
- [ ] The run folder holds filled notes and an empty `PROGRESS.jsonl`.
- [ ] Work areas build clean. One spare stands by.
- [ ] N, loop branch, and stop rule are in `EXAM.md`.
