# Brief (copy per explorer, fill, paste into the spawn task)

Idea: <one sentence, queue row + source>.
Budget: HARD <N> min. Commit code plus tests and NOTES.md. Then stop.
Baseline: <score, commit> Noise: <bar, how measured>.
Gate: <blind gate command, runs quickly in-tree>.
Edit: <owned files> only. Never touch: <frozen + run folder + other trees>.
Report: baseline, gate pass, one-line verdict, commit hash.
Run the blind gate in your tree. Do not run the scored exam. Do not look for scores or logs.
Forbid: <past failures>.
Target: <pasted code or absolute paths>.

## Filled example A (latency): cache parser output (queue 2, 60% in re-parse); HARD 30 min; baseline 4.2s @a1b2c3, noise 0.15s (3x, one box); gate `pytest -q` (12s in-tree); edit `src/parser.py:40-90` only, never `bench.py, tests/, run folder`; forbid regex rewrite (lost 0.3s).

Counter-example B (correctness): gate `pytest -q auth`, score pass rate.
