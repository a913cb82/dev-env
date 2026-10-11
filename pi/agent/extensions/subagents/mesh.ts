// Socket mesh: one Unix socket per live session, owned by the extension.
// Any session sends text (steer/followUp) and settle notifications directly
// to any other session by runId. Node builtins only.
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MESH_PROTOCOL_VERSION = 1;
export const DEFAULT_MESH_MAX_LINE_CHARS = 64 * 1024 * 1024;
export const DEFAULT_MESH_ACK_TIMEOUT_MS = 5000;

export type MeshMessageType = "steer" | "followUp" | "settled";

export interface MeshEnvelope {
	v: 1;
	type: MeshMessageType;
	from: string;
	to: string;
	id: string;
	seq: number;
	payload: Record<string, unknown>;
}

export interface MeshServerOptions {
	socketDir: string;
	runId: string;
	maxLineChars?: number;
	/** When false the server parses but never acks (tests ack timeouts). Default true. */
	autoAck?: boolean;
	/** Reject frames from unknown senders. Default accepts all. */
	isKnownRunId?: (runId: string) => boolean;
	onMessage: (message: MeshEnvelope) => void;
}

export interface MeshServer {
	runId: string;
	socketPath: string;
	close: () => Promise<void>;
}

export interface MeshSendOptions {
	socketDir: string;
	toRunId: string;
	fromRunId: string;
	type: MeshMessageType;
	seq?: number;
	payload: Record<string, unknown>;
	timeoutMs?: number;
	maxLineChars?: number;
}

let messageCounter = 0;

let ownerTokenCounter = 0;

export function sanitizeRunId(runId: string): string {
	return runId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Probe whether anything listens on a socket path (fast fail for dead files). */
function isSocketConnectable(socketPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (value: boolean) => {
			if (done) return;
			done = true;
			resolve(value);
		};
		const timer = setTimeout(() => {
			finish(false);
			try { socket.destroy(); } catch { /* already gone */ }
		}, timeoutMs);
		const socket = createConnection(socketPath);
		socket.on("connect", () => { clearTimeout(timer); finish(true); try { socket.destroy(); } catch { /* closing */ } });
		socket.on("error", () => { clearTimeout(timer); finish(false); });
	});
}

/** Remove stale socket files: unprotected (no live run claims the name)
 * and unconnectable (nothing listens). Never touches a connectable socket
 * or a live-claimed name. Returns the removed file names. */
export async function sweepStaleSockets(socketDir: string, isProtected: (socketFile: string) => boolean): Promise<string[]> {
	let entries: string[];
	try {
		entries = readdirSync(socketDir);
	} catch {
		return [];
	}
	const stale = entries.filter((entry) => entry.endsWith(".sock") && !entry.endsWith(".sock.owner") && !isProtected(entry));
	const removed: string[] = [];
	const dropOwner = (entry: string) => {
		try { rmSync(join(socketDir, `${entry}.owner`), { force: true }); } catch { /* already gone */ }
	};
	await Promise.all(stale.map(async (entry) => {
		const target = join(socketDir, entry);
		if (await isSocketConnectable(target, 300)) return;
		try {
			rmSync(target, { force: true });
			dropOwner(entry);
			removed.push(entry);
		} catch { /* raced unlink */ }
	}));
	// Owner sidecars whose socket is gone (crash leftovers) go too; a future
	// bind overwrites the token, so nothing valid is lost.
	for (const entry of entries) {
		if (!entry.endsWith(".sock.owner")) continue;
		const socketFile = entry.slice(0, -".owner".length);
		if (removed.includes(socketFile)) continue;
		try {
			if (!existsSync(join(socketDir, socketFile))) rmSync(join(socketDir, entry), { force: true });
		} catch { /* raced */ }
	}
	return removed;
}

export function meshSocketPath(socketDir: string, runId: string): string {
	return `${socketDir}/${sanitizeRunId(runId)}.sock`;
}

export function meshSocketDir(agentDir: string): string {
	return `${agentDir}/subagents/sockets`;
}

export interface MeshWaitOptions {
	timeoutMs?: number;
	intervalMs?: number;
	signal?: AbortSignal;
}

