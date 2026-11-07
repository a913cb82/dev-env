# EXAM (run-folder config, copy and fill)

- exam command: <your scored exam command>
- gate command: <blind gate command, fast, no scores, explorer runs it>
- budget: <what one round costs>
- budget tag: <short test name>
- seed policy: <seeds used, written with result>
- baseline: <score, date, commit; min 3 repeats on exam box>
- noise floor: <bar plus how measured>
- limits: <timeouts, counts, resource rules>
- proved limits: <one line each: number plus proving run; empty at start>
- score file: `<run-dir>/PROGRESS.jsonl`
- result log: `<run-dir>/results.log` (append-only, never edit)
- target folder: <only mutable surface>
- loop branch: <name, never main>
- share: <percent of box; example: 75%>
- exam slots: <start 1; more only if tests run side by side with room>
- N: <start 1; fill share after exam slots; +1 spare idle; hold queue at 1>
- N formula: <floor((share - exam reserve) / one explorer)>
- explorer budget: <near N x exam time / slots; clamp 5-60 min>
- spawn timeout: <budget plus 5 min>
- near noise: <repeat once back to back>
- drop idea: <after 3 failed changes>
- bold trigger: <after 2 misses>; bold patience: <3 tries>
- queue target: <example: 1 submit waiting while 1 exam runs>
- stop: <max tries, time box, or in-noise streak>
- forbidden:
  - <past failure 1>

## Filled example A (latency, changed fields only)

- exam: `pytest -q && python bench.py --runs 3 --seed 0,1,2` (~8 min); gate: `pytest -q` (12s, blind)
- tag: `pytest+bench3-seed0`; seeds: `--seed 0,1,2`, written with result
- baseline: 4.2s @a1b2c3 (2026-01-01); noise: 0.15s, 3 repeats on one box
- target: `src/parser`; branch: `loop/cache`; share: 75%; slots: 1; N: 2 (+1 spare idle)
- budget: 30 min; queue: 1 waiting; stop: 10 tries, 2 h, or 3 in-noise; limits: gate <60s, exam <10 min
- forbid: regex rewrite (lost 0.3s)

Counter-example B (correctness): exam `pytest -q` only; tag `pytest-only`; score pass rate.
