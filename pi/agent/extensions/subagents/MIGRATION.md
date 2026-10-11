# Subagents: process-to-in-process migration plan (v3)

Goal: run subagents as in-process pi sessions instead of spawned `pi --mode rpc`
processes. Keep every tree semantic. Delete the transport layer.

Non-goals: change the four tools, change addressing, change claiming or cost
rules, support both transports in production.

Simplicity is a hard constraint on the path, not just the end state. One
transport per tree. Thin adapter or it fails review. Delete, do not port.
No phase may add lasting complexity to serve the transition.

## 0. Round-1 review verdicts (4 reviewers, all read the code)

- Correctness: 2x BLOCK + AMEND. Orphan resume needs a specified sweeper
  before any deletion. Approval/UI carriers must pin to the pinned SDK
  before the freeze. Cancel/interrupt needs execution-scoped markers, a
  generation sequence (not wall-clock equality), and serialized
  send-then-abort.
- Value: BLOCK. The payoff is unpriced, the migration is a capability
  downgrade (isolation, orphan survival), and the adapter is a permanent
  tax. Added below as Gate 0: price it or stop.
- Verifiability: BLOCK. Probe 5 is untestable as written (no metrics, three
  failure modes in one sentence). Suite-green gates pass while the
  migration fails (weakened asserts, fake seam, topic-list ladder).
- Simplicity: AMEND. Delete the interface, the backend seam, the split
  suites, the extraction phase, the multi-writer afterlife, and 6 of 9
  probes. Flag day on idle trees with direct SDK calls.

v3 resolutions: Gate 0 prices the migration first. Probes carry kill
criteria with numbers. The freeze gains the orphan sweeper, the cancel
contract, and per-prompt trust. The path loses the interface, the seam,
and the split suites: tool-level tests need no shared abstraction.

## 1. Gate 0: price it or stop (before everything)

Run these two first. Either one passing justifies continuing; neither
passing stops the migration with nothing rewritten.

1. Latency share: spawn-latency distribution (p50/p99, cold/warm) and the
   share of a user-waited path that waits on it. Pass if p99 spawn exceeds
   ~10% of a waited path (depth-3 chains, quorum waits) where async cannot
   hide it.
2. Defect ledger: 3 months of extension fixes classified by subsystem. Pass
   if mesh/PID/lock/sweep defects dominate maintenance (>50% of fixes, or a
   recurrence no incremental fix closes).

If both fail, the never-migrate world wins: keep the boring transport,
revisit when the SDK stops moving or the ledger says otherwise. Probes
never run, phases never start.

## 2. API stability verdict: PUBLIC but FAST-MOVING

Installed `@earendil-works/pi-coding-agent` 1.0.0 (latest npm 1.1.0; ~50
releases since 0.74.0, created 2026-05-07).

First-class, no experimental markers, documented in `docs/sdk.md`:
`createAgentSession(options)` returns `{ session, extensionsResult }`;
`AgentSession` has `prompt`, `steer`, `followUp`, `abort`, `waitForIdle`,
`clearQueue`, `subscribe`, `getSessionStats`, `dispose`; `SessionManager`
has `create`, `open`, `continueRecent`, `findById`, `list`, `forkFrom`,
`inMemory`; sessions persist as JSONL auto-migrated to v3; resume works
across restarts; `getSessionStats()` aggregates over compacted history.

Past breaks redefined timing, not signatures (0.87.0 deferred settle
actions; 0.99.0 added per-input disposition, made bare `prompt()` reject).
Policy: pin the exact pi version in `package.json` plus lockfile. Upgrade
means bump pin, rerun probes, rerun the suite, amend the adapter. Never
build against a version not installed in the checkout. Types and runnable
probes outrank prose docs and d.ts examples (the shipped example uses a
`continueSession` option that does not exist).

## 3. Target semantics (frozen before any refactor)

- Orphan survival becomes resume with a specified sweeper: `session_start`
  re-queues non-terminal runs with no `reloadInterrupted` marker via
  `SessionManager` instead of synthesizing `failed`. Liveness without PIDs
  is session reachability, never a dummy pid. Test 21 asserts
  resume-and-collect. `spareLiveTree` and `self-report.ts` stay until the
  sweeper is green.
- Interrupt stays send-first-then-abort as one serialized unit on the live
  handle only, replicating the current `messageQueue` chain; elsewhere it
  degrades to `followUp`. Abort-then-steer ordering is proven per probe 3,
  not assumed.
- Cancel is execution-scoped: markers carry `executionId`; resume claims a
  generation under lock; cancel re-checks generation after abort and loops
  if the run re-queued beneath it. Supersede uses a monotonic generation
  sequence, never wall-clock equality.
- Approval inheritance is preserved with per-prompt trust: symlink
  re-resolution at every prompt and resume, not at session create, scoped
  through the pinned per-session mechanism or the migration stops.
  Silent always-approve is escalation; silent never-approve is a hang.
