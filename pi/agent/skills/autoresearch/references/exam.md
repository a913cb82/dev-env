# Exam

One fixed test per change. The run-folder `EXAM.md` sets the numbers. Keep them fixed.

Gate: explorers only. Exam: you only. Explorers never see scores.

## Budget

- Fix the budget before the first spawn. Keep it small enough to repeat.
- Run cheap stages first. Use different seeds each round.
- You pick the inputs and seeds. The explorer never picks easy ones.
- Test each change once. Never test the same code twice. If the full test is slow, explorers check more work first.
- Examples: the filled latency exam in `EXAM.md`.

## Entry id and duplicates

- Name each entry by folder plus commit. Notes-only commits keep the old name. They replay zero tests.
- Treat matching code as one entry: same `git patch-id` on the target diff. Check before you test.
- If you change the test, start a new tag and a new log file. Never append to the old file. Do not compare across tests.

## Blind gate (explorers run this)

- The gate is fast (under ~5% of the exam budget) and has no score. It runs inside the explorer tree.
- It checks: suite passes, smoke passes, output is stable.
- It prints no scores. It writes no logs.
- Every brief names the gate command. Every explorer runs it before it commits.
- If the gate fails, the explorer fixes the code. It never waits on you.

## Scored exam (you run this)

- Pick random inputs from the commit hash (first 8 hex digits mod N). Write those inputs with the score.
- Pick one fixed rule for ties. Use that rule every time.
- Run the gate first. The explorer already ran it blind. You re-run it, then run the full budget.

## Recorded score

- The harness appends one JSON line per finished test to `PROGRESS.jsonl`. That line never changes. Skip bad lines on read.
- The best recorded line for the current tag is the champion. Champion means the best score so far.
- Schema: `date, id, score, budget, champion`. Extra fields are allowed.
- Example row: `{"date":"2026-01-01","id":"src/parser-d4e5f6","score":0.47,"budget":"pytest+bench3-seed0","champion":"src/parser-a1b2c3"}`.

## Budget tag

- The tag names the test shape. New shape: new tag plus new log file (see above). Old rows stay filed.

## Guards (git example)

Fail before you test: clean tree, in-target diff only, append-only log. Check the staged diff before you commit.

```sh
if [ -n "$(git status --porcelain)" ]; then echo DIRTY; exit 1; fi
if git diff --name-only <sha>^..<sha> | grep -vx '<target>/.*'; then echo OUT-OF-SCOPE; exit 1; fi
if git diff --cached -- <run-dir>/PROGRESS.jsonl | grep '^-[^-]'; then echo REWROTE-HISTORY; exit 1; fi
```

- Dirty: commit first. Out-of-scope (test files, score logs, and harness code are always forbidden — every brief's Never-touch list names them, no exceptions): drop the commit. Rewrote history: stop and fix it. Fill `<sha>`, `<target>/`, `<run-dir>/` in `EXAM.md`.

## Commands

Fill these from run-folder `EXAM.md`. Examples only.

```sh
# blind gate: explorer runs this inside its tree (fast, no scores)
pytest -q && python bench.py --runs 1 --seed 0

# scored exam: you run this (budgeted, seeded, logged)
python bench.py --runs 3 --seed 0,1,2 >> <run-dir>/results.log

# push the loop branch
git push origin <loop-branch>
```

Never push `main` or tags (branch rules: [worktrees](worktrees.md)).

## Logs

- Keep every result in one append-only log. Never edit it.
- Keep outputs keyed by commit. Prune old ones first. Always keep the current one.
- Print one short line per round for the worklog. Example: `score 0.47, best 0.42, gain +0.05, noise 0.03, keep`.
