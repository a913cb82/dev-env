import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	getAgentDir,
	getMarkdownTheme,
	type ExtensionAPI,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { currentDepth, loadSettings, THINKING_LEVEL_VALUES } from "./config.ts";
import { computeFlush, restoreCostFloor, type AttributedUsage, type CostFloor } from "./cost.ts";
import { appendAgentMessage, drainPendingMessages, executionResultKey, getCachedRecords, isProcessAlive, isTerminalStatus, listFooterDismissed, markFooterDismissed, markRecordResultState, pruneRecords, queuePendingMessage, readRecords, saveRecord, withRecordLock, markReloadInterrupted, readReloadInterrupted, listReloadInterrupted, clearReloadInterrupted, type ReloadInterruptMarker } from "./registry.ts";
import { deliverMeshMessage, startMeshServer, meshSocketDir, meshSocketPath, sendMeshMessage, type MeshEnvelope, type MeshServer } from "./mesh.ts";
import { notifyWaiters, waitUntilSubagentsIdle } from "./wait.ts";
import { SubagentStatusWidget } from "./widget.ts";
import {
	cancelSubagent,
	gate,
	killPidTree,
	reapOwnedIfDrained,
	meshSenderFor,
	resumeSubagent,
	sendSubagentMessage,
	startSubagent,
	terminateOwnedSubagents,
} from "./spawn-agent.ts";
import { descendantsOf, resolveAgentPath, uniqueSiblingName } from "./registry.ts";
import { finalizeOwnRun, maybeWakeParent, summarizeSettleEvent, type SettleEventLike } from "./self-report.ts";
import type { AgentRecord, SubagentMessageMode, SubagentSettings, UsageSummary } from "./types.ts";
import { normalizeMessageMode } from "./types.ts";

interface RuntimeState {
	runId: string;
	rootRunId: string;
	depth: number;
	settings: SubagentSettings;
	projectTrusted: boolean;
}

