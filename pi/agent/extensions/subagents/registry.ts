import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentRecord, AgentStatus } from "./types.ts";

const TERMINAL = new Set<AgentStatus>(["completed", "failed", "cancelled"]);
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

interface CancellationMarker {
	version: 1;
	runId: string;
	cancelledAt: string;
	error?: string;
}

export function isTerminalStatus(status: AgentStatus): boolean {
	return TERMINAL.has(status);
}

export function registryDir(agentDir: string): string {
	return join(agentDir, "subagents", "runs");
}

function safeRunId(runId: string): string {
	return runId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function recordPath(agentDir: string, runId: string): string {
	return join(registryDir(agentDir), `${safeRunId(runId)}.json`);
}

function markerPath(agentDir: string, runId: string, kind: "cancelled" | "closed"): string {
	return join(registryDir(agentDir), `${safeRunId(runId)}.${kind}`);
}

function atomicWrite(target: string, contents: string): void {
	const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(temporary, target);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function writeCancellationMarker(agentDir: string, record: AgentRecord): void {
	const target = markerPath(agentDir, record.runId, "cancelled");
	if (existsSync(target)) return;
	const marker: CancellationMarker = {
		version: 1,
		runId: record.runId,
		cancelledAt: record.finishedAt ?? new Date().toISOString(),
		error: record.error,
	};
	atomicWrite(target, `${JSON.stringify(marker)}\n`);
}

function readCancellationMarker(agentDir: string, runId: string): CancellationMarker | undefined {
	const target = markerPath(agentDir, runId, "cancelled");
	if (!existsSync(target)) return undefined;
	try {
		const value = JSON.parse(readFileSync(target, "utf8")) as Partial<CancellationMarker>;
		if (value.version === 1 && value.runId === runId && typeof value.cancelledAt === "string") {
			return value as CancellationMarker;
		}
	} catch {
		// The marker's existence is enough to keep cancellation monotonic.
	}
	return { version: 1, runId, cancelledAt: new Date().toISOString(), error: "Cancelled" };
}

type ResultStateFlag = "resultsDelivered";

function resultStatePath(agentDir: string, record: AgentRecord, flag: ResultStateFlag): string {
	return join(registryDir(agentDir), `${safeRunId(record.runId)}.${safeRunId(record.executionId ?? "legacy")}.${flag}`);
}

/**
 * Parent/UI writes must never replace the execution owner's JSON snapshot.
 * Each flag is an independent monotonic fact scoped to the observed execution,
 * so even a delayed cross-process write cannot mark a newer turn or regress it.
 */
export function markRecordResultState(agentDir: string, record: AgentRecord, flag: ResultStateFlag): void {
	mkdirSync(registryDir(agentDir), { recursive: true, mode: 0o700 });
	atomicWrite(resultStatePath(agentDir, record, flag), "true\n");
}

function applyMarkers(agentDir: string, record: AgentRecord): AgentRecord {
	let result = record;
	if (existsSync(resultStatePath(agentDir, record, "resultsDelivered"))) {
		result = { ...result, resultsDelivered: true };
	}
	const cancellation = readCancellationMarker(agentDir, record.runId);
	if (cancellation) {
		result = {
			...result,
			status: "cancelled",
			activity: "cancelled",
			currentTool: undefined,
			error: cancellation.error ?? result.error ?? "Cancelled",
			finishedAt: cancellation.cancelledAt,
			updatedAt:
				Date.parse(result.updatedAt) > Date.parse(cancellation.cancelledAt)
					? result.updatedAt
					: cancellation.cancelledAt,
		};
	}
	if (existsSync(markerPath(agentDir, record.runId, "closed"))) {
		result = { ...result, pid: undefined, pidStartTime: undefined };
	}
	return result;
}

/**
 * Persist an execution-owner record atomically. Parent/UI flags must use
 * markRecordResultState instead. Result flags, cancellation and close markers are
 * separate monotonic facts, so a stale writer in another process cannot undo
 * these facts by replacing the JSON record later (within the same execution).
 */
export function saveRecord(agentDir: string, record: AgentRecord): AgentRecord {
	const dir = registryDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (record.status === "cancelled") writeCancellationMarker(agentDir, record);
	const saved = applyMarkers(agentDir, record);
	atomicWrite(recordPath(agentDir, record.runId), `${JSON.stringify(saved)}\n`);
	return saved;
}

/** Mark a child PID as permanently cleared before writing its final record. */
export function clearRecordPid(agentDir: string, record: AgentRecord): AgentRecord {
	const dir = registryDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = markerPath(agentDir, record.runId, "closed");
	if (!existsSync(target)) atomicWrite(target, `${new Date().toISOString()}\n`);
	return saveRecord(agentDir, { ...record, pid: undefined, pidStartTime: undefined });
}

export function isRecordCancelled(agentDir: string, runId: string): boolean {
	return existsSync(markerPath(agentDir, runId, "cancelled"));
}

/** Drop the cancellation marker so an accepted message resumes the run as a
 * new execution. Only call when a message was actually accepted for delivery
 * (senders queue behind the concurrency slot first); a concurrent cancel
 * re-creates the marker and still wins. */
export function clearRecordCancellation(agentDir: string, runId: string): void {
	rmSync(markerPath(agentDir, runId, "cancelled"), { force: true });
}

/** Drop the closed marker so a resumed execution can record its new PID.
 * Only call after the previous process is fully reaped; otherwise a late
 * close from the old process would re-create the marker and strip the new PID. */
export function clearRecordClosedMarker(agentDir: string, runId: string): void {
	rmSync(markerPath(agentDir, runId, "closed"), { force: true });
}

function sleepAsync(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(): string {
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Serialize the launch/cancel decision for one run across Pi processes.
 * Async: waiting contenders yield the event loop (5ms naps) instead of
 * spin-blocking it, so TUI input, timers and I/O keep flowing while a lock
 * is held. mkdir remains the atomic arbiter; semantics are unchanged. */
export async function withRecordLock<T>(agentDir: string, runId: string, operation: () => T | Promise<T>): Promise<T> {
	const dir = registryDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, `${safeRunId(runId)}.lock`);
	const token = `${process.pid}-${randomToken()}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			try {
				writeFileSync(join(lock, "owner"), `${token}\n`, { encoding: "utf8", mode: 0o600 });
			} catch (error) {
				rmSync(lock, { recursive: true, force: true });
				throw error;
			}
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			let stale = false;
			try {
				const age = Date.now() - statSync(lock).mtimeMs;
				if (age > LOCK_STALE_MS) stale = true;
				else {
					const owner = Number(readFileSync(join(lock, "owner"), "utf8").trim().split("-", 1)[0]);
					stale = Number.isInteger(owner) && owner > 0 && !isProcessAlive(owner);
				}
			} catch {
				// A creator may be between mkdir and writing owner. Give it time.
			}
			if (stale) {
				const quarantine = `${lock}.stale-${process.pid}-${randomToken()}`;
				try {
					renameSync(lock, quarantine);
					rmSync(quarantine, { recursive: true, force: true });
				} catch {
					// Another contender replaced or removed the stale lock.
				}
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for subagent record lock: ${runId}`);
			await sleepAsync(5);
		}
	}
	try {
		return await operation();
	} finally {
		try {
			if (readFileSync(join(lock, "owner"), "utf8").trim() === token) {
				rmSync(lock, { recursive: true, force: true });
			}
		} catch {
			// A stale-lock recovery may already have moved this lock aside.
		}
	}
}

