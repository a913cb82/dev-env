# Run

The loop. Needs passing [setup](setup.md). You orchestrate; explorers code.

## Before you start

- Setup checklist passes; `EXAM.md` is the config; your tree is on the loop branch ([worktrees](worktrees.md)).

## One iteration

1. Next `open` idea in `QUEUE.md` → mark `trying`, record owned files. Files no live explorer owns. On steer, cancel, or crash, reset `trying` to `open` before the next pick.
2. Brief one explorer from `BRIEF.md`: idea+source, HARD budget, baseline/noise, owned vs. never-touch files, report (baseline, gate, verdict, hash), gate-only — no exam, scores, or logs — past forbids.
3. Wait with `any`; relaunch on finish. Keep one result waiting while you test.

   | If | Do |
   |---|---|
   | Exam sits idle | Shorten time limits or add one explorer. |
   | More than one result waits | Give explorers more time per submit. |
   | Computer is too busy | Remove one explorer. |

4. Harvest ([worktrees](worktrees.md) checklist).
5. Test it yourself: guards ([exam](exam.md)), then the exam.
6. Log it: append `PROGRESS.jsonl`, add one `WORKLOG.md` entry (never edit old ones), mark the row `done`/`dropped`, commit `log: <idea>`, push the loop branch ([worktrees](worktrees.md)).
7. Stop rule in `EXAM.md`? Stop. Else step 1.

## Spawn skeleton

Paste the filled `BRIEF.md` into the spawn task — it is the sole spawn contract.

Tips, not rules: paste one winner diff and one near-miss diff. Cheap model for sweeps, strong model for hard lines. Pure recon with no code: a table plus one next shot.

## Verdict

- Explorer verdicts don't count. Compute the gain yourself; keep it only if it beats noise. Weigh score, stability, cost.
- Re-run close calls (within 1x noise) once on the exam box. Same tag only; old tags stay filed.

## Bold work (trigger and patience counts in `EXAM.md`)

- On a miss streak, try something different next. Start with notes, not code. Search the repo and the web. Pick a new design.
- Give a new design its full patience before you judge it.
- Keep the best of each line.

## If it breaks

- Stuck explorer: steer once, then cancel. Keep partial notes.
- Silent at budget end: order a clean wrap-up, then cancel.
- Crash: read the log, then brief next.
- Flaky score: test again on your box. Your test wins.
- Drop rule (count in `EXAM.md`): write the reason, mark `dropped`.

## Defaults

Starting numbers live in the EXAM template — copy them into the
run folder's `EXAM.md` and tune there. This file states no numbers.
