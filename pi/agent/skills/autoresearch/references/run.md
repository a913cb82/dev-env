# Run

After [setup](setup.md) passes, repeat this loop. You score; explorers code.

## One iteration

1. Take the next `open` idea. Mark it `trying`, record owned files, and set `BASE` to loop-branch HEAD.
2. Create a fresh detached worktree at `BASE`. Start one subagent in that directory with the filled `BRIEF.md` as its task. It commits one target change as `exp: <idea>` and writes untracked `NOTES.md`. It runs the gate only — never the exam or score logs.
3. Wait for an explorer to finish; start another when capacity allows. Keep one finished result waiting while you score.

   | If | Do |
   |---|---|
   | Exam sits idle | Shorten time limits or add one explorer. |
   | More than one result waits | Give explorers more time per submit. |
   | Computer is too busy | Remove one explorer. |

4. Harvest notes by [worktree rules](worktrees.md); keep the tree for review.
5. Check candidate `HEAD`, parent, clean status, allowed diff, patch-id, and staleness ([exam](exam.md)). Reject failures without scoring, log the reason, and remove the worktree. Rerun the gate; if it passes, run the fixed exam in the finished candidate worktree. Write output to the coordinator's run folder.
6. Keep only a valid score that beats the champion by more than noise in the configured direction. For a close call (within noise), repeat once on the exam machine and use the mean. Cherry-pick the `exp:` commit only if kept; otherwise leave it detached. If keeping changes target code, cancel explorers based on the old code and recover their notes. Record the resulting champion ID, then remove the worktree.
7. For each non-stale returned candidate commit, increment attempts and add a `WORKLOG.md` entry; unscored rejections have no `PROGRESS` row. A kept idea becomes `done`; a miss returns it to `open` until the drop limit, then `dropped`. Crashes, cancellations, and stale candidates return to `open` and do not count. Append one `PROGRESS.jsonl` row per scored candidate, including inputs and effective score. Commit records as `log: <idea>` and push the loop branch. Stop at the `EXAM.md` limit; otherwise repeat.

A **miss** is a returned candidate not kept. After the configured miss streak, try a different design: start with evidence, search the repo and web, then give the new design its configured patience. Keep the best result. An in-noise stop streak counts scored candidates whose effective score is within the noise floor.

## If it breaks

- Stuck: steer once, then cancel. Keep partial notes.
- Silent at budget end: order a clean wrap-up, then cancel.
- Crash/cancel: log an unscored outcome, then follow [worktree recovery](worktrees.md); do not score or promote it.
- Still unstable after the one close-call repeat: reject it. Do not add more runs.

Tips: include a winner and near-miss diff in briefs; use a cheaper model for sweeps and a stronger one for hard problems. Recon-only explorers return a table and one next step.
