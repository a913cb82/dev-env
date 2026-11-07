# Setup

Once per codebase; safe to repeat. No explorers until the checklist passes.

## When

- The run folder, `EXAM.md`, or `PROGRESS.jsonl` is missing; the target moved; the test changed.
- Otherwise skip to [run](run.md).

## Inputs

- Target folder. Explorers edit this folder only.
- Run folder. Example: `runs/<date>-<slug>/`. One run, one folder.
- Test command. The only way to score a change.
- Loop branch. Never `main`.

## Steps

1. Draw the boundary. Explorers edit the target only — never the test, the notes, or each other's files.
2. Write `EXAM.md`: copy `templates/EXAM.md`, fill every field.
3. Copy notes, missing files only (never clobber a live run):
   `RUN=runs/<date>-<slug> && mkdir -p $RUN && cp -n templates/EXAM.md templates/QUEUE.md templates/WORKLOG.md templates/PROGRESS.jsonl $RUN/`
   Fill the starting backlog.
4. Measure the baseline: run the exam on unchanged code, 3+ times back to back on one box. The spread sets the noise bar; smaller gains are not real. Confirm the gate runs fast in a fresh work area. Write both numbers in `EXAM.md`; paste them into `BRIEF.md`.
5. Build one detached work area per explorer (`git worktree add --detach <path>`), deps installed, plus one spare. No branches for untested code. See [worktrees](worktrees.md).
6. Set share, N, and budgets in `EXAM.md` per its N formula; keep peak headroom.
7. Write the pass rule in `EXAM.md`: gate passes in-tree, suite passes, output stable, only the score changes — then past failures.

## Exit checklist

- [ ] `EXAM.md`: gate passes fast in a fresh area; exam runs end to end on baseline.
- [ ] Same commit replays zero tests.
- [ ] Baseline and noise in `EXAM.md` and `BRIEF.md`.
- [ ] Run folder holds filled notes and empty `PROGRESS.jsonl`.
- [ ] Work areas build clean, one spare ready.
- [ ] N, loop branch, stop rule in `EXAM.md`.
