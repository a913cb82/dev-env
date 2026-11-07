# Brief (fill once per explorer; paste into its spawn task)

Idea: <one QUEUE row and its source>
Start commit: <current loop-branch HEAD SHA>
Budget: HARD <minutes>.
Baseline/noise: <score, direction, baseline commit, noise bar and method>.
Gate: <blind gate command>. Run it before committing.
Edit: <owned files under target> only. Never touch: <frozen paths, run folder, other trees>.
Commit one code change as `exp: <idea>`. Leave `NOTES.md` untracked; write findings there.
Report: candidate SHA, gate pass/fail, one-line verdict.
Do not run the scored exam or read scores/logs.
Past failures to avoid: <list>.
Target: <absolute paths or pasted code>.

## Example

Idea: cache parser output (QUEUE row 2; profile shows 60% in re-parse).
Start: `a1b2c3`; budget: HARD 30 min.
Baseline/noise: 4.2s, lower is better; noise 0.15s (3 runs on one box).
Gate: `pytest -q` (12s in-tree).
Edit: `src/parser.py` only. Never touch `bench.py`, shared tests, or run folder.
Forbid: regex rewrite (lost 0.3s).
Target: `src/parser.py:40-90`.
