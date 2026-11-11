// Replay tests for collapse: real Pi components, scripted transcripts.
//
// Instead of hand-built fake rows, the replay driver mounts the REAL
// AssistantMessageComponent / ToolExecutionComponent classes, feeds them a
// scripted transcript (restore + live ops + reload, like a real session),
// and screenshots the chat with component.render(width). If the extension
// misplaces a thinking with real components, it fails here — no mock can
// hide it.
//
// Run: node replay.test.cjs
const path = require("node:path");
const fs = require("node:fs");

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${extra !== undefined ? `: ${extra}` : ""}`);
  }
}

const loadFixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "replay", "fixtures", `${name}.json`), "utf8"));

(async () => {
  const driver = require("./replay/driver.cjs");
  const PI = await driver.loadPi();

  // R1. the reported shape, live, real components: thinking-only messages,
  // then agent prose, then the tools. The thinkings stand alone in their
  // own segment (before the prose) instead of teleporting into the tools'
  // block after it.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, loadFixture("segment-crossing").live);
    const shot = driver.dump(world);
    const at = (s) => shot.lines.findIndex((l) => l.includes(s));
    const standalones = shot.lines.filter((l) => l.includes("1 thinking"));
    check("standalone thinkings render before the prose",
      standalones.length === 2 && standalones.every((l) => shot.lines.indexOf(l) < at("Rule confirmed")),
      shot.lines.join("\n"));
    check("tools block renders after the prose",
      at(">2 bash") > at("Rule confirmed"),
      shot.lines.join("\n"));
    check("no thinking preview inside the tools block",
      !shot.lines.slice(at(">2 bash")).some((l) => l.includes("Designing") || l.includes("Evaluating")),
      shot.lines.join("\n"));
    check("thinking text stays hidden (count only, expands on click)",
      !shot.text.includes("Designing") && !shot.text.includes("Evaluating"),
      shot.lines.join("\n"));
  }

  // R2. restore + reload stability: persisted history renders one header
  // per segment, and rebuilding from the same entries reproduces the
  // identical screenshot (no drift across /reload).
  {
    const world = driver.createWorld(PI, { width: 100 });
    const entries = loadFixture("history-split").restore;
    await driver.restore(world, entries);
    const before = driver.dump(world).lines.join("\n");
    check("restore splits on the user boundary",
      before.split("\n").filter((l) => l.startsWith(">")).length === 2, before);
    await driver.reload(world);
    const after = driver.dump(world).lines.join("\n");
    check("reload reproduces the restore screenshot", after === before,
      `--- before ---\n${before}\n--- after ---\n${after}`);
  }

  // R3. mid-stream the prose is mounted but unpersisted: entries cannot
  // see it, so only the tree-order gate blocks the backward attach
  // (defer). Once both messages end, the settled pass stands the
  // thinking alone after the prose.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    const fx = loadFixture("live-prose-between");
    await driver.runLive(world, fx.liveMid);
    const k1run = world.mod.traceEntries.get("k1").runId;
    check("mid-stream thinking defers past mounted prose",
      world.mod.runThinkingCount(k1run) === 0, world.mod.detachDiag());
    await driver.runLive(world, fx.liveRest);
    const shot = driver.dump(world);
    const at = (s) => shot.lines.findIndex((l) => l.includes(s));
    check("settled thinking stands alone after the prose",
      at("1 thinking") > at("A quick note") && world.mod.runThinkingCount(k1run) === 0,
      shot.lines.join("\n"));
  }

  console.log(failures === 0 ? "PASS: collapse replay" : `FAILURES: ${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("FATAL", e); process.exitCode = 1; });
