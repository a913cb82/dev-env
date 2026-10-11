# Subagents: process-to-in-process migration plan

Goal: run subagents as in-process pi sessions instead of spawned `pi --mode rpc`
processes. Keep every tree semantic. Delete the transport layer.

Non-goals: change the four tools, change addressing, change claiming or cost
rules, support both transports in production.

## 1. API stability verdict: PUBLIC but FAST-MOVING

Investigated against installed `@earendil-works/pi-coding-agent` 1.0.0
(latest npm 1.1.0, released 2026-10-07; ~50 releases since 0.74.0, created
2026-05-07).

What exists, first-class (no experimental/internal markers anywhere in the
SDK types; `docs/sdk.md` documents it as the integration path):

- `createAgentSession(options)` returns `{ session, extensionsResult }`.
  Options carry cwd, agentDir, model, thinkingLevel, tools, customTools,
  sessionManager, settingsManager.
- `AgentSession`: `prompt()`, `steer()`, `followUp()`, `abort()` ("abort
  current operation and wait for idle"), `waitForIdle()`, `clearQueue()`,
  `subscribe(listener)`, `getSessionStats()`, `dispose()`.
- `SessionManager`: `create`, `open`, `continueRecent`, `findById`, `list`,
  `forkFrom`, `inMemory`. Sessions persist as JSONL under
  `~/.pi/agent/sessions/`, auto-migrated to v3 on load. Resume works across
  process restarts. Ephemeral opt-out exists (`inMemory`, `--no-session`).
- `getSessionStats()` aggregates tokens and cost over all entries including
  compacted history, so billed totals survive compaction.
- Settle signal: `agent_settled` event (1.1.0 adds an `aborted` flag).
  `message_end` is the authoritative message; `agent_end` is one low-level
  run only.

Three biggest risks:

1. The session API changes shape often, including breaking changes (0.87.0
   made `SessionManager` canonical for `AgentSession` providers). Our
   installed 1.0.0 is six days and five releases stale. Pin the dependency
   and put every SDK touch behind one adapter module, so a pi upgrade
   breaks one file, not the extension.
2. Stale docs: the `sdk.d.ts` example uses `createAgentSession({
   continueSession: true })` but no such option exists. Resume goes through
   `SessionManager`. Trust types and runnable probes, not prose docs.
3. `prompt()` without an explicit `streamingBehavior` rejects instead of
   guessing steer vs followUp. Our send paths must always choose.

Verdict: buildable. Pin `1.1.0`, wrap the SDK in an adapter, probe resume
and usage before committing to the rewrite.

## 2. Strategy: strangler behind a transport interface

Never two transports in production. Sequence:

- Phase 0 (refactor): extract the current process behavior behind a
  `ChildTransport` interface. Same behavior, same suite green.
- Phase 1 (harness): write `tree.test.cjs`, a high-level suite that drives
  only the four tools and asserts only transport-free facts. It passes
  against the process transport.
- Phase 2 (spike): implement `InProcessTransport` behind the same
  interface, backed by a fake in-process session. `tree.test.cjs` passes
  unchanged against both.
- Phase 3 (flip): real SDK adapter, one spawn path at a time, live legs
  after each. Delete the RPC transport only when the suite plus live legs
  are green on in-process.
- Phase 4 (cleanup): delete `mesh.ts`, `self-report.ts`, locks, sweeps,
  parks, offline markers. Registry keeps records without PIDs.

Every phase ends with the full suite green. Any red stops the migration.

## 3. ChildTransport interface (draft)

```ts
interface SpawnedChild {
  runId: string;
  send(text: string, mode: "steer" | "followUp"): Promise<void>;
  abortTurn(): Promise<void>;
  kill(): Promise<void>;
  waitSettled(): Promise<SettleInfo>; // { status, lastText }
  usage(): { input: number; output: number; cost: number };
  transcriptPath(): string; // session file, for resume and archaeology
  onEvent(cb: (ev: ChildEvent) => void): () => void;
}
type ChildEvent =
  | { type: "turn"; text: string; stopReason: string }
  | { type: "settled"; status: string; lastText: string };

interface ChildTransport {
  spawn(opts: SpawnOpts): Promise<SpawnedChild>;
  resume(opts: ResumeOpts): Promise<SpawnedChild>; // from transcriptPath
  isLive(runId: string): boolean;
}
```

`SpawnOpts` carries task, name, cwd, model, thinking, tools, maxTurns,
graceTurns, system prompt, and an abort signal. The extension keeps
ownership, claiming, audit, cost math, depth, names, and hide rules. The
transport moves text and reports usage. Interrupt stays one place:
`send(steer)` then `abortTurn()`, live handle only.

## 4. tree.test.cjs: the suite that survives the migration

New file next to the existing per-module suites. Rules:

- Drive only the four tools (`spawn_agent`, `check_subagents`,
  `send_to_subagent`, `cancel_subagent`) plus settings.
- Assert only transport-free facts: receipts, record statuses, delivered
  bodies, audit entries, delivery-once, ordering, error texts.
- Never assert: sockets, PIDs, locks, mesh frames, signals, files as IPC,
  timing. Poll with ceilings, never fixed sleeps.
- Backend seam: an env flag selects the child backend. Today it points at
  `fake-pi.cjs`. After migration it points at an in-process fake session
  with the same script surface (delay, fail, hang, echo markers). The test
  file does not change.

Test inventory (each one must pass before AND after):

Spawn and collect:

1. Spawn returns at once; the child runs in the background.
2. Finishing wakes the owner; `check_subagents` delivers the body once;
   a second check reports nothing outstanding.
3. `wait` with `mode: all` returns after every child settles.
4. `wait` with `mode: any` returns after the first child settles.
5. `wait` times out with a partial result and keeps the rest outstanding.

Addressing:

6. `me/child` reaches an owned child.
7. `../sibling` reaches a sibling; `..` reaches the parent; `/a/b`
   reaches by absolute path; run-ID prefix reaches a grandchild.
8. Unknown target fails; ambiguous name fails with disambiguation;
   self-target is refused.

Messaging:

9. Steer receipt names the tool-call boundary; the target processes the
   message and completes.
10. FollowUp receipt names the settle boundary; the target processes it
    after its turn.
11. Interrupt receipt promises immediate delivery; the run continues to
    completion and processes the message.
12. Non-live interrupt arrives as a follow-up with an honest receipt.
13. Finished run resumes from its transcript; the message rides the new
    execution; ownership does not move.
14. Queued run parks the message; it delivers at start.
15. Duplicate delivery dedupes: one body, one audit entry.

Cancel and limits:

16. Cancel stops a running child; status reads `cancelled`.
17. Cancel of a subtree stops descendants deepest-first.
18. Duplicate sibling name is refused; names stay unique among siblings.
19. Depth limit refuses a too-deep spawn with a clear error.
20. `maxTurns` wrap-up steer fires; past `maxTurns + graceTurns` the run
    cancels.

Orphans and wake chains:

21. A grandchild outlives its settled parent; the root collects the body.
22. Settled-parent resume is refused with a spawn-fresh error.
23. Reload resumes interrupted children; they complete and deliver.

Cost and audit:

24. Cost attributes once to the subtree; re-checks add nothing.
25. Audit log appends every cross message in order; viewing never claims.

Errors:

26. Root target refuses cancel and check; messaging the root works.
27. Invalid mode is rejected with the three valid modes named.

Widget and hide rules already live in `widget.test.cjs` and stay: they
assert display facts, not transport.

## 5. File-by-file fate (verify each during Phase 0)

Delete: `mesh.ts` (sockets, protocol, sweeps, tokens), `self-report.ts`
(replaced by `agent_settled` subscriptions), pending-message sidecars,
offline markers, stale-socket sweeps.

Rewrite the core: `spawn-agent.ts` (process spawn, stdio, PID trees, locks
around spawn, linger, EPIPE handling become the SDK adapter). Rewrite the
edges: `index.ts` (bind, ingress funnel, parked flush, resume paths keep
their shape but call the transport); `registry.ts` (drop `withRecordLock`,
`isProcessAlive`, PID liveness; liveness becomes `transport.isLive`).

Unchanged: `config.ts`, `types.ts`, `cost.ts`, `widget.ts`, addressing in
`paths` logic, tool descriptions, receipts, README behavior sections.

## 6. Gates and rollback

- Phase 0 gate: `tree.test.cjs` written, green on processes, plus all
  existing suites green. No behavior change in the diff.
- Phase 2 gate: `tree.test.cjs` green on BOTH transports with zero test
  edits. Any test edit here means the test was transport-coupled; fix the
  test, not the rule.
- Phase 3 gate: live legs repeat the proven ladder (depth-3 chain,
  sibling steer, wake-up, cancel, resume) on in-process, one spawn path
  at a time.
- Rollback: the RPC transport stays until Phase 4. A flag selects the
  transport per spawn during Phase 3; flip back is one setting.

## 7. Open probes (do first, they can still kill this)

1. Resume a real session across a process restart via `SessionManager`
   and confirm transcript, usage, and model restore.
2. Confirm `getSessionStats()` cost matches billed cost on a live model
   call, and survives compaction.
3. Confirm `abort()` mid-tool-call drops the call without killing the
   session, and the next `steer()` starts clean.
4. Confirm ten in-process children run concurrently without head-of-line
   blocking on one stuck turn.
5. Confirm a fault-injected child (tool throw, OOM-ish loop with turn
   limits) cannot wedge the parent session.
