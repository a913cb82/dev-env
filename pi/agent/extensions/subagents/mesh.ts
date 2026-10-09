// Socket mesh: one Unix socket per live session, owned by the extension.
// Any session sends text (steer/followUp) and settle notifications directly
// to any other session by runId. Node builtins only.
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdirSync, unlinkSync } from "node:fs";

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

function sanitizeRunId(runId: string): string {
	return runId.replace(/[^A-Za-z0-9_-]/g, "_");
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
						server.close(() => { removeFile(socketPath); done(); });
						// close() without connections still calls back; force unlink either way.
						setImmediate(() => { removeFile(socketPath); });
					});
				},
			});
		});
	});
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
