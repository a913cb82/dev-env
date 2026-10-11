# Subagents: process-to-in-process migration plan (v2)

Goal: run subagents as in-process pi sessions instead of spawned `pi --mode rpc`
processes. Keep every tree semantic. Delete the transport layer.

Non-goals: change the four tools, change addressing, change claiming or cost
rules, support both transports in production.

Simplicity is a hard constraint on the path, not just the end state. One
transport per tree. Thin adapter or it fails review. Delete, do not port.
No phase may add lasting complexity to serve the transition.

## 1. Adversarial review verdicts (5 reviewers, all read the code)

- Process skeptic: BLOCK. Fault isolation loss is fatal until proven
  otherwise: one poisoned child shares the parent heap and event loop, and
  there is no `kill -9` for a session. Debuggability regresses from Unix
  tools to `getSessionStats()`. The async design already hides spawn
  latency, so the payoff must be stated as maintainability, not speed.
- API hawk: AMEND. The surface is public but fast-moving with semantic
  breaks an adapter cannot contain (0.87.0 redefined settle timing with
  signatures intact). Phase 3 must not start on an uninstalled version.
- Harness: AMEND. The zero-test-edit gate is false. Receipts name the
  transport, liveness means PID-aliveness today, timing stacks differ.
  Replace with a coupling budget plus weaken-and-split triage.
- Functionality auditor: BLOCK. Approval inheritance and ui-request
  forwarding have no probe and no in-process equivalent established. The
  cross-writer safety net (locks, cancelled/closed markers, supersede
  checks) must survive in adapted form: reload generations still race.
- Strangler: BLOCK as sequenced. Phase 0 extraction is a rewrite in a
  refactor costume. Per-spawn flip plus one-transport-per-tree is
  contradictory. Corrected order: probes as kill gates, freeze target
  semantics, delete first, flag day on idle trees, delete together.

Common ground: probes come FIRST and can still kill this. The suite gets
versioned to target semantics once, explicitly. No dual-transport period.

## 2. API stability verdict: PUBLIC but FAST-MOVING

Investigated against installed `@earendil-works/pi-coding-agent` 1.0.0
(latest npm 1.1.0; ~50 releases since 0.74.0, created 2026-05-07).

What exists, first-class (no experimental/internal markers; `docs/sdk.md`
documents it as the integration path):

- `createAgentSession(options)` returns `{ session, extensionsResult }`.
  Options carry cwd, agentDir, model, thinkingLevel, tools, customTools,
  sessionManager, settingsManager.
- `AgentSession`: `prompt()`, `steer()`, `followUp()`, `abort()`,
  `waitForIdle()`, `clearQueue()`, `subscribe()`, `getSessionStats()`,
  `dispose()`.
- `SessionManager`: `create`, `open`, `continueRecent`, `findById`, `list`,
  `forkFrom`, `inMemory`. Sessions persist as JSONL, auto-migrated to v3.
  Resume works across restarts. Ephemeral opt-out exists.
- `getSessionStats()` aggregates tokens and cost over all entries including
  compacted history.
- Settle signal: `agent_settled` (1.1.0 adds an `aborted` flag; installed
  1.0.0 emits it bare).

Why an adapter is necessary but not sufficient: past breaks redefined
timing, not signatures (0.87.0 deferred settle actions; 0.99.0 added
per-input disposition and made `prompt()` without `streamingBehavior`
reject). A signature adapter contains the first column, not the timing
column. Policy: pin the exact pi version in `package.json` plus lockfile.
Upgrade means bump pin, rerun probes, rerun the suite on both backends,
amend the adapter. Never build against a version not installed in the
checkout. Types and runnable probes outrank prose docs and d.ts examples
(the shipped example uses a `continueSession` option that does not exist).

## 3. Target semantics (frozen before any refactor)

These decisions are the migration. Everything else is typing.

- Orphan survival becomes resume, not outliving. Today a grandchild
  process survives its parent's death. In-process, host death is children
  death. The guarantee becomes: every child persists its session file, and
  the next live host (or the root on wake) resumes it. Test 21 asserts
  resume-and-collect, not concurrent outliving.
- Interrupt stays abort-then... no: send-first-then-abort, live handle
  only, exactly as today. The adapter owns one ordering, proven by the
  abort/steer matrix probe.
- Approval inheritance is preserved, not re-decided. Per-session trust
  scoping must be found in settingsManager or equivalent, with symlink
  re-resolution kept. Silent always-approve is privilege escalation.
  Silent never-approve is a hang. Probe first.
- UI requests keep the forward-or-cancel boundary. Headless auto-cancel
  stays until a designed replacement ships.
- Cancel stays monotonic: cancelled markers beat concurrent resume, keyed
  on execution ids instead of PIDs. Stale writers skip via `updatedAt`
  supersede checks. Reload generations are still writers; the lock becomes
  a same-process mutex plus the file lock while any process transport
  exists.
- Concurrency gates and queued/starting lifecycles stay explicit. Holding
  an un-started session without prompting must be designed, not assumed.
- Unreachable children stay visible. Mesh-offline surfacing becomes
  session-unreachable surfacing with error text, not a boolean.
- Usage reporting keeps the full 6-field summary the cost math needs, not
  a 3-field subset.

## 4. Probes: kill gates before any refactor (time-boxed, days)

Each probe runs against the PINNED installed version. Any failure stops
the migration with no loss: nothing is rewritten yet.

1. Cross-restart resume: transcript, usage, and model restore via
   `SessionManager`.
2. `getSessionStats()` matches billed cost across compaction, nested
   tools, and aborts.