/** Resolve once the target's socket accepts connections. Rejects on timeout or abort. */
export function waitForMeshSocket(socketDir: string, runId: string, options: MeshWaitOptions = {}): Promise<void> {
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_MESH_ACK_TIMEOUT_MS);
	const intervalMs = Math.max(1, options.intervalMs ?? 50);
	const socketPath = meshSocketPath(socketDir, runId);
	return new Promise<void>((resolve, reject) => {
		let finished = false;
		const finish = (error?: Error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
		clearInterval(poller);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => finish(new Error(`timed out waiting for subagent "${runId}" socket`)), timeoutMs);
		const tryConnect = () => {
			if (finished) return;
			const socket = createConnection(socketPath);
			socket.on("connect", () => { socket.destroy(); finish(); });
			socket.on("error", () => { socket.destroy(); });
		};
		const poller = setInterval(tryConnect, intervalMs);
		if (options.signal) {
			if (options.signal.aborted) finish(new Error("wait for subagent socket was aborted"));
			else options.signal.addEventListener("abort", () => finish(new Error("wait for subagent socket was aborted")), { once: true });
		}
		tryConnect();
	});
}

function removeFile(path: string): void {
	try { unlinkSync(path); } catch { /* absent or raced */ }
}

function isValidEnvelope(value: unknown): value is MeshEnvelope {
	if (!value || typeof value !== "object") return false;
	const frame = value as Record<string, unknown>;
	return (
		frame.v === MESH_PROTOCOL_VERSION &&
		(frame.type === "steer" || frame.type === "followUp" || frame.type === "settled") &&
		typeof frame.from === "string" && frame.from.length > 0 &&
		typeof frame.to === "string" && frame.to.length > 0 &&
		typeof frame.id === "string" && frame.id.length > 0 &&
		typeof frame.seq === "number" &&
		!!frame.payload && typeof frame.payload === "object"
	);
}

export function startMeshServer(options: MeshServerOptions): Promise<MeshServer> {
	const maxLineChars = Math.max(1, options.maxLineChars ?? DEFAULT_MESH_MAX_LINE_CHARS);
	const autoAck = options.autoAck ?? true;
	const socketPath = meshSocketPath(options.socketDir, options.runId);
	mkdirSync(options.socketDir, { recursive: true, mode: 0o700 });
	// A previous crash may leave a stale file behind; an unlink before bind
	// reclaims the name. A live peer's file is a real socket: unlinking it
	// only removes the name, established connections are unaffected.
	removeFile(socketPath);

	const openSockets = new Set<Socket>();
	const server: Server = createServer((socket: Socket) => {
		openSockets.add(socket);
		socket.on("close", () => { openSockets.delete(socket); });
		let buffer = "";
		socket.setEncoding("utf8");
		const fail = (message: string, id?: string) => {
			try {
				if (id) socket.write(`${JSON.stringify({ v: MESH_PROTOCOL_VERSION, type: "error", id, message })}\n`);
			} catch { /* closing */ }
			socket.destroy();
		};
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > maxLineChars + 1) {
				fail(`frame exceeds ${maxLineChars} character limit`);
				buffer = "";
				return;
			}
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.length > maxLineChars) {
					fail(`frame exceeds ${maxLineChars} character limit`);
					buffer = "";
					return;
				}
				if (line.length > 0) {
					let frame: unknown;
					try {
						frame = JSON.parse(line);
					} catch {
						fail("malformed frame");
						buffer = "";
						return;
					}
					if (!isValidEnvelope(frame)) {
						fail("malformed frame", (frame as { id?: unknown })?.id !== undefined ? String((frame as { id?: unknown }).id) : undefined);
						buffer = "";
						return;
					}
					if (frame.to !== options.runId) {
						// Misdelivered: drop without ack so the sender times out
						// instead of believing the wrong peer received it.
					} else if (options.isKnownRunId && !options.isKnownRunId(frame.from)) {
						fail(`unknown sender "${frame.from}"`, frame.id);
						buffer = "";
						return;
					} else {
						if (autoAck) {
							try { socket.write(`${JSON.stringify({ v: MESH_PROTOCOL_VERSION, type: "ack", id: frame.id })}\n`); } catch { /* closing */ }
						}
						try { options.onMessage(frame); } catch { /* receiver errors must not kill the server */ }
					}
				}
				newline = buffer.indexOf("\n");
			}
		});
		socket.on("error", () => { /* per-connection noise */ });
	});

	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			let closed = false;
			// Owner token sidecar: `<socket>.owner` holds this bind's unique token.
			// close() unlinks the socket only while the token still matches, so
			// a rebind (same copy, reloaded copy, or racing predecessor) is
			// never unlinked by the previous owner's late close. Inode
			// comparison cannot do this: the kernel reuses freed inode
			// numbers, so a rebound file can test identical to the deleted one.
			const ownerToken = `${process.pid}:${++ownerTokenCounter}:${Date.now()}`;
			const ownerPath = `${socketPath}.owner`;
			try {
				writeFileSync(ownerPath, `${ownerToken}\n`, { encoding: "utf8", mode: 0o600 });
			} catch {
				// Best effort: without a token the close below stays conservative.
			}
			// Kernel-stamped creation time of the file this bind created. The
			// token alone has a split-write hole (socket exists before the
			// token lands); the birthtime alone has a coarse-clock hole on
			// exotic filesystems. Together they are sound: a rebound file is
			// always strictly newer, and a token always differs.
			let boundBirthMs: number | undefined;
			try {
				boundBirthMs = statSync(socketPath).birthtimeMs;
			} catch {
				// Vanished already; token-only check below.
			}
			resolve({
				runId: options.runId,
				socketPath,
				close: () => {
					if (closed) return Promise.resolve();
					closed = true;
					// Drop in-flight connections first: server.close() waits for
					// open sockets, and a stuck client must never stall teardown.
					for (const open of [...openSockets]) {
						try { open.destroy(); } catch { /* already gone */ }
					}
					return new Promise<void>((done) => {
						// server.close always calls back (even with zero open
						// connections), so this check strictly precedes done().
						// A rebound token means a newer owner holds the name:
						// unlinking would deafen it (ghost bind).
						server.close(() => {
							try {
								const tokenMatch = readFileSync(ownerPath, "utf8").trim() === ownerToken;
								let birthMatch = boundBirthMs === undefined;
								if (!birthMatch) {
									try {
										birthMatch = statSync(socketPath).birthtimeMs === boundBirthMs;
									} catch {
										birthMatch = false;
									}
								}
								if (tokenMatch && birthMatch) {
									removeFile(socketPath);
									removeFile(ownerPath);
								}
							} catch {
								// Absent or unreadable: leave it (the sweep reaps strays).
							}
							done();
						});
					});
				},
			});
		});
	});
}