function isRecord(value: unknown): value is AgentRecord {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<AgentRecord>;
	return (
		item.version === 1 &&
		typeof item.runId === "string" &&
		typeof item.parentRunId === "string" &&
		typeof item.rootRunId === "string" &&
		typeof item.sessionId === "string" &&
		typeof item.name === "string" &&
		typeof item.task === "string" &&
		typeof item.cwd === "string" &&
		typeof item.depth === "number" &&
		typeof item.status === "string" &&
		typeof item.startedAt === "string" &&
		typeof item.updatedAt === "string"
	);
}

export function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function readRecords(agentDir: string): AgentRecord[] {
	const dir = registryDir(agentDir);
	if (!existsSync(dir)) return [];
	const records: AgentRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (!isRecord(value)) continue;
			const marked = applyMarkers(agentDir, value);
			if (!TERMINAL.has(marked.status) && marked.pid && !isProcessAlive(marked.pid)) {
				records.push({
					...marked,
					status: "failed",
					activity: "process exited unexpectedly",
					error: marked.error ?? "Subagent process is no longer running",
				});
			} else {
				records.push(marked);
			}
		} catch {
			// A malformed or half-cleaned record must not break the whole footer.
		}
	}
	return records;
}

/** Mtime-guarded shared record cache (perf).
 *
 * Pure-read hot paths (widget ticks, tool_result, wait polls, delivery) share
 * one scan per registry state instead of re-reading hundreds of files each.
 * Invalidation is exact, not timed: every registry mutation in this codebase
 * (saveRecord, markers, locks, prune deletes) goes through an atomic
 * rename/create/delete inside the runs dir, which bumps its mtime.
 *
 * The returned array is shared: callers must treat it as frozen (filter/map
 * freely, never mutate in place). Write paths (spawn/cancel/resume/publish)
 * keep using readRecords directly.
 */
