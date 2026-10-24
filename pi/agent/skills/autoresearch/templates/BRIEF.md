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

## Filled example A (latency)

Idea: Cache parser output in parser.py (queue row 2, profile shows 60% in re-parse).
Budget: HARD 30 min. Commit code plus tests and NOTES.md. Then stop.
Baseline: 4.2s, commit a1b2c3. Noise: 0.15s, 3 repeats on one box.
Gate: pytest -q passes in 12s in-tree.
Edit: src/parser.py only. Never touch: bench.py, tests/, run folder.
Report: baseline, gate pass, one-line verdict, commit hash.
Run the blind gate in your tree. Do not run the scored exam. Do not look for scores or logs.
Forbid: regex rewrite (lost 0.3s last round).
Target: src/parser.py lines 40-90 pasted below.

Counter-example B (correctness): fix login retry; gate is `pytest -q auth`; score is pass rate.