export interface MeshDeliverOptions {
	socketDir: string;
	toRunId: string;
	fromRunId: string;
	/** steer redirects the target turn; followUp queues behind it. */
	type: "steer" | "followUp";
	text: string;
	/** How long to wait for a starting target's socket before giving up. */
	waitMs?: number;
	signal?: AbortSignal;
	maxLineChars?: number;
	timeoutMs?: number;
}

/** Direct socket-mesh delivery with one wait-and-retry for a starting peer.
 * Resolves when the peer acks; rejects when it stays offline (or refuses).
 * Recordless by design, so the root session itself is addressable even
 * though it has no subagent record. */
export async function deliverMeshMessage(options: MeshDeliverOptions): Promise<void> {
	const send = () =>
		sendMeshMessage({
			socketDir: options.socketDir,
			toRunId: options.toRunId,
			fromRunId: options.fromRunId,
			type: options.type,
			payload: { text: options.text },
			...(options.maxLineChars !== undefined ? { maxLineChars: options.maxLineChars } : {}),
			...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		});
	try {
		await send();
		return;
	} catch {
		// The target may be starting: wait for its socket, then retry once.
	}
	await waitForMeshSocket(options.socketDir, options.toRunId, { timeoutMs: options.waitMs ?? 5000, signal: options.signal });
	await send();
}

export function sendMeshMessage(options: MeshSendOptions): Promise<void> {
	const maxLineChars = Math.max(1, options.maxLineChars ?? DEFAULT_MESH_MAX_LINE_CHARS);
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_MESH_ACK_TIMEOUT_MS);
	const socketPath = meshSocketPath(options.socketDir, options.toRunId);
	const frame = JSON.stringify({
		v: MESH_PROTOCOL_VERSION,
		type: options.type,
		from: options.fromRunId,
		to: options.toRunId,
		id: `msg-${process.pid}-${++messageCounter}`,
		seq: options.seq ?? 0,
		payload: options.payload,
	});
	if (frame.length > maxLineChars) {
		return Promise.reject(new Error(`message exceeds ${maxLineChars} character limit (${frame.length} characters)`));
	}
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve();
		};
		const socket = createConnection(socketPath);
		socket.setEncoding("utf8");
		let buffer = "";
		const timer = setTimeout(() => finish(new Error(`timed out waiting for ack from "${options.toRunId}" after ${timeoutMs}ms`)), timeoutMs);
		socket.on("connect", () => { socket.write(`${frame}\n`); });
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.length > 0) {
					try {
						const reply = JSON.parse(line) as { type?: unknown; id?: unknown; message?: unknown };
						if (reply.type === "ack") finish();
						else if (reply.type === "error") finish(new Error(String(reply.message ?? "peer rejected the message")));
					} catch { /* ignore noise, keep waiting for ack */ }
				}
				newline = buffer.indexOf("\n");
			}
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
				// The peer is gone; its file (if any) is stale. Reclaim it so
				// the next bind/connect pair starts clean.
				removeFile(socketPath);
				finish(new Error(`subagent "${options.toRunId}" is offline`));
			} else {
				finish(error);
			}
		});
	});
}