interface RecordCacheEntry {
	mtimeMs: number;
	records: AgentRecord[];
}
const recordCache = new Map<string, RecordCacheEntry>();
let recordCacheHits = 0;
let recordCacheMisses = 0;

function registryMtimeMs(agentDir: string): number {
	try {
		return statSync(registryDir(agentDir)).mtimeMs;
	} catch {
		return -1;
	}
}

export function getCachedRecords(agentDir: string): AgentRecord[] {
	const mtimeMs = registryMtimeMs(agentDir);
	const hit = recordCache.get(agentDir);
	if (hit && hit.mtimeMs === mtimeMs) {
		recordCacheHits++;
		return refreshLiveness(hit.records);
	}
	recordCacheMisses++;
	const records = readRecords(agentDir);
	recordCache.set(agentDir, { mtimeMs, records });
	return refreshLiveness(records);
}

/** Drop cached scans: one directory, or the whole cache when omitted. */
export function invalidateRecordCache(agentDir?: string): void {
	if (agentDir === undefined) recordCache.clear();
	else recordCache.delete(agentDir);
}

/** Test/observability helper: cache size and hit/miss totals. */
export function recordCacheDebug(): { entries: number; hits: number; misses: number } {
	return { entries: recordCache.size, hits: recordCacheHits, misses: recordCacheMisses };
}

/**
 * Re-derive volatile liveness on every access. File state (records, markers)
 * is covered by the mtime guard, but process death is invisible to mtime:
 * a crashed child must read as failed on the very next access, not only
 * after some unrelated registry write. Kill-probes are ~microseconds and
 * only run for non-terminal records holding a pid (usually none or few).
 * Returns the same reference when nothing flipped.
 */
function refreshLiveness(records: AgentRecord[]): AgentRecord[] {
	let changed = false;
	const out = records.map((record) => {
		if (TERMINAL.has(record.status) || !record.pid || isProcessAlive(record.pid)) return record;
		changed = true;
		return {
			...record,
			status: "failed" as AgentRecord["status"],
			activity: "process exited unexpectedly",
			error: record.error ?? "Subagent process is no longer running",
		};
	});
	return changed ? out : records;
}

