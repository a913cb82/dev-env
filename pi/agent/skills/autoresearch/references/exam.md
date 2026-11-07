# Exam

One fixed test per change. `EXAM.md` sets the numbers; keep them fixed.

Gate: explorers only. Exam: you only. Explorers never see scores.

## Budget

- Fix the budget before the first spawn; keep it repeatable.
- Cheap stages first; fresh seeds each round.
- You pick inputs and seeds — never the explorer.
- Test each change once. Slow exam? Explorers pre-check more.
- Example: the filled exam in `EXAM.md`.

## Entry id and duplicates

- Name each entry folder-plus-commit. Notes-only commits keep the old name and replay zero tests.
- Matching code is one entry: same `git patch-id` on the target diff. Check before you test.
- New test shape: new tag, new log file. Never append to the old one; never compare across.

## Blind gate (explorers run this)

- Fast (<5% of the exam budget), scoreless, in-tree.
- Checks: suite, smoke, stable output.
- Prints no scores, writes no logs.
- Every brief names the gate; every explorer runs it pre-commit.
- Gate fails? The explorer fixes it. Never waits on you.

## Scored exam (you run this)

- Inputs from the commit hash (first 8 hex digits mod N); log them with the score.
- One fixed tie rule, every time.
- Re-run the gate, then the full budget.

## Recorded score

- One JSON line per finished test, appended, immutable. Skip bad lines on read.
- Champion = best recorded line for the current tag.
- Schema: `date, id, score, budget, champion`. Extra fields allowed.
- Example row: `{"date":"2026-01-01","id":"src/parser-d4e5f6","score":0.47,"budget":"pytest+bench3-seed0","champion":"src/parser-a1b2c3"}`.

## Budget tag

- The tag names the test shape. New shape: new tag plus new log file (see above). Old rows stay filed.

## Guards (git example)

Fail before you test: clean tree, in-target diff only, append-only log. Check the staged diff pre-commit.

```sh
if [ -n "$(git status --porcelain)" ]; then echo DIRTY; exit 1; fi
if git diff --name-only <sha>^..<sha> | grep -vx '<target>/.*'; then echo OUT-OF-SCOPE; exit 1; fi
if git diff --cached -- <run-dir>/PROGRESS.jsonl | grep '^-[^-]'; then echo REWROTE-HISTORY; exit 1; fi
```

- Dirty: commit first. Out-of-scope (tests, logs, harness always forbidden — named in every brief's Never-touch): drop it. Rewrote history: stop, fix it. Fill `<sha>`, `<target>/`, `<run-dir>/` in `EXAM.md`.

## Commands

From `EXAM.md`. Examples only.

```sh
# blind gate: explorer runs this inside its tree (fast, no scores)
pytest -q && python bench.py --runs 1 --seed 0

# scored exam: you run this (budgeted, seeded, logged)
python bench.py --runs 3 --seed 0,1,2 >> <run-dir>/results.log

# push the loop branch
git push origin <loop-branch>
```

Never push `main` or tags ([worktrees](worktrees.md)).

## Logs

- One append-only result log; never edit. Outputs keyed by commit; prune old, keep current.
- One worklog line per round: `score 0.47, best 0.42, gain +0.05, noise 0.03, keep`.
