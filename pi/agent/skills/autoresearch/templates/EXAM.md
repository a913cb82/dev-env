# EXAM (run config; copy and fill)

- target: <one folder explorers may change>
- frozen: <exam/gate harness, shared tests, score files; overrides target>
- run folder: <absolute coordinator path, outside candidate worktrees>
- loop branch: <name, never main>
- gate: <fast, scoreless command>
- exam: <scored command; append raw output to result log under candidate ID>
- pass rule: <conditions for accepting a result>
- score: <metric; higher or lower is better>
- tie rule: <fixed, deterministic rule>
- budget: <cost of one candidate>
- tag: <test shape and fixed input set; new set means new tag>
- inputs: <fixed inputs used by baseline and every candidate; record them>
- baseline: <mean, date, commit; 3+ repeats on one machine>
- baseline ID: <target>-<short baseline SHA; initial champion>
- noise floor: <max(score) - min(score) across baseline repeats>
- limits: <timeouts, counts, resource rules>
- proved limits: <number plus proving run; empty at start>
- score file: `<run-folder>/PROGRESS.jsonl` (append-only)
- result log: `<run-folder>/results.log` (append-only)
- share: <fraction of limiting resource available to this run>
- exam slots: <concurrent scored jobs, usually 1>
- exam reserve: <fraction held for all exam slots>
- explorer peak: <fraction per explorer on the same limiting resource>
- N: <max concurrent explorers; start at 1; floor((share - exam reserve) / explorer peak)>
- explorer budget: <near N x exam time / slots; clamp 5-60 min>
- spawn timeout: <budget plus 5 min>
- near noise: <repeat once back to back; decide by mean>
- drop idea: <after 3 failed candidate attempts>
- bold trigger: <after 2 consecutive misses>; bold patience: <3 tries>
- queue target: <e.g. 1 result waiting while 1 exam runs>
- stop: <max tries, time box, or in-noise streak>
- forbidden: <past failures>

## Filled example (latency; changed fields only)

- target: `src/parser`; frozen: `bench.py`, shared tests, run folder
- loop branch: `loop/cache`
- gate: `pytest -q` (12s); exam: `pytest -q && python bench.py --runs 3 --seed 0,1,2` (~8 min)
- pass rule: tests pass; output stable
- score: wall time, lower is better; tie: lower memory
- tag: `pytest+bench3-seeds0-2`; inputs: seeds 0,1,2 for baseline and all candidates
- baseline: 4.2s @a1b2c3; noise: 0.15s, 3 repeats on one box
- share: 75%; exam reserve: 25%; explorer peak: 25%; N: 2; queue: 1 waiting
- budget: 30 min; stop: 10 tries, 2 h, or 3 in-noise; limits: gate <60s, exam <10 min
- forbidden: regex rewrite (lost 0.3s)
