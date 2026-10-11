import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, depth, validateRpcMaxLineChars, validateThinkingLevel } from "./config.ts";
import { deliverMeshMessage, meshSocketDir, sendMeshMessage } from "./mesh.ts";
import { applyChildEvent, type ParsedChildState } from "./events.ts";
import {
	clearRecordCancellation,
	clearRecordClosedMarker,
	clearRecordPid,
	clearReloadInterrupted,
	descendantsOf,
	getCachedRecords,
	isProcessAlive,
	isRecordCancelled,
	isTerminalStatus,
	readRecords,
	readReloadInterrupted,
	saveRecord,
	shouldSkipOwnerWrite,
	siblingNameTaken,
	withRecordLock,
} from "./registry.ts";
import { EMPTY_USAGE, normalizeMessageMode, type AgentRecord, type SpawnAgentInput, type SubagentMessageMode, type SubagentSettings } from "./types.ts";

const STDERR_LIMIT = 4000;
const TERMINATION_WAIT_MS = 5000;
const RPC_REQUEST_TIMEOUT_MS = 15_000;
const RPC_STARTUP_TIMEOUT_MS = 30_000;

export class ConcurrencyGate {
	private running = 0;
	private waiters: Array<{ limit: number; resolve: (release: () => void) => void; cleanup?: () => void }> = [];

	/** True when a spawn with this limit would have to queue. */
	isFull(limit: number): boolean {
		return limit !== -1 && this.running >= limit;
	}

	acquire(limit: number, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new Error("Subagent was aborted while waiting for a concurrency slot"));
		if (limit === -1 || this.running < limit) {
			this.running++;
			return Promise.resolve(this.releaseOnce());
		}
		return new Promise((resolve, reject) => {
			const waiter: (typeof this.waiters)[number] = { limit, resolve };
			this.waiters.push(waiter);
			if (signal) {
				const abort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(new Error("Subagent was aborted while waiting for a concurrency slot"));
				};
				waiter.cleanup = () => signal.removeEventListener("abort", abort);
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
		});
	}

	private releaseOnce(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.running--;
			this.drain();
		};
	}

	private drain(): void {
		for (let index = 0; index < this.waiters.length; index++) {
			const waiter = this.waiters[index]!;
			if (waiter.limit !== -1 && this.running >= waiter.limit) continue;
			this.waiters.splice(index, 1);
			waiter.cleanup?.();
			this.running++;
			waiter.resolve(this.releaseOnce());
			index--;
		}
	}
}

export const gate = new ConcurrencyGate();

interface LiveChild {
	abort(): void;
	/** Abort the child's current turn via RPC (Esc-equivalent). Queued behind
	 * in-flight sends. The process is still reaped on settle; resume happens
	 * via a fresh process from the saved transcript. */
	abortTurn(): Promise<void>;
	sendMessage(message: string, signal?: AbortSignal, mode?: SubagentMessageMode): Promise<void>;
}

interface StartingChild {
	messages: Array<{ text: string; mode: SubagentMessageMode }>;
}

interface OwnedChild {
	pid: number;
	closed: Promise<void>;
	terminate(): Promise<void>;
}

const liveChildren = new Map<string, LiveChild>();
const startingChildren = new Map<string, StartingChild>();
const ownedChildren = new Map<string, OwnedChild>();
const childRuns = new Map<string, Promise<void>>();
const runAbortControllers = new Map<string, AbortController>();

export interface MeshSender {
	runId: string;
	socketDir: string;
	waitMs?: number;
}

export function meshSenderFor(agentDir: string, runId: string): MeshSender {
	return { runId, socketDir: meshSocketDir(agentDir) };
}

/** Best-effort settle notice to the result owner (the record's parent). The
 * registry remains the source of truth; a missing parent socket is ignored. */
export async function notifyParentSettled(agentDir: string, record: AgentRecord): Promise<void> {
	try {
		await sendMeshMessage({
			socketDir: meshSocketDir(agentDir),
			toRunId: record.parentRunId,
			fromRunId: record.runId,
			type: "settled",
			payload: { status: record.status },
		});
	} catch {
		// Parent gone or not yet listening; delivery falls back to polling.
	}
}

function fireSettled(context: SpawnContext, record: AgentRecord): void {
	try {
		context.onSettled?.(record);
	} finally {
		void notifyParentSettled(context.agentDir, record);
	}
}

/** Send to any live session: owned children use the direct RPC channel,
 * everything else goes over the socket mesh. Mode selects pi-native
 * delivery: `steer` (default) redirects current work, `followUp` queues
 * behind it. Terminal children always return false so the caller resumes
 * them via a fresh process from the saved transcript; unreachable
 * non-terminal children also return false after a bounded socket wait so
 * the caller can park (queued/starting) or fail (running) explicitly. */
/** Which transport carried a subagent message: the owned live RPC channel,
 * the starting-process queue, or the socket mesh. `false` means undelivered. */
export type SubagentSendChannel = "live" | "starting" | "mesh";
export async function sendSubagentMessage(record: AgentRecord, message: string, signal?: AbortSignal, mode: SubagentMessageMode = "steer", sender?: MeshSender): Promise<SubagentSendChannel | false> {
	if (signal?.aborted) throw new Error("Subagent message was aborted");
	mode = normalizeMessageMode(mode);
	if (isTerminalStatus(record.status)) return false;
	const live = liveChildren.get(record.runId);
	if (live) {
		await live.sendMessage(message, signal, mode);
		return "live";
	}
	const startup = startingChildren.get(record.runId);
	if (startup) {
		startup.messages.push({ text: message, mode });
		return "starting";
	}
	if (!sender) return false;
	try {
		await deliverMeshMessage({
			socketDir: sender.socketDir,
			toRunId: record.runId,
			fromRunId: sender.runId,
			type: mode,
			text: message,
			waitMs: sender.waitMs,
			signal,
		});
		return "mesh";
	} catch {
		return false;
	}
}

