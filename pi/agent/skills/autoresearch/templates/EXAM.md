# EXAM (copy and fill for each run)

- target: <one folder explorers may change>
- frozen: <exam/gate harness, shared tests, score files; overrides target>
- run folder: <absolute coordinator path, outside candidate worktrees>
- base ref: <branch/ref to merge into the loop branch; often main>
- loop branch: <name, different from the base ref>
- gate: <fast, scoreless command>
- exam: <scored command>
- pass rule: <conditions for accepting a result>
- score: <metric; higher or lower is better>
- exam cost: <time/resource cost of one scored candidate>
- explorer budget: <hard coding time limit>
- max explorers: <cap; start at 1, increase only while exam stays responsive>
- tag: <run label for the test shape and inputs; not a Git tag>
- inputs: <fixed set used by baseline and every candidate>
- baseline: <mean, date, commit; 3+ repeats on one machine>
- baseline ID: <target>-<short baseline SHA; initial champion>
- noise floor: <max(score) - min(score) across baseline repeats>
- limits: <timeouts and constraints>
- score file: `<run-folder>/PROGRESS.jsonl` (append-only)
- result log: `<run-folder>/results.log` (append-only)
- stop: <max attempts, time box, or in-noise streak>
- forbidden: <past failures>

## Example (latency)

- target: `src/parser`; frozen: `bench.py`, shared tests, run folder
- gate: `pytest -q`; exam: `pytest -q && python bench.py --runs 3 --seed 0,1,2`
- score: wall time, lower is better
- tag: `pytest+bench3-seeds0-2`; inputs: seeds 0,1,2 for baseline and all candidates
- baseline: 4.2s @a1b2c3; noise: 0.15s, 3 repeats