3. Abort/steer matrix: steer-then-abort, abort-then-steer, abort mid-tool
   then clean steer. One ordering specified, implemented once in the
   adapter.
4. Concurrency: ten children, one hung turn, p99 settle of the other nine
   within 2x of the process baseline.
5. Fault containment with teeth, on a live model: tool throw, infinite
   loop to turn limits, 100MB transcript, while the parent holds a turn.
   Parent heap and event-loop lag bounded, siblings unaffected, offender
   reaped by `abort()` alone. `kill -9` equivalence or it does not count.
6. `agent_settled` payload and timing on the pinned version: `aborted`
   flag presence, settle vs `waitForIdle` ordering, sends during settle
   emission.
7. Approval scoping per session plus symlink re-resolution.
8. UI/approval request surfacing from a child session: forward, deadlock,
   double-prompt, or vanish.
9. Payoff number: spawn-latency distribution (p50/p99, cold/warm) and the
   share of any user-visible path that waits on it. If the payoff is
   maintainability (delete the transport layer and its future races),
   state that and stop claiming speed.

## 5. tree.test.cjs: versioned once to target semantics

New file next to the existing suites. Rules:

- Drive only the four tools plus settings. Assert receipts, statuses,
  bodies, audit entries, delivery-once, ordering, error texts.
- Never assert sockets, PIDs, locks, mesh frames, signals, files as IPC,
  or fixed sleeps. Poll with ceilings via `timeoutMs` and `pollMs`.
- The suite is versioned to section 3 ONCE, explicitly, before Phase 3.
  After that the coupling budget governs: an edit is allowed iff it
  weakens an over-specific assertion or moves a transport-specific
  assertion to `transport-<name>.test.cjs`. Edits that tighten timings
  or silence failures are red. Each move is tracked in review.

Triage (from review; applies at versioning time):

- Truly identical: addressing (6-8), depth limit (19), name uniqueness
  (18), turn backstop text (20), cost-once and audit ordering (24-25),
  root refusal and invalid mode (26-27).
- Weaken in place: latency bounds become liveness-with-ceiling (1, 3-5),
  receipts become boundary regexes not exact strings (9-12), dedupe
  becomes at-most-once body (15).
- Split per transport: delivery-once mechanics (2), resume mechanics
  (13), starting-queue parking (14), cancel mechanics (16-17), orphan
  resume (21), settled-parent refusal text (22), reload mechanics (23).
  Process-only file is deleted with the transport.

Backend seam: an env flag selects the child backend (`fake-pi.cjs`
today, an in-process fake session later with the same script surface).

## 6. ChildTransport contract (revised)

```ts
interface SpawnedChild {
  runId: string;
  send(text: string, mode: "steer" | "followUp"): Promise<void>;
  abortTurn(): Promise<void>;
  kill(): Promise<void>;
  waitSettled(): Promise<SettleInfo>; // resolves like waitForIdle, not on raw event
  usage(): UsageSummary; // full 6-field summary for cost.ts
  transcriptPath(): string | undefined; // absent before the first prompt
  onEvent(cb: (ev: ChildEvent) => void): () => void;
  onUiRequest?: (req: UiRequest) => Promise<UiResponse>; // forward-or-cancel
}
type ChildEvent =
  | { type: "turn"; text: string; stopReason: string }
  | { type: "settled"; status: string; lastText: string; aborted: boolean };
```

The interface carries concurrency lifecycle (`queued`/`starting`), trust
scope, and ui-request forwarding. Anything it cannot carry thinly is a
sign the semantics are not frozen.

## 7. Phase order (corrected)

1. Probes (section 4). Kill gates. No refactor yet.
2. Freeze section 3 and version `tree.test.cjs` to it. Decide every
   delete up front: mesh parks, offline markers, PID liveness synthesis,
   `spareLiveTree`, starting queues. Deletion happens here on paper.
3. Extract pure logic only: tool/model/thinking resolution, path
   resolution, cost math, receipts. No `ChildTransport` yet. These are
   the only clean seams.
4. Build the in-process tree as a separate path, selected once per root
   (env plus registry schema version; refuse if a live node disagrees).
   Cut over idle trees only; drain and restart in-flight trees. No
   per-spawn flag, no mixed trees, no dual-transport period.
5. Delete the RPC transport in the same release: `mesh.ts`,
   `self-report.ts`, locks, sweeps, parks, PID fields. Never maintain
   both behind an interface.

Gates: every phase ends with the full suite green. Phase 2 ends with the
suite versioned and green on processes. Phase 4 ends with the suite green
on in-process plus the repeated live ladder (depth-3 chain, sibling
steer, wake-up, cancel, resume). Rollback before Phase 5 is whole-tree
restart on the old release, not a flag.

## 8. File-by-file fate

Delete: `mesh.ts`, `self-report.ts`, pending-message sidecars, offline
markers, stale-socket sweeps, PID trees, linger logic.

Rewrite: `spawn-agent.ts` core becomes the SDK adapter (spawn, send,
abort, turn backstop on subscribe events, settle via `waitForIdle`);
`index.ts` edges (ingress funnel becomes subscriptions, parked flush
deleted with parks, resume via `SessionManager`); `registry.ts` (drop
PID liveness and process locks; keep records, markers on execution ids,
claim logic, audit schema).

Unchanged: `config.ts`, `types.ts`, `cost.ts`, `widget.ts`, addressing,
tool descriptions, receipts, README behavior sections.

Explicitly retained in adapted form: `withRecordLock` semantics (mutex
plus file lock), cancelled/closed markers, `updatedAt` supersede checks,
reload-interrupt markers, adoption suffixing, symlink trust resolution,
headless auto-cancel.
