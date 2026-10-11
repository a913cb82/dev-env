// Tests for self-reporting orphan completion (self-report.ts): a subagent
// whose parent already settled finalizes its own record at agent_before_settle
// and wakes its parent with the result. No dependencies, no API calls.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

function findPiRoot() {
	const bin = execSync("command -v pi", { encoding: "utf8" }).trim();
	const real = fs.realpathSync(bin);
	return path.resolve(path.dirname(real), "..", "..");
}
const PI = process.env.PI_ROOT || findPiRoot();
const PIN = path.join(PI, "node_modules");
const { createJiti } = require(path.join(PIN, "jiti"));

const HERE = __dirname;
const jiti = createJiti(__filename, {
	interopDefault: true,
	fsCache: false,
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(PI, "dist", "bundle", "index.js"),
		"@earendil-works/pi-tui": path.join(PIN, "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: require.resolve("typebox", { paths: [PI] }),
	},
});

let failures = 0;
function check(name, cond, extra) {
	if (cond) console.log(`ok - ${name}`);
	else {
		failures++;
		console.error(`FAIL - ${name}${extra !== undefined ? `: ${extra}` : ""}`);
	}
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
let counter = 0;
function makeRecord(overrides) {
	counter++;
	return {
		version: 1,
		runId: `run-${counter}`,
		parentRunId: "root",
		rootRunId: "root",
		sessionId: `session-${counter}`,
		name: `agent-${counter}`,
		task: "test task",
		cwd: "/tmp",
		model: "test/model",
		thinking: "off",
		depth: 1,
		maxDepth: 2,
		status: "running",
		usage: { ...usage },
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}
function assistantMessage(text, msgUsage) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		...(msgUsage ? { usage: msgUsage } : {}),
	};
}

