# Run

The loop. Requires a passing [setup](setup.md). You orchestrate. Explorers code.

## Before you start

- The checklist in [setup](setup.md) passes.
- `EXAM.md` in the run folder is the config.
- Your tree is on the loop branch. See [worktrees](worktrees.md) for branch rules.

## One iteration

1. Pick the next `open` idea from `QUEUE.md`. Mark it `trying`. Give it files no live explorer owns.
2. Brief one explorer from `BRIEF.md`. Keep it short:
   - One idea and where it came from.
   - Time budget from `EXAM.md`.
   - Baseline and noise floor.
   - Files it may edit. Files it must never touch.
   - It runs the blind gate in its tree, then commits code plus tests as `exp: <idea>` plus `NOTES.md`. It replies with baseline, gate pass, verdict, and commit hash. Gate: explorers only. Exam: you only.
   - Past failures it must avoid.
3. Wait with `any`. Relaunch when one finishes. Hold one finished result waiting while you test.

   | If | Do |
   |---|---|
   | Exam sits idle | Shorten time limits or add one explorer. |
   | More than one result waits | Give explorers more time per submit. |
   | Computer is too busy | Remove one explorer. |

4. Harvest. See [worktrees](worktrees.md) for the numbered checklist.
5. Test it yourself. Pre-exam checklist, then the scored exam:
   `status clean, diff in target only, same tag, append-only log`. See [exam](exam.md) for the guard block.
6. Write it down. Append `PROGRESS.jsonl`. Add one `WORKLOG.md` entry. Never edit an old entry. Mark the queue row `done` or `dropped`. Commit notes as `log: <idea>`. Push the loop branch. Never push `main` or tags.
7. Check the stop rule in `EXAM.md`. Otherwise go to step 1.

## Spawn skeleton

Paste this into the spawn task. Fill the brackets.

```
Idea: <one sentence, queue row + source>
Budget: HARD <N> min. Commit code plus tests and NOTES.md. Then stop.
Baseline: <score, commit> Noise: <bar, how measured>
Edit: <owned files> only. Never touch: <frozen + run folder + other trees>
Report: baseline, gate pass, one-line verdict, commit hash.
Run the blind gate in your tree. Do not run the scored exam. Do not look for scores or logs.
Forbid: <past failures>
Target: <pasted code or absolute paths>
```

Tips, not rules: paste one winner diff and one near-miss diff. Use a cheap model for sweeps and a strong model for hard lines. Send pure recon with no code as a table plus one next shot.

## Verdict

- Ignore explorer verdicts. Compute the gain yourself.
- Keep the change only if the gain beats the noise floor.
- Check score, stability, and cost. Do not use score alone.
- Repeat close calls once on one box.
- Compare tags only with the same tag. Old tags stay filed.

## Bold work

- Two misses in a row means try something different next. Starting example; tune in `EXAM.md`.
- Start with notes, not code. Search the repo and the web. Pick a new design.
- Give a new design 3 tries before you judge it. Starting example; tune in `EXAM.md`.
- Keep the best of each line.

## If it breaks

- Stuck explorer: steer once, then cancel. Keep partial notes.
- No result at budget end: tell it to wrap up clean. Then cancel.
- Crash: read the log first. Then write the next brief.
- Flaky score: test again on your box. Your test wins.
- Three failed tries drops the idea. Starting example; write the reason and tune in `EXAM.md`.

## Defaults (starting example — copy into `EXAM.md` and tune)

| Item | Example |
|---|---|
| N | start 1; fill share after exam slots; +1 spare idle; then hold queue at 1 |
| Explorer budget | near N x exam time / exam slots; clamp 5-60 min; more gate passes when slow |
| Spawn timeout | budget plus 5 min |
| Near noise | repeat once back to back |
| Drop idea | after 3 failed changes |
| Bold trigger | after 2 misses |
| Bold patience | 3 tries |
| Stop | 10 tries, 2 h, or 3 in-noise in a row |
| Tags | old tags stay filed, never compare across tags |
