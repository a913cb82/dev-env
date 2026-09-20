# Performance Measurement

Method that turned a 30-second-per-move engine into 0.5 seconds. Guessing is the
enemy; every hour of guessing was worth one line of instrumentation.

## Instrument by Phase, in One Line

Log one line per operation, split into phases:

```text
genMove took 1804ms (mutexWait=0 sync=1 profile=1 setup=1 search=1801) -> play E6
```

- `mutexWait`: queue contention.
- `sync` and `setup`: bookkeeping before the work.
- `search`: the real cost.

This single line ended a multi-hour loop. Everything before the search was free,
so the cost was the search itself. Do not tune anything before this split
exists.

## Isolate, Then Integrate

Measure the engine alone with a probe harness (FIFO stdin/stdout, no app), then
in-app. The gap is the app's overhead. Neither number alone is trustworthy: a
probe measured 0.7s "warm" while real play measured 1.8s, because the probe
reused a search tree that real play never has.

## Warm and Cold Are Different States

- The first query after a model load pays caches and thread setup (seconds).
- A search continuing from an earlier position is not a fresh search. A human
  or engine move that leaves the explored tree makes the next search fresh.
- Choose the state real play is actually in, then measure that state.
- Hide unavoidable one-time costs in a launch warmup query.

## Change One Parameter per Build

A/B a single flag or count. Real examples:

- `includePolicy=true` on a CPU backend: +2.6s per call for data never read.
- Search threads 8 -> 2: FASTER on CPU (oversubscription). More threads only
  paid off under an NPU-backed model.
- Fixed per-call overhead can dominate visit counts: 15 visits and 50 visits
  cost the same when the constant is seconds.

## Breadth vs Depth

Focused search settings starve features that need many distinct results. One
engine returned only 3 to 4 distinct moves after 1236 visits because its
"human-like play" parameters concentrated the tree, and the analysis padding
(symmetry duplicates) was not real data. The fix was one parameter
(`analysisWideRootNoise`) that widens root exploration: 19 distinct scored
moves at 150 visits. Read the engine config docs for a breadth knob before
hand-rolling workarounds, and filter padding markers (for example
`isSymmetryOf`) out of result pools.

## Cheap Wins Checklist

- Cut visits until the result degrades, then stop.
- Split nets: a small fast net for search plus a large specialist net for style
  or steering is often several times faster than one large net.
- Keep the engine process alive with a persistent board. A reused tree beats
  restarted searches.
- Delete client-side delays on the critical path.
- Mirror the reference app's recipe (net sizes, budgets, params) before tuning
  from scratch.

## Budgets

- Set a target for "feel" (example: under one second per engine move) and
  measure the user-visible interval end to end, not the engine call alone.
- Keep a startup budget too: model load plus warmup should complete while the
  user reads the screen.
- Record every measurement in the project's on-device doc. Measurements beat
  memory across sessions and context compactions.