(async () => {
	const self = await jiti.import(path.join(HERE, "self-report.ts"));
	const registry = await jiti.import(path.join(HERE, "registry.ts"));

	// --- summarizeSettleEvent: outcome, final text, summed usage ---
	const doneEvent = {
		outcome: "completed",
		context: {
			pendingMessages: [],
			contextMessages: [
				{ role: "user", content: [{ type: "text", text: "do it" }] },
				assistantMessage("first", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } }),
				assistantMessage("final answer", { input: 20, output: 10, cacheRead: 2, cacheWrite: 1, totalTokens: 30, cost: { total: 0.002 } }),
			],
		},
	};
	const done = self.summarizeSettleEvent(doneEvent);
	check("completed outcome maps", done.status === "completed", done.status);
	check("final text is the last assistant message", done.finalText === "final answer", done.finalText);
	check("usage sums every assistant turn", done.usage.input === 30 && done.usage.output === 15 && done.usage.cacheRead === 2 && done.usage.totalTokens === 45, JSON.stringify(done.usage));
	check("cost sums object totals", Math.abs(done.usage.cost - 0.003) < 1e-12, String(done.usage.cost));
	check("aborted maps to cancelled", self.summarizeSettleEvent({ outcome: "aborted", context: { contextMessages: [] } }).status === "cancelled");
	check("error maps to failed", self.summarizeSettleEvent({ outcome: "error", context: { contextMessages: [] } }).status === "failed");
	check("missing text falls back", self.summarizeSettleEvent({ outcome: "completed", context: { contextMessages: [{ role: "user", content: [] }] } }).finalText === "(no output)");
	check("malformed event survives", self.summarizeSettleEvent({}).status === "completed" && self.summarizeSettleEvent({}).usage.input === 0);

	// --- finalizeOwnRun: upsert own completion, pid cleared ---
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "self-report-"));
	registry.saveRecord(dir, makeRecord({ runId: "g1", parentRunId: "p1", status: "running", pid: 123456 }));
	const written = self.finalizeOwnRun(dir, "g1", { status: "completed", finalText: "grand done", usage: { ...usage, input: 7 } });
	const g1 = registry.readRecords(dir).find((r) => r.runId === "g1");
	check("finalize writes completion", written === "written" && g1?.status === "completed" && g1?.latestText === "grand done" && g1?.usage.input === 7,
		JSON.stringify({ written, status: g1?.status, text: g1?.latestText }));
	check("finalize clears the exiting pid", g1?.pid === undefined, String(g1?.pid));
	check("finalize stamps finish", typeof g1?.finishedAt === "string", g1?.finishedAt);
	registry.saveRecord(dir, makeRecord({ runId: "done1", parentRunId: "p1", status: "completed", latestText: "old" }));
	check("finalize overwrites with the latest settle", self.finalizeOwnRun(dir, "done1", { status: "completed", finalText: "newer", usage: { ...usage } }) === "written"
		&& registry.readRecords(dir).find((r) => r.runId === "done1")?.latestText === "newer");
	check("finalize missing is missing", self.finalizeOwnRun(dir, "nope", { status: "completed", finalText: "x", usage: { ...usage } }) === "missing");

	// --- shouldSkipOwnerWrite: stale monitors must not clobber self-reports ---
	const mem = makeRecord({ runId: "w1", status: "thinking", updatedAt: "2026-01-01T00:00:00.000Z" });
	check("owner proceeds on untouched record", self.shouldSkipOwnerWrite({ ...mem }, mem) === false);
	check("owner proceeds on own terminal settle", self.shouldSkipOwnerWrite({ ...mem, status: "completed" }, mem) === false);
	check("owner skips foreign write", self.shouldSkipOwnerWrite({ ...mem, updatedAt: "2026-03-01T00:00:00.000Z" }, mem) === true);

	// --- maybeWakeParent: resurrect a settled parent, leave live ones alone ---
	const wakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-wake-"));
	registry.saveRecord(wakeDir, makeRecord({ runId: "wp", parentRunId: "root", name: "wake-parent", status: "completed", latestText: "parent done" }));
	registry.saveRecord(wakeDir, makeRecord({ runId: "wg", parentRunId: "wp", name: "wake-grand", status: "completed", latestText: "grand done" }));
	const spawn = await jiti.import(path.join(HERE, "spawn-agent.ts"));
	process.env.PI_SUBAGENT_COMMAND = path.join(HERE, "fake-pi.cjs");
	const wakeCtx = () => ({
		agentDir: wakeDir,
		parentRunId: "root",
		rootRunId: "root",
		currentDepth: 2,
		settings: { maxDepth: 2, maxConcurrency: -1 },
		parentModel: "fake/parent",
		parentThinking: "off",
		parentTools: ["read"],
		scopedModels: [],
		parentCwd: fs.realpathSync(os.tmpdir()),
		projectTrusted: false,
		signal: new AbortController().signal,
	});
	const woken = await self.maybeWakeParent({ agentDir: wakeDir, ownRunId: "wg", canLaunch: () => true, buildContext: wakeCtx });
	check("settled parent wakes", woken === "resumed", woken);
	let wokenRecord;
	for (let i = 0; i < 200; i++) {
		wokenRecord = registry.readRecords(wakeDir).find((r) => r.runId === "wp");
		if (wokenRecord && wokenRecord.status === "completed" && (wokenRecord.latestText ?? "").includes("fake done")) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check("woken parent runs its notification turn", wokenRecord?.status === "completed" && (wokenRecord?.latestText ?? "").includes("fake done"),
		JSON.stringify({ status: wokenRecord?.status, text: wokenRecord?.latestText }));
	check("wake keeps the original parent", wokenRecord?.parentRunId === "root", wokenRecord?.parentRunId);
	registry.saveRecord(wakeDir, makeRecord({ runId: "livep", parentRunId: "root", status: "running" }));
	registry.saveRecord(wakeDir, makeRecord({ runId: "liveg", parentRunId: "livep", status: "completed" }));
	check("live parent never wakes", (await self.maybeWakeParent({ agentDir: wakeDir, ownRunId: "liveg", canLaunch: () => true, buildContext: wakeCtx })) === "parent-live");
	// A settled-but-lingering parent owns its turn: the owner path delivers,
	// so waking it too would run two writers on one session (live duplicate).
	registry.saveRecord(wakeDir, makeRecord({ runId: "lingerp", parentRunId: "root", status: "completed", pid: process.pid }));
	registry.saveRecord(wakeDir, makeRecord({ runId: "lingerg", parentRunId: "lingerp", status: "completed" }));
	let resumeAttempted = false;
	const lingerResult = await self.maybeWakeParent({
		agentDir: wakeDir, ownRunId: "lingerg", canLaunch: () => true,
		buildContext: () => { resumeAttempted = true; return wakeCtx(); },
	});
	check("settled-but-lingering parent never wakes", lingerResult === "parent-live" && resumeAttempted === false, lingerResult);
	check("missing own skips", (await self.maybeWakeParent({ agentDir: wakeDir, ownRunId: "orphan-g", canLaunch: () => true, buildContext: wakeCtx })) === "missing");
	registry.saveRecord(wakeDir, makeRecord({ runId: "nop-g", parentRunId: "ghost", status: "completed" }));
	check("missing parent skips", (await self.maybeWakeParent({ agentDir: wakeDir, ownRunId: "nop-g", canLaunch: () => true, buildContext: wakeCtx })) === "no-parent");
	registry.saveRecord(wakeDir, makeRecord({ runId: "fullp", parentRunId: "root", status: "completed" }));
	registry.saveRecord(wakeDir, makeRecord({ runId: "fullg", parentRunId: "fullp", status: "completed" }));
	check("full gate skips the wake", (await self.maybeWakeParent({ agentDir: wakeDir, ownRunId: "fullg", canLaunch: () => false, buildContext: wakeCtx })) === "gate-full"
		&& registry.readRecords(wakeDir).find((r) => r.runId === "fullp")?.status === "completed");
	delete process.env.PI_SUBAGENT_COMMAND;

	console.log(failures === 0 ? "\nAll self-report tests passed." : `\n${failures} self-report test(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
	console.error(`HARNESS ERROR: ${error && error.stack ? error.stack : error}`);
	process.exit(1);
});
