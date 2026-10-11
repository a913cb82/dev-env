# Subagents: process-to-in-process migration plan (v5)

Goal: run subagents as in-process pi sessions instead of spawned `pi --mode rpc`
processes. Keep every tree semantic. Delete the transport layer.

Non-goals: change the four tools, change addressing, change claiming or cost
rules, support both transports in production.

Simplicity is a hard constraint on the path, not just the end state. One
transport per tree. Thin adapter or it fails review. Delete, do not port.
No phase may add lasting complexity to serve the transition.

## 0. Review verdicts (12 reviewers, all read the code)

Round 3: downgrade BLOCK (trust downgrade is surrender — the child itself
exploits the window; orphan resume needs fencing, order, no-replay, wait
re-registration before any deletion). Closure AMEND (threading feasible;
needs handoff mechanism, runtime Map, per-root gate, settings freeze,
COMMAND inventory, DEFAULT_* as root-inherit). SDK-future AMEND (pin
splits dev/runtime with a ceiling, tiered re-probe, timing canary,
rollback backup, priced standing cost). Cost AMEND (probe 2 becomes six
legs; lock contradiction resolved by retaining withRecordLock; single
writer; floor never regresses; durable floor).

Round 2: trust-knob NO-GO (no per-prompt trust primitive on SDK 1.0.0).
Orphan-sweeper BLOCK (seven-state fan, no liveness oracle). Ledger
CONDITIONAL PASS (52% fix-only, 41% full ledger, 3-week window).
Wildcard BLOCK (PI_SUBAGENT_* env is unnamed transport; fixed below).

Round 1: correctness 2x BLOCK + AMEND. Value BLOCK (answered by Gate 0).
Verifiability BLOCK. Simplicity AMEND (no interface, no seam, kept).

## 1. Gate 0: price it or stop (before everything)

1. Latency share: spawn p50/p99 cold/warm and the share of a user-waited
   path that waits on it. Pass if p99 spawn exceeds ~10% of a waited path
   where async cannot hide it.
2. Defect ledger: 3 months of fixes by subsystem (current window covers 3
   weeks: transport 52% fix-only, 41% full ledger — extend the window
   before pricing on this leg). Pass if mesh/PID/lock/sweep defects
   dominate (>50%) or a recurrence no incremental fix closes.
3. Standing cost: probe-days per pi bump times release cadence (~2.6 days)
   versus ledger cost per quarter. Pass only if staying migrated costs
   less than the transport it replaces.

Any leg failing stops the migration with nothing rewritten. Revisit when
SDK cadence drops below one breaking change per quarter or the ledger
says otherwise.

## 2. API stability: PUBLIC but FAST-MOVING, pinned twice

Installed 1.0.0, latest npm 1.1.0 (which already invalidated settle
assumptions with the `aborted` flag — the pin was stale on arrival).

First-class, no experimental markers: `createAgentSession` returns
`{ session, extensionsResult }`; `AgentSession` has `prompt`, `steer`,
`followUp`, `abort`, `waitForIdle`, `clearQueue`, `subscribe`,
`getSessionStats`, `dispose`; `SessionManager` persists JSONL auto-migrated
to v3 with cross-restart resume.

The pin splits in two. Dev pin (types and probes, in a real manifest —
none exists in this repo today). Runtime guard (the extension reads the
host version at load and refuses loudly outside the tested range, ceiling
included). A pin that cannot fail loud at runtime is decoration. Re-probe
tiers by changelog surface: patch or no SDK surface means smoke (probes 1,
6); minor with settle/session/event entries means targeted (1, 2, 3, 6,
7); session-version bump or agent/turn/disposition change means full
suite plus freeze review. A fast timing canary (prompt, steer, abort,
settle ordering plus `aborted` presence plus `waitForIdle`-vs-settle)
runs per host version so silent timing drift is caught without the full
battery. Rollback needs pre-flag-day session backup: sessions migrate
one-way on load, so whole-tree restart on the old release is unexecutable
after first touch without it. Types and runnable probes outrank prose
docs and d.ts examples.

## 3. Target semantics (frozen before any refactor)

- Orphan survival becomes resume with fencing first: claim generation
  before adoption, single-writer enforcement, deepest-first resume order
  with parent wake-text chaining, mid-tool no-replay guard, waits
  re-registered on the new host. The seven disk states triage to resume
  (mid-LLM with new executionId), inspect-first (mid-tool), fresh start
  (never-started), collect-only (self-reported terminal), hands-off
  (cancelled or delivered), drain-then-resume (parked), resolve-or-fail
  (stale sessionFile). Test 21 asserts resume-and-collect with no
  duplicate side effects. `spareLiveTree` and `self-report.ts` stay until
  the fenced sweeper plus probe 9 are green.
- Interrupt stays send-first-then-abort as one serialized unit on the
  live handle only; elsewhere it degrades to `followUp`.
- Cancel is execution-scoped: markers carry `executionId`; resume claims
  a generation under `withRecordLock`, which is retained (single writer
  was never true while monitor, self-report, and poller coexist); cancel
  re-checks generation after abort and loops if the run re-queued
  beneath it. Supersede uses a monotonic generation sequence.
- Approval trust is per-session-at-spawn with the window named: resolve
  once via ensureDirectory plus containment, pin the child's
  SettingsManager, re-resolve by fresh runtime at resume. The TOCTOU-safe
  per-spawn form is lost without an SDK-side atomic trust input; the
  child itself can exploit the window, so this downgrade needs either
  the SDK knob or adapter-side re-resolve on every prompt and approval
  decision before flag day. Silent always-approve or silent hang kills.
