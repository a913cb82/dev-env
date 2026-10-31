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
	const rec = (runId, parentRunId, status, depth, startedAt = now) => ({
		version: 1, runId, parentRunId, rootRunId: "root", sessionId: `s-${runId}`,
		name: runId, task: "t", cwd: "/tmp", model: "prov/m", thinking: "xhigh",
		depth, maxDepth: 3, status, usage: { ...usage }, startedAt, updatedAt: now,
	});
	registry.saveRecord(dir, rec("top", "me", "completed", 1));
	registry.saveRecord(dir, rec("mid", "top", "completed", 2));
	registry.saveRecord(dir, rec("bot", "mid", "running", 3));
	registry.saveRecord(dir, rec("m2", "top", "running", 2));
	registry.saveRecord(dir, rec("m2a", "m2", "running", 3));
	// Collect the parents (as if their results were delivered to their owners).
	for (const id of ["top", "mid"]) {
		const row = registry.readRecords(dir).find((r) => r.runId === id);
		registry.markRecordResultState(dir, row, "resultsDelivered");
	}
	const tui = { requestRender() {} };
	const theme = { fg: (color, text) => text };
	const foot = new widget.SubagentStatusWidget(tui, theme, dir, "me");
	const lines = foot.render(200);
	check("footer keeps collected parents of a live descendant", lines.length === 5, JSON.stringify(lines));
	check("grandchild guides follow a non-last parent", /^│  └─ /.test(lines.find((line) => line.includes("m2a")) ?? ""), JSON.stringify(lines));
	check("roots render bare", /^✓ top /.test(lines[0]), JSON.stringify(lines));
	check("siblings share timestamps so names break the tie", lines[1].includes("m2") && lines[2].includes("mid"), JSON.stringify(lines));
	// Siblings sort by creation time, oldest first, regardless of name.
	const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "widget-"));
	const mkRec = (runId, startedAt) => ({
		version: 1, runId, parentRunId: "me", rootRunId: "root", sessionId: `s-${runId}`,
		name: runId, task: "t", cwd: "/tmp", model: "prov/m", thinking: "xhigh",
		depth: 1, maxDepth: 3, status: "running", usage: { ...usage }, startedAt, updatedAt: now,
	});
	registry.saveRecord(dir2, mkRec("zeta", "2026-01-01T00:00:00.000Z"));
	registry.saveRecord(dir2, mkRec("alpha", "2026-06-01T00:00:00.000Z"));
	const timeLines = new widget.SubagentStatusWidget(tui, theme, dir2, "me").render(200);
	check("siblings order by creation time", timeLines[0].includes("zeta") && timeLines[1].includes("alpha"), JSON.stringify(timeLines));
	check("non-last child uses mid branch", /^├─ /.test(lines[1]), JSON.stringify(lines));
	check("last child uses end branch", /^└─ /.test(lines[2]), JSON.stringify(lines));
	check("grandchild guides follow a last parent", /^   └─ /.test(lines[3]) && lines[3].includes("bot"), JSON.stringify(lines));
	check("no via parent suffix", lines.every((line) => !line.includes("via")), JSON.stringify(lines));
	check("model shows short id plus thinking level",
		lines.every((line) => line.includes("m · xhigh") && !line.includes("prov/")), JSON.stringify(lines));
	// Control: once the descendants drain too, the footer clears.
	for (const id of ["bot", "m2", "m2a"]) {
		const row = registry.readRecords(dir).find((r) => r.runId === id);
		registry.saveRecord(dir, { ...row, status: "completed", updatedAt: new Date().toISOString() });
		const done = registry.readRecords(dir).find((r) => r.runId === id);
		registry.markRecordResultState(dir, done, "resultsDelivered");
	}
	foot.invalidate();
	check("drained chain clears the footer", foot.render(200).length === 0, JSON.stringify(foot.render(200)));
	foot.dispose();
	// Disk half of durable observation: a dismissal sidecar survives fresh
	// processes, so quit+resume restores it (the startup path that dropped it
	// took the viewer from an uninitialized runtime - now explicit).
	// Uncollected terminal rows terminal over 10 minutes stay out of the
	// footer; fresh orphans still show. Age comes from the record, so a fresh
	// widget (or a fresh session after reload) hides old rows on first render.
	const elevenAgo = new Date(Date.now() - 11 * 60000).toISOString();
	registry.saveRecord(dir, { ...rec("oldp", "me", "completed", 1), updatedAt: elevenAgo });
	registry.saveRecord(dir, { ...rec("oldc", "oldp", "failed", 2), updatedAt: elevenAgo });
	registry.saveRecord(dir, rec("freshc", "oldp", "failed", 2));
	const foot2 = new widget.SubagentStatusWidget(tui, theme, dir, "me", {});
	const firstLines = foot2.render(200);
	check("footer hides the old row at once", !firstLines.some((line) => line.includes("oldc")), JSON.stringify(firstLines));
	check("footer keeps the fresh orphan", firstLines.some((line) => line.includes("freshc")), JSON.stringify(firstLines));
	foot2.dispose();
	// Cancelled rows must never wear the completion tick: a ✓ still reads as
	// "done" in the tree. Cancelled wears ✗ like failed, but faded grey
	// (dim) instead of red (error): same shape, visibly retired.
	const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "widget-"));
	registry.saveRecord(dir3, rec("done", "me", "completed", 1));
	registry.saveRecord(dir3, rec("cx", "me", "cancelled", 1));
	registry.saveRecord(dir3, rec("fx", "me", "failed", 1));
	const foot3 = new widget.SubagentStatusWidget(tui, theme, dir3, "me");
	const glyphLines = foot3.render(200);
	check("cancelled row wears no tick", !glyphLines.some((line) => line.includes("cx") && line.includes("✓")), JSON.stringify(glyphLines));
	check("cancelled row wears the cross", glyphLines.some((line) => line.includes("✗") && line.includes("cx")), JSON.stringify(glyphLines));
	check("completed row keeps the tick", glyphLines.some((line) => /^✓ done /.test(line)), JSON.stringify(glyphLines));
	check("failed row keeps the cross", glyphLines.some((line) => line.includes("✗") && line.includes("fx")), JSON.stringify(glyphLines));
	foot3.dispose();
	const ctheme = { fg: (color, text) => `<${color}>${text}</>` };
	const foot3c = new widget.SubagentStatusWidget(tui, ctheme, dir3, "me");
	const colorLines = foot3c.render(200);
	check("cancelled cross is faded grey", colorLines.some((line) => line.includes("<dim>✗") && line.includes("cx")), JSON.stringify(colorLines));
	check("failed cross stays red", colorLines.some((line) => line.includes("<error>✗") && line.includes("fx")), JSON.stringify(colorLines));
	foot3c.dispose();
	// Terminal progress (OSC 9;4 tab-bar spinner): the widget owns the
	// indicator exactly while Pi does not — Pi drives it across its own
	// turn (turn_start→agent_end) and goes quiet on agent_end even with
	// subagents still busy. Edge-triggered: no repeats, never clearing Pi's.
	const progress = await jiti.import(path.join(HERE, "progress.ts"));
	const emitted = [];
	const term = { setProgress: (active) => emitted.push(active) };
	let shown = true;
	const syncState = progress.newProgressSyncState();
	const drive = (opts) => progress.syncTerminalProgress(syncState, term, { showProgress: shown, ...opts });
	drive({ mainDriving: false, busy: false });
	check("idle session stays silent", emitted.length === 0, JSON.stringify(emitted));
	drive({ mainDriving: false, busy: true });
	check("busy subtree asserts progress", emitted.length === 1 && emitted[0] === true, JSON.stringify(emitted));
	drive({ mainDriving: false, busy: true });
	check("repeat busy does not re-emit", emitted.length === 1, JSON.stringify(emitted));
	drive({ mainDriving: true, busy: true });
	check("main turn yields silently", emitted.length === 1, JSON.stringify(emitted));
	drive({ mainDriving: false, busy: true });
	check("busy after the turn re-asserts", emitted.length === 2 && emitted[1] === true, JSON.stringify(emitted));
	drive({ mainDriving: false, busy: false });
	check("drained subtree clears progress", emitted.length === 3 && emitted[2] === false, JSON.stringify(emitted));
	drive({ mainDriving: false, busy: false });
	check("repeat idle does not re-emit", emitted.length === 3, JSON.stringify(emitted));
	drive({ mainDriving: false, busy: true });
	shown = false;
	drive({ mainDriving: false, busy: true });
	check("disabling the setting clears our assertion", emitted.length === 5 && emitted[4] === false, JSON.stringify(emitted));
	drive({ mainDriving: false, busy: true });
	check("disabled setting stays silent", emitted.length === 5, JSON.stringify(emitted));
	shown = true;
	check("running descendant reads busy", progress.subtreeBusy(dir2, "me") === true, JSON.stringify(dir2));
	check("drained tree reads idle", progress.subtreeBusy(dir, "me") === false, JSON.stringify(dir));
	const src = (driving) => ({ showTerminalProgress: () => true, isMainDriving: () => driving });
	const pcalls = [];
	const foot4 = new widget.SubagentStatusWidget({ requestRender() {}, terminal: { setProgress: (a) => pcalls.push(a) } }, theme, dir2, "me", {}, src(false));
	check("widget clears stale then asserts a busy subtree", JSON.stringify(pcalls) === JSON.stringify([false, true]), JSON.stringify(pcalls));
	foot4.dispose();
	check("widget dispose clears its assertion", JSON.stringify(pcalls) === JSON.stringify([false, true, false]), JSON.stringify(pcalls));
	const qcalls = [];
	const foot5 = new widget.SubagentStatusWidget({ requestRender() {}, terminal: { setProgress: (a) => qcalls.push(a) } }, theme, dir, "me", {}, src(false));
	check("widget construct clears stale progress", JSON.stringify(qcalls) === JSON.stringify([false]), JSON.stringify(qcalls));
	foot5.dispose();
	check("idle construct leaves nothing asserted", qcalls.length === 1, JSON.stringify(qcalls));
	const ycalls = [];
	const foot6 = new widget.SubagentStatusWidget({ requestRender() {}, terminal: { setProgress: (a) => ycalls.push(a) } }, theme, dir2, "me", {}, src(true));
	foot6.invalidate();
	check("widget yields while the main session drives", JSON.stringify(ycalls) === JSON.stringify([false]), JSON.stringify(ycalls));
	foot6.dispose();
	check("yielding widget holds nothing to clear", ycalls.length === 1, JSON.stringify(ycalls));
	// Event-driven progress: pokeProgress syncs the tab spinner the moment a
	// record transition lands, without waiting for the 2s tree tick and
	// without rebuilding rows (OSC writes bypass TUI rendering entirely).
	const ecalls = [];
	const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "widget-"));
	registry.saveRecord(dir4, { ...mkRec("live", "2026-06-01T00:00:00.000Z"), parentRunId: "me" });
	const foot7 = new widget.SubagentStatusWidget({ requestRender() {}, terminal: { setProgress: (a) => ecalls.push(a) } }, theme, dir4, "me", {}, src(false));
	check("event widget asserts on construct", JSON.stringify(ecalls) === JSON.stringify([false, true]), JSON.stringify(ecalls));
	const liverow = registry.readRecords(dir4).find((r) => r.runId === "live");
	registry.saveRecord(dir4, { ...liverow, status: "completed", updatedAt: new Date().toISOString() });
	foot7.pokeProgress();
	check("poke clears without invalidate", JSON.stringify(ecalls) === JSON.stringify([false, true, false]), JSON.stringify(ecalls));
	check("poke rebuilds no rows", foot7.render(200).some((line) => line.includes("live")), JSON.stringify(foot7.render(200)));
	foot7.dispose();
	check("poked widget holds nothing to clear", ecalls.length === 3, JSON.stringify(ecalls));
	const dismissed = registry.readRecords(dir).find((r) => r.runId === "bot");
	registry.markFooterDismissed(dir, dismissed, "me", "dismissal-key");
	check("dismissal sidecar persists the key",
		registry.listFooterDismissed(dir, "me").includes("dismissal-key"),
		JSON.stringify(registry.listFooterDismissed(dir, "me")));

	console.log(failures === 0 ? "\nAll widget tests passed." : `\n${failures} widget test(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
	console.error(`FATAL - widget suite crashed: ${error?.stack || error}`);
	process.exit(1);
});