export interface ScopedModelCapability {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

export interface SpawnContext {
	agentDir: string;
	parentRunId: string;
	rootRunId: string;
	currentDepth: number;
	settings: SubagentSettings;
	parentModel?: string;
	parentThinking?: string;
	parentTools: readonly string[];
	scopedModels: readonly ScopedModelCapability[];
	parentCwd: string;
	projectTrusted: boolean;
	signal?: AbortSignal;
	onRecord?: (record: AgentRecord) => void;
	onUiRequest?: (record: AgentRecord, request: any) => Promise<Record<string, unknown> | void>;
	/** Fired once per child when it reaches a terminal state. */
	onSettled?: (record: AgentRecord) => void;
	/** Test overrides for transport bounds. */
	rpcRequestTimeoutMs?: number;
	rpcStartupTimeoutMs?: number;
	stdoutLineLimit?: number;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Test hook: run a fake child instead of the real pi binary.
	const override = process.env.PI_SUBAGENT_COMMAND;
	if (override) return { command: process.execPath, args: [override, ...args] };

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args }
		: { command: process.execPath, args };
}

function validateToolName(name: string): void {
	if (!name.trim()) throw new Error("Subagent tool names must not be blank");
	if (name !== name.trim()) {
		throw new Error(`Subagent tool name must not have leading or trailing whitespace: ${JSON.stringify(name)}`);
	}
	if (name.includes(",")) throw new Error(`Subagent tool name must not contain a comma: ${JSON.stringify(name)}`);
	if (/\p{Cc}/u.test(name)) throw new Error(`Subagent tool name must not contain control characters: ${JSON.stringify(name)}`);
}

/** Resolve the child's exact tool allowlist without granting anything its parent lacks. */
export function resolveChildTools(requested: readonly string[] | undefined, parentTools: readonly string[]): string[] {
	const effective = requested === undefined ? parentTools : requested;
	for (const name of effective) validateToolName(name);
	if (requested === undefined) return [...new Set(parentTools)];
	const available = new Set(parentTools);
	const unavailable = [...new Set(requested.filter((name) => !available.has(name)))];
	if (unavailable.length > 0) {
		throw new Error(
			`Subagent tools must be a subset of the creating session's active tools; unavailable: ${unavailable.join(", ")}`,
		);
	}
	return [...new Set(requested)];
}

function canonicalModel(model: ScopedModelCapability): string {
	return `${model.provider}/${model.id}`;
}

/** Canonicalize a requested model against a nonempty parent model scope. */
export function resolveChildModel(model: string, scopedModels: readonly ScopedModelCapability[]): string {
	if (scopedModels.length === 0) return model;
	const normalized = model.toLowerCase();
	const exact = scopedModels.find((item) => canonicalModel(item).toLowerCase() === normalized);
	if (exact) return canonicalModel(exact);
	const bareMatches = scopedModels.filter((item) => item.id.toLowerCase() === normalized);
	if (bareMatches.length === 1) return canonicalModel(bareMatches[0]!);
	if (bareMatches.length > 1) {
		throw new Error(`Subagent model "${model}" is ambiguous within the creating session's model scope`);
	}
	throw new Error(`Subagent model "${model}" is outside the creating session's model scope`);
}

/** Canonicalize an inherited or configured-default model when it is in scope,
 * otherwise use it as-is. Unlike resolveChildModel this never rejects: omitting
 * `model` must always work, even when the creating session's active model sits
 * outside its enabledModels scope. The child is launched with an explicit
 * --model, which pi resolves independently of the --models scope. */
export function resolveInheritedModel(model: string, scopedModels: readonly ScopedModelCapability[]): string {
	if (scopedModels.length === 0) return model;
	const normalized = model.toLowerCase();
	const exact = scopedModels.find((item) => canonicalModel(item).toLowerCase() === normalized);
	if (exact) return canonicalModel(exact);
	const bareMatches = scopedModels.filter((item) => item.id.toLowerCase() === normalized);
	return bareMatches.length === 1 ? canonicalModel(bareMatches[0]!) : model;
}

function scopedPin(model: string, scopedModels: readonly ScopedModelCapability[]): string | undefined {
	return scopedModels.find((item) => canonicalModel(item).toLowerCase() === model.toLowerCase())?.thinkingLevel;
}

function resolveChildThinking(
	requested: string | undefined,
	model: string,
	scopedModels: readonly ScopedModelCapability[],
	fallback: string,
): string {
	const pinned = scopedPin(model, scopedModels);
	const value = requested?.trim();
	if (value) {
		if (pinned && value !== pinned) {
			throw new Error(`Subagent thinking "${value}" is outside the creating session's pin for ${model} (${pinned})`);
		}
		return value;
	}
	return pinned || fallback;
}

function scopedModelArgs(scopedModels: readonly ScopedModelCapability[]): string[] {
	if (scopedModels.length === 0) return [];
	const names = scopedModels.map((item) => `${canonicalModel(item)}${item.thinkingLevel ? `:${item.thinkingLevel}` : ""}`);
	for (const name of names) {
		if (name.includes(",") || /\p{Cc}/u.test(name)) {
			throw new Error(`Cannot pass scoped model to a subagent: ${JSON.stringify(name)}`);
		}
	}
	return ["--models", names.join(",")];
}

function ensureDirectory(value: string): string {
	const cwd = resolve(value);
	let valid = false;
	try {
		valid = statSync(cwd).isDirectory();
	} catch {
		// Report one stable error below.
	}
	if (!valid) throw new Error(`Subagent working directory does not exist: ${cwd}`);
	return realpathSync(cwd);
}

