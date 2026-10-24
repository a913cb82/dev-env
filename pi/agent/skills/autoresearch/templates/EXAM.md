# EXAM (run-folder config, copy and fill)

- exam command: <your scored exam command>
- gate command: <blind gate command, fast, no scores, explorer runs it>
- budget: <what one round costs>
- budget tag: <short test name>
- seed policy: <seeds used, written with result>
- score file: `<run-dir>/PROGRESS.jsonl`
- result log: `<run-dir>/results.log` (append-only, never edit)
- target folder: <only mutable surface>
- loop branch: <name, never main>
- share: <percent of box; example: 75%>
- exam slots: <start 1; more only if tests can run side by side and box has room>
- N: <start 1; fill share after exam slots; +1 spare idle>
- explorer budget: <near N x exam time / exam slots; example clamp 5-60 min>
- queue target: <example: 1 submit waiting while 1 exam runs>
- stop: <max tries, time box, or in-noise streak>
- forbidden:
  - <past failure 1>

## Filled example A (latency)

- exam command: `pytest -q && python bench.py --runs 3 --seed 0,1,2`
- gate command: `pytest -q` (12s, blind, explorer runs it)
- budget: suite plus 3 seeded bench runs, ~8 min
- budget tag: `pytest+bench3-seed0`
- seed policy: `--seed 0,1,2`, written with result
- score file: `runs/2026-01-01-cache/PROGRESS.jsonl`
- result log: `runs/2026-01-01-cache/results.log`
- target folder: `src/parser`
- loop branch: `loop/cache`
- share: 75%
- exam slots: 1 (scorer needs the box)
- N: 2 (75% share fits 2 builders after 1 exam slot; +1 spare idle)
- explorer budget: 30 min with 3 gate passes (exam is slow: near 2 x 8 min)
- queue target: 1 waiting
- stop: 10 tries, 2 h, or 3 in-noise in a row
- forbidden:
  - regex rewrite (lost 0.3s)

Counter-example B (correctness): exam is `pytest -q` only; budget tag `pytest-only`; score is pass rate.
