# Exam

One fixed test per change. The run-folder `EXAM.md` sets the numbers. Keep them fixed.

Gate: explorers only. Exam: you only. Explorers never see scores.

## Budget

- Fix the budget before the first spawn. Keep it small enough to repeat.
- Run cheap stages first. Use different seeds each round.
- You pick the inputs and seeds. The explorer never picks easy ones.
- Test each change once. Never test the same code twice. If the full test is slow, explorers check more work first.

Example A (latency): `pytest -q` then `python bench.py --runs 3 --seed 0,1,2`.
Example B (pass/fail): `pytest -q` with required files listed in `EXAM.md`.

## Entry id and duplicates

- Name each entry by folder plus commit. Notes-only commits keep the old name. They replay zero tests.
- Treat matching code as one entry.
- If you change the test, start a new log. Do not compare across tests.

## Blind gate (explorers run this)

- The gate is fast and has no score. It runs inside the explorer tree.
- It checks: suite passes, smoke passes, output is stable.
- It prints no scores. It writes no logs.
- Every brief names the gate command. Every explorer runs it before it commits.
- If the gate fails, the explorer fixes the code. It never waits on you.

## Scored exam (you run this)

- Pick random inputs from the commit hash. Write those inputs with the score.
- Pick one fixed rule for ties. Use that rule every time.
- Run the gate first. The explorer already ran it blind. You re-run it, then run the full budget.

## Recorded score

- The harness appends one JSON line per finished test to `PROGRESS.jsonl`. That line never changes. Skip bad lines on read.
- The best recorded line for the current tag is the champion. Champion means the best score so far.
- Schema: `date, id, score, budget, champion`. Extra fields are allowed.
- Example row: `{"date":"2026-01-01","id":"src/parser-d4e5f6","score":0.47,"budget":"pytest+bench3-seed0","champion":"src/parser-a1b2c3"}`.

## Budget tag

- The tag names the test shape.
- A new test shape means a new tag. Old rows stay filed. Never compare across tags.

## Guards (git example)

Fail before you test. Generic rule: clean tree, in-target diff only, append-only log.

```sh
git status --porcelain | grep . && echo DIRTY
git diff --name-only <sha>^..<sha> | grep -vx 'src/<target>/.*' && echo OUT-OF-SCOPE
git diff HEAD -- PROGRESS.jsonl | grep '^-[^-]' && echo REWROTE-HISTORY
```

Filled example (matches `templates/EXAM.md` style):

```sh
git status --porcelain | grep . && echo DIRTY
git diff --name-only d4e5f6^..d4e5f6 | grep -vx 'src/parser/.*' && echo OUT-OF-SCOPE
git diff HEAD -- runs/2026-01-01-cache/PROGRESS.jsonl | grep '^-[^-]' && echo REWROTE-HISTORY
```

- If the tree is dirty, commit first.
- If out-of-scope files changed, drop the commit.
- If history was rewritten, stop and fix it.

Fill the paths in `EXAM.md`.

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

Never push `main` or tags.

## Logs

- Keep every result in one append-only log. Never edit it.
- Keep outputs keyed by commit. Prune old ones first. Always keep the current one.
- Print one short line per round for the worklog. Example: `score 0.47, best 0.42, gain +0.05, noise 0.03, keep`.

Example box (game tournaments only — skip unless your test is a game pool): fixed maps plus seed pool, quantile census, info-duel opponents, `mu`/`sigma` ratings, win-loss ranks, `games.log`, per-game `games` counts. Your `EXAM.md` names the real one.
