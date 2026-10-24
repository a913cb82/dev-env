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
2. Write `EXAM.md` in the run folder. Copy `templates/EXAM.md` and fill it. It records the blind gate command, the scored exam command, the budget, the tag, and the stop rule.
3. Copy the notes. Run one block:
   `RUN=runs/<date>-<slug> && mkdir -p $RUN && cp templates/* $RUN/ && touch $RUN/PROGRESS.jsonl`
   Fill the starting backlog. Statuses are defined in [notes](notes.md).
4. Measure the baseline. Run the scored exam on unchanged code. Repeat it on one box. Use the spread to set a noise bar. Smaller gains are not real. Confirm the blind gate runs inside a fresh work area quickly. Write both numbers in `STRATEGY.md`. Paste them into `BRIEF.md`.
5. Prepare one work area per explorer. Run `git worktree add --detach <path>` for each one. Install deps and build inside each area before you spawn. Keep one spare area ready. See [worktrees](worktrees.md).
6. Set N and work budgets from the share. Fill the box without starving the scorer. Write N in `EXAM.md`.

   Fill-in block (worked example — tune per run):

   ```
   box: <cores, RAM>                    # example: 16 cores, 64 GB
   gate x3: <wall, peak RAM>            # example: 12 s, 1.5 GB
   exam x1: <wall, peak RAM>            # example: 8 min, 4 GB
   share: <percent of box>              # example: 75%
   exam slots: <usually 1>
   N = floor((share - exam reserve) / one explorer)
   explorer budget = N x exam time / exam slots   # example: clamp 5-60 min
   queue target: 1 submit waiting while 1 exam runs
   ```

   The quick check uses a lot of power for short bursts. Writing code between checks uses little power. Plan by average use. Leave room for peak use.
   Keep one finished result waiting while you test. Set each time limit near N times test time. Divide that number by test slots.
7. Write the pass rule in `EXAM.md`. Start with: blind gate passes in the explorer tree, suite passes, output is stable, only the score changes. List past failures below it.

## Exit checklist

Setup passes when all hold:

- [ ] `EXAM.md` names a blind gate that passes in a fresh work area quickly, plus a scored exam that runs end to end on the baseline.
- [ ] The same commit replays zero tests.
- [ ] Baseline and noise floor are in `STRATEGY.md` and `BRIEF.md`.
- [ ] The run folder holds filled notes and an empty `PROGRESS.jsonl`.
- [ ] Work areas build clean. One spare stands by.
- [ ] N, loop branch, and stop rule are in `EXAM.md`.

## Traps

- Finish env and builds before you spawn. Setup must not burn explorer time.
- Do not create a branch for untested code.
- Put maps and notes in the brief. Do not make explorers search from zero.
