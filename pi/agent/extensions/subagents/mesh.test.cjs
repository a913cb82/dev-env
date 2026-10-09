// Tests for the subagent socket mesh (mesh.ts). No dependencies, no API calls.
// Run: node mesh.test.cjs
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { execSync } = require("node:child_process");
function findPiRoot() {
	const bin = execSync("command -v pi", { encoding: "utf8" }).trim();
	const real = fs.realpathSync(bin);
	// <root>/dist/bundle/cli.js
	return path.resolve(path.dirname(real), "..", "..");
}
const PI = process.env.PI_ROOT || findPiRoot();
const { createJiti } = require(path.join(PI, "node_modules", "jiti"));

const HERE = __dirname;
const jiti = createJiti(__filename, { interopDefault: true, fsCache: false, moduleCache: false });

let failures = 0;
function check(name, cond, extra) {
	if (cond) console.log(`ok - ${name}`);
	else {
		failures++;
		console.error(`FAIL - ${name}${extra !== undefined ? `: ${extra}` : ""}`);
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
	const mesh = await jiti.import(path.join(HERE, "mesh.ts"));

	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-test-"));
	const socketDir = path.join(sandbox, "sockets");
	const allowAll = () => true;
	const waitServers = [];

	// --- lifecycle: two servers bind distinct runIds ---
	const receivedA = [];
	const receivedB = [];
	const serverA = await mesh.startMeshServer({ socketDir, runId: "run-aaa", onMessage: (msg) => receivedA.push(msg) });
	const serverB = await mesh.startMeshServer({
		socketDir, runId: "run-bbb", onMessage: (msg) => receivedB.push(msg), isKnownRunId: allowAll,
	});
	check("socket files exist per runId", fs.existsSync(serverA.socketPath) && fs.existsSync(serverB.socketPath));
	check("socket paths differ per runId", serverA.socketPath !== serverB.socketPath);

	// --- direct delivery both directions ---
	await mesh.sendMeshMessage({ socketDir, toRunId: "run-bbb", fromRunId: "run-aaa", type: "followUp", payload: { text: "hello b" } });
	await mesh.sendMeshMessage({ socketDir, toRunId: "run-aaa", fromRunId: "run-bbb", type: "steer", payload: { text: "hello a" } });
	check("b receives followUp from a", receivedB.length === 1 && receivedB[0].type === "followUp" && receivedB[0].payload.text === "hello b" && receivedB[0].from === "run-aaa");
	check("a receives steer from b", receivedA.length === 1 && receivedA[0].type === "steer" && receivedA[0].payload.text === "hello a");

	// --- back-to-back frames stay separate and ordered (per-sender FIFO) ---
	receivedB.length = 0;
	const burst = [];
	for (let i = 0; i < 20; i++) {
		burst.push(mesh.sendMeshMessage({ socketDir, toRunId: "run-bbb", fromRunId: "run-aaa", type: "followUp", seq: i, payload: { text: `msg-${i}` } }));
	}
	await Promise.all(burst);
	check("20 rapid messages all arrive", receivedB.length === 20, receivedB.length);
	check("rapid messages arrive in order", receivedB.every((msg, i) => msg.payload.text === `msg-${i}` && msg.seq === i));

	// --- partial writes reassemble (raw socket, one byte at a time) ---
	receivedB.length = 0;
	const net = require("node:net");
	const frame = `${JSON.stringify({ v: 1, type: "steer", from: "run-aaa", to: "run-bbb", id: "partial-1", seq: 999, payload: { text: "partial" } })}\n`;
	await new Promise((resolve, reject) => {
		const sock = net.createConnection(serverB.socketPath, () => {
			let i = 0;
			const step = () => {
				if (i >= frame.length) { sock.end(); resolve(); return; }
				sock.write(frame[i]);
				i++;
				setImmediate(step);
			};
			step();
		});
		sock.on("error", reject);
	});
	await sleep(200);
	check("byte-at-a-time frame reassembles", receivedB.length === 1 && receivedB[0].payload.text === "partial", JSON.stringify(receivedB));

	// --- unknown sender dropped ---
	receivedB.length = 0;
	const strictServer = await mesh.startMeshServer({
		socketDir, runId: "run-strict", onMessage: () => { throw new Error("must not deliver unknown sender"); },
		isKnownRunId: (id) => id === "run-aaa",
	});
	let delivered = false;
	try {
		await mesh.sendMeshMessage({ socketDir, toRunId: "run-strict", fromRunId: "run-evil", type: "steer", payload: { text: "x" } });
		delivered = true;
	} catch { delivered = false; }
	check("unknown sender rejected", !delivered);
	await strictServer.close();

	// --- ack timeout surfaces an error ---
	const blackHole = await mesh.startMeshServer({ socketDir, runId: "run-hole", autoAck: false, onMessage: () => {} });
	let timedOut = false;
	try {
		await mesh.sendMeshMessage({ socketDir, toRunId: "run-hole", fromRunId: "run-aaa", type: "steer", payload: { text: "x" }, timeoutMs: 200 });
	} catch (error) {
		timedOut = /timed.?out/i.test(String(error && error.message));
	}
	check("missing ack times out", timedOut);
	await blackHole.close();

	// --- oversize line rejected, server survives ---
	const small = await mesh.startMeshServer({ socketDir, runId: "run-small", maxLineChars: 256, onMessage: (msg) => receivedA.push(msg) });
	receivedA.length = 0;
	let oversizeRejected = false;
	try {
		await mesh.sendMeshMessage({ socketDir, toRunId: "run-small", fromRunId: "run-aaa", type: "steer", payload: { text: "y".repeat(1024) }, maxLineChars: 256 });
	} catch (error) {
		oversizeRejected = /size|large|limit/i.test(String(error && error.message));
	}
	check("oversize send rejected client-side", oversizeRejected);
	await mesh.sendMeshMessage({ socketDir, toRunId: "run-small", fromRunId: "run-aaa", type: "steer", payload: { text: "small ok" } });
	await sleep(100);
	check("server survives oversize and serves next message", receivedA.some((msg) => msg.payload && msg.payload.text === "small ok"));
	await small.close();

	// --- waitForMeshSocket: resolves when the server appears ---
	const waitPath = mesh.meshSocketPath(socketDir, "run-wait");
	check("socket absent before bind", !fs.existsSync(waitPath));
	setTimeout(() => {
		mesh.startMeshServer({ socketDir, runId: "run-wait", onMessage: () => {} }).then((server) => waitServers.push(server));
	}, 100);
	const waitStarted = Date.now();
	await mesh.waitForMeshSocket(socketDir, "run-wait", { timeoutMs: 5000 });
	check("wait resolves once the server appears", Date.now() - waitStarted >= 50 && fs.existsSync(waitPath), `${Date.now() - waitStarted}ms`);
	let waitTimedOut = false;
	try {
		await mesh.waitForMeshSocket(socketDir, "run-never", { timeoutMs: 150, intervalMs: 25 });
	} catch (error) {
		waitTimedOut = /offline|timed?\s?out/i.test(String(error && error.message));
	}
	check("wait rejects when no server appears", waitTimedOut);
	const aborter = new AbortController();
	setTimeout(() => aborter.abort(), 50);
	let waitAborted = false;
	try {
		await mesh.waitForMeshSocket(socketDir, "run-never", { timeoutMs: 5000, signal: aborter.signal });
	} catch (error) {
		waitAborted = /abort/i.test(String(error && error.message));
	}
	check("wait aborts on signal", waitAborted);

	// --- offline target: refused connect unlinks stale file and throws ---
	await serverB.close();
	check("close removes socket file", !fs.existsSync(serverB.socketPath));
	fs.writeFileSync(serverB.socketPath, "stale");
	let offlineError = "";
	try {
		await mesh.sendMeshMessage({ socketDir, toRunId: "run-bbb", fromRunId: "run-aaa", type: "steer", payload: { text: "x" } });
	} catch (error) {
		offlineError = String(error && error.message);
	}
	check("offline target throws", /offline|refused|enoent/i.test(offlineError), offlineError);
	check("stale socket file cleaned", !fs.existsSync(serverB.socketPath));

	// --- close drops a stuck connection instead of stalling ---
	const netStuck = require("node:net");
	await new Promise((resolve, reject) => {
		const hanging = netStuck.createConnection(serverA.socketPath);
		hanging.on("error", () => {});
		hanging.on("connect", () => resolve());
		hanging.on("close", () => {});
	});
	const hangingCloseStarted = Date.now();
	await serverA.close();
	check("close resolves with an idle connection open", Date.now() - hangingCloseStarted < 2000, `${Date.now() - hangingCloseStarted}ms`);
	// --- rebind after close serves fresh traffic exactly once ---
	const reReceived = [];
	const reServer1 = await mesh.startMeshServer({ socketDir, runId: "run-re", onMessage: (msg) => reReceived.push(msg) });
	await reServer1.close();
	const reServer2 = await mesh.startMeshServer({ socketDir, runId: "run-re", onMessage: (msg) => reReceived.push(msg) });
	await mesh.sendMeshMessage({ socketDir, toRunId: "run-re", fromRunId: "run-aaa", type: "steer", payload: { text: "rebound" } });
	await sleep(100);
	check("rebound server receives exactly once", reReceived.length === 1 && reReceived[0].payload.text === "rebound", JSON.stringify(reReceived));
	await reServer2.close();
	for (const server of waitServers) await server.close();
	// --- close is idempotent, remaining server still works ---
	await serverA.close();
	await serverA.close();
	check("double close safe", true);

	console.log(failures === 0 ? "\nAll mesh tests passed." : `\n${failures} mesh test(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
	console.error(`HARNESS ERROR: ${error && error.stack ? error.stack : error}`);
	process.exit(1);
});
