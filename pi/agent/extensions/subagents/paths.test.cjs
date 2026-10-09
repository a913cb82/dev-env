// Tests for tree-wide path resolution (resolveAgentPath in registry.ts).
// No dependencies, no API calls. Run: node paths.test.cjs
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function findPiRoot() {
	const bin = execSync("command -v pi", { encoding: "utf8" }).trim();
	const real = fs.realpathSync(bin);
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
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

(async () => {
	const registry = await jiti.import(path.join(HERE, "registry.ts"));

	// Tree (root "root" has no record):
	//   root
	//   ├─ a (run a1)
	//   │  ├─ alpha (run a1a)
	//   │  ├─ beta  (run a1b)
	//   │  ├─ dup   (run a1d1)
	//   │  └─ dup   (run a1d2)
	//   └─ b (run b1)
	//      └─ alpha (run b1a, cross-level duplicate of a/alpha)
	const A = makeRecord({ runId: "a1", sessionId: "sess-a", name: "a", parentRunId: "root" });
	const B = makeRecord({ runId: "b1", sessionId: "sess-b", name: "b", parentRunId: "root" });
	const A1 = makeRecord({ runId: "a1a", sessionId: "sess-a1", name: "alpha", parentRunId: "a1", depth: 2 });
	const A2 = makeRecord({ runId: "a1b", sessionId: "sess-a2", name: "beta", parentRunId: "a1", depth: 2 });
	const D1 = makeRecord({ runId: "a1d1", sessionId: "sess-d1", name: "dup", parentRunId: "a1", depth: 2 });
	const D2 = makeRecord({ runId: "a1d2", sessionId: "sess-d2", name: "dup", parentRunId: "a1", depth: 2 });
	const B1 = makeRecord({ runId: "b1a", sessionId: "sess-b1", name: "alpha", parentRunId: "b1", depth: 2 });
	const records = [A, B, A1, A2, D1, D2, B1];

	const resolve = (anchorRunId, target) => registry.resolveAgentPath(records, { anchorRunId, rootRunId: "root", target });
	const runIdOf = (anchorRunId, target) => resolve(anchorRunId, target).runId;
	const throws = (anchorRunId, target) => {
		try { resolve(anchorRunId, target); return ""; }
		catch (error) { return String((error && error.message) || error); }
	};

	// --- absolute paths from root ---
	check("absolute /a", runIdOf("root", "/a") === "a1");
	check("absolute /a/alpha disambiguates cross-level dup", runIdOf("root", "/a/alpha") === "a1a");
	check("absolute /b/alpha disambiguates cross-level dup", runIdOf("a1a", "/b/alpha") === "b1a");
	check("absolute from deep node", runIdOf("b1a", "/a/beta") === "a1b");
	check("absolute / is root session", runIdOf("a1a", "/").runId === undefined || resolve("a1a", "/").runId === "root");
	check("absolute unknown segment", /no subagent matches/i.test(throws("root", "/a/nope")), throws("root", "/a/nope"));

	// --- relative navigation ---
	check(".. reaches parent", runIdOf("a1a", "..") === "a1");
	check("../.. reaches grandparent", runIdOf("a1a", "../..") === "root");
	check("../../b/alpha from deep node", runIdOf("a1a", "../../b/alpha") === "b1a");
	check("me/child", runIdOf("a1", "me/alpha") === "a1a");
	check("./child", runIdOf("a1", "./beta") === "a1b");
	check("../sibling", runIdOf("a1a", "../beta") === "a1b");
	check("child walk from root", runIdOf("root", "a/alpha") === "a1a");
	check("mid-path . is a no-op", runIdOf("root", "/a/./alpha") === "a1a");

	// --- legacy bare names still work (deep search within subtree) ---
	check("bare child name", runIdOf("root", "a") === "a1");
	check("bare deep name", runIdOf("root", "beta") === "a1b");
	check("bare runId prefix", runIdOf("root", "a1a") === "a1a" && runIdOf("root", "a1") === "a1");
	check("bare sessionId", runIdOf("root", "sess-a1") === "a1a");
	check("bare sibling sugar", runIdOf("a1a", "beta") === "a1b");
	check("legacy deep match wins over sibling", runIdOf("a1", "alpha") === "a1a");

	// --- segments accept runId and sessionId too ---
	check("segment runId", runIdOf("root", "/a/a1a") === "a1a");
	check("segment runId prefix", runIdOf("root", "/b/b1") === "b1a");
	check("segment sessionId", runIdOf("root", "/a/sess-a1") === "a1a");

	// --- rejections ---
	check("self via me rejected", /self/i.test(throws("a1a", "me")), throws("a1a", "me"));
	check("self via . rejected", /self/i.test(throws("a1a", ".")), throws("a1a", "."));
	check("self via / rejected at root", /self/i.test(throws("root", "/")), throws("root", "/"));
	check("self via resolving path rejected", /self/i.test(throws("a1a", "../alpha")), throws("a1a", "../alpha"));
	check(".. above root rejected", /root/i.test(throws("root", "..")), throws("root", ".."));
	check("escape above root rejected", /root/i.test(throws("a1a", "../../..")), throws("a1a", "../../.."));
	check("same-level duplicates ambiguous", /ambiguous/i.test(throws("root", "/a/dup")), throws("root", "/a/dup"));
	check("legacy cross-level duplicates ambiguous", /ambiguous/i.test(throws("root", "alpha")), throws("root", "alpha"));
	check("empty target rejected", throws("root", "").length > 0 && throws("root", "   ").length > 0);
	check("double slash rejected", throws("root", "/a//alpha").length > 0);
	check("unknown bare name", /no subagent matches/i.test(throws("root", "nope")), throws("root", "nope"));

	console.log(failures === 0 ? "\nAll path tests passed." : `\n${failures} path test(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
	console.error(`HARNESS ERROR: ${error && error.stack ? error.stack : error}`);
	process.exit(1);
});