- UI requests keep forward-or-cancel with exactly-once delivery per
  request; headless auto-cancel stays until a designed replacement ships
  with its own probe.
- Concurrency gates and queued/starting lifecycles stay explicit.
- Unreachable children stay visible with error text, not a boolean.
- Usage reporting keeps the full 6-field summary the cost math needs.

## 4. Probes: kill gates with numbers (time-boxed, days)

Each runs against the pinned installed version. Any failure stops the
migration with nothing rewritten.

1. Cross-restart resume: transcript, usage, and model restore via
   `SessionManager`. Kill if any field drops.
2. Cost match: `getSessionStats()` equals billed cost across compaction,
   nested tools, and aborts. Kill on mismatch.
3. Abort/steer matrix: steer-then-abort, abort-then-steer, abort mid-tool
   then clean steer. Exactly one ordering specified, implemented once.
   Kill if the queued steer does not survive.
4. Concurrency: ten children, one hung turn. Kill if the other nine do
   not all settle or their p99 exceeds 2x the same-day process baseline.
5. Fault containment, three separate legs with a parent holding a turn:
   (a) sync infinite loop in a child tool, (b) async never-resolving
   tool, (c) 100MB transcript growth. Each leg records parent event-loop
   lag p99 (dedicated heartbeat; kill if over budget for the window),
   parent heap delta ceiling, sibling settle ceiling, and offender
   `abort()`-to-settled latency. Any leg needing a process restart, or
   blocking a sibling past ceiling, kills the migration.
6. Settle payload and timing on the pinned version: `aborted` flag
   presence, settle vs `waitForIdle` ordering, sends during settle
   emission. Kill on skew the adapter cannot absorb.
7. Approval matrix: trusted/untrusted x inside/outside x
   symlink-swap-between-check-and-prompt. Kill on silent always-approve
   or silent never-approve hang.
8. UI matrix: headless parent, UI parent, two concurrent child requests.
   Pass is exactly-once forward-or-cancel per request with dismissal
   normalized at the boundary. Deadlock, vanish, or double-prompt kills.
9. Orphan probe: kill the host with a live grandchild, start a new host,
   collect via `check_subagents`. Kill if the result is `failed` instead
   of resume-and-collect.

## 5. Suite: parity corpus, no new harness

No new test file, no backend seam, no split suites, no coupling budget.
The existing `subagents.test.cjs` stays as-is on processes. A parity
corpus is named, not built: delivery-once bodies, cancel-monotonicity,
cost-once plus audit ordering, orphan-resume-and-collect, reload
supersede. The corpus runs UNCHANGED on both backends; it is the only
suite gate that matters. Transport-specific assertions are deleted inline
at cutover with the transport, not versioned beforehand. Any other edit
that tightens timings or silences failures is red. Fake-only green is
never a phase exit: Phase 4 exits on the pinned live SDK with ceilings
and content checks (depth-3 bodies, sibling-steer ordering, wake-up
delivery, cancel-then-collect, cross-restart resume with usage intact).

## 6. Phase order

1. Gate 0 (section 1). Price or stop.
2. Probes (section 4). Kill gates. No refactor yet.
3. Freeze section 3 on paper. One page, no code.
4. Flag day on idle trees: rewrite `spawn-agent.ts` to call the SDK
   directly (no interface, no flag, no schema version; clean shutdown
   required). Same release delete `mesh.ts`, `self-report.ts`, locks,
   sweeps, parks, PID fields, sidecars. Drain and restart in-flight
   trees; never mixed trees.
5. Rollback is whole-tree restart on the old release, not a flag.

Every phase ends with the full suite green. The live ladder repeats the
proven legs (depth-3 chain, sibling steer, wake-up, cancel, resume) on
in-process before the old release is retired.

## 7. File-by-file fate

Delete: `mesh.ts`, `self-report.ts`, pending-message sidecars, offline
markers, stale-socket sweeps, PID trees, linger logic, parked flush,
`withRecordLock` (single writer needs none), wall-clock supersede checks.

Rewrite: `spawn-agent.ts` core becomes direct SDK calls (spawn, send,
abort, turn backstop on subscribe events, settle via `waitForIdle`);
`index.ts` edges (ingress becomes subscriptions, resume via
`SessionManager`); `registry.ts` (drop PID liveness and process locks;
keep records, execution-scoped markers with generation sequence, claim
logic, audit schema).

Unchanged: `config.ts`, `types.ts`, `cost.ts`, `widget.ts`, addressing,
tool descriptions, receipts, README behavior sections.

Explicitly retained in adapted form: cancelled/closed markers on
execution ids, reload-interrupt markers, adoption suffixing, symlink
trust resolution, headless auto-cancel, the orphan sweeper.