const SpawnAgentSchema = Type.Object({
	task: Type.String({ description: "Task to delegate" }),
	name: Type.String({ description: "Subagent name (required, unique among siblings)" }),
	cwd: Type.Optional(Type.String({ description: "Working directory (relative unless absolute)" })),
	model: Type.Optional(Type.String({ description: "Exact model selector. Overrides configured and inherited defaults." })),
	thinking: Type.Optional(
		Type.String({ description: "Thinking level for this subagent", enum: [...THINKING_LEVEL_VALUES] }),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Subset of my active tools; omit to inherit all" })),
	maxDepth: Type.Optional(Type.Integer({
		description: "Tree depth budget for this spawn (default 2). Only the top-level root session may set it; descendants inherit and can never raise it.",
		minimum: 0,
	})),
});

const CheckSchema = Type.Object({
	targets: Type.Optional(Type.Array(Type.String(), {
		description: "Tree paths (/a/b absolute, me/child, ../sibling) or run id/prefix, session id, or name; omit for all",
	})),
	wait: Type.Optional(Type.Boolean({ description: "Block until they finish (returns early)" })),
	mode: Type.Optional(Type.String({
		description: "With wait: resolve when any or all finish (default all)",
		enum: ["any", "all"],
	})),
	timeoutMs: Type.Optional(Type.Integer({ description: "Max wait in ms (default 30000, max 300000)" })),
});

const CancelSchema = Type.Object({
	target: Type.String({ description: "Tree path (/a/b, me/child, ../sibling) or run id/prefix, session id, or name" }),
});

const SendSchema = Type.Object({
	target: Type.String({ description: "Tree path (/a/b absolute, me/child, ../sibling) or run id/prefix, session id, or name" }),
	message: Type.String({ description: "Message for the subagent" }),
	mode: Type.Optional(Type.String({
		description: "steer (default) redirects current work; followUp queues behind it",
		enum: ["steer", "followUp"],
	})),
});

const RESULT_OUTPUT_CAP = 8000;

/** Message that restarts an interrupted turn from its transcript after a reload. */
const RELOAD_RESUME_MESSAGE =
	"The parent session reloaded and your previous turn was interrupted before it could finish. " +
	"Continue your task from where you left off; do not restart work already present in the transcript above.";

function cap(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function shortId(runId: string): string {
	return runId.slice(0, 8);
}

export default function subagentsExtension(pi: ExtensionAPI) {
	let runtime: RuntimeState | undefined;
	let widget: SubagentStatusWidget | undefined;
	let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
	let deliveryRetryDelay = 1000;
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	let sessionAbort = new AbortController();
	let shuttingDown = false;
	let agentActive = false;
	let isIdle: (() => boolean) | undefined;
	let delivering = false;
	let deliveryPaused = false;
	let activeSignal: AbortSignal | undefined;
	let meshServer: MeshServer | undefined;
	let meshWarned = false;
	// Bind with retries: a resumed session can race its own dying predecessor
	// for the socket name, and a reload may never re-fire session_start at all.
	// Without this socket no tree message can reach this session, so every
	// tool execute ensures it (lazy path, extension scope so tools can call it).
	const bindMeshServer = async (): Promise<unknown> => {
		if (!runtime || shuttingDown || meshServer) return undefined;
		const agentDir = getAgentDir();
		let lastError: unknown;
		for (let attempt = 0; attempt < 3 && !meshServer; attempt++) {
			if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
			try {
				meshServer = await startMeshServer({
					socketDir: meshSocketDir(agentDir),
					runId: runtime.runId,
					maxLineChars: runtime.settings.rpcMaxLineChars,
					isKnownRunId: (id) =>
						id === runtime!.rootRunId ||
						getCachedRecords(agentDir).some((record) => record.runId === id && record.rootRunId === runtime!.rootRunId),
					onMessage: handleMeshMessage,
				});
			} catch (error) {
				lastError = error;
			}
		}
		return lastError;
	};
	const warnMeshOffline = (lastError: unknown, ui?: { notify?: (message: string, type?: string) => void }) => {
		if (meshServer || meshWarned) return;
		meshWarned = true;
		try {
			ui?.notify?.(`Subagent mesh offline (${lastError instanceof Error ? lastError.message : String(lastError)}): this session cannot receive tree messages.`, "error");
		} catch { /* notification is best effort */ }
	};
	const ensureMeshBound = async (ui?: { notify?: (message: string, type?: string) => void }) => {
		if (!runtime || shuttingDown) return;
		// A stale handle (server object set, socket file gone - killed racing
		// predecessor, external unlink) must rebind, not early-return deaf.
		if (meshServer) {
			try {
				if (!existsSync(meshSocketPath(meshSocketDir(getAgentDir()), runtime.runId))) {
					try { await meshServer.close(); } catch { /* already gone */ }
					meshServer = undefined;
				}
			} catch { /* on doubt keep the existing handle */ }
		}
		if (meshServer) return;
		warnMeshOffline(await bindMeshServer(), ui);
	};
	const deliveredResults = new Set<string>();
	const notifiedResults = new Set<string>();
	const seenDescendantResults = new Set<string>();
	/** Per-child reported subtree-cost totals. Rebuilt from session entries on start/tree; advanced by flushes. */
	const costFloor: CostFloor = new Map();
	const resultKey = (record: AgentRecord) => executionResultKey(record);
	/** Terminal records whose report this session has not consumed yet. */
	const undelivered = (records: readonly AgentRecord[]) =>
		records.filter((record) => isTerminalStatus(record.status) && !record.resultsDelivered && !deliveredResults.has(resultKey(record)));
	/** Terminal records this session has not pinged yet (steering notice, not body). */
	const unpinged = (records: readonly AgentRecord[]) =>
		records.filter((record) => isTerminalStatus(record.status) && !record.resultsDelivered && !deliveredResults.has(resultKey(record)) && !notifiedResults.has(resultKey(record)));
	/** Finished report body, or the live activity line while the child runs. */
	const resultBody = (record: AgentRecord): string =>
		isTerminalStatus(record.status)
			? cap(record.status === "completed" ? record.latestText || "(no output)" : record.error || record.status, RESULT_OUTPUT_CAP)
			: `still running: ${record.currentTool || record.activity || record.status}`;
	const formatResult = (record: AgentRecord, meta?: string): string =>
		`### ${record.name} — ${record.status}${meta ? `\n${meta}` : ""}\n\n${resultBody(record)}`;
	/** Re-read a record so send/cancel decisions use the latest on-disk state. */
	const latestRecord = (record: AgentRecord): AgentRecord =>
		getCachedRecords(getAgentDir()).find((item) => item.runId === record.runId) ?? record;
	const senderName = (runId: string): string => {
		if (runId === runtime?.rootRunId) return "root";
		return getCachedRecords(getAgentDir()).find((record) => record.runId === runId)?.name ?? runId;
	};
	/** Parked inbound mesh texts, oldest first. A busy session cannot take
	 * an injection (the host drops it), so arrivals park here and flush in
	 * order when the session idles. Bounded: beyond the cap the oldest goes. */
	const meshParked: Array<{ from: string; mode: SubagentMessageMode; text: string }> = [];
	const MESH_PARK_CAP = 50;
	/** Inject mesh text into this session as a native steer/followUp message. */
	const injectMeshNow = async (from: string, mode: SubagentMessageMode, text: string) => {
		try {
			await pi.sendMessage(
				{ content: `[${senderName(from)}] ${text}` },
				{ triggerTurn: true, deliverAs: mode },
			);
		} catch {
			// Session ending or host rejection: the message is dropped.
		}
	};
	const injectMeshText = async (from: string, mode: SubagentMessageMode, text: string) => {
		if (!runtime || shuttingDown) return;
		// Audit first: the append-only log never touches the record JSON
		// (owned by the parent process), so logging cannot regress it.
		try {
			await appendAgentMessage(getAgentDir(), runtime.runId, { from, mode, text });
		} catch {
			// Audit never blocks delivery.
		}
		if (isIdle && !isIdle()) {
			if (meshParked.length >= MESH_PARK_CAP) meshParked.shift();
			meshParked.push({ from, mode, text });
			return;
		}
		await injectMeshNow(from, mode, text);
	};
	/** Flush parked inbound mesh texts in order while the session idles. */
	const flushMeshParked = async () => {
		while (meshParked.length > 0 && !shuttingDown && runtime && (!isIdle || isIdle())) {
			const next = meshParked.shift()!;
			await injectMeshNow(next.from, next.mode, next.text);
		}
	};
	// Recently seen inbound mesh envelope ids. The sender retries after any
	// transport failure, so the same envelope can arrive twice (both copies
	// are ACKed); the second copy must not audit, park, or inject again.
	// Bounded: insertion-ordered, the oldest id goes past the cap.
	const seenMeshIds = new Set<string>();
	const SEEN_MESH_ID_CAP = 200;
	const handleMeshMessage = (envelope: MeshEnvelope) => {
		if (!runtime || shuttingDown) return;
		if (seenMeshIds.has(envelope.id)) return;
		seenMeshIds.add(envelope.id);
		if (seenMeshIds.size > SEEN_MESH_ID_CAP) {
			const oldest = seenMeshIds.values().next().value;
			if (oldest !== undefined) seenMeshIds.delete(oldest);
		}
		if (envelope.type === "settled") {
			notifyWaiters(getAgentDir());
			scheduleDelivery(0);
			return;
		}
		const text = (envelope.payload as { text?: unknown }).text;
		if (typeof text !== "string" || !text) return;
		void injectMeshText(envelope.from, envelope.type, text);
	};
	const formatPing = (record: AgentRecord): string =>
		`Subagent ${record.name} finished (${record.status}, run ${shortId(record.runId)}). Use check_subagents to read its result.`;
	const rememberNotified = (records: AgentRecord[]) => {
		for (const record of records) {
			notifiedResults.add(resultKey(record));
		}
	};
	const rememberDelivered = (records: AgentRecord[]) => {
		for (const record of records) {
			deliveredResults.add(resultKey(record));
			notifiedResults.add(resultKey(record));
			try { markRecordResultState(getAgentDir(), record, "resultsDelivered"); } catch {
				// Keep the report in the returned content even if disk persistence fails.
				// Session receipts restore this in-memory claim after reload.
			}
		}
	};
	const restoreReceipts = (entries: readonly SessionEntry[], viewerRunId?: string) => {
		seenDescendantResults.clear();
		for (const entry of entries) {
			const rawDetails = entry.type === "custom_message" && entry.customType === "subagent-results"
				? entry.details : entry.type === "message" && entry.message.role === "toolResult" ? entry.message.details : undefined;
			const details = rawDetails as { resultKeys?: unknown; notifiedKeys?: unknown; seenDescendantResults?: unknown } | undefined;
			for (const key of Array.isArray(details?.resultKeys) ? details.resultKeys : []) {
				if (typeof key === "string") { deliveredResults.add(key); notifiedResults.add(key); }
			}
			for (const key of Array.isArray(details?.notifiedKeys) ? details.notifiedKeys : []) {
				if (typeof key === "string") notifiedResults.add(key);
			}
			for (const key of Array.isArray(details?.seenDescendantResults) ? details.seenDescendantResults : []) {
				if (typeof key === "string") seenDescendantResults.add(key);
			}
		}
		// Second durability leg for observation: transcript receipts are lost to
		// compaction, forks, and branch subsets, but the dismissal sidecars
		// survive. Claims need no help here; their markers already persist.
		// The viewer is explicit because fresh startups restore before the
		// runtime exists - without it every dismissed descendant resurfaces
		// after quit+resume.
		const viewer = viewerRunId ?? runtime?.runId;
		if (viewer) {
			try {
				for (const key of listFooterDismissed(getAgentDir(), viewer)) seenDescendantResults.add(key);
			} catch {
				// Observation is best effort; the transcript leg still applies.
			}
		}
	};

	/** Hold the event loop open while background children run (matters for print-mode parents). */
	const refreshKeepAlive = () => {
		if (!runtime || shuttingDown) return;
		const pending = descendantsOf(getCachedRecords(getAgentDir()), runtime!.runId).some(
			(record) => !isTerminalStatus(record.status),
		);
		if (pending && !keepAlive) {
			keepAlive = setInterval(() => {}, 60000);
		} else if (!pending && keepAlive) {
			clearInterval(keepAlive);
			keepAlive = undefined;
		}
	};

	/** Deliver finished-but-undelivered child results to this session, debounced so parallel finishes batch into one message. */
	const scheduleDelivery = (delay = 1000) => {
		if (deliveryTimer || shuttingDown) return;
		deliveryTimer = setTimeout(async () => {
			deliveryTimer = undefined;
			try {
				await deliverResults();
				deliveryRetryDelay = 1000;
			} catch {
				// Keep the result unclaimed and back off while this session is alive.
				const retryDelay = deliveryRetryDelay;
				deliveryRetryDelay = Math.min(deliveryRetryDelay * 2, 30000);
				scheduleDelivery(retryDelay);
			}
		}, delay);
		// Unlike progress/debounce timers, this timer is the only thing that can
		// deliver a completed result after a print-mode parent becomes idle. Keep it
		// referenced so the parent cannot exit before the automatic delivery runs.
	};

	const deliverResults = async () => {
		// Steering pings may interrupt active work: the parent decides whether to
		// address a finish straight away or keep working and pull via check_subagents.
		if (!runtime || shuttingDown || delivering || deliveryPaused) return;
		const agentDir = getAgentDir();
		const children = getCachedRecords(agentDir).filter((record) => record.parentRunId === runtime!.runId);
		const pending = unpinged(children);
		if (pending.length === 0) return;
		const parts = pending.map((record) => formatPing(record));
		const intro =
			pending.length === 1
				? `Subagent finished:`
				: `${pending.length} subagents finished:`;
		// Pi's extension binding returns void, not a model-completion receipt.
		// At idle it starts the prompt directly instead of queueing; while
		// streaming it queues as steering. Also honor rejection from hosts
		// that return a promise.
		delivering = true;
		try {
			await pi.sendMessage(
				{
					customType: "subagent-results",
					content: `${intro}\n\n${parts.join("\n")}\n\nUse check_subagents to read results.`,
					display: false,
					details: { notifiedKeys: pending.map(resultKey) },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			rememberNotified(pending);
			reapOwnedIfDrained(agentDir);
		} finally {
			delivering = false;
		}
	};

	pi.on("agent_start", (_event, ctx) => {
		agentActive = true;
		deliveryPaused = false;
		activeSignal = ctx.signal;
		void flushMeshParked();
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && event.message.stopReason === "aborted") deliveryPaused = true;
		void flushMeshParked();
	});
	pi.on("agent_settled", () => {
		agentActive = false;
		if (activeSignal?.aborted) deliveryPaused = true;
		if (!deliveryPaused) scheduleDelivery(0);
		void flushMeshParked();
	});
	pi.on("session_tree", (_event, ctx) => {
		restoreReceipts(ctx.sessionManager.getBranch());
		// Replace, never merge: a fork copies a subset of entries, so a stale-high
		// floor would under-report the new file forever.
		restoreCostFloor(costFloor, ctx.sessionManager);
	});

	// Flush unreported descendant spend as usage on completed tool results.
	// Finished bodies are never attached here: finishes arrive as steering pings
	// (deliverResults) and full text is pulled via check_subagents.
	pi.on("tool_result", (event, ctx) => {
		if (ctx.signal?.aborted) { deliveryPaused = true; return; }
		if (!runtime || shuttingDown || delivering || deliveryPaused) return;
		// Custom tools may use scalar/array details. Leave their result shape alone.
		if (event.details !== undefined && (!event.details || typeof event.details !== "object" || Array.isArray(event.details))) return;
		const details = event.details as Record<string, unknown> | undefined;
		const agentDir = getAgentDir();
		const records = getCachedRecords(agentDir);
		// Flush unreported descendant spend as usage on this tool result, whatever
		// the tool was. Independent of pending reports: running children accrue
		// cost with no report yet, and terminal states all leave final usage behind.
		let cost: { usage: AttributedUsage; receipt: Record<string, UsageSummary> } | undefined;
		try {
			cost = computeFlush(records, runtime!.runId, costFloor);
		} catch {
			// A registry hiccup degrades to skipping cost this flush, never to a broken tool result.
			cost = undefined;
		}
		if (!cost) return;
		return {
			details: {
				...details,
				...(cost ? { costReported: cost.receipt } : {}),
			},
			...(cost ? { usage: cost.usage } : {}),
		};
	});

	pi.registerFlag("subagent-depth", {
		description: "Maximum recursive subagent depth (any non-negative integer)",
		type: "string",
	});

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		agentActive = false;
		isIdle = () => ctx.isIdle?.() ?? !agentActive;
		deliveryPaused = false;
		deliveredResults.clear();
		notifiedResults.clear();
		const runId = process.env.PI_SUBAGENT_RUN_ID || ctx.sessionManager.getSessionId();
		const rootRunId = process.env.PI_SUBAGENT_ROOT_ID || runId;
		restoreReceipts(ctx.sessionManager.getBranch?.() ?? [], runId);
		restoreCostFloor(costFloor, ctx.sessionManager);
		try {
			runtime = {
				runId,
				rootRunId,
				depth: currentDepth(),
				settings: loadSettings({
					agentDir: getAgentDir(),
					cwd: ctx.cwd,
					projectTrusted: ctx.isProjectTrusted(),
					depthFlag: typeof pi.getFlag("subagent-depth") === "string" ? String(pi.getFlag("subagent-depth")) : undefined,
				}),
				projectTrusted: ctx.isProjectTrusted(),
			};
		} catch (error) {
			runtime = undefined;
			if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}

		if (!runtime) return;
		try {
			// Best-effort rotation of terminal records; keeps every registry
			// scan (widget, tool_result, waits) proportional to live work.
			// Undelivered runs are covered too: anything terminal older than
			// the threshold has no live claimant left to read it.
			const DAY_MS = 24 * 3600 * 1000;
			pruneRecords(getAgentDir(), {
				olderThanMs: (runtime.settings.pruneDeliveredAfterDays ?? 14) * DAY_MS,
				keepMinimum: runtime.settings.pruneDeliveredKeep ?? 50,
				undeliveredAfterMs: (runtime.settings.pruneUndeliveredAfterDays ?? 30) * DAY_MS,
				undeliveredKeep: runtime.settings.pruneUndeliveredKeep ?? 500,
			});
		} catch {
			// Rotation must never break session startup.
		}
		scheduleDelivery();

		// Socket mesh: this session is addressable tree-wide by its run id.
		// Binding never breaks startup; without it only owned children are reachable.
		// Capture the directory synchronously: async continuations below may
		// run after the host has moved on (tests multiplex several sessions).
		const meshAgentDir = getAgentDir();
		void (async () => {
		try {
			if (meshServer) {
				try { await meshServer.close(); } catch { /* replaced */ }
				meshServer = undefined;
			}
			warnMeshOffline(await bindMeshServer(), ctx.hasUI ? ctx.ui : undefined);
		} catch {
			meshServer = undefined;
		}
		// Parked messages (queued while this run had no session) drain in order.
		try {
			const pending = await drainPendingMessages(meshAgentDir, runtime!.runId);
			for (const message of pending) {
				try {
					await pi.sendMessage(
						{ content: `[${senderName(message.from)}] ${message.text}` },
						{ triggerTurn: true, deliverAs: message.mode },
					);
				} catch {
					// Session ending: remaining parked messages are dropped.
					break;
				}
			}
		} catch {
			// No pending queue, no problem.
		}
		})().catch(() => {
			// Mesh setup is best effort and never breaks session startup.
		});

		sessionAbort = new AbortController();

		// A /reload tears down live children with the old runtime; restart the
		// ones it interrupted so active work continues instead of dying cancelled.
		// No markers exist on ordinary starts, so this is a no-op there.
		void resumeInterruptedChildren({
			cwd: ctx.cwd,
			scopedModels: Array.isArray((ctx as { scopedModels?: unknown }).scopedModels)
				? (ctx as unknown as { scopedModels: Array<{ model: { provider: string; id: string }; thinkingLevel?: string }> }).scopedModels.map(({ model, thinkingLevel }) => ({ provider: model.provider, id: model.id, thinkingLevel }))
				: [],
			ui: (ctx as { ui?: unknown }).ui,
			hasUI: ctx.hasUI,
		}).catch(() => {
			// Best effort: resume failures are reported per-child (or silently
			// dropped headless) and never break session startup.
		});

		if (ctx.mode !== "tui") return;

		ctx.ui.setWidget(
			"subagents",
			(tui, theme) => {
				widget?.dispose();
				widget = new SubagentStatusWidget(tui, theme, getAgentDir(), runtime!.runId);
				return widget;
			},
			{ placement: "belowEditor" },
		);
	});

	pi.registerMessageRenderer("subagent-results", (message, _options, _theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		return new Markdown(text, 1, 0, getMarkdownTheme());
	});

	const trackChild = (record: AgentRecord) => {
		if (shuttingDown) return;
		refreshKeepAlive();
		notifyWaiters(getAgentDir());
		if (isTerminalStatus(record.status)) scheduleDelivery();
	};
	// Self-reported completion: when our parent already settled, no live
	// monitor will record this turn, so the session finalizes its own record
	// at settle and wakes its parent with the result (see self-report.ts).
	// Live parents monitor us; the root session is never a subagent run.
	const handleOwnSettle = async (event: SettleEventLike): Promise<void> => {
		try {
			if (!runtime) return;
			const runId = process.env.PI_SUBAGENT_RUN_ID;
			if (!runId || runId !== runtime.runId) return;
			if (event?.continue === true) return;
			const pending = (event?.context as { pendingMessages?: unknown } | undefined)?.pendingMessages;
			if (Array.isArray(pending) && pending.length > 0) return;
			const agentDir = getAgentDir();
			const rows = getCachedRecords(agentDir);
			const own = rows.find((record) => record.runId === runId);
			if (!own) return;
			const parent = rows.find((record) => record.runId === own.parentRunId);
			if (parent && !isTerminalStatus(parent.status)) return;
			const summary = summarizeSettleEvent(event);
			if (finalizeOwnRun(agentDir, runId, summary) !== "written") return;
			// Instant waiter wake at the root (best effort; polls cover the rest).
			if (runtime.rootRunId !== runId) {
				try {
					await sendMeshMessage({ socketDir: meshSocketDir(agentDir), toRunId: runtime.rootRunId, fromRunId: runId, type: "settled", payload: { status: summary.status } });
				} catch {
					// An offline root falls back to polling.
				}
			}
			if (!parent) return;
			const ownDepth = runtime.depth;
			const ownSettings = runtime.settings;
			const ownTrusted = runtime.projectTrusted;
			await maybeWakeParent({
				agentDir,
				ownRunId: runId,
				canLaunch: () => !gate.isFull(ownSettings.maxConcurrency),
				buildContext: (wakee) => ({
					agentDir,
					parentRunId: wakee.parentRunId,
					rootRunId: wakee.rootRunId,
					currentDepth: ownDepth,
					settings: ownSettings,
					parentTools: typeof (pi as { getActiveTools?: unknown }).getActiveTools === "function"
						? (pi as unknown as { getActiveTools: () => string[] }).getActiveTools()
						: [],
					scopedModels: [],
					parentCwd: own.cwd,
					projectTrusted: ownTrusted,
					signal: new AbortController().signal,
					onRecord: trackChild,
					onSettled: trackChild,
				}),
			});
		} catch {
			// Best effort: self-report must never break settling.
		}
	};
	pi.on("agent_before_settle", (event) => {
		void handleOwnSettle(event as SettleEventLike).catch(() => {});
	});

	const resolveRecord = (target: string): AgentRecord => {
		if (!runtime) throw new Error("Subagent extension settings failed to initialize");
		const resolved = resolveAgentPath(getCachedRecords(getAgentDir()), { anchorRunId: runtime.runId, rootRunId: runtime.rootRunId, target });
		if (!resolved.record) throw new Error(`"${target.trim()}" is the root session, not a subagent.`);
		return resolved.record;
	};

	const makeUiHandler = (ui: any) => async (child: AgentRecord, request: any) => {
		const title = `[${child.name}] ${request.title || "Subagent request"}`;
		const opts = typeof request.timeout === "number" ? { timeout: request.timeout } : undefined;
		// Dialogs resolve undefined on dismissal; the child protocol only
		// understands explicit cancellation, so normalize at the boundary.
		const answer = async <T>(ask: Promise<T | undefined>): Promise<{ value: T } | { cancelled: true }> => {
			const value = await ask;
			return value === undefined ? { cancelled: true } : { value };
		};
		switch (request.method) {
			case "select": return answer(ui.select(title, request.options ?? [], opts));
			case "confirm": return { confirmed: await ui.confirm(title, request.message ?? "", opts) };
			case "input": return answer(ui.input(title, request.placeholder, opts));
			case "editor": return answer(ui.editor(title, request.prefill));
			case "notify": ui.notify(`[${child.name}] ${request.message ?? ""}`, request.notifyType);
		}
	};

	const sendToRecord = async (
		record: AgentRecord,
		text: string,
		signal?: AbortSignal,
		mode: SubagentMessageMode = "steer",
		ctx?: { cwd: string; scopedModels: Array<{ model: { provider: string; id: string }; thinkingLevel?: string }>; ui: any },
	): Promise<{ resumed: boolean; queued?: boolean }> => {
		if (!runtime) throw new Error("Subagent extension settings failed to initialize");
		mode = normalizeMessageMode(mode);
		signal = signal ? AbortSignal.any([signal, sessionAbort.signal]) : sessionAbort.signal;
		const agentDir = getAgentDir();
		const sender = meshSenderFor(agentDir, runtime.runId);
		let current = latestRecord(record);
		// Any tree node except this session is addressable: owned children
		// use the direct RPC channel, everything else the socket mesh.
		if (!isTerminalStatus(current.status)) {
			if (await sendSubagentMessage(current, text, signal, mode, sender)) return { resumed: false };
			current = latestRecord(record);
			if (!isTerminalStatus(current.status)) {
				if (current.status === "queued" || current.status === "starting") {
					await queuePendingMessage(agentDir, current.runId, { from: runtime.runId, mode, text });
					return { resumed: false, queued: true };
				}
				throw new Error(`${current.name} is no longer reachable`);
			}
		}
		// Terminal run: restart from its transcript in a fresh process. The
			// previous process was already reaped on settle; resumeSubagent
			// awaits any straggler before the new writer opens the session.
		// Resume preserves the record's parent: the result owner keeps its
		// claim and the resuming session only lends its concurrency slot.
		// A settled parent means no live claimant: continuing would waste a turn
		// on a result nobody can collect, so refuse and re-delegate instead.
		const resumerParent = getCachedRecords(agentDir).find((candidate) => candidate.runId === current.parentRunId);
		if (resumerParent && isTerminalStatus(resumerParent.status)) {
			throw new Error(`Cannot resume ${current.name}: its parent ${resumerParent.name} already ${resumerParent.status}. Spawn a fresh subagent instead.`);
		}
		if (!ctx?.scopedModels || !ctx?.cwd) throw new Error(`${current.name} finished (${current.status}); retry with session context to resume it`);
		await resumeSubagent(
			current,
			text,
			{
				agentDir,
				parentRunId: current.parentRunId,
				rootRunId: current.rootRunId,
				currentDepth: runtime.depth,
				settings: runtime.settings,
				parentTools: pi.getActiveTools(),
				scopedModels: ctx.scopedModels.map(({ model, thinkingLevel }) => ({ provider: model.provider, id: model.id, thinkingLevel })),
				parentCwd: ctx.cwd,
				projectTrusted: runtime.projectTrusted,
				signal,
				onRecord: trackChild,
				onUiRequest: makeUiHandler(ctx.ui),
				onSettled: trackChild,
			},
			mode,
		);
		return { resumed: true };
	};

	/** Restart children a /reload interrupted. Only claims runs still carrying
	 * their reload-interrupt marker for the interrupted execution: explicitly
	 * cancelled children carry no marker and finished children are never
	 * marked, so neither is resurrected. Orphans (direct parent settled while
	 * they still ran) are adopted so the interrupted turn keeps a live claimant. */
	const resumeInterruptedChildren = async (resumeCtx: {
		cwd: string;
		scopedModels: Array<{ provider: string; id: string; thinkingLevel?: string }>;
		ui: any;
		hasUI: boolean;
	}): Promise<void> => {
		if (!runtime || shuttingDown) return;
		const agentDir = getAgentDir();
		const markers = new Map<string, ReloadInterruptMarker>();
		try {
			for (const marker of listReloadInterrupted(agentDir)) markers.set(marker.runId, marker);
		} catch {
			return;
		}
		if (markers.size === 0) return;
		const all = getCachedRecords(agentDir);
		const byId = new Map(all.map((record) => [record.runId, record]));
		const candidates = descendantsOf(all, runtime.runId).filter((record) => {
			if (!markers.has(record.runId)) return false;
			if (record.parentRunId === runtime!.runId) return true;
			const parent = byId.get(record.parentRunId);
			return !parent || isTerminalStatus(parent.status);
		});
		for (const candidate of candidates) {
			if (!runtime || shuttingDown) return;
			try {
				const latest = getCachedRecords(agentDir).find((item) => item.runId === candidate.runId) ?? candidate;
				const marker = readReloadInterrupted(agentDir, candidate.runId);
				if (!marker || latest.status !== "cancelled" || latest.resultsDelivered || (marker.executionId ?? null) !== (latest.executionId ?? null)) {
					try { clearReloadInterrupted(agentDir, candidate.runId); } catch {
						// Best effort.
					}
					continue;
				}
				if (latest.parentRunId !== runtime.runId) {
					// Adoption stays visible: tag the previous parent and keep the
					// sibling name unique so the adopted run never looks promoted
					// and its path never goes ambiguous.
					const previousParent = latest.parentRunId;
					await withRecordLock(agentDir, latest.runId, () => {
						const current = readRecords(agentDir).find((item) => item.runId === latest.runId) ?? latest;
						if (current.parentRunId !== runtime!.runId) {
							saveRecord(agentDir, {
								...current,
								parentRunId: runtime!.runId,
								adoptedFrom: current.adoptedFrom ?? previousParent,
								name: uniqueSiblingName(readRecords(agentDir), runtime!.runId, current.name),
							});
						}
					});
				}
				// resumeSubagent consumes the marker under its own lock. Runs that
				// never started have no transcript: restart them with the original task.
				await resumeSubagent(
					latest,
					latest.sessionFile ? RELOAD_RESUME_MESSAGE : latest.task,
					{
						agentDir,
						parentRunId: runtime.runId,
						rootRunId: runtime.rootRunId,
						currentDepth: runtime.depth,
						settings: runtime.settings,
						parentTools: typeof (pi as { getActiveTools?: unknown }).getActiveTools === "function"
							? (pi as unknown as { getActiveTools: () => string[] }).getActiveTools()
							: [],
						scopedModels: resumeCtx.scopedModels,
						parentCwd: resumeCtx.cwd,
						projectTrusted: runtime.projectTrusted,
						signal: sessionAbort.signal,
						onRecord: trackChild,
						onUiRequest: resumeCtx.hasUI && resumeCtx.ui ? makeUiHandler(resumeCtx.ui) : undefined,
						onSettled: trackChild,
					},
					"steer",
					{ claimReloadMarker: true },
				);
			} catch (error) {
				// A failed resume must not retry-loop on later starts: leave the
				// child cancelled and drop the intent.
				try { clearReloadInterrupted(agentDir, candidate.runId); } catch {
					// Best effort.
				}
				if (resumeCtx.hasUI && resumeCtx.ui) {
					try {
						resumeCtx.ui.notify(`Could not resume interrupted subagent ${candidate.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
					} catch {
						// Best effort.
					}
				}
			}
		}
	};

	pi.on("session_shutdown", async (event, ctx) => {
		shuttingDown = true;
		widget?.dispose();
		widget = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget("subagents", undefined);
		if (deliveryTimer) {
			clearTimeout(deliveryTimer);
			deliveryTimer = undefined;
		}
		if (keepAlive) {
			clearInterval(keepAlive);
			keepAlive = undefined;
		}
		sessionAbort.abort();
		try { await meshServer?.close(); } catch { /* best effort */ }
		meshServer = undefined;
		// This pi process is going away: stop every live descendant. Terminal
		// children were already reaped on settle; this is a safety net for
		// stragglers plus the await for still-running turns.
		if (!runtime) return;
		const agentDir = getAgentDir();
		// A reload tears down this runtime but the session continues: leave a
		// resume marker on every still-running descendant so the fresh runtime
		// restarts them instead of losing active work. Other shutdown reasons
		// (quit, session switch) keep the cancel-and-stop behavior below.
		if ((event as { reason?: string } | undefined)?.reason === "reload") {
			try {
				const owned = new Set(descendantsOf(getCachedRecords(agentDir), runtime.runId).map((child) => child.runId));
				for (const record of readRecords(agentDir)) {
					if (!owned.has(record.runId) || isTerminalStatus(record.status)) continue;
					try { markReloadInterrupted(agentDir, record); } catch {
						// Marking must never block teardown of the old runtime.
					}
				}
			} catch {
			// Marking must never block teardown of the old runtime.
			}
		}
		// A finished session being reaped (harness teardown after settle) leaves
		// its live subtree alone: grandchildren outlive their parents and
		// self-report, so cancelling here would murder work the wake chain
		// was built to save. Reload marks + restarts everything below; any
		// other teardown of a live (or root) session still cancels the tree.
		const ownId = process.env.PI_SUBAGENT_RUN_ID;
		const own = ownId ? readRecords(agentDir).find((candidate) => candidate.runId === runtime.runId) : undefined;
		const spareLiveTree = (event as { reason?: string } | undefined)?.reason !== "reload" && !!own && isTerminalStatus(own.status);
		const records = descendantsOf(getCachedRecords(agentDir), runtime.runId);
		for (const record of records.slice().reverse()) {
			try {
				if (isTerminalStatus(record.status)) {
					if (record.pid && isProcessAlive(record.pid)) killPidTree(record.pid, record.pidStartTime);
				} else if (!spareLiveTree) {
					await cancelSubagent(agentDir, record);
				}
			} catch {
				// Cross-process cleanup is best effort. Owned children are awaited below.
			}
		}
		// Spared runs keep their processes: their monitors die with this process
		// anyway, but the detached session must survive to self-report.
		await terminateOwnedSubagents(records.filter((record) => !spareLiveTree || isTerminalStatus(record.status)).map((record) => record.runId));
	});

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn a recursive Pi subagent that runs in the background and returns immediately. Finishing sends a steering notice; use check_subagents to read results.",
		promptSnippet: "Delegate work to a background subagent",
		promptGuidelines: [
			"spawn_agent returns immediately; keep working while the child runs.",
			"Call check_subagents with wait:true before relying on spawned results; cancel_subagent stops a runaway.",
		],
		parameters: SpawnAgentSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!runtime) throw new Error("Subagent extension settings failed to initialize");
			await ensureMeshBound(ctx?.ui);
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const record = await startSubagent(
				{
					task: params.task,
					name: params.name,
					cwd: params.cwd ? resolve(ctx.cwd, params.cwd) : undefined,
					model: params.model,
					thinking: params.thinking,
					tools: params.tools,
					maxDepth: params.maxDepth,
				},
				{
					agentDir: getAgentDir(),
					parentRunId: runtime.runId,
					rootRunId: runtime.rootRunId,
					currentDepth: runtime.depth,
					settings: runtime.settings,
					parentModel,
					parentThinking: ctx.thinkingLevel ?? "off",
					parentTools: pi.getActiveTools(),
					scopedModels: ctx.scopedModels.map(({ model, thinkingLevel }) => ({ provider: model.provider, id: model.id, thinkingLevel })),
					parentCwd: ctx.cwd,
					projectTrusted: runtime.projectTrusted,
					signal,
					onRecord: trackChild,
					onUiRequest: makeUiHandler(ctx.ui),
					onSettled: trackChild,
				},
			);
			return {
				content: [
					{
						type: "text",
						text: `Spawned subagent "${record.name}" (run ${shortId(record.runId)}, depth ${record.depth}/${record.maxDepth}, model ${record.model}). It is ${record.status === "queued" ? "queued" : "running in the background"} — continue with other work and call check_subagents (wait:true) to collect its result.`,
					},
				],
				details: { record },
			};
		},
		renderCall(args, theme) {
			const name = args.name;
			const model = args.model ? ` · ${args.model}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("spawn_agent"))} ${theme.fg("accent", name)}${theme.fg("dim", model)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const record = (result.details as { record?: AgentRecord } | undefined)?.record;
			if (!record) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new Text(
				`${theme.fg("accent", "◌")} ${theme.fg("accent", record.name)} ${theme.fg("dim", "· spawned in background")}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "check_subagents",
		label: "Check Subagents",
		description:
			"Check this session's subagents — all of them, or a `targets` list — and collect each finished result once. Already-delivered results are not repeated.",
		promptSnippet: "Check background subagent results",
		parameters: CheckSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!runtime) throw new Error("Subagent extension settings failed to initialize");
			await ensureMeshBound(ctx?.ui);
			const agentDir = getAgentDir();
			// Resolve the optional target list once; targets address any tree node
			// (unknown or ambiguous targets fail before waiting).
			const requested = params.targets && params.targets.length > 0 ? params.targets : undefined;
			const targetIds = requested
				? new Set(requested.map((target) => {
				const resolved = resolveAgentPath(getCachedRecords(agentDir), { anchorRunId: runtime!.runId, rootRunId: runtime!.rootRunId, target });
				if (!resolved.record) throw new Error(`"${target.trim()}" is the root session, not a subagent.`);
				return resolved.record.runId;
			}))
				: undefined;
			const snapshot = () => {
				const all = getCachedRecords(agentDir);
				const rows = descendantsOf(all, runtime!.runId);
				if (!targetIds) return rows;
				const selected = rows.filter((record) => targetIds.has(record.runId));
				// Targets outside the subtree (siblings, ancestors) stay visible
				// read-only; claiming remains the direct parent's job.
				const seen = new Set(selected.map((record) => record.runId));
				const byId = new Map(all.map((record) => [record.runId, record]));
				for (const id of targetIds) {
					if (!seen.has(id)) {
						const record = byId.get(id);
						if (record) {
							selected.push(record);
							seen.add(id);
						}
					}
				}
				return selected;
			};
			if (params.wait) {
				const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 30000, 0), 300000);
				await waitUntilSubagentsIdle(agentDir, runtime.runId, {
					timeoutMs,
					signal,
					targets: targetIds ? [...targetIds] : undefined,
					mode: params.mode === "any" ? "any" : "all",
				});
			}
			// Refresh before claiming results so auto-delivery that happened while
			// waiting is not repeated by this check.
			const rows = snapshot();
			// This session owns delivery only for its direct children. Descendant
			// results remain visible, but their direct parent must claim them.
			const newlyFinished = undelivered(rows.filter((record) => record.parentRunId === runtime!.runId));
			rememberDelivered(newlyFinished);
			reapOwnedIfDrained(agentDir);
			if (rows.length === 0) {
				return { content: [{ type: "text", text: "No subagents have been spawned by this session." }], details: { records: [] } };
			}
			const descendantIds = new Set(descendantsOf(getCachedRecords(agentDir), runtime!.runId).map((record) => record.runId));
			const running = rows.filter((record) => !isTerminalStatus(record.status));
			const newlyFinishedIds = new Set(newlyFinished.map((record) => record.runId));
			const observedDescendants: string[] = [];
			const sections = rows
				.filter(
					(record) =>
						!isTerminalStatus(record.status) ||
						newlyFinishedIds.has(record.runId) ||
						(record.parentRunId !== runtime!.runId && !record.resultsDelivered && !seenDescendantResults.has(resultKey(record))),
				)
				.map((record) => {
					if (record.parentRunId !== runtime!.runId && isTerminalStatus(record.status)) {
						const key = resultKey(record);
						seenDescendantResults.add(key);
						observedDescendants.push(key);
						try {
							markFooterDismissed(agentDir, record, runtime!.runId, key);
						} catch {
							// Dismissal is best effort; memory still hides it this session.
						}
					}
					const readOnly = record.parentRunId !== runtime!.runId
						? descendantIds.has(record.runId) ? " · read-only descendant" : " · read-only"
						: "";
					const meta = `${record.model} · depth ${record.depth}/${record.maxDepth} · ${record.cwd}${record.runId ? ` · run ${shortId(record.runId)}` : ""}${readOnly}${record.parentRunId !== runtime!.runId ? ` · via ${senderName(record.parentRunId)}` : ""}${record.adoptedFrom ? ` · adopted from ${senderName(record.adoptedFrom)}` : ""}`;
					return formatResult(record, meta);
				});
			const summary =
				running.length > 0
					? `${rows.length - running.length}/${rows.length} finished, ${running.length} still running.`
					: `All ${rows.length} subagent${rows.length === 1 ? "" : "s"} finished.`;
			const sectionText = sections.length > 0 ? sections.join("\n\n") : "No new subagent results since the last check.";
			return {
				content: [{ type: "text", text: `${summary}\n\n${sectionText}` }],
				details: { records: rows, resultKeys: newlyFinished.map(resultKey), seenDescendantResults: observedDescendants },
			};
		},
	});

	pi.registerTool({
		name: "send_to_subagent",
		label: "Send to Subagent",
		description: "Message anyone in the tree except this session: /a/b absolute from root, me/child, ../sibling, or a name/run id/session id. `..` from a direct child and `/` from anywhere reach the root session itself. Running sessions receive it in place (steer redirects, followUp queues); finished ones resume from transcript without changing owner; queued ones park until start.",
		promptSnippet: "Message any subagent by tree path (running, finished, queued, or cancelled)",
		parameters: SendSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await ensureMeshBound(ctx?.ui);
			const mode = normalizeMessageMode(params.mode);
			const resolved = resolveAgentPath(getCachedRecords(getAgentDir()), { anchorRunId: runtime!.runId, rootRunId: runtime!.rootRunId, target: params.target });
			if (!resolved.record) {
				// The root session itself: direct mesh delivery, no claim,
				// no resume. Reachable as `..` from a direct child, `/`
				// from anywhere below. Self-targeting still throws above.
				const agentDir = getAgentDir();
				try {
					await deliverMeshMessage({
						socketDir: meshSocketDir(agentDir),
					toRunId: resolved.runId,
					fromRunId: runtime!.runId,
					type: mode,
					text: params.message,
					signal: signal ? AbortSignal.any([signal, sessionAbort.signal]) : sessionAbort.signal,
					});
				} catch (error) {
					throw new Error(`The root session is offline: ${error instanceof Error ? error.message : String(error)}`);
				}
				try {
					await appendAgentMessage(agentDir, resolved.runId, { from: senderName(runtime!.runId), mode, text: params.message });
				} catch {
					// Audit is best effort; delivery already succeeded.
				}
				return {
					content: [{ type: "text", text: `Sent ${mode === "followUp" ? "follow-up" : "steering"} message to the root session.` }],
					details: {},
				};
			}
			const record = resolved.record;
			const { resumed, queued } = await sendToRecord(record, params.message, signal, mode, ctx);
			return {
				content: [{ type: "text", text: resumed ? `Resumed ${record.name} from its transcript with a new execution.` : queued ? `Queued message for ${record.name} (not running yet; delivers when its session starts).` : `Sent ${mode === "followUp" ? "follow-up" : "steering"} message to ${record.name}.` }],
				details: { record },
			};
		},
	});

	pi.registerTool({
		name: "cancel_subagent",
		label: "Cancel Subagent",
		description: "Abort a running or queued subagent's current turn and stop its process. Send a new message later to resume it from its transcript.",
		promptSnippet: "Stop a running subagent",
		parameters: CancelSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			await ensureMeshBound(_ctx?.ui);
			const agentDir = getAgentDir();
			const record = resolveRecord(params.target);
			// An explicit cancellation supersedes any reload-interrupt intent:
			// the user stopped this turn on purpose, so it must not auto-resume
			// (checked before the terminal early-return below, and again after
			// the cancel for the whole subtree).
			try {
				clearReloadInterrupted(agentDir, record.runId);
			} catch {
				// Marker cleanup is best effort; a stale marker is dropped unread
				// when the next session start finds no matching interrupted execution.
			}
			if (isTerminalStatus(record.status)) {
				return { content: [{ type: "text", text: `${record.name} already finished (${record.status}).` }], details: { record } };
			}
			const cancelled = await cancelSubagent(agentDir, record);
			// An explicit cancellation supersedes any reload-interrupt intent:
			// the user stopped this turn on purpose, so it must not auto-resume.
			try {
				clearReloadInterrupted(agentDir, cancelled.runId);
				for (const child of descendantsOf(getCachedRecords(agentDir), cancelled.runId)) {
					clearReloadInterrupted(agentDir, child.runId);
				}
			} catch {
				// Marker cleanup is best effort; a stale marker is dropped unread
				// when the next session start finds no matching interrupted execution.
			}
			trackChild(cancelled);
			return { content: [{ type: "text", text: `Cancelled ${cancelled.name}.` }], details: { record: cancelled } };
		},
	});
}
