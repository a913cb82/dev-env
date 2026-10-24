# Worklog

One entry per round. Never edit an old entry.

## 0 — setup (<date>)
- commit: <baseline sha>
- score: <baseline score>
- best: <baseline score>
- verdict: keep
- what changed: <exam, notes, work areas ready>
- what you learned: <noise floor>
- next: <first idea>

## Filled example A (latency)

## 1 — cache parser output (<date>)
- commit: d4e5f6
- score: 0.47 (spread 0.03)
- best: 0.42 before this round
- verdict: keep (gain +0.05 beats noise 0.03)
- what changed: added cache to parser hot path
- what you learned: re-parse was 60% of time
- next: cap cache size

Counter-example B (correctness): verdict keep (9/10 pass vs best 7/10).