export interface PruneOptions {
	/** Delete delivered terminal records older than this. Default 14 days. */
	olderThanMs?: number;
	/** Always keep this many newest candidates. Default 50. */
	keepMinimum?: number;
	/** Reap undelivered terminal runs older than this (0 disables). Default 30 days. */
	undeliveredAfterMs?: number;
	/** Keep this many newest undelivered runs (0 disables the cap). Default 500. */
	undeliveredKeep?: number;
	/** The count cap never reaps runs younger than this. Default 7 days. */
	capGraceMs?: number;
	/** Clock override (tests). Default Date.now(). */
	now?: number;
}

export interface PruneResult {
	pruned: string[];
	kept: number;
}

const DEFAULT_PRUNE_OLDER_THAN_MS = 14 * 24 * 3600 * 1000;
const DEFAULT_PRUNE_KEEP_MINIMUM = 50;
const DEFAULT_PRUNE_UNDELIVERED_AFTER_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_PRUNE_UNDELIVERED_KEEP = 500;
const DEFAULT_PRUNE_CAP_GRACE_MS = 7 * 24 * 3600 * 1000;

/** Known sidecar suffixes prunable alongside a record. Locks (.lock dirs)
 * and in-flight atomic writes (.tmp-) are never touched. */
function isPrunableSidecar(name: string): boolean {
	if (name.includes(".tmp-")) return false;
	return (
		name.endsWith(".cancelled") ||
		name.endsWith(".closed") ||
		name.endsWith(".resultsDelivered") ||
		name.endsWith(".footerDismissed")
	);
}

function recordAgeStamp(record: AgentRecord): number {
	const stamp = Date.parse(record.finishedAt ?? record.updatedAt);
	// Unparseable timestamps sort newest: never prune what we cannot age.
	return Number.isFinite(stamp) ? stamp : Number.MAX_SAFE_INTEGER;
}

/**
 * Bound runs-dir growth: delete delivered terminal records older than
 * `olderThanMs` (keeping the newest `keepMinimum`), and reap undelivered
 * terminal runs older than `undeliveredAfterMs` or beyond the newest
 * `undeliveredKeep` (the cap never takes runs younger than `capGraceMs`).
 * Running children and queued work are never touched. An undelivered result
 * older than the threshold has no live claimant — no pi session lives that
 * long — so reaping it cannot destroy a result anyone will still read.
 * Sidecars of pruned runs and orphan sidecars (markers whose record JSON
 * is already gone) go with them.
 * Best-effort: never throws for I/O races (concurrent child writes).
 */
