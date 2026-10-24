# Performance Measurement

Generic method: instrument by phase, isolate the cost, then change one thing
per build. Worked example below turned a 30-second-per-move engine into 0.5
seconds on one native-engine project. Guessing is the enemy — every hour of
guessing was worth one line of instrumentation there.

## Instrument by Phase, in One Line

Log one line per operation, split into phases. Example shape:

```text
genMove took 1804ms (mutexWait=0 sync=1 profile=1 setup=1 search=1801) -> play E6
```

- `mutexWait`: queue contention.
- `sync` and `setup`: bookkeeping before the work.
- `search`: the real cost.

In the worked example this single line ended a multi-hour loop: everything before the search was
free, so the cost was the search itself. Do not tune anything before this
split exists.

## Isolate, Then Integrate

Measure the component alone with a probe harness (FIFO stdin/stdout, no app).
Then measure in-app. The gap is the app's overhead. Neither number alone is
trustworthy. Worked example: a probe measured 0.7s "warm" while real play measured 1.8s,
because the probe reused a search tree that real play never has.

## Warm and Cold Are Different States

- The first query after a model load warms caches and thread setup (seconds).
- A search continuing from an earlier position is not a fresh search.
- A human or engine move that leaves the explored tree makes the next search fresh.
- Choose the state real play is actually in. Then measure that state.
- Hide unavoidable one-time costs in a start-up warmup query.

## Change One Parameter per Build

A/B a single flag or count. Worked examples from the engine project:

- One unread client flag added +2.6s per call.
- Search threads 8 → 2 ran FASTER on CPU (oversubscription). More threads only
  paid off under an NPU-backed model.
- Fixed per-call overhead can dominate visit counts: 15 visits and 50 visits
  cost the same when the constant is seconds.

## Breadth vs Depth

Focused search settings starve features that need many distinct results. Worked example:
one engine returned only 3–4 distinct moves after 1236 visits because its
"human-like play" parameters concentrated the tree (symmetry padding was not real data).
The fix was one breadth knob that widens root exploration, yielding 19
distinct scored moves at 150 visits. Read the engine config docs for a
breadth knob before you build a custom workaround, and filter padding markers
out of result pools.

## Cheap Wins Checklist

- Cut visits/budget until the result degrades. Then stop.
- Split nets. A small fast net for search plus a large specialist net for
  style or steering is often several times faster than one large net.
- Keep the engine process alive with a persistent board. A reused tree beats
  restarted searches.
- Delete client-side delays on the critical path.
- Mirror the reference app's recipe (net sizes, budgets, params) before
  tuning from scratch.

## Budgets

- Set a target for "feel" (worked example: under one second per engine move).
  Measure the user-visible interval end to end, not the component call alone.
- Keep a startup budget too: model load plus warmup completes while the
  user reads the screen.
- Record every measurement in the project's on-device doc. Measurements
  beat memory across sessions and context compactions.
