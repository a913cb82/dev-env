# Exam

One fixed exam per run. `EXAM.md` defines the test, inputs, and score; keep them fixed. Explorers run only the blind gate. You run the scored exam; explorers never see candidate scores or result logs.

## Scoring

- Use the same fixed inputs for baseline and every candidate. The coordinator chooses them; explorers never do.
- Score each target patch-id once. Repeat only a close call (within the noise floor), once on the exam machine; use the mean.
- A changed test or input set needs a new tag and run folder. Never compare across tags.
- Choose one tie rule and score direction in `EXAM.md`.

## Blind gate

- Fast (<5% of exam budget), scoreless, and run in the candidate worktree.
- Checks correctness, smoke behavior, and stable output; prints no scores or result logs.
- Every brief names the gate. The explorer runs it before committing; you rerun it before the exam.
- If it fails, do not run the scored exam.

## Candidate guards

After copying `NOTES.md` out and removing it from the worktree, set `TREE` (candidate worktree), `BASE` (start commit in the brief), `CURRENT` (loop-branch HEAD), `SHA` (reported commit), and `TARGET` (allowed folder in `EXAM.md`). Check:

```sh
git -C "$TREE" status --porcelain
git -C "$TREE" rev-parse HEAD
git -C "$TREE" rev-parse "$SHA^"
git -C "$TREE" diff --quiet "$BASE" "$CURRENT" -- "$TARGET"
git -C "$TREE" diff --name-only "$BASE" "$SHA"
git -C "$TREE" diff "$BASE" "$SHA" -- "$TARGET" | git patch-id --stable
```

- Status must be empty; HEAD must equal SHA; its parent must equal BASE; `diff --quiet` must exit 0; changed paths must be under target and outside frozen paths. Otherwise reject without scoring.
- The final command gives the target patch-id. No patch means no code change. If that patch-id already has a result, reuse it and do not test again (except its one close-call repeat).
- A candidate is stale if target code at BASE differs from CURRENT. Copy its notes, return its idea to `open`, and remove the worktree without scoring.

## Scored exam

After the explorer exits and guards pass, rerun the gate and the fixed exam in its worktree. Append raw output to `<run-folder>/results.log`, keyed by candidate ID.

## Recorded score

- After the exam and any close-call repeat, append one JSON line per candidate to `PROGRESS.jsonl`. Never edit or delete rows; skip malformed rows when reading.
- `score` is the effective score; after a close-call repeat, it is the mean. Store raw runs in an extra `runs` field.
- Setup baseline is the initial champion, ID `<target>-<short baseline SHA>`. Each row's `champion` is the best code ID after that decision: `<target>-<short cherry-pick SHA>` if kept, otherwise the previous champion ID.
- Schema: `date, id, patch_id, inputs, score, budget, champion`. Extra fields are allowed. `id` is `<target>-<short candidate SHA>`; `budget` is the tag.
- Example: `{"date":"2026-01-01","id":"src/parser-d4e5f6","patch_id":"abc123","inputs":"0,1,2","score":4.2,"budget":"pytest+bench3-seeds0-2","champion":"src/parser-a1b2c3"}`.
