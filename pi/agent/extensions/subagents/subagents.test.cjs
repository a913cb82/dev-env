// Regression tests for the subagents extension. No dependencies, no API calls.
// Run: node subagents.test.cjs
const { execSync, execFileSync, spawn: spawnProcess } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Install before jiti imports node:fs, which captures named function exports.
let failMarkerWritesFor;
let injectedMarkerFailures = 0;
const realRenameSync = fs.renameSync;
fs.renameSync = (from, to) => {
	if (failMarkerWritesFor && String(to).includes(failMarkerWritesFor) && String(to).endsWith(".resultsDelivered")) {
		injectedMarkerFailures++;
		throw new Error("injected marker write failure");
	}
	return realRenameSync(from, to);
};

// Registry scan counter for perf tests. Installed before jiti imports node:fs
// (same capture reason as above): counts readdirSync calls on one runs dir.
// The registry performs exactly one readdir per full scan, so this observes
// scan frequency without timing flakiness.
let countReaddirFor = null;
let readdirScanCount = 0;
const realReaddirSync = fs.readdirSync;
fs.readdirSync = function (...args) {
	if (countReaddirFor !== null && String(args[0]) === countReaddirFor) readdirScanCount++;
	return realReaddirSync.apply(this, args);
};

function findPiRoot() {
	const bin = execSync("command -v pi", { encoding: "utf8" }).trim();
	const real = fs.realpathSync(bin);
	// <root>/dist/bundle/cli.js
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

(async () => {
	const config = await jiti.import(path.join(HERE, "config.ts"));
	const registry = await jiti.import(path.join(HERE, "registry.ts"));
	const events = await jiti.import(path.join(HERE, "events.ts"));
	const spawn = await jiti.import(path.join(HERE, "spawn-agent.ts"));
	const wait = await jiti.import(path.join(HERE, "wait.ts"));
	const cost = await jiti.import(path.join(HERE, "cost.ts"));
	const { SubagentStatusWidget, POLL_MS } = await jiti.import(path.join(HERE, "widget.ts"));
	const { default: subagentsExtension } = await jiti.import(path.join(HERE, "index.ts"));

	// --- config ---
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
	const agentDir = path.join(sandbox, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	let s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} });
	check("default RPC bound is 64 Mi characters", s.rpcMaxLineChars === 64 * 1024 * 1024);
	for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1024", null]) {
		let threw = false;
		try { config.validateRpcMaxLineChars(value, "test"); } catch { threw = true; }
		check(`invalid RPC bound ${String(value)} rejected`, threw);
	}
	fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify({ rpcMaxLineChars: 12345 }));
	check("RPC bound loads from configuration", config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} }).rpcMaxLineChars === 12345);
	check("defaults maxDepth=2", s.maxDepth === 2, s.maxDepth);
	check("defaults maxConcurrency=4", s.maxConcurrency === 4, s.maxConcurrency);

	// Model the effective limit exported by each spawn, without forwarding flags.
	const depthOptions = { agentDir, cwd: sandbox, projectTrusted: false };
	const inheritDepth = (settings) => ({
		PI_SUBAGENT_MAX_DEPTH: String(settings.maxDepth),
		PI_SUBAGENT_DEPTH_FLAG_OVERRIDE: settings.maxDepthFlagOverride ? "1" : "0",
	});
	const fallbackDepth = config.loadSettings({ ...depthOptions, env: { PI_SUBAGENT_MAX_DEPTH: "4" } });
	check("defaults do not tighten unflagged inheritance", fallbackDepth.maxDepth === 4, fallbackDepth.maxDepth);
	const rootDepth = config.loadSettings({ ...depthOptions, depthFlag: "4", env: {} });
	check("root flag raises default depth", rootDepth.maxDepth === 4, rootDepth.maxDepth);
	const childDepth = config.loadSettings({ ...depthOptions, env: inheritDepth(rootDepth) });
	check("child preserves root flag above default", childDepth.maxDepth === 4, childDepth.maxDepth);
	const grandchildDepth = config.loadSettings({ ...depthOptions, env: inheritDepth(childDepth) });
	check("grandchild preserves root flag above default", grandchildDepth.maxDepth === 4, grandchildDepth.maxDepth);
	const tightenedDepth = config.loadSettings({ ...depthOptions, depthFlag: "3", env: inheritDepth(childDepth) });
	check("explicit descendant flag tightens inherited depth", tightenedDepth.maxDepth === 3, tightenedDepth.maxDepth);
	const tightenedGrandchild = config.loadSettings({ ...depthOptions, env: inheritDepth(tightenedDepth) });
	check("grandchild preserves tightened depth", tightenedGrandchild.maxDepth === 3, tightenedGrandchild.maxDepth);
	const raisedGrandchild = config.loadSettings({ ...depthOptions, depthFlag: "9", env: inheritDepth(tightenedDepth) });
	check("grandchild cannot raise tightened depth", raisedGrandchild.maxDepth === 3, raisedGrandchild.maxDepth);
	const disabledDepth = config.loadSettings({ ...depthOptions, depthFlag: "0", env: inheritDepth(childDepth) });
	check("explicit descendant zero disables spawning", disabledDepth.maxDepth === 0, disabledDepth.maxDepth);
	const disabledGrandchild = config.loadSettings({ ...depthOptions, depthFlag: "4", env: inheritDepth(disabledDepth) });
	check("inherited zero cannot be raised", disabledGrandchild.maxDepth === 0, disabledGrandchild.maxDepth);

	fs.mkdirSync(path.join(sandbox, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(sandbox, ".pi", "subagents.json"), JSON.stringify({ maxDepth: 2 }));
	fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify({ maxDepth: 4 }));
	const unflaggedRoot = config.loadSettings({ ...depthOptions, env: {} });
	const restrictedChild = config.loadSettings({ ...depthOptions, projectTrusted: true, env: inheritDepth(unflaggedRoot) });
	check("root global4 without flag permits child project2 restriction", restrictedChild.maxDepth === 2, restrictedChild.maxDepth);
	const restrictedGrandchild = config.loadSettings({ ...depthOptions, env: inheritDepth(restrictedChild) });
	check("larger global config cannot raise child restriction", restrictedGrandchild.maxDepth === 2, restrictedGrandchild.maxDepth);
	fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify({ maxDepth: 2 }));
	const globalRestrictedChild = config.loadSettings({ ...depthOptions, env: inheritDepth(unflaggedRoot) });
	check("explicit global config tightens unflagged inheritance", globalRestrictedChild.maxDepth === 2, globalRestrictedChild.maxDepth);
	const configuredRoot = config.loadSettings({ ...depthOptions, projectTrusted: true, depthFlag: "4", env: {} });
	check("root flag overrides lower global config", configuredRoot.maxDepth === 4, configuredRoot.maxDepth);
	const configuredChild = config.loadSettings({ ...depthOptions, projectTrusted: true, env: inheritDepth(configuredRoot) });
	check("global config cannot undo inherited root flag", configuredChild.maxDepth === 4, configuredChild.maxDepth);
	const configuredGrandchild = config.loadSettings({ ...depthOptions, projectTrusted: true, env: inheritDepth(configuredChild) });
	check("global config cannot undo root flag in grandchild", configuredGrandchild.maxDepth === 4, configuredGrandchild.maxDepth);

	fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify({ defaultModel: "a/b", maxDepth: 5, maxConcurrency: 2 }));
	fs.mkdirSync(path.join(sandbox, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(sandbox, ".pi", "subagents.json"), JSON.stringify({ maxDepth: 9 }));
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, env: {} });
	check("project maxDepth wins", s.maxDepth === 9, s.maxDepth);
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} });
	check("untrusted project ignored", s.maxDepth === 5, s.maxDepth);
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, depthFlag: "3", env: {} });
	check("flag wins", s.maxDepth === 3, s.maxDepth);
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, depthFlag: "30", env: { PI_SUBAGENT_MAX_DEPTH: "4" } });
	check("inherited caps flag", s.maxDepth === 4, s.maxDepth);
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, env: { PI_SUBAGENT_MAX_DEPTH: "4" } });
	check("project config cannot raise inherited depth", s.maxDepth === 4, s.maxDepth);
	fs.writeFileSync(path.join(sandbox, ".pi", "subagents.json"), JSON.stringify({ maxDepth: 1 }));
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, env: { PI_SUBAGENT_MAX_DEPTH: "4" } });
	check("project config tightens unflagged inherited depth", s.maxDepth === 1, s.maxDepth);
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, env: inheritDepth(rootDepth) });
	check("project config cannot undo inherited flag override", s.maxDepth === 4, s.maxDepth);
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, depthFlag: "2", env: { PI_SUBAGENT_MAX_DEPTH: "4" } });
	check("descendant flag still tightens with conflicting config", s.maxDepth === 2, s.maxDepth);

	fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify({ maxConcurrency: -1, maxDepth: 100 }));
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} });
	check("concurrency -1 kept", s.maxConcurrency === -1, s.maxConcurrency);
	check("depth 100 kept (no cap)", s.maxDepth === 100, s.maxDepth);

	// --- prune settings ---
	const pruneDefaults = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} });
	check("prune delivered defaults", pruneDefaults.pruneDeliveredAfterDays === 14 && pruneDefaults.pruneDeliveredKeep === 50, JSON.stringify(pruneDefaults));
	check("prune undelivered defaults", pruneDefaults.pruneUndeliveredAfterDays === 30 && pruneDefaults.pruneUndeliveredKeep === 500, JSON.stringify(pruneDefaults));
	for (const [label, bad] of [["negative delivered days", { pruneDeliveredAfterDays: -1 }], ["negative undelivered days", { pruneUndeliveredAfterDays: -1 }], ["negative delivered keep", { pruneDeliveredKeep: -1 }], ["negative undelivered keep", { pruneUndeliveredKeep: -1 }], ["fractional keep", { pruneUndeliveredKeep: 1.5 }], ["NaN days", { pruneUndeliveredAfterDays: NaN }]]) {
		fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify(bad));
		let threw = false;
		try { config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} }); } catch { threw = true; }
		check(`invalid ${label} throws`, threw);
	}
	fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify({ pruneUndeliveredAfterDays: 0, pruneUndeliveredKeep: 7 }));
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} });
	check("zero undelivered days disables age reap", s.pruneUndeliveredAfterDays === 0, s.pruneUndeliveredAfterDays);
	check("custom undelivered keep loads", s.pruneUndeliveredKeep === 7, s.pruneUndeliveredKeep);
	check("project prune settings untouched by global", s.pruneDeliveredAfterDays === 14, s.pruneDeliveredAfterDays);
	fs.writeFileSync(path.join(sandbox, ".pi", "subagents.json"), JSON.stringify({ pruneUndeliveredAfterDays: 60 }));
	s = config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: true, env: {} });
	check("trusted project overrides prune days", s.pruneUndeliveredAfterDays === 60, s.pruneUndeliveredAfterDays);
	check("untrusted project prune ignored", config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} }).pruneUndeliveredAfterDays === 0);
	fs.writeFileSync(path.join(agentDir, "subagents.json"), "{}");
	fs.writeFileSync(path.join(sandbox, ".pi", "subagents.json"), JSON.stringify({ maxDepth: 1 }));

	for (const [label, bad] of [["depth -1", { maxDepth: -1 }], ["depth 1.5", { maxDepth: 1.5 }], ["concurrency 0", { maxConcurrency: 0 }], ["concurrency -2", { maxConcurrency: -2 }], ["bad thinking", { defaultThinking: "ultra" }]]) {
		fs.writeFileSync(path.join(agentDir, "subagents.json"), JSON.stringify(bad));
		let threw = false;
		try { config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: {} }); } catch { threw = true; }
		check(`invalid ${label} throws`, threw);
	}
	fs.writeFileSync(path.join(agentDir, "subagents.json"), "{}");
	let envThinkingThrew = false;
	try {
		config.loadSettings({ agentDir, cwd: sandbox, projectTrusted: false, env: { PI_SUBAGENT_DEFAULT_THINKING: "ultra" } });
	} catch {
		envThinkingThrew = true;
	}
	check("invalid environment thinking throws", envThinkingThrew);

	// --- registry ---
	const agentDir2 = path.join(sandbox, "agent2");
	const now = new Date().toISOString();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	const mk = (runId, parent, extra = {}) => ({
		version: 1, runId, parentRunId: parent, rootRunId: "root", sessionId: runId,
		name: runId, task: "t", cwd: "/tmp", model: "m", thinking: "off",
		depth: 1, maxDepth: 2, status: "completed", usage: { ...usage },
		startedAt: now, updatedAt: now, ...extra,
	});
	registry.saveRecord(agentDir2, mk("root", ""));
	registry.saveRecord(agentDir2, mk("child1", "root"));
	registry.saveRecord(agentDir2, mk("child2", "root"));
	registry.saveRecord(agentDir2, mk("grand", "child1"));
	fs.writeFileSync(path.join(agentDir2, "subagents", "runs", "junk.json"), "not json{");
	const all = registry.readRecords(agentDir2);
	check("malformed record skipped", all.length === 4, all.length);
	const desc = registry.descendantsOf(all, "root").map((r) => r.runId);
	check("descendants order", JSON.stringify(desc) === JSON.stringify(["child1", "grand", "child2"]), desc.join(","));
	const depths = registry.relativeDepths(all, "root");
	check("relative depths", depths.get("child1") === 0 && depths.get("grand") === 1, JSON.stringify([...depths]));

	// --- record cache (perf: mtime-guarded shared scan) ---
	check("record cache API exists", typeof registry.getCachedRecords === "function" && typeof registry.invalidateRecordCache === "function" && typeof registry.recordCacheDebug === "function");
	if (typeof registry.getCachedRecords === "function") {
		const cacheDir = path.join(sandbox, "cache");
		registry.saveRecord(cacheDir, mk("c1", "root"));
		const first = registry.getCachedRecords(cacheDir);
		const second = registry.getCachedRecords(cacheDir);
		check("cache returns identical records when unchanged", first === second && first.length === 1, String(first.length));
		registry.saveRecord(cacheDir, mk("c2", "root"));
		const third = registry.getCachedRecords(cacheDir);
		check("cache re-reads after a registry write", third !== first && third.length === 2, String(third.length));
		const otherDir = path.join(sandbox, "cache-other");
		registry.saveRecord(otherDir, mk("o1", "root"));
		check("cache is isolated per directory", registry.getCachedRecords(otherDir).length === 1 && registry.getCachedRecords(cacheDir).length === 2);
		registry.invalidateRecordCache(cacheDir);
		const fourth = registry.getCachedRecords(cacheDir);
		check("explicit invalidate forces a re-read", fourth !== third && fourth.length === 2);
		const missing = registry.getCachedRecords(path.join(sandbox, "cache-missing-xyz"));
		check("cache matches readRecords on a missing dir", Array.isArray(missing) && missing.length === 0);
		const dbg0 = registry.recordCacheDebug();
		registry.getCachedRecords(cacheDir);
		registry.getCachedRecords(cacheDir);
		const dbg1 = registry.recordCacheDebug();
		check("cache debug counts hits without misses", dbg1.hits === dbg0.hits + 2 && dbg1.misses === dbg0.misses, JSON.stringify({ dbg0, dbg1 }));
		registry.markRecordResultState(cacheDir, third.find((r) => r.runId === "c1"), "resultsDelivered");
		const fifth = registry.getCachedRecords(cacheDir);
		check("marker writes invalidate the cache", fifth !== fourth && fifth.find((r) => r.runId === "c1").resultsDelivered === true);
		// Process death is invisible to mtime: the cache must re-derive it.
		const liveDir = path.join(sandbox, "cache-liveness");
		const sleeper = spawnProcess("sleep", ["30"], { stdio: "ignore" });
		try {
			registry.saveRecord(liveDir, mk("live-pid", "root", { status: "thinking", pid: sleeper.pid }));
			const alive = registry.getCachedRecords(liveDir);
			check("live pid reads as thinking", alive.find((r) => r.runId === "live-pid").status === "thinking");
			sleeper.kill("SIGKILL");
			await new Promise((resolveWait) => sleeper.once("close", resolveWait));
			const ghost = registry.getCachedRecords(liveDir).find((r) => r.runId === "live-pid");
			check("cached records re-derive death without a registry write", ghost && ghost.status === "failed", ghost && ghost.status);
		} finally {
			try { sleeper.kill("SIGKILL"); } catch { /* already reaped */ }
		}
	}

	// --- registry prune (perf: bound unbounded runs-dir growth) ---
	check("prune API exists", typeof registry.pruneRecords === "function");
	if (typeof registry.pruneRecords === "function") {
		const pruneDir = path.join(sandbox, "prune");
		const oldStamp = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
		const freshStamp = new Date().toISOString();
		const delivered = { resultsDelivered: true };
		for (const id of ["old-1", "old-2", "old-3"]) {
			registry.saveRecord(pruneDir, mk(id, "root", { status: "completed", ...delivered, updatedAt: oldStamp, finishedAt: oldStamp }));
			registry.markRecordResultState(pruneDir, { runId: id }, "resultsDelivered");
			const full = registry.readRecords(pruneDir).find((r) => r.runId === id);
			registry.clearRecordPid(pruneDir, full);
		}
		registry.saveRecord(pruneDir, mk("recent", "root", { status: "completed", ...delivered, updatedAt: freshStamp, finishedAt: freshStamp }));
		registry.saveRecord(pruneDir, mk("undelivered", "root", { status: "completed", updatedAt: oldStamp, finishedAt: oldStamp }));
		registry.saveRecord(pruneDir, mk("running", "root", { status: "running_tool", updatedAt: oldStamp }));
		const runsFiles = () => fs.readdirSync(registry.registryDir(pruneDir));
		const before = runsFiles();
		check("prune fixture has sidecars", before.some((f) => f.endsWith(".resultsDelivered")) && before.some((f) => f.endsWith(".closed")), before.join(","));
		const res = registry.pruneRecords(pruneDir, { olderThanMs: 14 * 24 * 3600 * 1000, keepMinimum: 1, undeliveredAfterMs: 90 * 24 * 3600 * 1000, undeliveredKeep: 500, now: Date.now() });
		check("prune removes old delivered terminal records", ["old-1", "old-2", "old-3"].every((id) => res.pruned.includes(id)) && res.pruned.length === 3, JSON.stringify(res));
		const remaining = registry.readRecords(pruneDir).map((r) => r.runId).sort();
		check("prune keeps recent, undelivered and running", JSON.stringify(remaining) === JSON.stringify(["recent", "running", "undelivered"]), remaining.join(","));
		const after = runsFiles();
		check("prune removes sidecars of pruned runs", !after.some((f) => f.startsWith("old-")), after.join(","));
		check("prune with empty options keeps everything young", registry.pruneRecords(pruneDir, { olderThanMs: 14 * 24 * 3600 * 1000, keepMinimum: 10, undeliveredAfterMs: 90 * 24 * 3600 * 1000, undeliveredKeep: 500, now: Date.now() }).pruned.length === 0);
		// keepMinimum protects even ancient records when nothing is young.
		// kept counts both delivered and undelivered retained (recent + undelivered).
		const res2 = registry.pruneRecords(pruneDir, { olderThanMs: 0, keepMinimum: 2, undeliveredAfterMs: 90 * 24 * 3600 * 1000, undeliveredKeep: 500, now: Date.now() });
		check("keepMinimum retains newest candidates", res2.pruned.length === 0 && res2.kept === 2, JSON.stringify(res2));
	}
	// --- undelivered reap: age threshold, count cap, youth guard ---
	{
		const day = 24 * 3600 * 1000;
		const t0 = Date.now();
		const stamp = (daysAgo) => new Date(t0 - daysAgo * day).toISOString();
		const udir = path.join(sandbox, "prune-undelivered");
		for (const [id, age] of [["u-old-1", 60], ["u-old-2", 45], ["u-old-3", 31]]) {
			registry.saveRecord(udir, mk(id, "root", { status: "completed", updatedAt: stamp(age), finishedAt: stamp(age) }));
		}
		registry.saveRecord(udir, mk("u-new", "root", { status: "completed", updatedAt: stamp(1), finishedAt: stamp(1) }));
		registry.saveRecord(udir, mk("d-old", "root", { status: "completed", resultsDelivered: true, updatedAt: stamp(60), finishedAt: stamp(60) }));
		const r1 = registry.pruneRecords(udir, { olderThanMs: 14 * day, keepMinimum: 0, undeliveredAfterMs: 30 * day, undeliveredKeep: 500, now: t0 });
		check("undelivered older than threshold reaped", ["u-old-1", "u-old-2", "u-old-3", "d-old"].every((id) => r1.pruned.includes(id)) && r1.pruned.length === 4, JSON.stringify(r1));
		check("recent undelivered kept", registry.readRecords(udir).some((r) => r.runId === "u-new"));
		registry.saveRecord(udir, mk("u-keep", "root", { status: "completed", updatedAt: stamp(90), finishedAt: stamp(90) }));
		const r2 = registry.pruneRecords(udir, { olderThanMs: 14 * day, keepMinimum: 50, undeliveredAfterMs: 0, undeliveredKeep: 500, now: t0 });
		check("zero undelivered threshold disables age reap", !r2.pruned.includes("u-keep") && !r2.pruned.includes("u-new"), JSON.stringify(r2));
		// Count cap: newest 2 survive, oldest go (all past the grace floor).
		const cdir = path.join(sandbox, "prune-cap");
		for (const [id, age] of [["c-30", 30], ["c-20", 20], ["c-10", 10], ["c-8", 8]]) {
			registry.saveRecord(cdir, mk(id, "root", { status: "completed", updatedAt: stamp(age), finishedAt: stamp(age) }));
		}
		registry.pruneRecords(cdir, { olderThanMs: 14 * day, keepMinimum: 50, undeliveredAfterMs: 90 * day, undeliveredKeep: 2, capGraceMs: 7 * day, now: t0 });
		const rem3 = registry.readRecords(cdir).map((r) => r.runId).sort();
		check("cap keeps newest undelivered", JSON.stringify(rem3) === JSON.stringify(["c-10", "c-8"]), rem3.join(","));
		// Youth guard: the cap never takes records younger than the grace floor.
		const ydir = path.join(sandbox, "prune-youth");
		registry.saveRecord(ydir, mk("y-old", "root", { status: "completed", updatedAt: stamp(30), finishedAt: stamp(30) }));
		registry.saveRecord(ydir, mk("y-hour", "root", { status: "completed", updatedAt: stamp(0.04), finishedAt: stamp(0.04) }));
		registry.saveRecord(ydir, mk("y-min", "root", { status: "completed", updatedAt: stamp(0.01), finishedAt: stamp(0.01) }));
		registry.pruneRecords(ydir, { olderThanMs: 14 * day, keepMinimum: 50, undeliveredAfterMs: 90 * day, undeliveredKeep: 1, capGraceMs: 7 * day, now: t0 });
		const rem4 = registry.readRecords(ydir).map((r) => r.runId).sort();
		check("cap never reaps young records", JSON.stringify(rem4) === JSON.stringify(["y-hour", "y-min"]), rem4.join(","));
	}

	// --- async record lock (perf: lock wait must not freeze the event loop) ---
	check("record lock is async", registry.withRecordLock.constructor.name === "AsyncFunction", registry.withRecordLock.constructor.name);
	{
		const lockDir = path.join(sandbox, "lock-async");
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const holder = registry.withRecordLock(lockDir, "run-1", async () => { await sleep(300); return "held"; });
		await sleep(20); // let the holder take the lock
		let beats = 0;
		const heart = setInterval(() => { beats++; }, 10);
		const waiter = await registry.withRecordLock(lockDir, "run-1", () => "waiter");
		clearInterval(heart);
		const held = await holder;
		check("lock wait does not freeze the event loop", beats >= 3, `beats=${beats}`);
		check("contended lock still hands off", waiter === "waiter" && held === "held", `${waiter}/${held}`);
		check("sync operations still work", (await registry.withRecordLock(lockDir, "run-1", () => 42)) === 42);
		const order = [];
		await Promise.all([
			registry.withRecordLock(lockDir, "run-2", async () => { order.push("a-start"); await sleep(50); order.push("a-end"); }),
			registry.withRecordLock(lockDir, "run-2", async () => { order.push("b-start"); await sleep(10); order.push("b-end"); }),
		]);
		check("async lock serializes critical sections", JSON.stringify(order) === JSON.stringify(["a-start", "a-end", "b-start", "b-end"]), order.join(","));
	}

	// --- actionable run IDs ---
	const targetA = mk("12345678-aaaa-4000-8000-000000000001", "root", { name: "review", sessionId: "session-a" });
	const targetB = mk("87654321-bbbb-4000-8000-000000000002", "root", { name: "review", sessionId: "session-b" });
	const targets = [targetA, targetB];
	check("displayed eight-character run ID resolves", registry.resolveAgentRecord(targets, "12345678") === targetA);
	check("full run ID resolves", registry.resolveAgentRecord(targets, targetB.runId) === targetB);
	check("exact session ID resolves", registry.resolveAgentRecord(targets, "session-b") === targetB);
	check("target whitespace is trimmed", registry.resolveAgentRecord(targets, " 12345678 ") === targetA);
	const named = mk("other-id", "root", { name: "12345678", sessionId: "other-session" });
	check("exact name takes precedence over run prefix", registry.resolveAgentRecord([...targets, named], "12345678") === named);
	const collision = mk("12345678-cccc-4000-8000-000000000003", "root");
	for (const [label, rows, target] of [
		["duplicate name", targets, "review"],
		["ambiguous prefix", [...targets, collision], "12345678"],
	]) {
		let error;
		try { registry.resolveAgentRecord(rows, target); } catch (caught) { error = caught; }
		check(`${label} rejected with actionable full IDs`, error?.message.includes("ambiguous") && error.message.includes(targetA.runId) && error.message.includes(label === "duplicate name" ? targetB.runId : collision.runId), error?.message);
	}
	for (const target of ["", "   ", "unknown"]) {
		let rejected = false;
		try { registry.resolveAgentRecord(targets, target); } catch { rejected = true; }
		check(`invalid target ${JSON.stringify(target)} rejected`, rejected);
	}

	// --- subagent cost roll-up ---
	{
		const costAgentDir = path.join(sandbox, "cost-agent");
		fs.mkdirSync(costAgentDir, { recursive: true });
		const U = (input, output, usd, extra = {}) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: usd, ...extra });
		const usageClose = (a, b) => a && b && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((f) => a[f] === b[f]) && Math.abs(a.cost - b.cost) < 1e-12;

		// Pure: subtree sums own + descendants.
		const costRecs = [
			mk("cost-root", "", { rootRunId: "cost-root" }),
			{ ...mk("cost-child", "cost-parent", { rootRunId: "cost-parent", status: "thinking" }), usage: U(10, 5, 0.001) },
			{ ...mk("cost-grand", "cost-child", { rootRunId: "cost-parent", depth: 2, status: "thinking" }), usage: U(100, 50, 0.01) },
		];
		check("subtree usage sums own and descendants", usageClose(cost.subtreeUsage(costRecs, "cost-child"), U(110, 55, 0.011)));
		check("subtree usage of leaf is own usage", usageClose(cost.subtreeUsage(costRecs, "cost-grand"), U(100, 50, 0.01)));
		check("subtree usage of unknown run is zero", usageClose(cost.subtreeUsage(costRecs, "nope"), U(0, 0, 0)));

		// Pure: pi usage shape.
		const shaped = cost.toPiUsage(U(10, 5, 0.001, { cacheRead: 1, cacheWrite: 2 }));
		check("attributed usage carries full breakdown", shaped.input === 10 && shaped.output === 5 && shaped.cacheRead === 1 && shaped.cacheWrite === 2 && shaped.totalTokens === 15 && shaped.cost.total === 0.001 && shaped.cost.input === 0);

		// Pure: floor rebuild takes per-field max, ignores corrupt/misplaced receipts.
		const floorEntries = [
			{ type: "message", message: { role: "toolResult", toolName: "read", details: { costReported: { a: U(10, 5, 0.001) } } } },
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: { costReported: { a: U(12, 5, 0.001), b: U(1, 1, 0) } } } },
			{ type: "message", message: { role: "toolResult", toolName: "read", details: { costReported: { a: "garbage", c: { input: 1 } } } } },
			{ type: "message", message: { role: "assistant", details: { costReported: { d: U(9, 9, 9) } } } },
			{ type: "custom_message", details: { costReported: { e: U(9, 9, 9) } } },
		];
		const rebuilt = cost.rebuildFloor(floorEntries);
		check("floor rebuild takes per-field max", usageClose(rebuilt.get("a"), { input: 12, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: 0.001 }));
		check("floor rebuild keeps zero-cost token reporters", rebuilt.get("b")?.input === 1);
		check("floor rebuild ignores corrupt and misplaced receipts", !rebuilt.has("c") && !rebuilt.has("d") && !rebuilt.has("e"));

		// Pure: flush delta math, epsilon, negative clamp.
		const floor = new Map();
		const first = cost.computeFlush(costRecs, "cost-parent", floor);
		check("first flush reports full subtree delta", first !== undefined && first.usage.input === 110 && first.usage.output === 55 && Math.abs(first.usage.cost.total - 0.011) < 1e-9 && usageClose(first.receipt["cost-child"], U(110, 55, 0.011)));
		check("second flush with no change emits nothing", cost.computeFlush(costRecs, "cost-parent", floor) === undefined);
		const resumedRecs = costRecs.map((r) => r.runId === "cost-child"
			? { ...r, executionId: "exec-2", usage: U(15, 5, 0.0015) }
			: r);
		const resumedFlush = cost.computeFlush(resumedRecs, "cost-parent", floor);
		check("resume reports only new spend", resumedFlush !== undefined && resumedFlush.usage.input === 5 && resumedFlush.usage.output === 0 && Math.abs(resumedFlush.usage.cost.total - 0.0005) < 1e-12);
		const floor2 = new Map();
		cost.computeFlush(costRecs, "cost-parent", floor2);
		const dusty = costRecs.map((r) => r.runId === "cost-child" ? { ...r, usage: { ...r.usage, cost: r.usage.cost + 1e-10 } } : r);
		check("cost dust below epsilon emits nothing", cost.computeFlush(dusty, "cost-parent", floor2) === undefined);
		const mixed = costRecs.map((r) => r.runId === "cost-child"
			? { ...r, usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: 0.0005 } }
			: r);
		const mixedFlush = cost.computeFlush(mixed, "cost-parent", floor2);
		check("mixed dip clamps negatives and advances floor", mixedFlush !== undefined && mixedFlush.usage.input === 10 && mixedFlush.usage.cost.total === 0 && cost.computeFlush(mixed, "cost-parent", floor2) === undefined);

		// Hook: flush rides tool results; reload/fork restore the floor.
		const prevCostAgentDir = process.env.PI_CODING_AGENT_DIR;
		const prevCostRunId = process.env.PI_SUBAGENT_RUN_ID;
		const prevCostRootId = process.env.PI_SUBAGENT_ROOT_ID;
		const prevCostCommand = process.env.PI_SUBAGENT_COMMAND;
		process.env.PI_CODING_AGENT_DIR = costAgentDir;
		delete process.env.PI_SUBAGENT_RUN_ID;
		delete process.env.PI_SUBAGENT_ROOT_ID;
		const costHandlers = new Map();
		const costTools = new Map();
		const hookEvent = { toolName: "read", content: [{ type: "text", text: "original tool output" }] };
		try {
			subagentsExtension({
				registerFlag: () => {},
				on: (event, handler) => costHandlers.set(event, handler),
				registerMessageRenderer: () => {},
				registerCommand: () => {},
				registerTool: (tool) => costTools.set(tool.name, tool),
				getFlag: () => undefined,
				sendMessage: () => {},
				sendUserMessage: () => {},
			});
			const costStart = (sessionId, entries) => costHandlers.get("session_start")({}, {
				sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
				cwd: sandbox, isProjectTrusted: () => false, mode: "rpc", hasUI: false,
			});
			await costStart("cost-parent", []);
			registry.saveRecord(costAgentDir, { ...mk("cost-run", "cost-parent", { rootRunId: "cost-parent", status: "thinking" }), usage: U(10, 5, 0.001) });
			const flushed = costHandlers.get("tool_result")(hookEvent, {});
			check("tool result carries child cost as usage", flushed && flushed.usage && flushed.usage.input === 10 && flushed.usage.output === 5 && Math.abs(flushed.usage.cost.total - 0.001) < 1e-12, JSON.stringify(flushed && flushed.usage));
			check("cost-only flush preserves original content", flushed && !("content" in flushed));
			check("cost receipt stapled to details", flushed && flushed.details && flushed.details.costReported && Math.abs(flushed.details.costReported["cost-run"].cost - 0.001) < 1e-12);
			check("steady state emits nothing", costHandlers.get("tool_result")(hookEvent, {}) === undefined);
			const allReceiptDetails = [flushed.details];
			for (const status of ["completed", "failed", "cancelled"]) {
				const id = `cost-term-${status}`;
				registry.saveRecord(costAgentDir, { ...mk(id, "cost-parent", { rootRunId: "cost-parent", status, latestText: `${status} out`, error: `${status} err` }), usage: U(7, 3, 0.002) });
				const out = costHandlers.get("tool_result")(hookEvent, {});
				check(`${status} child cost flushes`, out && out.usage && out.usage.input === 7 && Math.abs(out.usage.cost.total - 0.002) < 1e-12);
				if (out && out.details) allReceiptDetails.push(out.details);
			}
			registry.saveRecord(costAgentDir, { ...mk("cost-run", "cost-parent", { rootRunId: "cost-parent", status: "thinking", executionId: "exec-2" }), usage: U(25, 10, 0.0025) });
			const hookResumed = costHandlers.get("tool_result")(hookEvent, {});
			check("resumed child reports only new spend", hookResumed && hookResumed.usage && hookResumed.usage.input === 15 && hookResumed.usage.output === 5 && Math.abs(hookResumed.usage.cost.total - 0.0015) < 1e-12);
			registry.saveRecord(costAgentDir, { ...mk("cost-kid", "cost-parent", { rootRunId: "cost-parent", status: "thinking" }), usage: U(1, 1, 0.0001) });
			registry.saveRecord(costAgentDir, { ...mk("cost-gkid", "cost-kid", { rootRunId: "cost-parent", depth: 2, status: "thinking" }), usage: U(100, 50, 0.01) });
			const recFlush = costHandlers.get("tool_result")(hookEvent, {});
			check("root flush includes grandchild exactly once", recFlush && recFlush.usage && recFlush.usage.input === 101 && Math.abs(recFlush.usage.cost.total - 0.0101) < 1e-12, JSON.stringify(recFlush && recFlush.usage));
			check("no replay after recursion flush", costHandlers.get("tool_result")(hookEvent, {}) === undefined);
			// Reload: receipts restore the floor — no replay.
			allReceiptDetails.push(hookResumed.details, recFlush.details);
			await costStart("cost-parent", allReceiptDetails.map((details) => ({ type: "message", message: { role: "toolResult", toolName: "read", details } })));
			check("reload restores cost floor without replay", costHandlers.get("tool_result")(hookEvent, {}) === undefined);
			// Fork: a subset of entries rebuilds a lower floor; next flush reports exactly the remainder.
			costHandlers.get("session_tree")({}, {
				sessionManager: {
					getBranch: () => [],
					getEntries: () => [{ type: "message", message: { role: "toolResult", toolName: "read", details: flushed.details } }],
				},
			});
			const forkFlush = costHandlers.get("tool_result")(hookEvent, {});
			const forkKeys = forkFlush && forkFlush.details && forkFlush.details.costReported ? Object.keys(forkFlush.details.costReported) : [];
			check("fork rebuild reports exactly the remainder", forkFlush && forkFlush.usage && forkFlush.usage.input === 137 && forkFlush.usage.output === 65 && Math.abs(forkFlush.usage.cost.total - 0.0176) < 1e-9 && forkKeys.length === 5 && !("cost-gkid" in forkFlush.details.costReported), JSON.stringify(forkFlush && forkFlush.usage));
			// Hosts without entry history: no crash, degrades to a full report.
			await costHandlers.get("session_start")({}, {
				sessionManager: { getSessionId: () => "cost-parent" },
				cwd: sandbox, isProjectTrusted: () => false, mode: "rpc", hasUI: false,
			});
			const freshFlush = costHandlers.get("tool_result")(hookEvent, {});
			check("missing entry history degrades to full report", freshFlush && freshFlush.usage && freshFlush.usage.input === 147 && freshFlush.usage.output === 70);
			// A failure inside the cost path skips cost without breaking the tool result.
			const origDescendants = registry.descendantsOf;
			let descendantsPatched = false;
			try {
				registry.descendantsOf = () => { throw new Error("boom"); };
				try { registry.descendantsOf([], "x"); } catch (error) { descendantsPatched = error && error.message === "boom"; }
			} catch { descendantsPatched = false; }
			if (descendantsPatched) {
				try {
					check("cost-path failure skips cost without breaking the tool result", costHandlers.get("tool_result")(hookEvent, {}) === undefined);
				} finally {
					registry.descendantsOf = origDescendants;
				}
			} else {
				check("cost-path failure test skipped (namespace frozen)", true);
			}
			// End-to-end: a real fake-pi child accrues exactly one priced turn, flushed once.
			process.env.PI_SUBAGENT_COMMAND = path.join(HERE, "fake-pi.cjs");
			const costSpawnDir = path.join(sandbox, "cost-spawn");
			fs.mkdirSync(costSpawnDir, { recursive: true });
			const costSpawnAgentDir = path.join(sandbox, "cost-spawn-agent");
			const e2eCtx = {
				agentDir: costSpawnAgentDir,
				parentRunId: "cost-e2e",
				rootRunId: "cost-e2e",
				currentDepth: 0,
				settings: { maxDepth: 2, maxConcurrency: -1 },
				parentModel: "fake/parent",
				parentThinking: "off",
				parentTools: ["read"],
				scopedModels: [],
				parentCwd: costSpawnDir,
				projectTrusted: false,
			};
			process.env.PI_CODING_AGENT_DIR = costSpawnAgentDir;
			const e2eRec = await spawn.startSubagent({ task: "cost e2e" }, e2eCtx);
			let e2eFinal;
			for (let i = 0; i < 100; i++) {
				e2eFinal = registry.readRecords(costSpawnAgentDir).find((r) => r.runId === e2eRec.runId);
				if (e2eFinal && e2eFinal.status === "completed") break;
				await new Promise((r) => setTimeout(r, 25));
			}
			check("fake child settles completed", e2eFinal && e2eFinal.status === "completed", e2eFinal && e2eFinal.status);
			check("fake child accrues exactly one priced turn", e2eFinal && usageClose(e2eFinal.usage, U(10, 5, 0.001)), JSON.stringify(e2eFinal && e2eFinal.usage));
			await costStart("cost-e2e", []);
			const e2eFlush = costHandlers.get("tool_result")(hookEvent, {});
			check("fake-child spend flushes exactly once", e2eFlush && e2eFlush.usage && e2eFlush.usage.input === 10 && e2eFlush.usage.output === 5 && Math.abs(e2eFlush.usage.cost.total - 0.001) < 1e-12, JSON.stringify(e2eFlush && e2eFlush.usage));
			check("fake-child spend never replays", costHandlers.get("tool_result")(hookEvent, {}) === undefined);
			process.env.FAKE_EXIT = "1";
			const failRec = await spawn.startSubagent({ task: "cost fail" }, e2eCtx);
			let failFinal;
			for (let i = 0; i < 100; i++) {
				failFinal = registry.readRecords(costSpawnAgentDir).find((r) => r.runId === failRec.runId);
				if (failFinal && ["completed", "failed", "cancelled"].includes(failFinal.status)) break;
				await new Promise((r) => setTimeout(r, 25));
			}
			delete process.env.FAKE_EXIT;
			check("failing fake child settles failed", failFinal && failFinal.status === "failed", failFinal && failFinal.status);
			const failUsage = failFinal && failFinal.usage;
			const failFlush = costHandlers.get("tool_result")(hookEvent, {});
			if (failUsage && (failUsage.input !== 0 || failUsage.output !== 0 || failUsage.cost !== 0)) {
				check("failed child spend flushes", failFlush && failFlush.usage && failFlush.usage.input === failUsage.input && failFlush.usage.output === failUsage.output && Math.abs(failFlush.usage.cost.total - failUsage.cost) < 1e-12, JSON.stringify(failFlush && failFlush.usage));
			} else {
				check("failed child with no spend attaches no usage", !failFlush || !failFlush.usage);
			}
		} finally {
			await costHandlers.get("session_shutdown")?.({}, { mode: "rpc" });
			if (prevCostAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevCostAgentDir;
			if (prevCostRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
			else process.env.PI_SUBAGENT_RUN_ID = prevCostRunId;
			if (prevCostRootId === undefined) delete process.env.PI_SUBAGENT_ROOT_ID;
			else process.env.PI_SUBAGENT_ROOT_ID = prevCostRootId;
			if (prevCostCommand === undefined) delete process.env.PI_SUBAGENT_COMMAND;
			else process.env.PI_SUBAGENT_COMMAND = prevCostCommand;
			delete process.env.FAKE_EXIT;
		}
	}

	// --- tool_result serves steady state from the record cache (perf) ---
	// Ungated behavioral test: passes only when the handler avoids registry
	// scans while nothing changed (scan counting via the pre-import hook).
	{
		const dir = path.join(sandbox, "cache-hook");
		const hookHandlers = new Map();
		const prevHookDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			subagentsExtension({
				registerFlag: () => {},
				on: (event, handler) => hookHandlers.set(event, handler),
				registerMessageRenderer: () => {},
				registerCommand: () => {},
				registerTool: () => {},
				getFlag: () => undefined,
				sendMessage: () => {},
				sendUserMessage: () => {},
			});
			await hookHandlers.get("session_start")({}, {
				sessionManager: { getSessionId: () => "cache-parent", getEntries: () => [], getBranch: () => [] },
				cwd: sandbox, isProjectTrusted: () => false, mode: "rpc", hasUI: false,
			});
			const hookEvent = { toolName: "read", content: [{ type: "text", text: "out" }] };
			// Ensure the runs dir exists before priming so dir creation itself
			// does not count as a registry mutation inside the window below.
			fs.mkdirSync(path.join(dir, "subagents", "runs"), { recursive: true });
			check("childless tool result emits nothing", hookHandlers.get("tool_result")(hookEvent, {}) === undefined);
			countReaddirFor = path.join(dir, "subagents", "runs");
			readdirScanCount = 0;
			try {
				check("steady-state tool result emits nothing", hookHandlers.get("tool_result")(hookEvent, {}) === undefined);
			} finally {
				countReaddirFor = null;
			}
			check("steady-state tool result performs no registry scan", readdirScanCount === 0, `scans=${readdirScanCount}`);
			// A registry write must invalidate: new child spend still flushes.
			registry.saveRecord(dir, { ...mk("cache-kid", "cache-parent", { rootRunId: "cache-parent", status: "thinking" }), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.001 } });
			const flushed = hookHandlers.get("tool_result")(hookEvent, {});
			check("post-write tool result still flushes child spend", flushed && flushed.usage && flushed.usage.input === 10 && !("content" in flushed), JSON.stringify(flushed && flushed.usage));
			check("no replay after cached flush", hookHandlers.get("tool_result")(hookEvent, {}) === undefined);
		} finally {
			await hookHandlers.get("session_shutdown")?.({}, { mode: "rpc" });
			if (prevHookDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevHookDir;
		}
	}

	// --- session_start pruning hook (perf: rotation covers undelivered too) ---
	{
		const dir = path.join(sandbox, "prune-hook");
		const day = 24 * 3600 * 1000;
		const stamp = (daysAgo) => new Date(Date.now() - daysAgo * day).toISOString();
		// Custom keep exercises the settings wiring: a lone delivered
		// candidate is otherwise always retained by keepMinimum.
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "subagents.json"), JSON.stringify({ pruneDeliveredKeep: 0 }));
		registry.saveRecord(dir, mk("hook-old-d", "hook-parent", { rootRunId: "hook-parent", status: "completed", resultsDelivered: true, updatedAt: stamp(60), finishedAt: stamp(60) }));
		registry.saveRecord(dir, mk("hook-old-u", "hook-parent", { rootRunId: "hook-parent", status: "completed", updatedAt: stamp(60), finishedAt: stamp(60) }));
		registry.saveRecord(dir, mk("hook-new", "hook-parent", { rootRunId: "hook-parent", status: "completed", updatedAt: stamp(1), finishedAt: stamp(1) }));
		const pruneHookHandlers = new Map();
		const prevHookDir2 = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			subagentsExtension({
				registerFlag: () => {},
				on: (event, handler) => pruneHookHandlers.set(event, handler),
				registerMessageRenderer: () => {},
				registerCommand: () => {},
				registerTool: () => {},
				getFlag: () => undefined,
				sendMessage: () => {},
				sendUserMessage: () => {},
			});
			await pruneHookHandlers.get("session_start")({}, {
				sessionManager: { getSessionId: () => "hook-parent", getEntries: () => [], getBranch: () => [] },
				cwd: sandbox, isProjectTrusted: () => false, mode: "rpc", hasUI: false,
			});
			const left = registry.readRecords(dir).map((r) => r.runId).sort();
			check("session start prunes old delivered and undelivered", JSON.stringify(left) === JSON.stringify(["hook-new"]), left.join(","));
		} finally {
			await pruneHookHandlers.get("session_shutdown")?.({}, { mode: "rpc" });
			if (prevHookDir2 === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevHookDir2;
		}
	}

	// --- execution-scoped parent state (including legacy records) ---
	{
		const dir = path.join(sandbox, "result-state");
		let owner = registry.saveRecord(dir, mk("result", "root", { latestText: "first" }));
		const staleParent = { ...owner };
		registry.markRecordResultState(dir, staleParent, "resultsDelivered");
		owner = registry.saveRecord(dir, { ...owner, resultsDelivered: false });
		check("stale owner publish preserves the parent flag", owner.resultsDelivered);
		const parsed = { finalText: "first" };
		events.applyChildEvent(owner, parsed, { type: "agent_start" });
		owner.latestText = "second in progress";
		owner = registry.saveRecord(dir, owner);
		check("agent_start resets delivery for a new execution", !!owner.executionId && !owner.resultsDelivered);
		const recordFile = path.join(registry.registryDir(dir), "result.json");
		const before = fs.readFileSync(recordFile, "utf8");
		// A separate process with an old terminal snapshot must write only the old
		// execution marker, never replace the newer execution's JSON.
		execFileSync(process.execPath, ["-e", `
			const { createJiti } = require(${JSON.stringify(path.join(PIN, "jiti"))});
			const jiti = createJiti(${JSON.stringify(__filename)}, { fsCache: false });
			(async () => {
				const registry = await jiti.import(${JSON.stringify(path.join(HERE, "registry.ts"))});
				const record = ${JSON.stringify(staleParent)};
				registry.markRecordResultState(${JSON.stringify(dir)}, record, "resultsDelivered");
			})();
		`]);
		check("cross-process stale UI writes leave execution JSON untouched", fs.readFileSync(recordFile, "utf8") === before);
		const current = registry.readRecords(dir)[0];
		check("old execution claim does not mark the continuation", current.status === "thinking" && current.latestText === "second in progress" && !current.resultsDelivered);
		registry.markRecordResultState(dir, current, "resultsDelivered");
		const closed = registry.clearRecordPid(dir, { ...owner, pid: process.pid });
		check("clearRecordPid preserves the current execution claim", closed.pid === undefined && closed.resultsDelivered);
	}

	// --- wait ---
	const waitSleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
	const waitCase = (name) => path.join(sandbox, `wait-${name}`);
	const waitRecord = (dir, parent, runId, status, extra = {}) =>
		registry.saveRecord(dir, mk(runId, parent, { rootRunId: parent, status, ...extra }));

	{
		const dir = waitCase("idle");
		const started = Date.now();
		const rows = await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000 });
		check("wait returns immediately when no children", rows.length === 0 && Date.now() - started < 200, String(Date.now() - started));
	}

	{
		const dir = waitCase("already");
		waitRecord(dir, "parent", "done", "completed");
		const started = Date.now();
		const rows = await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000 });
		check("wait returns immediately when all terminal", rows.length === 1 && Date.now() - started < 200, String(Date.now() - started));
	}

	// --- wait default poll interval (perf: polls must stay cheap, not rare) ---
	// Explicit waits need a responsive default (cross-process finishes), so the
	// interval stays 250ms; the shared record cache is what makes each poll
	// cheap. This guards that composition: ~2s pending must cost few scans.
	check("default wait poll interval is 250ms", wait.DEFAULT_POLL_MS === 250, String(wait.DEFAULT_POLL_MS));

	{
		// Behavioral: a pending wait with no in-process notify polls via the
		// default interval, but every poll must be a cache hit, not a rescan.
		// 2100ms at 250ms polls ~= 11 polls; total directory scans must stay
		// at the pre-checks + final snapshot (~3). Scan counting via hook.
		const dir = waitCase("poll-rate");
		waitRecord(dir, "parent", "live", "thinking");
		countReaddirFor = path.join(dir, "subagents", "runs");
		readdirScanCount = 0;
		try {
			await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 2100 });
		} finally {
			countReaddirFor = null;
		}
		check("pending wait polls from cache without rescanning", readdirScanCount <= 3, `scans=${readdirScanCount}`);
	}

	{
		const dir = waitCase("notify");
		waitRecord(dir, "parent", "live", "thinking");
		const started = Date.now();
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000, pollMs: 10000 });
		setTimeout(() => {
			waitRecord(dir, "parent", "live", "completed", { latestText: "notified" });
			wait.notifyWaiters(dir);
		}, 40);
		const rows = await pending;
		check("in-process notify wakes wait immediately", Date.now() - started < 500, String(Date.now() - started));
		check("notify wait sees completed child", rows.some((r) => r.runId === "live" && r.status === "completed"));
		check("notify wait releases resources", wait.waitDebugState().waiters === 0, JSON.stringify(wait.waitDebugState()));
	}

	{
		const dir = waitCase("all");
		waitRecord(dir, "parent", "a", "thinking");
		waitRecord(dir, "parent", "b", "thinking");
		let resolved = false;
		const started = Date.now();
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000, pollMs: 10000 }).then((rows) => {
			resolved = true;
			return rows;
		});
		await waitSleep(30);
		waitRecord(dir, "parent", "a", "completed");
		wait.notifyWaiters(dir);
		await waitSleep(50);
		check("wait-for-all stays pending after first child", resolved === false);
		waitRecord(dir, "parent", "b", "completed");
		wait.notifyWaiters(dir);
		await pending;
		check("wait-for-all returns after last child", resolved && Date.now() - started < 500, String(Date.now() - started));
	}

	{
		const dir = waitCase("targets-any");
		waitRecord(dir, "parent", "a", "thinking");
		waitRecord(dir, "parent", "b", "thinking");
		waitRecord(dir, "parent", "c", "thinking");
		let resolved = false;
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000, pollMs: 10000, targets: ["a", "b"], mode: "any" }).then((rows) => {
			resolved = true;
			return rows;
		});
		await waitSleep(30);
		waitRecord(dir, "parent", "c", "completed");
		wait.notifyWaiters(dir);
		await waitSleep(50);
		check("any wait ignores unselected siblings", resolved === false);
		waitRecord(dir, "parent", "b", "completed");
		wait.notifyWaiters(dir);
		const rows = await pending;
		check("any wait resolves when one selected target finishes", resolved && rows.some((r) => r.runId === "b"));
	}

	{
		const dir = waitCase("targets-all");
		waitRecord(dir, "parent", "a", "thinking");
		waitRecord(dir, "parent", "b", "thinking");
		waitRecord(dir, "parent", "c", "thinking");
		let resolved = false;
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000, pollMs: 10000, targets: ["a", "b"], mode: "all" }).then(() => { resolved = true; });
		await waitSleep(30);
		waitRecord(dir, "parent", "a", "completed");
		wait.notifyWaiters(dir);
		await waitSleep(50);
		check("all wait stays pending after one selected target", resolved === false);
		waitRecord(dir, "parent", "b", "completed");
		wait.notifyWaiters(dir);
		await pending;
		check("all wait resolves after the last selected target", resolved);
	}

	{
		const dir = waitCase("targets-empty");
		waitRecord(dir, "parent", "live", "thinking");
		const started = Date.now();
		const rows = await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000, targets: ["missing"] });
		check("targeted wait with no matching rows returns immediately", Date.now() - started < 200, String(Date.now() - started));
		check("targeted wait still returns the snapshot", rows.some((r) => r.runId === "live"));
	}

	{
		const dir = waitCase("poll");
		waitRecord(dir, "parent", "polled", "thinking");
		const started = Date.now();
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 3000, pollMs: 50 });
		setTimeout(() => {
			waitRecord(dir, "parent", "polled", "completed");
		}, 40);
		const rows = await pending;
		check("poll notices a foreign record change", Date.now() - started < 1500 && rows.some((r) => r.runId === "polled" && r.status === "completed"), String(Date.now() - started));
	}

	{
		const dir = waitCase("abort");
		waitRecord(dir, "parent", "abort-me", "thinking");
		const ac = new AbortController();
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000, signal: ac.signal, pollMs: 10000 });
		ac.abort();
		let abortThrew = false;
		try {
			await pending;
		} catch (error) {
			abortThrew = error instanceof Error && error.message.includes("aborted");
		}
		check("abort rejects wait", abortThrew);
		check("abort releases waiters", wait.waitDebugState().waiters === 0, JSON.stringify(wait.waitDebugState()));
	}

	{
		const dir = waitCase("zero");
		waitRecord(dir, "parent", "still-running", "thinking");
		const started = Date.now();
		const rows = await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 0 });
		check("timeout 0 does not wait", rows.some((r) => r.status === "thinking") && Date.now() - started < 200, String(Date.now() - started));
	}

	{
		const dir = waitCase("timeout");
		waitRecord(dir, "parent", "slow", "thinking");
		const started = Date.now();
		const rows = await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 300, pollMs: 10000 });
		const elapsed = Date.now() - started;
		check("positive timeout returns the running snapshot", elapsed >= 250 && elapsed < 1500 && rows.some((r) => r.runId === "slow" && r.status === "thinking"), String(elapsed));
		check("timeout releases the waiter", wait.waitDebugState().waiters === 0, JSON.stringify(wait.waitDebugState()));
	}

	{
		const dir = waitCase("dead-pid");
		waitRecord(dir, "parent", "ghost", "thinking", { pid: 2147483647 });
		const started = Date.now();
		const rows = await wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 5000 });
		const ghost = rows.find((r) => r.runId === "ghost");
		check("dead pid treated as terminal without waiting", ghost && ghost.status === "failed" && Date.now() - started < 200, ghost && `${ghost.status} ${Date.now() - started}`);
	}

	{
		const dir = waitCase("dead-while");
		const child = spawnProcess("sleep", ["30"], { stdio: "ignore" });
		waitRecord(dir, "parent", "live-pid", "thinking", { pid: child.pid });
		const started = Date.now();
		const pending = wait.waitUntilSubagentsIdle(dir, "parent", { timeoutMs: 3000, pollMs: 50 });
		await waitSleep(20);
		child.kill("SIGKILL");
		await new Promise((resolveWait) => child.once("close", resolveWait));
		const rows = await pending;
		const live = rows.find((r) => r.runId === "live-pid");
		check("dead pid during wait is noticed by poll", live && live.status === "failed" && Date.now() - started < 500, live && `${live.status} ${Date.now() - started}`);
	}

	// --- incremental check results ---
	const checkAgentDir = path.join(sandbox, "check-agent");
	fs.mkdirSync(checkAgentDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousRunId = process.env.PI_SUBAGENT_RUN_ID;
	const previousRootId = process.env.PI_SUBAGENT_ROOT_ID;
	delete process.env.PI_SUBAGENT_RUN_ID;
	delete process.env.PI_SUBAGENT_ROOT_ID;
	process.env.PI_CODING_AGENT_DIR = checkAgentDir;
	const checkHandlers = new Map();
	const checkTools = new Map();
	const checkPi = {
		registerFlag: () => {},
		on: (event, handler) => checkHandlers.set(event, handler),
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		registerTool: (tool) => checkTools.set(tool.name, tool),
		getFlag: () => undefined,
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	try {
		subagentsExtension(checkPi);
		await checkHandlers.get("session_start")({}, {
			sessionManager: { getSessionId: () => "check-parent" },
			cwd: sandbox,
			isProjectTrusted: () => false,
			mode: "rpc",
			hasUI: false,
		});
		const prefixRecord = mk("abcd1234-aaaa-4000-8000-000000000004", "check-parent", { rootRunId: "check-parent", status: "completed" });
		registry.saveRecord(checkAgentDir, prefixRecord);
		const prefixCancel = await checkTools.get("cancel_subagent").execute("cancel-prefix", { target: "abcd1234" }, undefined, undefined, {});
		check("cancel tool accepts displayed run prefix", prefixCancel.details.record.runId === prefixRecord.runId);
		let prefixSendError;
		try { await checkTools.get("send_to_subagent").execute("send-prefix", { target: "abcd1234", message: "hello" }); } catch (error) { prefixSendError = error; }
		check("send tool resolves prefix before checking liveness", prefixSendError?.message.includes("retry with session context"), prefixSendError?.message);
		const checkTool = checkTools.get("check_subagents");
		const checkRecord = (runId, status, extra = {}) => mk(runId, "check-parent", { rootRunId: "check-parent", status, ...extra });
		registry.saveRecord(checkAgentDir, checkRecord("first", "completed", { latestText: "first result" }));
		registry.saveRecord(checkAgentDir, checkRecord("second", "thinking", { activity: "working" }));
		const firstCheck = await checkTool.execute("check-1", { wait: false }, undefined, undefined, {});
		const firstText = firstCheck.content[0].text;
		check("first check returns first result", firstText.includes("first result"), firstText);
		check("first check reports second running", firstText.includes("second") && firstText.includes("still running"), firstText);

		const finishTimer = setTimeout(() => {
			registry.saveRecord(checkAgentDir, checkRecord("second", "completed", { latestText: "second result" }));
		}, 50);
		const waitStarted = Date.now();
		const secondCheck = await checkTool.execute("check-2", { wait: true, timeoutMs: 1000 }, undefined, undefined, {});
		clearTimeout(finishTimer);
		const secondText = secondCheck.content[0].text;
		check("second check returns newly finished result", secondText.includes("second result"), secondText);
		check("second check returns before timeout once child finishes", Date.now() - waitStarted < 800, String(Date.now() - waitStarted));
		check("second check omits previously delivered result", !secondText.includes("first result"), secondText);
		const thirdCheck = await checkTool.execute("check-3", { wait: false }, undefined, undefined, {});
		const thirdText = thirdCheck.content[0].text;
		check("later check omits all delivered results", !thirdText.includes("first result") && !thirdText.includes("second result"), thirdText);
		check("later check explains no new results", thirdText.includes("No new subagent results since the last check."), thirdText);

		// A recursive result belongs to its direct parent, even when the root can inspect it.
		registry.saveRecord(checkAgentDir, checkRecord("owner-child", "completed", { latestText: "child result" }));
		registry.saveRecord(checkAgentDir, mk("owner-grand", "owner-child", {
			rootRunId: "check-parent", depth: 2, status: "completed", latestText: "grandchild result",
		}));
		const rootOwnershipCheck = await checkTool.execute("check-owner-root", { wait: false }, undefined, undefined, {});
		const rootOwnershipText = rootOwnershipCheck.content[0].text;
		const afterRootOwnership = registry.readRecords(checkAgentDir);
		check("root claims its direct child result", afterRootOwnership.find((r) => r.runId === "owner-child")?.resultsDelivered === true);
		check("root does not claim grandchild result", afterRootOwnership.find((r) => r.runId === "owner-grand")?.resultsDelivered !== true);
		check("root can inspect grandchild result read-only", rootOwnershipText.includes("grandchild result") && rootOwnershipText.includes("read-only descendant"), rootOwnershipText);
		const rootRepeat = await checkTool.execute("check-owner-repeat", {}, undefined, undefined, {});
		check("root does not repeat an unclaimed descendant execution", !rootRepeat.content[0].text.includes("grandchild result"));
		check("root observation keeps direct parent ownership", registry.readRecords(checkAgentDir).find((r) => r.runId === "owner-grand")?.resultsDelivered !== true);
		check("check persists observed descendant keys", rootOwnershipCheck.details.seenDescendantResults.length === 1);

		// Messaging is parent -> direct child only; a grandchild is rejected clearly.
		let descendantSendError;
		try {
			await checkTools.get("send_to_subagent").execute("send-descendant", { target: "owner-grand", message: "hello" }, undefined, undefined, {});
		} catch (error) { descendantSendError = error; }
		check("messaging a non-direct descendant is rejected", descendantSendError?.message.includes("not a direct child"), descendantSendError?.message);

		// Targeted checks: an explicit target list, and any/all waiting.
		registry.saveRecord(checkAgentDir, checkRecord("bystander", "completed", { latestText: "bystander result" }));
		registry.saveRecord(checkAgentDir, checkRecord("target-a", "thinking"));
		registry.saveRecord(checkAgentDir, checkRecord("target-b", "thinking"));
		const anyWait = checkTool.execute("check-any", { targets: ["target-a", "target-b"], wait: true, mode: "any", timeoutMs: 2000 }, undefined, undefined, {});
		setTimeout(() => registry.saveRecord(checkAgentDir, checkRecord("target-b", "completed", { latestText: "target-b done" })), 30);
		const anyResult = await anyWait;
		check("targeted any wait returns on the first finish", anyResult.content[0].text.includes("target-b done"), anyResult.content[0].text);
		check("targeted check omits unselected children", !anyResult.content[0].text.includes("bystander"), anyResult.content[0].text);
		registry.saveRecord(checkAgentDir, checkRecord("target-a", "completed", { latestText: "target-a done" }));
		const allResult = await checkTool.execute("check-all", { targets: ["target-a"], wait: true, mode: "all", timeoutMs: 2000 }, undefined, undefined, {});
		check("targeted all wait resolves on the selected target", allResult.content[0].text.includes("target-a done"), allResult.content[0].text);
		registry.saveRecord(checkAgentDir, checkRecord("timeout-target", "thinking"));
		const timeoutStarted = Date.now();
		const timeoutResult = await checkTool.execute("check-timeout", { targets: ["timeout-target"], wait: true, mode: "all", timeoutMs: 300 }, undefined, undefined, {});
		const timeoutElapsed = Date.now() - timeoutStarted;
		check("targeted wait times out with the running snapshot", timeoutElapsed >= 250 && timeoutElapsed < 1500 && timeoutResult.content[0].text.includes("still running"), String(timeoutElapsed));
		registry.saveRecord(checkAgentDir, checkRecord("timeout-target", "completed", { latestText: "timed-out target done" }));
		await checkTool.execute("check-timeout-cleanup", {}, undefined, undefined, {});
		let unknownTargetError;
		try { await checkTool.execute("check-unknown", { targets: ["not-a-real-subagent"] }, undefined, undefined, {}); } catch (error) { unknownTargetError = error; }
		check("unknown check target rejected", unknownTargetError?.message.includes("No subagent matches"), unknownTargetError?.message);
		await checkTool.execute("check-target-cleanup", {}, undefined, undefined, {});

		const childHandlers = new Map();
		const childTools = new Map();
		const childPi = {
			...checkPi,
			on: (event, handler) => childHandlers.set(event, handler),
			registerTool: (tool) => childTools.set(tool.name, tool),
		};
		process.env.PI_SUBAGENT_RUN_ID = "owner-child";
		process.env.PI_SUBAGENT_ROOT_ID = "check-parent";
		subagentsExtension(childPi);
		await childHandlers.get("session_start")({}, {
			sessionManager: { getSessionId: () => "owner-child" },
			cwd: sandbox,
			isProjectTrusted: () => false,
			mode: "rpc",
			hasUI: false,
		});
		delete process.env.PI_SUBAGENT_RUN_ID;
		delete process.env.PI_SUBAGENT_ROOT_ID;
		const childOwnershipCheck = await childTools.get("check_subagents").execute("check-owner-child", { wait: false }, undefined, undefined, {});
		check("child receives grandchild result", childOwnershipCheck.content[0].text.includes("grandchild result"), childOwnershipCheck.content[0].text);
		check("child claims grandchild result", registry.readRecords(checkAgentDir).find((r) => r.runId === "owner-grand")?.resultsDelivered === true);
		const rootAfterParentClaim = await checkTool.execute("check-owner-root-again", { wait: false }, undefined, undefined, {});
		check("root omits grandchild after parent claims it", !rootAfterParentClaim.content[0].text.includes("grandchild result"), rootAfterParentClaim.content[0].text);

		let automaticGrandchildMessages = 0;
		childPi.sendMessage = async (message) => {
			if (message.content.includes("automatic-grand")) automaticGrandchildMessages++;
		};
		registry.saveRecord(checkAgentDir, mk("automatic-grand", "owner-child", {
			rootRunId: "check-parent", depth: 2, status: "thinking", latestText: "automatic grandchild result",
		}));
		await childTools.get("cancel_subagent").execute("cancel-automatic-grand", { target: "automatic-grand" }, undefined, undefined, {});
		for (let i = 0; i < 100 && automaticGrandchildMessages < 1; i++) await new Promise((r) => setTimeout(r, 25));
		check("automatic grandchild delivery reaches direct parent", automaticGrandchildMessages === 1, String(automaticGrandchildMessages));
		check("automatic grandchild delivery is claimed by direct parent", registry.readRecords(checkAgentDir).find((r) => r.runId === "automatic-grand")?.resultsDelivered === true);
		childHandlers.get("session_shutdown")?.({}, { mode: "rpc" });

		// A failed automatic send leaves the result pending and schedules another attempt.
		let automaticSendAttempts = 0;
		checkPi.sendMessage = () => {
			automaticSendAttempts++;
			if (automaticSendAttempts === 1) throw new Error("temporary send failure");
		};
		registry.saveRecord(checkAgentDir, checkRecord("retry-child", "thinking"));
		await checkTools.get("cancel_subagent").execute("cancel-retry", { target: "retry-child" }, undefined, undefined, {});
		for (let i = 0; i < 100 && automaticSendAttempts < 1; i++) await new Promise((r) => setTimeout(r, 25));
		check("failed automatic send leaves result unclaimed", registry.readRecords(checkAgentDir).find((r) => r.runId === "retry-child")?.resultsDelivered !== true);
		for (let i = 0; i < 100 && automaticSendAttempts < 2; i++) await new Promise((r) => setTimeout(r, 25));
		check("failed automatic send is retried", automaticSendAttempts >= 2, String(automaticSendAttempts));
		check("successful automatic retry claims result", registry.readRecords(checkAgentDir).find((r) => r.runId === "retry-child")?.resultsDelivered === true);

		// An asynchronous send failure must behave like a synchronous one: the
		// result stays pending and the delivery loop retries it.
		let asyncAutomaticSendAttempts = 0;
		checkPi.sendMessage = async () => {
			asyncAutomaticSendAttempts++;
			if (asyncAutomaticSendAttempts === 1) throw new Error("temporary async send failure");
		};
		registry.saveRecord(checkAgentDir, checkRecord("async-retry-child", "thinking"));
		await checkTools.get("cancel_subagent").execute("cancel-async-retry", { target: "async-retry-child" }, undefined, undefined, {});
		for (let i = 0; i < 100 && asyncAutomaticSendAttempts < 1; i++) await new Promise((r) => setTimeout(r, 25));
		check("async failed automatic send leaves result unclaimed", registry.readRecords(checkAgentDir).find((r) => r.runId === "async-retry-child")?.resultsDelivered !== true);
		for (let i = 0; i < 100 && asyncAutomaticSendAttempts < 2; i++) await new Promise((r) => setTimeout(r, 25));
		check("async failed automatic send is retried", asyncAutomaticSendAttempts >= 2, String(asyncAutomaticSendAttempts));
		check("successful async automatic retry claims result", registry.readRecords(checkAgentDir).find((r) => r.runId === "async-retry-child")?.resultsDelivered === true);

		// A busy parent must not queue reports behind its final answer or hide
		// them from checks. Model a real Pi follow-up queue, not immediate delivery.
		const queuedReports = [];
		checkPi.sendMessage = (message, options) => queuedReports.push({ message, options });
		checkHandlers.get("agent_start")({}, {});
		registry.saveRecord(checkAgentDir, checkRecord("busy-check", "thinking"));
		await checkTools.get("cancel_subagent").execute("cancel-busy", { target: "busy-check" }, undefined, undefined, {});
		await new Promise((r) => setTimeout(r, 1100));
		check("busy parent does not queue automatic follow-ups", queuedReports.length === 0);
		check("busy result remains available for explicit check", registry.readRecords(checkAgentDir).find((r) => r.runId === "busy-check")?.resultsDelivered !== true);
		const busyCheck = await checkTool.execute("busy-check", {}, undefined, undefined, {});
		check("explicit check consumes a result while parent is busy", busyCheck.content[0].text.includes("### busy-check"));

		registry.saveRecord(checkAgentDir, checkRecord("boundary-child", "completed", { latestText: "fresh boundary result", executionId: "first" }));
		const toolEvent = { toolName: "read", content: [{ type: "text", text: "original tool output" }] };
		const aborted = new AbortController(); aborted.abort();
		const abortedDelivery = checkHandlers.get("tool_result")(toolEvent, { signal: aborted.signal });
		check("aborted tool boundary does not consume reports", abortedDelivery === undefined && !registry.readRecords(checkAgentDir).find((r) => r.runId === "boundary-child")?.resultsDelivered);
		checkHandlers.get("agent_settled")();
		await new Promise((r) => setTimeout(r, 50));
		check("Esc does not wake the parent with pending reports", queuedReports.length === 0);
		checkHandlers.get("agent_start")({}, {});
		const boundary = checkHandlers.get("tool_result")(toolEvent, {});
		check("tool boundary preserves original output", boundary.content[0].text === "original tool output");
		check("tool boundary includes fresh report", boundary.content[1].text.includes("fresh boundary result"));
		check("next sibling tool result does not repeat report", checkHandlers.get("tool_result")(toolEvent, {}) === undefined);
		const afterBoundary = await checkTool.execute("after-boundary", {}, undefined, undefined, {});
		check("check does not repeat boundary-delivered report", !afterBoundary.content[0].text.includes("fresh boundary result"));

		// Repeated executions replace the unread snapshot rather than creating
		// one queued prompt per completion.
		registry.saveRecord(checkAgentDir, checkRecord("boundary-child", "completed", { latestText: "superseded result", executionId: "second" }));
		registry.saveRecord(checkAgentDir, checkRecord("boundary-child", "completed", { latestText: "latest result", executionId: "third" }));
		registry.saveRecord(checkAgentDir, checkRecord("idle-batch", "completed", { latestText: "other result" }));
		checkHandlers.get("agent_settled")();
		await new Promise((r) => setTimeout(r, 50));
		check("settled parent receives one fresh batch", queuedReports.length === 1);
		check("idle batch uses latest execution only", queuedReports[0]?.message.content.includes("latest result") && !queuedReports[0]?.message.content.includes("superseded result"));
		check("idle batch contains other finished child", queuedReports[0]?.message.content.includes("other result"));
		check("idle batch still wakes the parent", queuedReports[0]?.options.triggerTurn === true);
		checkHandlers.get("agent_settled")();
		await new Promise((r) => setTimeout(r, 50));
		check("settling after acknowledgement does not replay reports", queuedReports.length === 1);

		registry.saveRecord(checkAgentDir, mk("owner-grand", "owner-child", {
			rootRunId: "check-parent", depth: 2, status: "completed", latestText: "new grandchild execution", executionId: "new-execution",
		}));
		const newDescendant = await checkTool.execute("new-descendant", {}, undefined, undefined, {});
		check("root sees a new descendant execution", newDescendant.content[0].text.includes("new grandchild execution"));
		checkHandlers.get("session_tree")({}, { sessionManager: { getBranch: () => [] } });
		const beforeReceipt = await checkTool.execute("before-receipt", {}, undefined, undefined, {});
		check("tree before receipt makes descendant visible again", beforeReceipt.content[0].text.includes("new grandchild execution"));
		checkHandlers.get("session_tree")({}, { sessionManager: { getBranch: () => [
			{ type: "message", message: { role: "toolResult", toolName: "check_subagents", details: newDescendant.details } },
		] } });
		check("tree restores descendant receipt", !(await checkTool.execute("restored-receipt", {}, undefined, undefined, {})).content[0].text.includes("new grandchild execution"));

		checkHandlers.get("agent_start")({}, {});
		registry.saveRecord(checkAgentDir, checkRecord("marker-good", "completed", { latestText: "good marker report" }));
		registry.saveRecord(checkAgentDir, checkRecord("marker-failure", "completed", { latestText: "failed marker report" }));
		let faultResult;
		try {
			failMarkerWritesFor = "marker-failure";
			faultResult = checkHandlers.get("tool_result")(toolEvent, {});
		} finally { failMarkerWritesFor = undefined; }
		check("marker failure injection exercised", injectedMarkerFailures === 1);
		check("partial marker failure preserves all reports", faultResult.content[1].text.includes("good marker report") && faultResult.content[1].text.includes("failed marker report"));
		check("in-memory receipt prevents failed-marker replay", checkHandlers.get("tool_result")(toolEvent, {}) === undefined);
		check("tool result contains durable delivery receipts", faultResult.details.resultKeys.length === 2);
		await checkHandlers.get("session_shutdown")({}, { mode: "rpc" });
		await checkHandlers.get("session_start")({}, {
			sessionManager: {
				getSessionId: () => "check-parent",
				getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "read", details: faultResult.details } }],
			},
			cwd: sandbox, isProjectTrusted: () => false, mode: "rpc", hasUI: false,
		});
		const restoredDirect = await checkTool.execute("restored-direct", {}, undefined, undefined, {});
		check("reload restores delivery after marker failure", !restoredDirect.content[0].text.includes("failed marker report"));
	} finally {
		checkHandlers.get("session_shutdown")?.({}, { mode: "rpc" });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
		else process.env.PI_SUBAGENT_RUN_ID = previousRunId;
		if (previousRootId === undefined) delete process.env.PI_SUBAGENT_ROOT_ID;
		else process.env.PI_SUBAGENT_ROOT_ID = previousRootId;
	}

	registry.saveRecord(agentDir2, mk("child1", "root", { status: "thinking" }));
	registry.saveRecord(agentDir2, mk("grand", "child1", { status: "running_tool" }));
	const child1StaleWriter = registry.readRecords(agentDir2).find((r) => r.runId === "child1");
	await spawn.cancelSubagent(agentDir2, child1StaleWriter);
	const cancelledTree = registry.readRecords(agentDir2);
	check("cancelling parent cancels descendants", ["child1", "grand"].every((id) => cancelledTree.find((r) => r.runId === id)?.status === "cancelled"));
	fs.writeFileSync(
		path.join(agentDir2, "subagents", "runs", "child1.json"),
		`${JSON.stringify({ ...child1StaleWriter, status: "completed", latestText: "stale completion" })}\n`,
	);
	const monotonicCancel = registry.readRecords(agentDir2).find((r) => r.runId === "child1");
	check("stale record writer cannot undo cancellation", monotonicCancel?.status === "cancelled", monotonicCancel?.status);
	registry.clearRecordPid(agentDir2, { ...monotonicCancel, pid: 2147483647 });
	fs.writeFileSync(
		path.join(agentDir2, "subagents", "runs", "child1.json"),
		`${JSON.stringify({ ...monotonicCancel, pid: 2147483647 })}\n`,
	);
	const clearedPid = registry.readRecords(agentDir2).find((r) => r.runId === "child1")?.pid;
	check("stale record writer cannot restore cleared PID", clearedPid === undefined, String(clearedPid));
	registry.saveRecord(agentDir2, mk("stale", "root", { status: "running_tool", pid: 2147483647 }));
	const stale = registry.readRecords(agentDir2).find((r) => r.runId === "stale");
	check("dead pid reconciled to failed", stale && stale.status === "failed", stale && stale.status);

	// --- events ---
	const rec = mk("x", "root", { status: "starting", activity: "starting" });
	const state = { finalText: "" };
	for (const e of [
		{ type: "session", id: "sess-1" },
		{ type: "agent_start" },
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello " } },
		{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } },
		{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false },
		{
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "hello done" }], provider: "p", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } }, stopReason: "stop", timestamp: 1 },
		},
		{ type: "agent_end", messages: [] },
	]) events.applyChildEvent(rec, state, e);
	check("session id captured", rec.sessionId === "sess-1", rec.sessionId);
	check("tool cleared after end", rec.currentTool === undefined, String(rec.currentTool));
	check("final text", state.finalText === "hello done", state.finalText);
	check("usage summed", rec.usage.input === 10 && rec.usage.cost === 0.001, JSON.stringify(rec.usage));
	check("idle after agent_end", rec.status === "idle", rec.status);

	// --- gate ---
	const g1 = new spawn.ConcurrencyGate();
	const slots = await Promise.all([g1.acquire(-1), g1.acquire(-1), g1.acquire(-1)]);
	check("unlimited acquires immediately", slots.length === 3);
	slots.forEach((r) => r());
	const g2 = new spawn.ConcurrencyGate();
	const r1 = await g2.acquire(1);
	let secondResolved = false;
	const p2 = g2.acquire(1).then((r) => { secondResolved = true; return r; });
	await new Promise((r) => setTimeout(r, 50));
	check("second acquire waits at limit 1", secondResolved === false);
	r1();
	const r2 = await p2;
	check("second acquire resolves after release", secondResolved === true);
	r2();

	// --- capability narrowing ---
	const inheritedTools = spawn.resolveChildTools(undefined, ["read", "spawn_agent", "read"]);
	check("omitted tools inherit active tools", JSON.stringify(inheritedTools) === JSON.stringify(["read", "spawn_agent"]), JSON.stringify(inheritedTools));
	const narrowedTools = spawn.resolveChildTools(["read"], ["read", "bash", "spawn_agent"]);
	check("explicit tools may narrow active tools", JSON.stringify(narrowedTools) === JSON.stringify(["read"]), JSON.stringify(narrowedTools));
	check("explicit empty tools stays empty", spawn.resolveChildTools([], ["read", "spawn_agent"]).length === 0);
	for (const [label, tools] of [["blank", ["  "]], ["surrounding whitespace", [" read"]], ["comma", ["read,bash"]], ["control", ["read\n"]]]) {
		let threw = false;
		try { spawn.resolveChildTools(tools, ["read", "bash"]); } catch { threw = true; }
		check(`${label} tool name rejected`, threw);
	}
	let escalationThrew = false;
	try { spawn.resolveChildTools(["read", "write"], ["read"]); } catch (error) { escalationThrew = String(error).includes("subset"); }
	check("explicit tools cannot add a parent-inactive tool", escalationThrew);
	const safeSubset = spawn.resolveChildTools(["read"], ["read", "bad,parent-tool"]);
	check("excluded unserializable parent tool does not block a subset", JSON.stringify(safeSubset) === JSON.stringify(["read"]), JSON.stringify(safeSubset));
	check("empty model scope keeps legacy model selection", spawn.resolveChildModel("fuzzy-model", []) === "fuzzy-model");
	const modelScope = [{ provider: "one", id: "shared" }, { provider: "two", id: "other" }];
	check("scoped bare model canonicalized", spawn.resolveChildModel("OTHER", modelScope) === "two/other");
	check("scoped canonical model matching ignores case", spawn.resolveChildModel("TWO/OTHER", modelScope) === "two/other");
	let modelScopeThrew = false;
	try { spawn.resolveChildModel("outside", modelScope); } catch (error) { modelScopeThrew = String(error).includes("outside"); }
	check("out-of-scope child model rejected", modelScopeThrew);
	let ambiguousModelThrew = false;
	try { spawn.resolveChildModel("shared", [...modelScope, { provider: "three", id: "shared" }]); } catch (error) { ambiguousModelThrew = String(error).includes("ambiguous"); }
	check("ambiguous bare scoped model rejected", ambiguousModelThrew);

	// --- status widget: outstanding (unread) descendants only ---
	const theme = { fg: (_c, t) => String(t), bg: (_c, t) => String(t), bold: (t) => String(t) };
	const tui = { requestRender: () => {} };
	registry.saveRecord(agentDir2, mk("alpha", "root2", { status: "running_tool", currentTool: "bash npm test", model: "prov/model-x" }));
	registry.saveRecord(agentDir2, mk("beta", "root2"));
	let widget = new SubagentStatusWidget(tui, theme, agentDir2, "root2");
	const shown = widget.render(100);
	check("widget shows outstanding children", shown.some((l) => l.includes("alpha")) && shown.some((l) => l.includes("beta")), shown.join(" | "));
	check("widget shows model and activity", shown.some((l) => l.includes("prov/model-x") && l.includes("npm test")), shown.join(" | "));
	const strip = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");
	for (const w of [20, 80, 200]) {
		const over = widget.render(w).filter((l) => [...strip(l)].length > w);
		check(`widget respects width ${w}`, over.length === 0, over.join(" | "));
	}
	widget.dispose();

	// A finished child stays visible until its result is delivered, then disappears.
	registry.saveRecord(agentDir2, mk("gamma", "root2", { status: "completed" }));
	widget = new SubagentStatusWidget(tui, theme, agentDir2, "root2");
	check("widget shows an unread finished child", widget.render(100).some((l) => l.includes("gamma")));
	registry.markRecordResultState(agentDir2, registry.readRecords(agentDir2).find((r) => r.runId === "gamma"), "resultsDelivered");
	widget.invalidate();
	check("widget hides a child once its result is delivered", !widget.render(100).some((l) => l.includes("gamma")), widget.render(100).join(" | "));
	check("widget keeps running children after a delivery", widget.render(100).some((l) => l.includes("alpha")));
	widget.dispose();

	// Grandchildren are nested until their direct parent reads them.
	const agentDir3 = path.join(sandbox, "widget-tree");
	registry.saveRecord(agentDir3, mk("root", ""));
	registry.saveRecord(agentDir3, mk("a", "root", { name: "a", status: "running_tool", currentTool: "bash npm test" }));
	registry.saveRecord(agentDir3, mk("a1", "a", { name: "a1" }));
	registry.saveRecord(agentDir3, mk("b", "root", { name: "b" }));
	widget = new SubagentStatusWidget(tui, theme, agentDir3, "root");
	const nested = widget.render(100);
	check("widget nests grandchildren", nested.some((l) => l.includes("a1")) && nested.some((l) => l.includes("b")), nested.join(" | "));
	widget.dispose();

	// Widget refresh must not rescan the registry when nothing changed (perf:
	// the 500ms... now 2000ms tick runs on the TUI thread during select/copy).
	check("widget poll interval is 2000ms", POLL_MS === 2000, String(POLL_MS));
	{
		const dir = path.join(sandbox, "widget-cache");
		registry.saveRecord(dir, mk("w1", "wroot", { status: "running_tool", currentTool: "bash x" }));
		const countingTui = { requestRender: () => {} };
		const cached = new SubagentStatusWidget(countingTui, theme, dir, "wroot");
		check("widget shows running child", cached.render(100).some((l) => l.includes("w1")));
		countReaddirFor = path.join(dir, "subagents", "runs");
		readdirScanCount = 0;
		try {
			cached.refresh();
		} finally {
			countReaddirFor = null;
		}
		check("unchanged widget refresh performs no registry scan", readdirScanCount === 0, `scans=${readdirScanCount}`);
		registry.saveRecord(dir, mk("w2", "wroot", { status: "thinking" }));
		cached.refresh();
		check("widget picks up new children after refresh", cached.render(100).some((l) => l.includes("w2")), cached.render(100).join(" | "));
		cached.dispose();
	}

	// --- async spawn: returns immediately, settles in background, auto-cancels ---
	const fakePi = path.join(HERE, "fake-pi.cjs");
	const spawnDir = path.join(sandbox, "spawn");
	fs.mkdirSync(spawnDir, { recursive: true });
	const spawnAgentDir = path.join(sandbox, "spawn-agent");
	fs.mkdirSync(spawnAgentDir, { recursive: true });
	const baseCtx = () => ({
		agentDir: spawnAgentDir,
		parentRunId: "parent",
		rootRunId: "parent",
		currentDepth: 0,
		settings: { maxDepth: 2, maxConcurrency: -1 },
		parentModel: "fake/parent",
		parentThinking: "off",
		parentTools: ["read", "spawn_agent"],
		scopedModels: [],
		parentCwd: spawnDir,
		projectTrusted: false,
	});
	process.env.PI_SUBAGENT_COMMAND = fakePi;

	// --- project trust follows canonical paths ---
	const fakeArgsDir = path.join(sandbox, "trust-args");
	process.env.FAKE_ARGS_DIR = fakeArgsDir;
	const internalDir = path.join(spawnDir, "internal");
	const externalDir = path.join(sandbox, "external-project");
	const externalLink = path.join(spawnDir, "external-link");
	fs.mkdirSync(internalDir);
	fs.mkdirSync(externalDir);
	fs.symlinkSync(externalDir, externalLink, process.platform === "win32" ? "junction" : "dir");
	const internalRec = await spawn.startSubagent(
		{ task: "trusted internal", cwd: internalDir },
		{ ...baseCtx(), projectTrusted: true, persistAfterSettled: false },
	);
	const externalRec = await spawn.startSubagent(
		{ task: "untrusted symlink", cwd: externalLink },
		{ ...baseCtx(), projectTrusted: true, persistAfterSettled: false },
	);
	for (let i = 0; i < 100; i++) {
		const rows = registry.readRecords(spawnAgentDir);
		if ([internalRec, externalRec].every((record) => rows.find((row) => row.runId === record.runId)?.status === "completed")) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const internalArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${internalRec.runId}.json`), "utf8"));
	const externalArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${externalRec.runId}.json`), "utf8"));
	check("trusted canonical descendant inherits approval", internalArgs.includes("--approve"), JSON.stringify(internalArgs));
	check("symlink escape does not inherit approval", !externalArgs.includes("--approve"), JSON.stringify(externalArgs));
	check("child cwd is canonicalized", externalRec.cwd === fs.realpathSync(externalDir), externalRec.cwd);

	let requestedModelThrew = false;
	try {
		await spawn.startSubagent({ task: "x", model: "fake/outside" }, { ...baseCtx(), scopedModels: [{ provider: "fake", id: "allowed" }] });
	} catch (error) {
		requestedModelThrew = String(error).includes("outside");
	}
	check("explicitly requested model must be in nonempty parent scope", requestedModelThrew);
	check("inherited in-scope model canonicalized", spawn.resolveInheritedModel("allowed", [{ provider: "fake", id: "allowed" }]) === "fake/allowed");
	check("inherited out-of-scope model kept as-is", spawn.resolveInheritedModel("fake/outside", [{ provider: "fake", id: "allowed" }]) === "fake/outside");
	check("inherited model with empty scope kept", spawn.resolveInheritedModel("anything", []) === "anything");
	const inheritedRec = await spawn.startSubagent(
		{ task: "x" },
		{ ...baseCtx(), scopedModels: [{ provider: "fake", id: "allowed" }], persistAfterSettled: false },
	);
	check("omitting model inherits without the scope check", inheritedRec.model === "fake/parent", inheritedRec.model);
	const defaultRec = await spawn.startSubagent(
		{ task: "x" },
		{ ...baseCtx(), settings: { ...baseCtx().settings, defaultModel: "fake/outside" }, scopedModels: [{ provider: "fake", id: "allowed" }], persistAfterSettled: false },
	);
	check("configured default inherits without the scope check", defaultRec.model === "fake/outside", defaultRec.model);
	let pinThrew = false;
	try {
		await spawn.startSubagent(
			{ task: "x", model: "allowed", thinking: "off" },
			{ ...baseCtx(), scopedModels: [{ provider: "fake", id: "allowed", thinkingLevel: "high" }] },
		);
	} catch (error) {
		pinThrew = String(error).includes("pin");
	}
	check("explicit thinking cannot escape scoped pin", pinThrew);
	check("failed capability validation saves no record", registry.readRecords(spawnAgentDir).length === 4, String(registry.readRecords(spawnAgentDir).length));

	const t0 = Date.now();
	const settled = [];
	const rec1 = await spawn.startSubagent({ task: "say hi", name: "alpha" }, { ...baseCtx(), onSettled: (r) => settled.push(r.status) });
	check("startSubagent returns fast", Date.now() - t0 < 1000, String(Date.now() - t0));
	check("startSubagent returns non-terminal record", !spawn.isTerminalStatus ? rec1.status !== "completed" : true, rec1.status);
	let polled;
	for (let i = 0; i < 100; i++) {
		polled = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
		if (polled && ["completed", "failed"].includes(polled.status)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("background child completes", polled && polled.status === "completed", polled && polled.status);
	check("fake output captured", polled && polled.latestText === "fake done", polled && polled.latestText);
	check("usage captured", polled && polled.usage.input === 10, polled && JSON.stringify(polled.usage));
	const inheritedArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${rec1.runId}.json`), "utf8"));
	check("omitted tools become a child CLI allowlist", inheritedArgs[inheritedArgs.indexOf("--tools") + 1] === "read,spawn_agent", JSON.stringify(inheritedArgs));
	check("empty model scope emits no --models flag", !inheritedArgs.includes("--models"), JSON.stringify(inheritedArgs));
	await new Promise((r) => setTimeout(r, 250));
	check("onSettled fired", settled.includes("completed"), JSON.stringify(settled));

	// Claim/dismiss at settlement while the owning process still has stale flags.
	// A real child close must not resurrect either UI state.
	const closeRec = await spawn.startSubagent({ task: "close after result" }, {
		...baseCtx(), persistAfterSettled: false,
		onSettled: (record) => {
			registry.markRecordResultState(spawnAgentDir, { ...record }, "resultsDelivered");
		},
	});
	let closedResult;
	for (let i = 0; i < 100; i++) {
		closedResult = registry.readRecords(spawnAgentDir).find((r) => r.runId === closeRec.runId);
		if (closedResult?.status === "completed" && closedResult.pid === undefined) break;
		await waitSleep(25);
	}
	check("actual child close clears PID and preserves the delivery claim", closedResult?.status === "completed" && closedResult.pid === undefined && closedResult.resultsDelivered);

	// A finished child resumes from its transcript in a fresh process (new execution).
	const previousResult = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
	const prevExecutionId = previousResult?.executionId;
	check("finished child process is reaped", previousResult?.pid === undefined, String(previousResult?.pid));
	const terminalSend = await spawn.sendSubagentMessage(previousResult, "next result");
	check("terminal send returns false (resume via fresh process)", terminalSend === false, String(terminalSend));
	registry.markRecordResultState(spawnAgentDir, previousResult, "resultsDelivered");
	await spawn.resumeSubagent(previousResult, "next result", baseCtx());
	let continued;
	for (let i = 0; i < 100; i++) {
		continued = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
		if (continued?.status === "completed" && continued.executionId !== prevExecutionId) break;
		await waitSleep(25);
	}
	check("transcript resume resets delivery despite a stale claim", continued?.status === "completed" && continued.executionId !== prevExecutionId && !continued.resultsDelivered, continued && `${continued.status} ${continued.executionId !== prevExecutionId} ${continued.resultsDelivered}`);
	for (let i = 0; i < 100; i++) {
		continued = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
		if (continued?.status === "completed" && continued.pid === undefined) break;
		await waitSleep(25);
	}
	check("resumed child process is reaped after settle", continued?.pid === undefined, String(continued?.pid));

	// Verify the real spawn environment, then reload it as a child/grandchild.
	const unflaggedSpawnEnv = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${rec1.runId}.env.json`), "utf8"));
	check("unflagged spawn exports no flag override", unflaggedSpawnEnv.PI_SUBAGENT_DEPTH_FLAG_OVERRIDE === "0");
	let propagatedSettings = configuredRoot;
	for (const generation of ["child", "grandchild"]) {
		const depthRec = await spawn.startSubagent({ task: "depth propagation" }, {
			...baseCtx(), settings: propagatedSettings, persistAfterSettled: false,
		});
		const envPath = path.join(fakeArgsDir, `${depthRec.runId}.env.json`);
		for (let i = 0; i < 100 && !fs.existsSync(envPath); i++) await new Promise((r) => setTimeout(r, 25));
		const depthEnv = JSON.parse(fs.readFileSync(envPath, "utf8"));
		check(`${generation} spawn exports effective cap and flag provenance`,
			depthEnv.PI_SUBAGENT_MAX_DEPTH === "4" && depthEnv.PI_SUBAGENT_DEPTH_FLAG_OVERRIDE === "1", JSON.stringify(depthEnv));
		propagatedSettings = config.loadSettings({ ...depthOptions, projectTrusted: true, env: depthEnv });
		check(`${generation} reload retains flag cap over file limits`, propagatedSettings.maxDepth === 4, propagatedSettings.maxDepth);
	}

	const noToolsRec = await spawn.startSubagent({ task: "none", tools: [] }, baseCtx());
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === noToolsRec.runId);
		if (row && ["completed", "failed"].includes(row.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const noToolsArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${noToolsRec.runId}.json`), "utf8"));
	check("explicit empty tools emits --no-tools", noToolsArgs.includes("--no-tools") && !noToolsArgs.includes("--tools"), JSON.stringify(noToolsArgs));

	const narrowedRec = await spawn.startSubagent({ task: "narrow", tools: ["read"] }, baseCtx());
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === narrowedRec.runId);
		if (row && ["completed", "failed"].includes(row.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const narrowedArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${narrowedRec.runId}.json`), "utf8"));
	check("explicit tools remove recursive spawn when excluded", narrowedArgs[narrowedArgs.indexOf("--tools") + 1] === "read", JSON.stringify(narrowedArgs));

	const scopedRec = await spawn.startSubagent(
		{ task: "scoped", model: "allowed" },
		{ ...baseCtx(), scopedModels: [{ provider: "fake", id: "allowed", thinkingLevel: "high" }, { provider: "fake", id: "other" }] },
	);
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === scopedRec.runId);
		if (row && ["completed", "failed"].includes(row.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const scopedArgs = JSON.parse(fs.readFileSync(path.join(fakeArgsDir, `${scopedRec.runId}.json`), "utf8"));
	check("bare scoped child model becomes canonical", scopedArgs[scopedArgs.indexOf("--model") + 1] === "fake/allowed", JSON.stringify(scopedArgs));
	check("parent model scope propagates to child CLI", scopedArgs[scopedArgs.indexOf("--models") + 1] === "fake/allowed:high,fake/other", JSON.stringify(scopedArgs));
	check("scoped pin is applied as --thinking", scopedArgs[scopedArgs.indexOf("--thinking") + 1] === "high", JSON.stringify(scopedArgs));
	delete process.env.FAKE_ARGS_DIR;

	process.env.FAKE_MODE = "split-utf8";
	process.env.FAKE_TEXT = "unicode 😀 survives";
	const unicodeRec = await spawn.startSubagent({ task: "unicode", name: "unicode-child" }, baseCtx());
	delete process.env.FAKE_MODE;
	delete process.env.FAKE_TEXT;
	let unicodeDone;
	for (let i = 0; i < 100; i++) {
		unicodeDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === unicodeRec.runId);
		if (unicodeDone?.status === "completed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check("split UTF-8 stdout is decoded intact", unicodeDone?.latestText === "unicode 😀 survives", unicodeDone?.latestText);

	// Messaging a finished child resumes it from its transcript in a fresh process.
	const finishedRow = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
	const finishedExec = finishedRow?.executionId;
	await spawn.resumeSubagent(finishedRow, "focus on tests", baseCtx());
	for (let i = 0; i < 100; i++) {
		polled = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec1.runId);
		if (polled && polled.status === "completed" && polled.executionId !== finishedExec) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	check("finished child resumes as a new execution", polled && polled.executionId !== finishedExec && polled.status === "completed", polled && `${polled.status} ${polled.executionId === finishedExec}`);

	// followUp mode to a running child: accepted, queued behind current work.
	process.env.FAKE_DELAY_MS = "800";
	const followRec = await spawn.startSubagent({ task: "follow-me", name: "follow-child" }, baseCtx());
	let followRow;
	for (let i = 0; i < 100; i++) {
		followRow = registry.readRecords(spawnAgentDir).find((r) => r.runId === followRec.runId);
		if (followRow && ["thinking", "running_tool"].includes(followRow.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const followAccepted = await spawn.sendSubagentMessage(followRow, "after your work", undefined, "followUp");
	delete process.env.FAKE_DELAY_MS;
	check("followUp to a running child is accepted", followAccepted === true);
	let followDone;
	for (let i = 0; i < 100; i++) {
		followDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === followRec.runId);
		if (followDone?.status === "completed" && followDone.latestText === "steered: after your work") break;
		await new Promise((r) => setTimeout(r, 50));
	}
	check("followUp executes as its own turn", followDone?.latestText === "steered: after your work", followDone && `${followDone.status} ${followDone.latestText}`);

	// invalid modes are rejected with a clear error.
	let invalidModeError;
	try {
		await checkTools.get("send_to_subagent").execute("send-bad-mode", { target: followRec.runId, message: "x", mode: "bogus" }, undefined, undefined, {});
	} catch (error) { invalidModeError = error; }
	check("invalid send mode rejected", invalidModeError?.message.includes('"steer" or "followUp"'), invalidModeError?.message);
	let directModeError;
	try {
		await spawn.sendSubagentMessage(followRow, "x", undefined, "bogus");
	} catch (error) { directModeError = error; }
	check("invalid direct send mode rejected", directModeError?.message.includes('"steer" or "followUp"'), directModeError?.message);

	process.env.FAKE_DELAY_MS = "100";
	const immediateRec = await spawn.startSubagent({ task: "initial", name: "immediate-child" }, baseCtx());
	const immediateAccepted = await spawn.sendSubagentMessage(immediateRec, "immediate steer");
	delete process.env.FAKE_DELAY_MS;
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === immediateRec.runId);
		if (row?.latestText === "steered: immediate steer" && row.status === "completed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const immediateDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === immediateRec.runId);
	check("immediate steering waits for RPC startup", immediateAccepted && immediateDone?.latestText === "steered: immediate steer", immediateDone?.latestText);

	let uiRequest;
	const uiRec = await spawn.startSubagent({ task: "ui-request", name: "ui-child" }, {
		...baseCtx(),
		onUiRequest: async (_record, request) => {
			uiRequest = request;
			return { value: "approved" };
		},
	});
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === uiRec.runId);
		if (row && row.status === "completed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const uiDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === uiRec.runId);
	check("child UI request forwarded", uiRequest && uiRequest.method === "select", uiRequest && JSON.stringify(uiRequest));
	check("child UI response returned", uiDone && uiDone.latestText === "ui: approved", uiDone && uiDone.latestText);

	const rejectedRec = await spawn.startSubagent({ task: "reject", name: "rejected-child" }, baseCtx());
	for (let i = 0; i < 100; i++) {
		const row = registry.readRecords(spawnAgentDir).find((r) => r.runId === rejectedRec.runId);
		if (row?.status === "failed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const rejectedDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === rejectedRec.runId);
	check("rejected RPC prompt fails without hanging", rejectedDone?.status === "failed" && rejectedDone.error?.includes("fake rejection"), rejectedDone && `${rejectedDone.status} ${rejectedDone.error}`);

	process.env.FAKE_MODE = "ignore-state";
	const timeoutRec = await spawn.startSubagent(
		{ task: "never starts", name: "timeout-child" },
		{ ...baseCtx(), rpcRequestTimeoutMs: 1000, rpcStartupTimeoutMs: 100 },
	);
	delete process.env.FAKE_MODE;
	let timeoutDone;
	for (let i = 0; i < 100; i++) {
		timeoutDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === timeoutRec.runId);
		if (timeoutDone?.status === "failed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check("RPC startup has a deadline", timeoutDone?.error?.includes("startup timed out"), timeoutDone && `${timeoutDone.status} ${timeoutDone.error}`);

	// Timeouts/aborts apply to a running child's in-flight RPC (hang = no response).
	process.env.FAKE_DELAY_MS = "5000";
	const boundedRec = await spawn.startSubagent(
		{ task: "ready", name: "bounded-child" },
		{ ...baseCtx(), rpcRequestTimeoutMs: 100 },
	);
	let boundedLive;
	for (let i = 0; i < 100; i++) {
		boundedLive = registry.readRecords(spawnAgentDir).find((r) => r.runId === boundedRec.runId);
		if (boundedLive && ["thinking", "running_tool"].includes(boundedLive.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const abortController = new AbortController();
	const abortTimer = setTimeout(() => abortController.abort(), 50);
	let abortError;
	try { await spawn.sendSubagentMessage(boundedLive, "hang", abortController.signal); } catch (error) { abortError = String(error); }
	clearTimeout(abortTimer);
	check("aborted RPC request rejects promptly", abortError?.includes("aborted"), abortError);
	let requestError;
	try {
		const stillRunning = registry.readRecords(spawnAgentDir).find((r) => r.runId === boundedRec.runId);
		if (stillRunning && !registry.isTerminalStatus(stillRunning.status)) {
			await spawn.sendSubagentMessage(stillRunning, "hang");
		}
	} catch (error) { requestError = String(error); }
	delete process.env.FAKE_DELAY_MS;
	check("RPC requests have a deadline", requestError?.includes("request timed out") || requestError?.includes("no longer running"), requestError);

	process.env.FAKE_MODE = "close-stdin";
	const writeRec = await spawn.startSubagent(
		{ task: "cannot write", name: "write-child" },
		{ ...baseCtx(), rpcRequestTimeoutMs: 2000, rpcStartupTimeoutMs: 2000 },
	);
	delete process.env.FAKE_MODE;
	let writeDone;
	for (let i = 0; i < 100; i++) {
		writeDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === writeRec.runId);
		if (writeDone?.status === "failed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check("RPC stdin errors fail without waiting for deadline", writeDone?.status === "failed" && !writeDone.error?.includes("timed out"), writeDone && `${writeDone.status} ${writeDone.error}`);

	for (const mode of ["large-image", "large-aggregate"]) {
		for (const limit of [undefined, 1024 * 1024]) {
			process.env.FAKE_MODE = mode;
			const rec = await spawn.startSubagent(
				{ task: "image payload", name: mode },
				{ ...baseCtx(), persistAfterSettled: false, settings: { ...baseCtx().settings, rpcMaxLineChars: limit } },
			);
			delete process.env.FAKE_MODE;
			let done;
			for (let i = 0; i < 200; i++) {
				done = registry.readRecords(spawnAgentDir).find((r) => r.runId === rec.runId);
				if (done && ["completed", "failed"].includes(done.status) && !done.pid) break;
				await new Promise((r) => setTimeout(r, 25));
			}
			check(`${mode} ${limit ? "fails above configured bound" : "completes above 1 MiB"}`,
				limit ? done?.status === "failed" && done.error?.includes(`stdout line exceeded ${limit}`)
					: done?.status === "completed" && done.latestText === (process.env.FAKE_TEXT ?? "fake done"),
				done && `${done.status} ${done.error ?? done.latestText}`);
			check(`${mode} child closed after payload test`, !done?.pid);
		}
	}

	process.env.FAKE_MODE = "oversized-line";
	process.env.FAKE_LINE_LENGTH = "4096";
	const oversizedRec = await spawn.startSubagent(
		{ task: "too much stdout", name: "oversized-child" },
		{ ...baseCtx(), stdoutLineLimit: 512 },
	);
	delete process.env.FAKE_MODE;
	delete process.env.FAKE_LINE_LENGTH;
	let oversizedDone;
	for (let i = 0; i < 100; i++) {
		oversizedDone = registry.readRecords(spawnAgentDir).find((r) => r.runId === oversizedRec.runId);
		if (oversizedDone?.status === "failed") break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check("unterminated RPC stdout line is capped", oversizedDone?.error?.includes("stdout line exceeded 512"), oversizedDone && `${oversizedDone.status} ${oversizedDone.error}`);

	process.env.FAKE_EXIT = "1";
	const failRec = await spawn.startSubagent({ task: "fail", name: "failer" }, { ...baseCtx(), onSettled: (r) => settled.push(r.status) });
	delete process.env.FAKE_EXIT;
	for (let i = 0; i < 100; i++) {
		polled = registry.readRecords(spawnAgentDir).find((r) => r.runId === failRec.runId);
		if (polled && ["completed", "failed"].includes(polled.status)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("failing child marked failed", polled && polled.status === "failed" && (polled.error || "").includes("fake failure"), polled && `${polled.status} ${polled.error}`);

	// depth and thinking validation still throw synchronously
	let thinkingThrew = false;
	try {
		await spawn.startSubagent({ task: "x", thinking: "ultra" }, baseCtx());
	} catch (error) {
		thinkingThrew = String(error).includes("thinking level");
	}
	check("per-spawn invalid thinking throws", thinkingThrew);

	let depthThrew = false;
	try {
		await spawn.startSubagent({ task: "x" }, { ...baseCtx(), currentDepth: 2 });
	} catch (error) {
		depthThrew = String(error).includes("depth limit");
	}
	check("depth limit throws at spawn", depthThrew);

	// Cancel stops the child process; resume restarts it from the transcript.
	const slowRec = await spawn.startSubagent({ task: "slow", name: "slowpoke" }, { ...baseCtx() });
	let slowRow;
	for (let i = 0; i < 100; i++) {
		slowRow = registry.readRecords(spawnAgentDir).find((r) => r.runId === slowRec.runId);
		if (slowRow && ["thinking", "running_tool", "idle", "completed"].includes(slowRow.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	const cancelled = await spawn.cancelSubagent(spawnAgentDir, slowRec);
	check("cancel marks cancelled", cancelled.status === "cancelled", cancelled.status);
	let cancelledRow;
	for (let i = 0; i < 100; i++) {
		cancelledRow = registry.readRecords(spawnAgentDir).find((r) => r.runId === slowRec.runId);
		if (cancelledRow?.status === "cancelled" && cancelledRow.pid === undefined) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check("cancel reaps the child process", cancelledRow?.pid === undefined && !registry.isProcessAlive(cancelledRow?.pid), String(cancelledRow?.pid));
	// A cancelled child is terminal: direct send refuses, resume starts a new execution.
	const executionsBefore = cancelledRow?.executionId;
	const cancelledSend = await spawn.sendSubagentMessage(cancelledRow, "resume after cancel");
	check("terminal send returns false", cancelledSend === false, String(cancelledSend));
	await spawn.resumeSubagent(cancelledRow, "resume after cancel", baseCtx());
	let resumed;
	for (let i = 0; i < 100; i++) {
		resumed = registry.readRecords(spawnAgentDir).find((r) => r.runId === slowRec.runId);
		if (resumed?.status === "completed" && resumed.executionId !== executionsBefore) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	check("cancelled child resumes from transcript as a new execution", resumed?.status === "completed" && resumed.executionId !== executionsBefore, resumed && `${resumed.status} ${resumed.executionId === executionsBefore}`);
	await spawn.terminateOwnedSubagents([slowRec.runId]);
	const closedSlow = registry.readRecords(spawnAgentDir).find((r) => r.runId === slowRec.runId);
	check("shutdown leaves no live child", !registry.isProcessAlive(closedSlow?.pid), String(closedSlow?.pid));
	check("child close persists PID clearing", closedSlow?.pid === undefined, String(closedSlow?.pid));

	// Resume slot semantics: a resumed turn holds the gate while running, frees after.
	const slotCtx = { ...baseCtx(), settings: { maxDepth: 2, maxConcurrency: 1 } };
	const kept = await spawn.startSubagent({ task: "keep-slot", name: "keep-slot" }, slotCtx);
	for (let i = 0; i < 100; i++) {
		if (registry.readRecords(spawnAgentDir).find((r) => r.runId === kept.runId)?.status === "completed") break;
		await waitSleep(25);
	}
	const keptRowOf = () => registry.readRecords(spawnAgentDir).find((r) => r.runId === kept.runId);
	await spawn.resumeSubagent(keptRowOf(), "delay-rpc 400", slotCtx);
	let sawFull = false;
	for (let i = 0; i < 200; i++) {
		if (spawn.gate.isFull(1)) { sawFull = true; break; }
		if (keptRowOf()?.status === "completed") break;
		await waitSleep(10);
	}
	check("resumed turn holds its slot while running", sawFull, keptRowOf()?.status);
	let keptRow;
	for (let i = 0; i < 200; i++) {
		keptRow = keptRowOf();
		if (keptRow?.status === "completed" && keptRow.pid === undefined) break;
		await waitSleep(25);
	}
	check("resumed turn finishes and frees its slot", keptRow?.status === "completed" && !spawn.gate.isFull(1), keptRow && `${keptRow.status} full=${spawn.gate.isFull(1)}`);
	check("resumed child process is reaped", keptRow?.pid === undefined, String(keptRow?.pid));
	await spawn.terminateOwnedSubagents([kept.runId]);

	// Cancelling while a resume waits for a slot keeps it cancelled, no leak.
	const contRec = await spawn.startSubagent({ task: "cont", name: "cont-cancel" }, slotCtx);
	const contRowOf = () => registry.readRecords(spawnAgentDir).find((r) => r.runId === contRec.runId);
	for (let i = 0; i < 100; i++) {
		if (contRowOf()?.status === "completed") break;
		await waitSleep(25);
	}
	const heldSlot = await spawn.gate.acquire(1);
	await spawn.resumeSubagent(contRowOf(), "resume after slot", slotCtx);
	let contQueued = false;
	for (let i = 0; i < 200; i++) {
		if (contRowOf()?.status === "queued") { contQueued = true; break; }
		await waitSleep(10);
	}
	check("resume waits as queued while the slot is held", contQueued, contRowOf()?.status);
	await spawn.cancelSubagent(spawnAgentDir, contRowOf());
	let contFinal;
	for (let i = 0; i < 200; i++) {
		contFinal = contRowOf();
		if (contFinal?.status === "cancelled" && !spawn.gate.isFull(1)) break;
		await waitSleep(10);
	}
	check("cancel keeps a queued resume cancelled", contFinal?.status === "cancelled", contFinal && `${contFinal.status}`);
	heldSlot();
	check("cancel frees the queued resume waiter", !spawn.gate.isFull(1));
	await spawn.terminateOwnedSubagents([contRec.runId]);

	if (process.platform === "linux") {
		const pidProbe = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		spawn.killPidTree(pidProbe.pid, "not-the-recorded-start-time");
		await new Promise((resolve) => setTimeout(resolve, 50));
		check("PID identity mismatch prevents stale-record kill", registry.isProcessAlive(pidProbe.pid), String(pidProbe.pid));
		try { process.kill(-pidProbe.pid, "SIGTERM"); } catch { pidProbe.kill("SIGTERM"); }
		await new Promise((resolve) => pidProbe.once("close", resolve));
	}

	// queued when the gate is full
	const held = await spawn.gate.acquire(1);
	const queuedRec = await spawn.startSubagent(
		{ task: "q", name: "queued" },
		{ ...baseCtx(), settings: { maxDepth: 2, maxConcurrency: 1 } },
	);
	check("full gate queues the spawn", queuedRec.status === "queued", queuedRec.status);
	const queuedSendStarted = Date.now();
	const queuedAccepted = await spawn.sendSubagentMessage(queuedRec, "queued steer");
	check("steering a queued child returns immediately", queuedAccepted && Date.now() - queuedSendStarted < 250, String(Date.now() - queuedSendStarted));
	const queuedFollowRec = await spawn.startSubagent(
		{ task: "qf", name: "queued-follow" },
		{ ...baseCtx(), settings: { maxDepth: 2, maxConcurrency: 1 } },
	);
	const queuedFollowAccepted = await spawn.sendSubagentMessage(queuedFollowRec, "queued followup", undefined, "followUp");
	check("followUp to a queued child is retained with its mode", queuedFollowAccepted === true);
	held();
	for (let i = 0; i < 100; i++) {
		polled = registry.readRecords(spawnAgentDir).find((r) => r.runId === queuedRec.runId);
		if (polled?.status === "completed" && polled.latestText === "steered: queued steer") break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("queued child receives startup steering", polled?.status === "completed" && polled.latestText === "steered: queued steer", polled && `${polled.status} ${polled.latestText}`);
	let queuedFollowPolled;
	for (let i = 0; i < 100; i++) {
		queuedFollowPolled = registry.readRecords(spawnAgentDir).find((r) => r.runId === queuedFollowRec.runId);
		if (queuedFollowPolled?.status === "completed" && queuedFollowPolled.latestText === "steered: queued followup") break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("queued child receives startup followUp", queuedFollowPolled?.status === "completed" && queuedFollowPolled.latestText === "steered: queued followup", queuedFollowPolled && `${queuedFollowPolled.status} ${queuedFollowPolled.latestText}`);

	const heldForAbort = await spawn.gate.acquire(1);
	const abortQueuedCtl = new AbortController();
	const abortQueued = await spawn.startSubagent(
		{ task: "must not launch", name: "abort-queued" },
		{ ...baseCtx(), settings: { maxDepth: 2, maxConcurrency: 1 }, signal: abortQueuedCtl.signal },
	);
	check("abort target starts queued", abortQueued.status === "queued", abortQueued.status);
	abortQueuedCtl.abort();
	await new Promise((r) => setTimeout(r, 20));
	heldForAbort();
	let abortQueuedFinal;
	for (let i = 0; i < 50; i++) {
		abortQueuedFinal = registry.readRecords(spawnAgentDir).find((r) => r.runId === abortQueued.runId);
		if (abortQueuedFinal && ["failed", "cancelled"].includes(abortQueuedFinal.status)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	check(
		"queued spawn abort does not launch a child",
		abortQueuedFinal?.pid === undefined && !abortQueuedFinal?.latestText && String(abortQueuedFinal?.error || "").includes("aborted"),
		JSON.stringify(abortQueuedFinal),
	);

	const heldForCancel = await spawn.gate.acquire(1);
	const cancelledQueued = await spawn.startSubagent(
		{ task: "must not launch", name: "cancelled-queued" },
		{ ...baseCtx(), settings: { maxDepth: 2, maxConcurrency: 1 } },
	);
	await spawn.cancelSubagent(spawnAgentDir, cancelledQueued);
	let queuedCancelDrained = false;
	await Promise.race([
		spawn.terminateOwnedSubagents([cancelledQueued.runId]).then(() => { queuedCancelDrained = true; }),
		new Promise((resolve) => setTimeout(resolve, 500)),
	]);
	check("queued cancellation removes gate waiter", queuedCancelDrained);
	heldForCancel();
	const cancelledQueuedFinal = registry.readRecords(spawnAgentDir).find((r) => r.runId === cancelledQueued.runId);
	check("queued cancellation wins launch race", cancelledQueuedFinal?.status === "cancelled" && cancelledQueuedFinal.pid === undefined && !cancelledQueuedFinal.latestText, JSON.stringify(cancelledQueuedFinal));

	// --- cancel race: a cancelled child must stay cancelled, not flip to failed ---
	process.env.FAKE_DELAY_MS = "4000";
	const raceRec = await spawn.startSubagent({ task: "race", name: "racer" }, baseCtx());
	await new Promise((r) => setTimeout(r, 300));
	await spawn.cancelSubagent(spawnAgentDir, raceRec);
	let raceFinal;
	for (let i = 0; i < 80; i++) {
		raceFinal = registry.readRecords(spawnAgentDir).find((r) => r.runId === raceRec.runId);
		if (raceFinal && ["completed", "failed", "cancelled"].includes(raceFinal.status)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("cancelled child stays cancelled", raceFinal && raceFinal.status === "cancelled", raceFinal && raceFinal.status);
	delete process.env.FAKE_DELAY_MS;

	delete process.env.PI_SUBAGENT_COMMAND;

	fs.rmSync(sandbox, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
	console.error("HARNESS ERROR:", e && e.stack ? e.stack : e);
	process.exit(2);
});
