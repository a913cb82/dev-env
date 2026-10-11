// Tests for the subagent status footer (widget.ts): one line per outstanding
// descendant, plus every visible row's ancestry — a live grandchild must never
// render as a root-level run after its parents are collected. No API calls.
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

(async () => {
	const registry = await jiti.import(path.join(HERE, "registry.ts"));
	const widget = await jiti.import(path.join(HERE, "widget.ts"));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-"));
	const now = new Date().toISOString();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	const rec = (runId, parentRunId, status, depth) => ({
		version: 1, runId, parentRunId, rootRunId: "root", sessionId: `s-${runId}`,
		name: runId, task: "t", cwd: "/tmp", model: "prov/m", thinking: "xhigh",
		depth, maxDepth: 3, status, usage: { ...usage }, startedAt: now, updatedAt: now,
	});
	registry.saveRecord(dir, rec("top", "me", "completed", 1));
	registry.saveRecord(dir, rec("mid", "top", "completed", 2));
	registry.saveRecord(dir, rec("bot", "mid", "running", 3));
	// Collect the parents (as if their results were delivered to their owners).
	for (const id of ["top", "mid"]) {
		const row = registry.readRecords(dir).find((r) => r.runId === id);
		registry.markRecordResultState(dir, row, "resultsDelivered");
	}
	const tui = { requestRender() {} };
	const theme = { fg: (color, text) => text };
	const foot = new widget.SubagentStatusWidget(tui, theme, dir, "me");
	const lines = foot.render(200);
	check("footer keeps collected parents of a live descendant", lines.length === 3, JSON.stringify(lines));
	check("chain order reads top-down",
		lines[0].includes("top") && lines[1].includes("mid") && lines[2].includes("bot"),
		JSON.stringify(lines));
	check("live descendant stays indented under its chain",
		!/^ /.test(lines[0]) && /^  +/.test(lines[2]), JSON.stringify(lines));
	check("no via parent suffix", lines.every((line) => !line.includes("via")), JSON.stringify(lines));
	check("model shows short id plus thinking level",
		lines.every((line) => line.includes("m · xhigh") && !line.includes("prov/")), JSON.stringify(lines));
	// Control: once the descendant drains too, the footer clears.
	const botRow = registry.readRecords(dir).find((r) => r.runId === "bot");
	registry.saveRecord(dir, { ...botRow, status: "completed", updatedAt: new Date().toISOString() });
	const botDone = registry.readRecords(dir).find((r) => r.runId === "bot");
	registry.markRecordResultState(dir, botDone, "resultsDelivered");
	foot.invalidate();
	check("drained chain clears the footer", foot.render(200).length === 0, JSON.stringify(foot.render(200)));
	foot.dispose();

	console.log(failures === 0 ? "\nAll widget tests passed." : `\n${failures} widget test(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
	console.error(`FATAL - widget suite crashed: ${error?.stack || error}`);
	process.exit(1);
});
