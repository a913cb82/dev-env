# Run

The loop. Requires a passing [setup](setup.md). You orchestrate. Explorers code.

## Before you start

- The checklist in [setup](setup.md) passes.
- `EXAM.md` in the run folder is the config.
- Your tree is on the loop branch. See [worktrees](worktrees.md) for branch rules.

## One iteration

1. Pick the next `open` idea from `QUEUE.md`. Mark it `trying` and record its owned files in the row. Give it files no live explorer owns. On steer, cancel, or crash, reset `trying` rows to `open` before the next pick.
2. Brief one explorer from `BRIEF.md`: idea+source, HARD budget, baseline/noise, owned vs. never-touch files, baseline/gate/verdict/hash report, gate-only (no exam/scores/logs), past forbids.
3. Wait with `any`. Relaunch when one finishes. Hold one finished result waiting while you test.

   | If | Do |
   |---|---|
   | Exam sits idle | Shorten time limits or add one explorer. |
   | More than one result waits | Give explorers more time per submit. |
   | Computer is too busy | Remove one explorer. |

4. Harvest. See [worktrees](worktrees.md) for the numbered checklist.
5. Test it yourself. Guards first, then the scored exam. See [exam](exam.md).
6. Write it down. Append `PROGRESS.jsonl`. Add one `WORKLOG.md` entry. Never edit an old entry. Mark the queue row `done` or `dropped`. Commit notes as `log: <idea>`. Push the loop branch (branch rules: [worktrees](worktrees.md)).
7. Check the stop rule in `EXAM.md`. Otherwise go to step 1.

## Spawn skeleton

Paste the filled `BRIEF.md` into the spawn task — it is the sole spawn contract.

Tips, not rules: paste one winner diff and one near-miss diff. Use a cheap model for sweeps and a strong model for hard lines. Send pure recon with no code as a table plus one next shot.

## Verdict

- Ignore explorer verdicts. Compute the gain yourself.
- Keep the change only if the gain beats the noise floor.
- Check score, stability, and cost. Do not use score alone.
- Repeat close calls (within 1x noise floor) once on the exam box.
- Compare tags only with the same tag. Old tags stay filed.

## Bold work (trigger and patience counts in `EXAM.md`)

- On a miss streak, try something different next. Start with notes, not code. Search the repo and the web. Pick a new design.
- Give a new design its full patience before you judge it.
- Keep the best of each line.

## If it breaks

- Stuck explorer: steer once, then cancel. Keep partial notes.
- No result at budget end: tell it to wrap up clean. Then cancel.
- Crash: read the log first. Then write the next brief.
- Flaky score: test again on your box. Your test wins.
- Drop rule (count in `EXAM.md`): write the reason, mark `dropped`.

## Defaults

Starting numbers live in the EXAM template — copy them into the
run folder's `EXAM.md` and tune there. This file states no numbers.