export function pruneRecords(agentDir: string, options: PruneOptions = {}): PruneResult {
	const olderThanMs = options.olderThanMs ?? DEFAULT_PRUNE_OLDER_THAN_MS;
	const keepMinimum = Math.max(0, options.keepMinimum ?? DEFAULT_PRUNE_KEEP_MINIMUM);
	const undeliveredAfterMs = options.undeliveredAfterMs ?? DEFAULT_PRUNE_UNDELIVERED_AFTER_MS;
	const undeliveredKeep = Math.max(0, options.undeliveredKeep ?? DEFAULT_PRUNE_UNDELIVERED_KEEP);
	const capGraceMs = options.capGraceMs ?? DEFAULT_PRUNE_CAP_GRACE_MS;
	const now = options.now ?? Date.now();
	let records: AgentRecord[];
	try {
		records = getCachedRecords(agentDir);
	} catch {
		return { pruned: [], kept: 0 };
	}
	const candidates = records
		.filter((record) => isTerminalStatus(record.status) && record.resultsDelivered === true)
		.sort((a, b) => recordAgeStamp(a) - recordAgeStamp(b));
	const keepFrom = Math.max(0, candidates.length - keepMinimum);
	const doomed = candidates
		.slice(0, keepFrom)
		.filter((record) => now - recordAgeStamp(record) > olderThanMs);
	const undelivered = records
		.filter((record) => isTerminalStatus(record.status) && record.resultsDelivered !== true)
		.sort((a, b) => recordAgeStamp(a) - recordAgeStamp(b));
	const doomedIds = new Set(doomed.map((record) => record.runId));
	if (undeliveredAfterMs > 0) {
		for (const record of undelivered) {
			if (now - recordAgeStamp(record) > undeliveredAfterMs) doomedIds.add(record.runId);
		}
	}
	if (undeliveredKeep > 0 && undelivered.length > undeliveredKeep) {
		for (const record of undelivered.slice(0, undelivered.length - undeliveredKeep)) {
			if (now - recordAgeStamp(record) > capGraceMs) doomedIds.add(record.runId);
		}
	}
	const doomedAll = records.filter((record) => doomedIds.has(record.runId));
	const dir = registryDir(agentDir);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return { pruned: [], kept: candidates.length + undelivered.length };
	}
	const liveJson = new Set(
		entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)),
	);
	const removeFile = (name: string) => {
		try {
			const target = join(dir, name);
		if (statSync(target).isDirectory()) return;
		rmSync(target, { force: true });
		} catch {
			// Concurrent writer (child settle, lock recovery) won the race.
		}
	};
	for (const record of doomedAll) {
		const prefix = `${safeRunId(record.runId)}.`;
		for (const name of entries) {
			if (name === `${prefix.slice(0, -1)}.json` || (name.startsWith(prefix) && isPrunableSidecar(name))) {
				removeFile(name);
			liveJson.delete(name.slice(0, -5));
		}
		}
	}
	// Orphan sweep: sidecars whose record JSON is absent (crash leftovers).
	for (const name of entries) {
		if (!isPrunableSidecar(name)) continue;
		const owner = name.endsWith(".resultsDelivered")
			? name.split(".").slice(0, -2).join(".")
			: name.split(".").slice(0, -1).join(".");
		if (!liveJson.has(owner)) removeFile(name);
	}
	if (doomedAll.length > 0) invalidateRecordCache(agentDir);
	const retained = candidates.length + undelivered.length - doomedAll.length;
	return { pruned: doomedAll.map((record) => record.runId), kept: retained };
}

export function descendantsOf(records: readonly AgentRecord[], parentRunId: string): AgentRecord[] {
	const children = new Map<string, AgentRecord[]>();
	for (const record of records) {
		const list = children.get(record.parentRunId) ?? [];
		list.push(record);
		children.set(record.parentRunId, list);
	}
	for (const list of children.values()) {
		list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	}
	const result: AgentRecord[] = [];
	const visit = (parent: string) => {
		for (const child of children.get(parent) ?? []) {
			result.push(child);
			visit(child.runId);
		}
	};
	visit(parentRunId);
	return result;
}

/** Resolve exact identities first, then an unambiguous run-ID prefix. */
export function resolveAgentRecord(records: readonly AgentRecord[], target: string): AgentRecord {
	const value = target.trim();
	const exact = value ? records.filter((record) => record.runId === value || record.sessionId === value || record.name === value) : [];
	const matches = exact.length > 0 ? exact : value ? records.filter((record) => record.runId.startsWith(value)) : [];
	if (matches.length === 0) throw new Error(`No subagent matches "${value}".`);
	if (matches.length > 1) {
		throw new Error(`"${value}" is ambiguous; matches: ${matches.map((record) => `${record.name} (${record.runId})`).join(", ")}`);
	}
	return matches[0]!;
}

export function relativeDepths(records: readonly AgentRecord[], parentRunId: string): Map<string, number> {
	const depths = new Map<string, number>();
	const byParent = new Map<string, AgentRecord[]>();
	for (const record of records) {
		const list = byParent.get(record.parentRunId) ?? [];
		list.push(record);
		byParent.set(record.parentRunId, list);
	}
	const visit = (parent: string, depth: number) => {
		for (const child of byParent.get(parent) ?? []) {
			depths.set(child.runId, depth);
			visit(child.runId, depth + 1);
		}
	};
	visit(parentRunId, 0);
	return depths;
}