/** Check canonical path containment without relying on platform-specific separators. */
export function isWithinDirectory(path: string, directory: string): boolean {
	const child = relative(directory, path);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

interface ProcessIdentity {
	pid: number;
	startTime: string;
	processGroup: number;
}

function readProcessIdentity(pid: number): ProcessIdentity | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return undefined;
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		const processGroup = Number(fields[2]);
		const startTime = fields[19];
		if (!Number.isInteger(processGroup) || !startTime) return undefined;
		return { pid, processGroup, startTime };
	} catch {
		return undefined;
	}
}

function sameProcess(identity: ProcessIdentity): boolean {
	const current = readProcessIdentity(identity.pid);
	return !!current && current.startTime === identity.startTime;
}

function processGroupSnapshot(group: number): ProcessIdentity[] {
	if (process.platform !== "linux") return [];
	const members: ProcessIdentity[] = [];
	try {
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name)) continue;
			const identity = readProcessIdentity(Number(name));
			if (identity?.processGroup === group) members.push(identity);
		}
	} catch {
		// /proc may be unavailable or restricted.
	}
	return members;
}

function signalPidTree(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

/**
 * Stop a process tree not owned by this Pi process. On Linux, delayed SIGKILL
 * targets only the original process-group members whose PID start time still
 * matches. Other platforms avoid a delayed PID-only kill that could hit a
 * reused PID.
 */
export function killPidTree(pid: number, expectedStartTime?: string): void {
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
		return;
	}
	const leader = readProcessIdentity(pid);
	if (expectedStartTime && leader?.startTime !== expectedStartTime) return;
	const members = processGroupSnapshot(pid);
	signalPidTree(pid, "SIGTERM");
	if (members.length === 0) return;
	setTimeout(() => {
		for (const member of members) {
			if (!sameProcess(member)) continue;
			try {
				process.kill(member.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}, 3000).unref();
}

function waitTimeout(ms: number): Promise<void> {
	return new Promise((resolveWait) => {
		const timer = setTimeout(resolveWait, ms);
		timer.unref();
	});
}

function ownChild(runId: string, child: ChildProcessWithoutNullStreams): OwnedChild {
	const pid = child.pid;
	if (!pid) throw new Error("Subagent process started without a PID");
	let closed = false;
	let resolveClosed!: () => void;
	const closedPromise = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	child.once("close", () => {
		closed = true;
		resolveClosed();
	});
	const identity = readProcessIdentity(pid);
	let terminating: Promise<void> | undefined;
	const owned: OwnedChild = {
		pid,
		closed: closedPromise,
		terminate() {
			if (terminating) return terminating;
			terminating = (async () => {
				if (process.platform === "win32") {
					spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
				} else {
					signalPidTree(pid, "SIGTERM");
					const timer = setTimeout(() => {
						if (
							!closed &&
							child.exitCode === null &&
							child.signalCode === null &&
							(!identity || sameProcess(identity))
						) {
							signalPidTree(pid, "SIGKILL");
						}
					}, 3000);
					timer.unref();
					closedPromise.finally(() => clearTimeout(timer));
				}
				await Promise.race([closedPromise, waitTimeout(TERMINATION_WAIT_MS)]);
			})();
			return terminating;
		},
	};
	ownedChildren.set(runId, owned);
	closedPromise.finally(() => {
		if (ownedChildren.get(runId) === owned) ownedChildren.delete(runId);
	});
	return owned;
}

/** Cancel one run: registry flip plus every stop handle this process holds
 * (live channel, owned process, raw pid tree for runs owned by other
 * processes). Already-terminal runs keep their status. Cancelled results
 * stay collectable via check_subagents. Lock failures propagate. */
async function cancelOne(agentDir: string, item: AgentRecord, detail: string): Promise<AgentRecord> {
	let updated!: AgentRecord;
	let live: LiveChild | undefined;
	let owned: OwnedChild | undefined;
	let pid: number | undefined;
	let pidStartTime: string | undefined;
	await withRecordLock(agentDir, item.runId, () => {
		const latest = readRecords(agentDir).find((candidate) => candidate.runId === item.runId) ?? item;
		if (isTerminalStatus(latest.status)) {
			updated = latest;
			return;
		}
		const now = new Date().toISOString();
		updated = saveRecord(agentDir, {
			...latest,
			status: "cancelled",
			activity: "cancelled",
			currentTool: undefined,
			error: latest.error ?? detail,
			finishedAt: latest.finishedAt ?? now,
			updatedAt: now,
		});
		live = liveChildren.get(item.runId);
		owned = ownedChildren.get(item.runId);
		pid = updated.pid;
		pidStartTime = updated.pidStartTime;
		runAbortControllers.get(item.runId)?.abort();
	});
	if (live) live.abort();
	if (owned) void owned.terminate();
	else if (pid && isProcessAlive(pid)) killPidTree(pid, pidStartTime);
	return updated;
}

/** Cancel every non-terminal descendant, deepest first (a descendant owned by
 * another process is reached via its pid tree). Settle uses a parent-settled
 * detail plus pre-delivery; explicit cancellation keeps results collectable. */
export async function cancelDescendants(agentDir: string, runId: string, detail = "Cancelled"): Promise<void> {
	for (const child of descendantsOf(readRecords(agentDir), runId).reverse()) {
		if (isTerminalStatus(child.status)) continue;
		try {
			await cancelOne(agentDir, child, detail);
		} catch {
			// One stuck descendant must not break settle or shutdown.
		}
	}
}

/** Abort a running or queued child's current turn, plus all of its descendants.
 * The child process is always stopped so no idle pi process lingers; a later
 * message resumes the session via a fresh process from the saved transcript.
 * Session shutdown still reaps everything via terminateOwnedSubagents. */
export async function cancelSubagent(agentDir: string, record: AgentRecord): Promise<AgentRecord> {
	await cancelDescendants(agentDir, record.runId);
	return cancelOne(agentDir, record, "Cancelled");
}

/** True when no live descendant needs this run's pipes. */
export function subtreeDrained(agentDir: string, runId: string): boolean {
	try {
		return !descendantsOf(getCachedRecords(agentDir), runId).some((child) => !isTerminalStatus(child.status));
	} catch {
		// Unreadable registry: keep pipes open rather than orphan.
		return false;
	}
}

/** Reap owned processes of terminal runs whose subtree fully drained.
 * Runs with live descendants linger with pipes open (see the settle site).
 * Idempotent: owned.terminate memoizes, and closed handles leave the map. */
export function reapOwnedIfDrained(agentDir: string): void {
	let all: AgentRecord[];
	try {
		all = getCachedRecords(agentDir);
	} catch {
		return;
	}
	for (const record of all) {
		if (!isTerminalStatus(record.status) || !ownedChildren.has(record.runId)) continue;
		if (descendantsOf(all, record.runId).some((child) => !isTerminalStatus(child.status))) continue;
		liveChildren.delete(record.runId);
		void ownedChildren.get(record.runId)?.terminate();
	}
}

/** Stop and await children owned by this process. Queued run loops also drain. */
export async function terminateOwnedSubagents(runIds: readonly string[]): Promise<void> {
	const ids = new Set(runIds);
	const terminations: Promise<void>[] = [];
	for (const runId of ids) {
		runAbortControllers.get(runId)?.abort();
		liveChildren.get(runId)?.abort();
		const owned = ownedChildren.get(runId);
		if (owned) terminations.push(owned.terminate());
	}
	await Promise.all(terminations);
	const runs = [...ids].map((runId) => childRuns.get(runId)).filter((run): run is Promise<void> => !!run);
	await Promise.race([Promise.all(runs).then(() => {}), waitTimeout(TERMINATION_WAIT_MS)]);
}

async function findSessionFile(cwd: string, sessionId: string): Promise<string | undefined> {
	try {
		return (await SessionManager.list(cwd)).find((session) => session.id === sessionId)?.path;
	} catch {
		return undefined;
	}
}

/**
 * Launch a subagent without waiting for it. Validates everything the caller
 * should see as a tool error (depth, model, cwd), persists the record, and
 * returns immediately. The process runs in the background; progress lands in
 * the registry and onSettled fires when it reaches a terminal state.
 */
export async function startSubagent(input: SpawnAgentInput, context: SpawnContext): Promise<AgentRecord> {
	if (context.signal?.aborted) throw new Error("Subagent spawn was aborted");
	// Only the top-level root controls the tree budget (default 2): it may set
	// maxDepth per spawn, and descendants inherit without ever raising it.
	if (input.maxDepth !== undefined && context.parentRunId !== context.rootRunId) {
		throw new Error("Only the root session may set maxDepth; descendant budgets inherit.");
	}
	const settings = input.maxDepth === undefined
		? context.settings
		: { ...context.settings, maxDepth: depth(input.maxDepth, "maxDepth") };
	if (context.currentDepth >= settings.maxDepth) {
		throw new Error(`Subagent depth limit reached (${context.currentDepth}/${settings.maxDepth})`);
	}
	const queued = gate.isFull(context.settings.maxConcurrency);
	const runId = randomUUID();
	const parentCwd = ensureDirectory(context.parentCwd);
	const cwd = ensureDirectory(input.cwd ? resolve(parentCwd, input.cwd) : parentCwd);
	const requestedModel = input.model?.trim();
	const selectedModel = requestedModel || context.settings.defaultModel || context.parentModel;
	if (!selectedModel) {
		throw new Error("No subagent model is available; choose a parent model or configure defaultModel");
	}
	// An explicitly requested model must be inside the creating session's scope;
	// inherited/default models bypass that check so a session whose active model
	// is outside enabledModels can still delegate without naming a model.
	const model = requestedModel
		? resolveChildModel(requestedModel, context.scopedModels)
		: resolveInheritedModel(selectedModel, context.scopedModels);
	const tools = resolveChildTools(input.tools, context.parentTools);
	scopedModelArgs(context.scopedModels);
	// Names are required and unique among siblings so every tree path
	// resolves to one run. Reload adoption suffixes automatically.
	const name = input.name?.trim();
	if (!name) throw new Error("Subagent name is required; choose a name unique among siblings.");
	if (siblingNameTaken(readRecords(context.agentDir), context.parentRunId, name)) {
		throw new Error(`A subagent named "${name}" already exists under this session; choose a different name.`);
	}
	const thinking = validateThinkingLevel(
		resolveChildThinking(
			input.thinking,
			model,
			context.scopedModels,
			context.settings.defaultThinking || context.parentThinking || "off",
		),
		"thinking",
	);
	const now = new Date().toISOString();
	const record: AgentRecord = {
		version: 1,
		runId,
		parentRunId: context.parentRunId,
		rootRunId: context.rootRunId,
		sessionId: runId,
		name,
		task: input.task,
		cwd,
		model,
		thinking,
		tools,
		depth: context.currentDepth + 1,
		maxDepth: settings.maxDepth,
		status: queued ? "queued" : "starting",
		activity: queued ? "waiting for a concurrency slot" : "starting",
		usage: { ...EMPTY_USAGE },
		startedAt: now,
		updatedAt: now,
	};
	Object.assign(record, saveRecord(context.agentDir, record));
	context.onRecord?.(record);

	startingChildren.set(record.runId, { messages: [] });
	const runAbort = new AbortController();
	runAbortControllers.set(record.runId, runAbort);
	if (context.signal) {
		const abortRun = () => runAbort.abort();
		if (context.signal.aborted) runAbort.abort();
		else context.signal.addEventListener("abort", abortRun, { once: true });
	}
	const run = runSubagentProcess(input, context, record, runAbort.signal)
		.catch((error) => {
			if (isRecordCancelled(context.agentDir, record.runId)) {
				const onDisk = readRecords(context.agentDir).find((candidate) => candidate.runId === record.runId);
				if (onDisk) Object.assign(record, onDisk);
				// A run cancelled mid-startup never registers a live channel, so no
				// later message can resume it — don't leak its process.
				void ownedChildren.get(record.runId)?.terminate();
				return;
			}
			if (isTerminalStatus(record.status)) return;
			record.status = "failed";
			record.activity = "failed";
			record.error = error instanceof Error ? error.message : String(error);
			record.finishedAt = record.finishedAt ?? new Date().toISOString();
			record.updatedAt = record.finishedAt;
			Object.assign(record, saveRecord(context.agentDir, record));
			context.onRecord?.(record);
			fireSettled(context, record);
		})
		.finally(() => {
			if (runAbortControllers.get(record.runId) === runAbort) runAbortControllers.delete(record.runId);
			startingChildren.delete(record.runId);
		});
	childRuns.set(record.runId, run);
	void run.finally(() => {
		if (childRuns.get(record.runId) === run) childRuns.delete(record.runId);
	});
	return record;
}

/**
 * Resume a terminal subagent from its saved transcript in a fresh process.
 * Reuses the same run id (new execution): the transcript file already holds
 * the full history, so `--session` reopens it and the message starts the next
 * turn. The previous process is reaped first so two writers never share a
 * session file. Returns immediately like startSubagent; progress lands in the
 * registry and onSettled fires when the new turn reaches a terminal state.
 */
export async function resumeSubagent(
	record: AgentRecord,
	message: string,
	context: SpawnContext,
	_mode: SubagentMessageMode = "steer",
	options: { claimReloadMarker?: boolean } = {},
): Promise<AgentRecord> {
	normalizeMessageMode(_mode);
	if (context.signal?.aborted) throw new Error("Subagent message was aborted");
	const latest = readRecords(context.agentDir).find((candidate) => candidate.runId === record.runId) ?? record;
	if (!isTerminalStatus(latest.status)) {
		throw new Error(`${latest.name} is still running`);
	}
	if (childRuns.has(record.runId) || startingChildren.has(record.runId)) {
		throw new Error(`${latest.name} is still running`);
	}
	// Reap any straggler process before a new writer opens the same session.
	// Terminal + liveChildren means leftover, not running: the record already
	// settled, so terminate and continue.
	liveChildren.delete(record.runId);
	await terminateOwnedSubagents([record.runId]);
	let reset!: AgentRecord;
	await withRecordLock(context.agentDir, record.runId, () => {
		const current = readRecords(context.agentDir).find((candidate) => candidate.runId === record.runId) ?? latest;
		if (!isTerminalStatus(current.status)) throw new Error(`${current.name} is still running`);
		// Claim before mutating: a failed claim leaves the disk exactly as-is
		// so a concurrent explicit cancellation is never undone mid-flight.
		if (options.claimReloadMarker && !readReloadInterrupted(context.agentDir, record.runId)) {
			throw new Error(`${current.name} is no longer awaiting resume`);
		}
		clearRecordCancellation(context.agentDir, record.runId);
		clearRecordClosedMarker(context.agentDir, record.runId);
		// A resume (manual or automatic after a reload) consumes the
		// reload-interrupt intent: the new execution owns the run now.
		clearReloadInterrupted(context.agentDir, record.runId);
		const queued = gate.isFull(context.settings.maxConcurrency);
		const now = new Date().toISOString();
		reset = saveRecord(context.agentDir, {
			...current,
			status: queued ? "queued" : "starting",
			activity: queued ? "waiting for a concurrency slot" : "starting",
			updatedAt: now,
		});
	});
	Object.assign(record, reset);
	Object.assign(latest, reset);
	context.onRecord?.(record);

	startingChildren.set(record.runId, { messages: [] });
	const runAbort = new AbortController();
	runAbortControllers.set(record.runId, runAbort);
	if (context.signal) {
		const abortRun = () => runAbort.abort();
		if (context.signal.aborted) runAbort.abort();
		else context.signal.addEventListener("abort", abortRun, { once: true });
	}
	const run = runSubagentProcess({ task: message }, context, record, runAbort.signal, true)
		.catch((error) => {
			if (isRecordCancelled(context.agentDir, record.runId)) {
				const onDisk = readRecords(context.agentDir).find((candidate) => candidate.runId === record.runId);
				if (onDisk) Object.assign(record, onDisk);
				void ownedChildren.get(record.runId)?.terminate();
				return;
			}
			if (isTerminalStatus(record.status)) return;
			record.status = "failed";
			record.activity = "failed";
			record.error = error instanceof Error ? error.message : String(error);
			record.finishedAt = record.finishedAt ?? new Date().toISOString();
			record.updatedAt = record.finishedAt;
			Object.assign(record, saveRecord(context.agentDir, record));
			context.onRecord?.(record);
			fireSettled(context, record);
		})
		.finally(() => {
			if (runAbortControllers.get(record.runId) === runAbort) runAbortControllers.delete(record.runId);
			startingChildren.delete(record.runId);
		});
	childRuns.set(record.runId, run);
	void run.finally(() => {
		if (childRuns.get(record.runId) === run) childRuns.delete(record.runId);
	});
	return record;
}

async function runSubagentProcess(
	input: SpawnAgentInput,
	context: SpawnContext,
	record: AgentRecord,
	runSignal: AbortSignal,
	isResume = false,
): Promise<void> {
	let release: (() => void) | undefined;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const publish = () => {
		Object.assign(record, saveRecord(context.agentDir, record));
		context.onRecord?.(record);
	};
	const publishClosed = () => {
		Object.assign(record, clearRecordPid(context.agentDir, record));
		context.onRecord?.(record);
	};
	const diskCancelled = () => isRecordCancelled(context.agentDir, record.runId);
	const schedulePublish = (immediate = false) => {
		if (immediate) {
			if (flushTimer) clearTimeout(flushTimer);
			flushTimer = undefined;
			publish();
			return;
		}
		if (!flushTimer) {
			flushTimer = setTimeout(() => {
				flushTimer = undefined;
				publish();
			}, 200);
			flushTimer.unref?.();
		}
	};
	const settle = (status: AgentRecord["status"], detail?: string) => {
		if (diskCancelled()) status = "cancelled";
		record.status = status;
		record.activity = status;
		record.currentTool = undefined;
		if (detail) record.error = detail;
		record.finishedAt = new Date().toISOString();
		record.updatedAt = record.finishedAt;
		publish();
		fireSettled(context, record);
		// A live subtree keeps running: grandchildren outlive this settle and
		// report their own completion (see self-report.ts). Explicit
		// cancellation still takes the whole subtree via cancelSubagent.
	};

	try {
		release = await gate.acquire(context.settings.maxConcurrency, runSignal);
		if (record.status === "cancelled" || diskCancelled()) return;

		const systemPrompt = `You are subagent "${record.name}" at depth ${record.depth}/${record.maxDepth}. Complete delegated tasks and return concise, self-contained results.`;
		const args = ["--mode", "rpc"];
		if (isResume && record.sessionFile && existsSync(record.sessionFile)) {
			// Resume from the saved transcript; the system prompt is already in it.
			args.push("--session", record.sessionFile);
		} else {
			args.push("--session-id", record.runId);
			args.push("--append-system-prompt", systemPrompt);
		}
		args.push("--model", record.model);
		args.push("--name", record.name);
		if (record.thinking) args.push("--thinking", record.thinking);
		args.push(...scopedModelArgs(context.scopedModels));
		if (record.tools?.length) args.push("--tools", record.tools.join(","));
		else args.push("--no-tools");

		let stderr = "";
		let lineParts: string[] = [];
		let lineLength = 0;
		let transportError: string | undefined;
		let requestId = 0;
		let initialSettled = false;
		let closing = false;
		let resolveInitial!: () => void;
		const initialDone = new Promise<void>((resolveDone) => {
			resolveInitial = resolveDone;
		});
		const state: ParsedChildState = { finalText: "" };
		type PendingRequest = {
			resolve: (value: any) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			signal?: AbortSignal;
			onAbort?: () => void;
		};
		const pending = new Map<string, PendingRequest>();
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		const requestTimeoutMs = Math.max(1, context.rpcRequestTimeoutMs ?? RPC_REQUEST_TIMEOUT_MS);
		const startupDeadline = Date.now() + Math.max(1, context.rpcStartupTimeoutMs ?? RPC_STARTUP_TIMEOUT_MS);
		const stdoutLineLimit = validateRpcMaxLineChars(
			context.stdoutLineLimit ?? context.settings.rpcMaxLineChars ?? DEFAULT_SETTINGS.rpcMaxLineChars,
			"rpcMaxLineChars",
		);

		let child: ChildProcessWithoutNullStreams | undefined;
		await withRecordLock(context.agentDir, record.runId, () => {
			if (diskCancelled()) return;
			// Re-resolve immediately before spawn so a swapped symlink cannot keep --approve.
			record.cwd = ensureDirectory(record.cwd);
			const trustedRoot = ensureDirectory(context.parentCwd);
			if (context.projectTrusted && isWithinDirectory(record.cwd, trustedRoot)) {
				args.push("--approve");
			}
			const invocation = getPiInvocation(args);
			child = spawn(invocation.command, invocation.args, {
				cwd: record.cwd,
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_SUBAGENT_RUN_ID: record.runId,
					PI_SUBAGENT_PARENT_ID: context.parentRunId,
					PI_SUBAGENT_ROOT_ID: context.rootRunId,
					PI_SUBAGENT_DEPTH: String(record.depth),
					PI_SUBAGENT_MAX_DEPTH: String(record.maxDepth),
					PI_SUBAGENT_DEPTH_FLAG_OVERRIDE: context.settings.maxDepthFlagOverride ? "1" : "0",
				},
			});
			ownChild(record.runId, child);
			record.pid = child.pid;
			record.pidStartTime = child.pid ? readProcessIdentity(child.pid)?.startTime : undefined;
			record.status = "starting";
			record.activity = "starting";
			publish();
		});
		if (!child) return;
		const launchedChild = child;

		const cleanupPending = (request: PendingRequest) => {
			clearTimeout(request.timer);
			if (request.signal && request.onAbort) request.signal.removeEventListener("abort", request.onAbort);
		};
		const rejectPending = (error: Error) => {
			for (const request of pending.values()) {
				cleanupPending(request);
				request.reject(error);
			}
			pending.clear();
		};
		const failTransport = (error: Error) => {
			if (transportError) return;
			transportError = error.message;
			lineParts = [];
			lineLength = 0;
			rejectPending(error);
			if (closing) return;
			launchedChild.stdin.destroy();
			const owned = ownedChildren.get(record.runId);
			if (owned) void owned.terminate();
			else if (record.pid && isProcessAlive(record.pid)) killPidTree(record.pid, record.pidStartTime);
		};
		const writeLine = (value: Record<string, unknown>, id?: string) => {
			if (launchedChild.stdin.destroyed || launchedChild.stdin.writableEnded) {
				const error = new Error("Subagent RPC stdin is not writable");
				if (id) {
					const request = pending.get(id);
					if (request) {
						pending.delete(id);
						cleanupPending(request);
						request.reject(error);
					}
				}
				failTransport(error);
				return;
			}
			try {
				launchedChild.stdin.write(`${JSON.stringify(value)}\n`, "utf8", (error) => {
					if (error) failTransport(error);
				});
			} catch (error) {
				failTransport(error instanceof Error ? error : new Error(String(error)));
			}
		};
		/** Rejection marker: the child explicitly refused the command, so no new
		 * turn will start (unlike aborts and transport failures, where a turn may
		 * still be running). Lets sendMessage restore pre-send status. */
		const rpcRefused = (error: Error): Error => {
			(error as Error & { rpcRefused?: boolean }).rpcRefused = true;
			return error;
		};
		const send = (
			command: Record<string, unknown>,
			options: { signal?: AbortSignal; deadline?: number } = {},
		): Promise<any> => {
			const id = `subagent-${++requestId}`;
			const commandName = typeof command.type === "string" ? command.type : "RPC command";
			const timeoutMs = Math.min(
				requestTimeoutMs,
				options.deadline === undefined ? requestTimeoutMs : Math.max(0, options.deadline - Date.now()),
			);
			if (options.signal?.aborted) return Promise.reject(new Error(`${commandName} was aborted`));
			if (timeoutMs <= 0) return Promise.reject(new Error(`Subagent RPC startup timed out: deadline already exceeded before the ${commandName} send ran`));
			return new Promise((resolveCommand, rejectCommand) => {
				const finish = (error?: Error, value?: any) => {
					const request = pending.get(id);
					if (!request) return;
					pending.delete(id);
					cleanupPending(request);
					if (error) request.reject(error);
					else request.resolve(value);
				};
				const timer = setTimeout(() => {
					const label = options.deadline === undefined ? `${commandName} request` : "Subagent RPC startup";
					const error = new Error(`${label} timed out after ${timeoutMs}ms`);
					finish(error);
					failTransport(error);
				}, timeoutMs);
				timer.unref?.();
				const onAbort = options.signal ? () => finish(new Error(`${commandName} was aborted`)) : undefined;
				pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer, signal: options.signal, onAbort });
				options.signal?.addEventListener("abort", onAbort!, { once: true });
				writeLine({ ...command, id }, id);
			});
		};

		let messageQueue = Promise.resolve();
		const lifetime = new AbortController();
		const liveChild: LiveChild = {
			abort: () => lifetime.abort(),
			abortTurn() {
				const result = messageQueue.then(() => send({ type: "abort" }, { signal: lifetime.signal }));
				messageQueue = result.catch(() => {});
				return result.then(() => {});
			},
			sendMessage(message: string, signal?: AbortSignal, mode: SubagentMessageMode = "steer") {
				mode = normalizeMessageMode(mode);
				signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
				const result = messageQueue.then(async () => {
					if (signal?.aborted) throw new Error("Subagent message was aborted");
					if (closing || isTerminalStatus(record.status)) {
						throw new Error("Subagent is no longer running");
					}
					// prompt + streamingBehavior IS pi-native steering/follow-up while
					// the child streams (session queues via steer()/followUp()).
					// Terminal children never reach here: sendSubagentMessage returns
					// false for them so the caller resumes via a fresh process from
					// the saved transcript instead.
					await send({ type: "prompt", message, streamingBehavior: mode }, { signal });
				});
				messageQueue = result.catch(() => {});
				return result;
			},
		};

		// Turn backstop (maxTurns/graceTurns): a stuck runaway can otherwise hold
		// its parent's linger and the box forever. Counts assistant turns per
		// process and never resets — steered follow-up turns are work too;
		// a resume starts a fresh process and a fresh counter.
		let turnCount = 0;
		const enforceTurnLimit = () => {
			const maxTurns = context.settings.maxTurns ?? 0;
			if (!(maxTurns > 0)) return;
			const graceTurns = context.settings.graceTurns ?? 5;
			if (turnCount === maxTurns && graceTurns > 0) {
				const live = liveChildren.get(record.runId);
				if (live) {
					void live.sendMessage(
						`You reached your turn limit (${maxTurns}). Wrap up now. Give your final answer or a partial answer. List the next steps. The job stopped at a usage limit. It may need follow-up.`,
						undefined,
						"steer",
					).catch(() => {});
				}
			} else if (turnCount >= maxTurns + graceTurns) {
				void cancelSubagent(context.agentDir, record).catch(() => {});
			}
		};
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "response" && typeof event.id === "string") {
				const request = pending.get(event.id);
				if (!request) return;
				pending.delete(event.id);
				cleanupPending(request);
				if (event.success) request.resolve(event);
				else request.reject(rpcRefused(new Error(event.error || `${event.command || "RPC command"} failed`)));
				return;
			}
			if (event.type === "extension_ui_request" && typeof event.id === "string") {
				const dialog = ["select", "confirm", "input", "editor"].includes(event.method);
				if (context.onUiRequest) {
					void context.onUiRequest(record, event).then(
						(response) => {
							if (dialog) writeLine({ type: "extension_ui_response", id: event.id, ...(response ?? { cancelled: true }) });
						},
						() => {
							if (dialog) writeLine({ type: "extension_ui_response", id: event.id, cancelled: true });
						},
					);
				} else if (dialog) {
					writeLine({ type: "extension_ui_response", id: event.id, cancelled: true });
				}
				return;
			}
			const important = applyChildEvent(record, state, event);
			if (event?.type === "message_end" && event?.message?.role === "assistant") {
				turnCount++;
			enforceTurnLimit();
			}
			if (event.type === "agent_settled") {
				if (record.status === "cancelled" || diskCancelled()) {
					const onDisk = readRecords(context.agentDir).find((r) => r.runId === record.runId);
					if (onDisk) Object.assign(record, onDisk);
				} else if (state.stopReason === "aborted") {
					settle("cancelled", "Subagent was aborted");
				} else if (state.stopReason === "error") {
					settle("failed", state.errorMessage || stderr.trim() || "Subagent failed");
				} else {
					record.latestText = state.finalText || record.latestText || "(no output)";
					settle("completed");
				}
				if (!initialSettled) {
					initialSettled = true;
					resolveInitial();
				}
				// Reap on drain, not on settle: a settled run with live descendants
				// lingers with pipes open, because an orphaned pi child exits(1)
			// on its first stdout write (host output-guard) and no wake chain
			// can survive that. reapOwnedIfDrained reaps it once the subtree
				// drains; shutdown still terminates everything at quit.
				liveChildren.delete(record.runId);
				if (subtreeDrained(context.agentDir, record.runId)) {
					try {
						launchedChild.stdin.end();
					} catch {
						// Already gone; terminate() below still reaps the PID.
					}
					void ownedChildren.get(record.runId)?.terminate();
				}
				return;
			}
			schedulePublish(important);
		};

		const consumeStdout = (text: string) => {
			if (!text || transportError) return;
			// Scan each chunk once; don't repeatedly copy/scan a growing image payload.
			let start = 0;
			while (start < text.length && !transportError) {
				const newline = text.indexOf("\n", start);
				const end = newline < 0 ? text.length : newline;
				const length = end - start;
				if (lineLength + length > stdoutLineLimit) {
					failTransport(new Error(`Subagent RPC stdout line exceeded ${stdoutLineLimit} characters (rpcMaxLineChars)`));
					return;
				}
				if (length) lineParts.push(text.slice(start, end));
				lineLength += length;
				if (newline < 0) return;
				let line = lineParts.join("");
				lineParts = [];
				lineLength = 0;
				if (line.endsWith("\r")) line = line.slice(0, -1);
				processLine(line);
				start = newline + 1;
			}
		};
		launchedChild.stdout.on("data", (chunk: Buffer) => {
			consumeStdout(stdoutDecoder.write(chunk));
		});
		launchedChild.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${stderrDecoder.write(chunk)}`.slice(-STDERR_LIMIT);
		});
		launchedChild.stdin.on("error", (error) => failTransport(error));
		launchedChild.on("close", (code) => {
			closing = true;
			lifetime.abort();
			liveChildren.delete(record.runId);
			consumeStdout(stdoutDecoder.end());
			stderr = `${stderr}${stderrDecoder.end()}`.slice(-STDERR_LIMIT);
			if (!transportError && lineLength) processLine(lineParts.join(""));
			lineParts = [];
			lineLength = 0;
			const exitError = new Error(transportError || stderr.trim() || `Subagent exited with code ${code ?? 1}`);
			rejectPending(exitError);
			const wasCancelled = record.status === "cancelled" || diskCancelled();
			const onDisk = readRecords(context.agentDir).find((candidate) => candidate.runId === record.runId);
			// Another writer finalized first (a self-reported completion or a
			// newer execution): this stale monitor touches nothing, not even
			// the pid, so it can neither clobber the record nor orphan the
			// new process.
			const superseded = !onDisk || shouldSkipOwnerWrite(onDisk, record);
			if (wasCancelled) {
				if (onDisk) Object.assign(record, onDisk);
			}
			let newlySettled = false;
			if (!wasCancelled && !superseded && !isTerminalStatus(record.status)) {
				record.status = "failed";
				record.activity = "failed";
				record.currentTool = undefined;
				record.error = exitError.message;
				record.finishedAt = new Date().toISOString();
				record.updatedAt = record.finishedAt;
				newlySettled = true;
			}
			if (!superseded || wasCancelled) {
				record.pid = undefined;
				publishClosed();
			}
			if (newlySettled) fireSettled(context, record);
			if (!initialSettled) {
				initialSettled = true;
				resolveInitial();
			}
		});
		launchedChild.on("error", (error) => {
			stderr = `${stderr}\n${error.message}`.slice(-STDERR_LIMIT);
			failTransport(error);
		});

		try {
			const stateResponse = await send({ type: "get_state" }, { signal: runSignal, deadline: startupDeadline });
			if (typeof stateResponse.data?.sessionFile === "string") {
				record.sessionFile = stateResponse.data.sessionFile;
				publish();
			} else {
				record.sessionFile = await findSessionFile(record.cwd, record.runId);
			}
			// Queue parked startup messages synchronously with the prompt send, not
			// after its response: a fast child can complete in the gap between
			// response processing and a later drain (same-chunk coalescing), and
			// the terminal check would then swallow the retained messages.
		// Queued here they ride messageQueue behind the prompt, ahead of any
			// possible completion round trip. Wire order stays prompt-first:
			// send() writes the prompt line synchronously before returning.
			const promptPromise = send({ type: "prompt", message: input.task }, { signal: runSignal, deadline: startupDeadline });
			const startup = startingChildren.get(record.runId);
			liveChildren.set(record.runId, liveChild);
			startingChildren.delete(record.runId);
			for (const { text, mode } of startup?.messages ?? []) {
				void liveChild.sendMessage(text, undefined, mode).catch(() => {});
			}
			await promptPromise;
			await initialDone;
		} catch (error) {
			launchedChild.stdin.end();
			const owned = ownedChildren.get(record.runId);
			if (owned) void owned.terminate();
			throw error;
		}
	} finally {
		if (flushTimer) clearTimeout(flushTimer);
		release?.();
	}
}
