# Exam

`EXAM.md` fixes the test, inputs, score direction, and limits for one run. Its `tag` is a run label, not a Git tag. Never compare across tags.

## Gate and exam

- All candidates and the baseline use the same inputs, chosen by the coordinator. A changed exam or input set needs a new tag/run folder.
- The gate is a fast (<5% of exam budget), scoreless correctness/smoke check; it prints or writes no score/result log. Explorers run it before commit; the coordinator reruns it. Failure means no scored exam.
- The coordinator runs the full exam after the explorer exits. Append raw output to `<run-folder>/results.log`, keyed by candidate ID.
- Score a target patch-id once. Repeat a close call (within noise) once on the same machine; use the mean.

## Candidate guards

After copying `NOTES.md` out and removing it, set `TREE` (candidate worktree), `BASE` (brief's start commit), `CURRENT` (loop-branch HEAD), `SHA` (reported commit), and `TARGET` (allowed folder). Check:

```sh
git -C "$TREE" status --porcelain
git -C "$TREE" rev-parse HEAD
git -C "$TREE" rev-parse "$SHA^"
git -C "$TREE" diff --quiet "$BASE" "$CURRENT" -- "$TARGET"
git -C "$TREE" diff --name-only "$BASE" "$SHA"
git -C "$TREE" diff "$BASE" "$SHA" -- "$TARGET" | git patch-id --stable
```

Status must be empty; HEAD must equal SHA; its parent must equal BASE; `diff --quiet` must exit 0; changed paths must be under target and outside frozen paths. Otherwise reject without scoring. The last command returns the target patch-id; no output means no change. Reuse a recorded patch-id instead of retesting it, except for its one close-call repeat.

## Record

After the exam and any repeat, append one JSON line to `PROGRESS.jsonl`. Never edit rows. `score` is the candidate score or the mean; include raw repeat scores in `runs`. `inputs` records the fixed set. The baseline ID `<target>-<short baseline SHA>` is the initial champion. Each row's `champion` is the best code ID after that decision.

Schema: `date, id, patch_id, inputs, score, tag, champion`. Extra fields are allowed. `id` is `<target>-<short candidate SHA>`; `tag` matches `EXAM.md`.