- UI requests keep exactly-once forward-or-cancel; headless auto-cancel
  stays until a designed replacement ships with its own probe.
- Concurrency gates go per-root (the module-global gate contaminates
  across trees); queued/starting lifecycles stay explicit; settings
  freeze per session.
- Unreachable children stay visible with error text.
- Usage has one writer: subscribe-events or stats-polling feeds
  `record.usage`, never both; `finalizeOwnRun` merges by per-field max,
  never replaces. Floor never regresses: `floor.set` is maxVector-guarded
  and `restoreCostFloor` fails loud on missing history. The floor lives
  outside the compactable transcript or receipts are proven
  compaction-immune on the pinned version.
- Identity travels in closures, never env: `config.ts` becomes env-free
  pure functions of explicit args. `PARENT_ID` was write-only dead weight
  and goes. `DEFAULT_MODEL` and `DEFAULT_THINKING` are operator ambient
  config: read once at root `session_start`, inherit through the closure.
  `PI_SUBAGENT_COMMAND` dies with the transport; an in-process fake
  replaces `fake-pi.cjs`. The spawn-to-`session_start` identity handoff
  needs its mechanism named (SDK affordance or keyed rendezvous) with a
  race analysis before any refactor; `runtime` becomes a per-session map
  with settle and shutdown gates rekeyed to it.

## 4. Probes: kill gates with numbers (time-boxed, days)

Each runs against the pinned installed version. Any failure stops the
migration with nothing rewritten.

1. Cross-restart resume: transcript, usage, and model restore. Kill on
   any dropped field.
2. Cost, six separately-killed legs with tolerances on all 6 fields:
   child stats vs billed across compaction; parent floor survival across
   parent compaction (no re-emit); abort matrix naming the canonical
   source; nested-tool single-count proof; fork and navigation
   invariance; zero-cost-model token reporting.
3. Abort/steer matrix: steer-then-abort, abort-then-steer, abort mid-tool
   then clean steer. One ordering, implemented once.
4. Concurrency: ten children, one hung turn. All nine settle, p99 within
   2x same-day process baseline.
5. Fault containment, three legs with a parent holding a turn: sync
   infinite loop, async never-resolving tool, 100MB transcript. Each
   records parent event-loop lag p99, heap delta ceiling, sibling settle
   ceiling, offender abort-to-settled latency. Process restart or a
   blocked sibling kills.
6. Settle payload and timing on the pinned version, including the 1.1.0
   `aborted` invalidation.
7. Approval matrix on the downgraded form plus an active symlink-swap
   adversary between spawn-check and second prompt. Silent approve or
   hang kills.
8. UI matrix: headless, UI parent, two concurrent requests.
   Exactly-once forward-or-cancel each; deadlock, vanish, or
   double-prompt kills.
9. Orphan probe with fencing: kill the host with a live grandchild, new
   host collects via `check_subagents`. Kill on `failed`, on a second
   writer, or on a duplicate side effect.
10. Env-identity probe, one process: maxDepth=1 allows the child and
    rejects the grandchild; two concurrent roots with maxDepth 1 versus
    5 keep budgets plus gate slots separate. Kill on cross-talk.

## 5. Suite: parity corpus, no new harness

No new test file, no backend seam, no split suites. `subagents.test.cjs`
stays as-is on processes. Parity corpus, run UNCHANGED on both backends:
delivery-once bodies, cancel-monotonicity, cost-once plus audit ordering,
orphan-resume-and-collect, reload supersede. Transport-specific assertions
die inline at cutover. Fake-only green is never an exit: cutover exits on
the pinned live SDK with ceilings and content checks.

## 6. Phase order

1. Gate 0 (section 1). Price or stop.
2. Probes (section 4). Kill gates. No refactor yet.
3. Freeze section 3 on paper. One page equivalent, no code.
4. Flag day on idle trees: rewrite `spawn-agent.ts` against the SDK
   directly. Same release delete `mesh.ts`, `self-report.ts`, locks,
   sweeps, parks, PID fields, sidecars, PI_SUBAGENT_* plumbing. Drain
   and restart in-flight trees; never mixed trees. Session backup first.
5. Rollback is whole-tree restart on the old release against backed-up
   sessions, tested once before cutover.

Every phase ends with the full suite green. The live ladder repeats the
proven legs on in-process before the old release retires.

## 7. File-by-file fate

Delete: `mesh.ts`, `self-report.ts`, pending-message sidecars, offline
markers, stale-socket sweeps, PID trees, linger logic, parked flush,
wall-clock supersede checks, `PARENT_ID`, `PI_SUBAGENT_COMMAND`.

Rewrite: `spawn-agent.ts` core (direct SDK calls, settle via
`waitForIdle`); `index.ts` edges (subscriptions, `SessionManager`
resume, per-session runtime map, rekeyed gates); `registry.ts` (drop PID
liveness and process locks; keep records, execution-scoped markers with
generation sequence, claim logic, audit schema); `config.ts` (env-free
pure functions, root-inherit for operator ambient).

Unchanged: `types.ts`, `cost.ts`, `widget.ts`, addressing, tool
descriptions, receipts, README behavior sections.

Retained: cancelled/closed markers on execution ids, reload-interrupt
markers, adoption suffixing, symlink trust resolution, headless
auto-cancel, the fenced orphan sweeper, `withRecordLock` until the
single-writer rule is proven.
