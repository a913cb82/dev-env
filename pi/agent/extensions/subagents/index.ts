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
import { getCachedRecords, isProcessAlive, isTerminalStatus, markRecordResultState, pruneRecords } from "./registry.ts";
import { notifyWaiters, waitUntilSubagentsIdle } from "./wait.ts";
import { SubagentStatusWidget } from "./widget.ts";
import {
	cancelSubagent,
	killPidTree,
	resumeSubagent,
	sendSubagentMessage,
	startSubagent,
	terminateOwnedSubagents,
} from "./spawn-agent.ts";
import { descendantsOf, resolveAgentRecord } from "./registry.ts";
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
	name: Type.Optional(Type.String({ description: "Subagent name" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (relative unless absolute)" })),
	model: Type.Optional(Type.String({ description: "Exact model selector. Overrides configured and inherited defaults." })),
	thinking: Type.Optional(
		Type.String({ description: "Thinking level for this subagent", enum: [...THINKING_LEVEL_VALUES] }),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Subset of my active tools; omit to inherit all" })),
});

const CheckSchema = Type.Object({
	targets: Type.Optional(Type.Array(Type.String(), {
		description: "Subagents to check (run id/prefix, session id, or name); omit for all",
	})),
	wait: Type.Optional(Type.Boolean({ description: "Block until they finish (returns early)" })),
	mode: Type.Optional(Type.String({
		description: "With wait: resolve when any or all finish (default all)",
		enum: ["any", "all"],
	})),
	timeoutMs: Type.Optional(Type.Integer({ description: "Max wait in ms (default 30000, max 300000)" })),
});

const CancelSchema = Type.Object({
	target: Type.String({ description: "Subagent run id (or unique prefix), session id, or exact name" }),
});

const SendSchema = Type.Object({
	target: Type.String({ description: "Subagent run id (or unique prefix), session id, or exact name" }),
	message: Type.String({ description: "Message for the subagent" }),
	mode: Type.Optional(Type.String({
		description: "steer (default) redirects current work; followUp queues behind it",
		enum: ["steer", "followUp"],
	})),
});

const RESULT_OUTPUT_CAP = 8000;

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
	const deliveredResults = new Set<string>();
	const seenDescendantResults = new Set<string>();
	/** Per-child reported subtree-cost totals. Rebuilt from session entries on start/tree; advanced by flushes. */
	const costFloor: CostFloor = new Map();
	const resultKey = (record: AgentRecord) => JSON.stringify([
		record.runId, record.executionId ?? record.finishedAt ?? record.updatedAt,
	]);
	/** Terminal records whose report this session has not consumed yet. */
	const undelivered = (records: readonly AgentRecord[]) =>
		records.filter((record) => isTerminalStatus(record.status) && !record.resultsDelivered && !deliveredResults.has(resultKey(record)));
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
	const rememberDelivered = (records: AgentRecord[]) => {
		for (const record of records) {
			deliveredResults.add(resultKey(record));
			try { markRecordResultState(getAgentDir(), record, "resultsDelivered"); } catch {
				// Keep the report in the returned content even if disk persistence fails.
				// Session receipts restore this in-memory claim after reload.
			}
		}
	};
	const restoreReceipts = (entries: readonly SessionEntry[]) => {
		seenDescendantResults.clear();
		for (const entry of entries) {
			const rawDetails = entry.type === "custom_message" && entry.customType === "subagent-results"
				? entry.details : entry.type === "message" && entry.message.role === "toolResult" ? entry.message.details : undefined;
			const details = rawDetails as { resultKeys?: unknown; seenDescendantResults?: unknown } | undefined;
			for (const key of Array.isArray(details?.resultKeys) ? details.resultKeys : []) {
				if (typeof key === "string") deliveredResults.add(key);
			}
			for (const key of Array.isArray(details?.seenDescendantResults) ? details.seenDescendantResults : []) {
				if (typeof key === "string") seenDescendantResults.add(key);
			}
		}
	};

	/** Hold the event loop open while background children run (matters for print-mode parents). */
	const refreshKeepAlive = () => {
		if (!runtime || shuttingDown) return;
		const pending = getCachedRecords(getAgentDir()).some(
			(record) => record.parentRunId === runtime!.runId && !isTerminalStatus(record.status),
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
		// Never put result snapshots in Pi's follow-up queue while work is active.
		// Tool results drain the inbox during a run; agent_settled wakes it at idle.
		if (!runtime || shuttingDown || delivering || deliveryPaused || agentActive || isIdle?.() === false) return;
		const agentDir = getAgentDir();
		const children = getCachedRecords(agentDir).filter((record) => record.parentRunId === runtime!.runId);
		const pending = undelivered(children);
		if (pending.length === 0) return;
		const stillRunning = children.filter((record) => !isTerminalStatus(record.status)).length;
		const parts = pending.map((record) => formatResult(record));
		const intro =
			stillRunning > 0
				? `Subagent results (${pending.length} finished, ${stillRunning} still running):`
				: `All ${pending.length} subagent${pending.length === 1 ? "" : "s"} finished:`;
		// Pi's extension binding returns void, not a model-completion receipt.
		// At idle it starts the prompt directly instead of queueing a follow-up.
		// Also honor rejection from hosts that return a promise.
		delivering = true;
		try {
			await pi.sendMessage(
				{
					customType: "subagent-results",
					content: `${intro}\n\n${parts.join("\n\n")}`,
					display: true,
					details: { resultKeys: pending.map(resultKey) },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			rememberDelivered(pending);
		} finally {
			delivering = false;
		}
	};

	pi.on("agent_start", (_event, ctx) => {
		agentActive = true;
		deliveryPaused = false;
		activeSignal = ctx.signal;
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && event.message.stopReason === "aborted") deliveryPaused = true;
	});
	pi.on("agent_settled", () => {
		agentActive = false;
		if (activeSignal?.aborted) deliveryPaused = true;
		if (!deliveryPaused) scheduleDelivery(0);
	});
	pi.on("session_tree", (_event, ctx) => {
		restoreReceipts(ctx.sessionManager.getBranch());
		// Replace, never merge: a fork copies a subset of entries, so a stale-high
		// floor would under-report the new file forever.
		restoreCostFloor(costFloor, ctx.sessionManager);
	});

	// Attach fresh results to a completed tool, rather than queueing a separate
	// prompt. Pi persists this content and includes it in the next model call.
	// This does not steer the agent or skip any sibling tool calls.
	pi.on("tool_result", (event, ctx) => {
		if (ctx.signal?.aborted) { deliveryPaused = true; return; }
		if (!runtime || shuttingDown || delivering || deliveryPaused) return;
		// Custom tools may use scalar/array details. Leave their result shape alone.
		if (event.details !== undefined && (!event.details || typeof event.details !== "object" || Array.isArray(event.details))) return;
		const details = event.details as Record<string, unknown> | undefined;
		const previousKeys = Array.isArray(details?.resultKeys) ? details.resultKeys : [];
		const agentDir = getAgentDir();
		const records = getCachedRecords(agentDir);
		const pending = undelivered(records.filter((record) => record.parentRunId === runtime!.runId));
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
		if (pending.length === 0 && !cost) return;
		if (pending.length > 0) rememberDelivered(pending);
		return {
			...(pending.length > 0
				? { content: [...event.content, { type: "text" as const, text: `Subagent results:\n\n${pending.map((record) => formatResult(record)).join("\n\n")}` }] }
				: {}),
			details: {
				...details,
				...(pending.length > 0 ? { resultKeys: [...previousKeys, ...pending.map(resultKey)] } : {}),
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
		restoreReceipts(ctx.sessionManager.getBranch?.() ?? []);
		restoreCostFloor(costFloor, ctx.sessionManager);
		const runId = process.env.PI_SUBAGENT_RUN_ID || ctx.sessionManager.getSessionId();
		const rootRunId = process.env.PI_SUBAGENT_ROOT_ID || runId;
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

		sessionAbort = new AbortController();

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

	const resolveRecord = (target: string): AgentRecord => {
		if (!runtime) throw new Error("Subagent extension settings failed to initialize");
		const rows = descendantsOf(getCachedRecords(getAgentDir()), runtime.runId);
		return resolveAgentRecord(rows, target);
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
	): Promise<{ resumed: boolean }> => {
		if (!runtime) throw new Error("Subagent extension settings failed to initialize");
		mode = normalizeMessageMode(mode);
		signal = signal ? AbortSignal.any([signal, sessionAbort.signal]) : sessionAbort.signal;
		const latest = latestRecord(record);
		// Messaging is parent -> direct child only. A deeper descendant is reached
		// through its own parent (which owns its RPC channel and concurrency slot).
		if (latest.parentRunId !== runtime.runId) {
			throw new Error(`${latest.name} is a descendant, not a direct child — message its parent instead`);
		}
		if (await sendSubagentMessage(latest, text, signal, mode)) return { resumed: false };
		if (!isTerminalStatus(latest.status)) {
			throw new Error(`${latest.name} is no longer running`);
		}
		// Terminal child: restart from its transcript in a fresh process. The
			// previous process was already reaped on settle; resumeSubagent
			// awaits any straggler before the new writer opens the session.
		if (!ctx) throw new Error(`${latest.name} finished (${latest.status}); retry with session context to resume it`);
		await resumeSubagent(
			latest,
			text,
			{
				agentDir: getAgentDir(),
				parentRunId: runtime.runId,
				rootRunId: runtime.rootRunId,
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

	pi.on("session_shutdown", async (_event, ctx) => {
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
		// This pi process is going away: stop every live descendant. Terminal
		// children were already reaped on settle; this is a safety net for
		// stragglers plus the await for still-running turns.
		if (!runtime) return;
		const agentDir = getAgentDir();
		const records = descendantsOf(getCachedRecords(agentDir), runtime.runId);
		for (const record of records.slice().reverse()) {
			try {
				if (isTerminalStatus(record.status)) {
					if (record.pid && isProcessAlive(record.pid)) killPidTree(record.pid, record.pidStartTime);
				} else {
					await cancelSubagent(agentDir, record);
				}
			} catch {
				// Cross-process cleanup is best effort. Owned children are awaited below.
			}
		}
		await terminateOwnedSubagents(records.map((record) => record.runId));
	});

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn a recursive Pi subagent that runs in the background and returns immediately. Finished results arrive with your next tool result, or automatically when idle; you can also collect them with check_subagents.",
		promptSnippet: "Delegate work to a background subagent",
		promptGuidelines: [
			"spawn_agent returns immediately; keep working while the child runs.",
			"Call check_subagents with wait:true before relying on spawned results; cancel_subagent stops a runaway.",
		],
		parameters: SpawnAgentSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!runtime) throw new Error("Subagent extension settings failed to initialize");
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const record = await startSubagent(
				{
					task: params.task,
					name: params.name,
					cwd: params.cwd ? resolve(ctx.cwd, params.cwd) : undefined,
					model: params.model,
					thinking: params.thinking,
					tools: params.tools,
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
			const name = args.name?.trim() || args.task.replace(/\s+/g, " ").slice(0, 50);
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
			const agentDir = getAgentDir();
			// Resolve the optional target list once; every target must be a descendant
			// of this session (unknown or ambiguous targets fail before waiting).
			const requested = params.targets && params.targets.length > 0 ? params.targets : undefined;
			const targetIds = requested
				? new Set(requested.map((target) => resolveAgentRecord(descendantsOf(getCachedRecords(agentDir), runtime!.runId), target).runId))
				: undefined;
			const snapshot = () => {
				const rows = descendantsOf(getCachedRecords(agentDir), runtime!.runId);
				return targetIds ? rows.filter((record) => targetIds.has(record.runId)) : rows;
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
			if (rows.length === 0) {
				return { content: [{ type: "text", text: "No subagents have been spawned by this session." }], details: { records: [] } };
			}
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
					}
					const readOnly = record.parentRunId !== runtime!.runId ? " · read-only descendant" : "";
					const meta = `${record.model} · depth ${record.depth}/${record.maxDepth} · ${record.cwd}${record.runId ? ` · run ${shortId(record.runId)}` : ""}${readOnly}`;
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
		description: "Message one of this session's direct subagents. Running children are steered in place; messaging a finished or cancelled child resumes it from its transcript in a fresh process as a new execution; deeper descendants are reached through their own parent.",
		promptSnippet: "Message a direct subagent (running, finished, or cancelled)",
		parameters: SendSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const mode = normalizeMessageMode(params.mode);
			const record = resolveRecord(params.target);
			const { resumed } = await sendToRecord(record, params.message, signal, mode, ctx);
			return {
				content: [{ type: "text", text: resumed ? `Resumed ${record.name} from its transcript with a new execution.` : `Sent ${mode === "followUp" ? "follow-up" : "steering"} message to ${record.name}.` }],
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
			const agentDir = getAgentDir();
			const record = resolveRecord(params.target);
			if (isTerminalStatus(record.status)) {
				return { content: [{ type: "text", text: `${record.name} already finished (${record.status}).` }], details: { record } };
			}
			const cancelled = await cancelSubagent(agentDir, record);
			trackChild(cancelled);
			return { content: [{ type: "text", text: `Cancelled ${cancelled.name}.` }], details: { record: cancelled } };
		},
	});
}
