# Run

1. Take the next `open` idea. Mark it `trying`, record owned files, and set `BASE` to loop-branch HEAD.
2. Create a detached worktree at `BASE`. Start one subagent there with a filled `BRIEF` template as its task. It makes one `exp:` commit, leaves untracked `NOTES.md`, runs the blind gate, and never runs the exam or reads scores.
3. Keep one finished result waiting while you score. Add workers up to the `EXAM.md` limit if the exam idles; allow more work time if results pile up; remove a worker if the machine is busy.
4. Harvest notes by [worktree rules](worktrees.md). Check candidate guards; reject dirty, out-of-scope, or stale changes without an exam, reopening stale ideas. Rerun the gate; a failure means no exam. Reuse a duplicate patch-id's recorded result instead of retesting it.
5. If a score is within noise of the champion, repeat once on the same machine and use the mean. Keep only if the effective score beats the champion by more than noise in the configured direction. Cherry-pick only a kept candidate. If this changes target code, cancel explorers based on the old code; reopen their ideas.
6. For each non-stale returned commit, increment attempts and log the decision. Keep → `done`; miss → `open`, or `dropped` at the attempt limit. Crashes, cancels, and stale candidates do not count. Append one `PROGRESS.jsonl` row per scored candidate; commit records as `log: <idea>` and push the loop branch.
7. Stop at the `EXAM.md` limit; otherwise repeat.

A miss is a returned candidate not kept. After 2 consecutive misses, try a different approach; allow it 3 attempts. Drop an idea after 3 failed candidate attempts. If still unstable after the one close-call repeat, reject it.

At the hard budget, request a clean wrap-up; cancel if it does not return. On crash/cancel, record an unscored outcome and follow [worktree recovery](worktrees.md). Do not score or promote it.
