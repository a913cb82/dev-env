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

  // R4. both resume orders converge: `pi` (start, then mount) and
  // `pi -r` (mount, then start) must produce the SAME screenshot, with
  // thinking preserved and one run per user boundary. A divergence here
  // means one real startup path silently loses counts or merges runs.
  {
    const entries = loadFixture("history-split").restore;
    const shots = {};
    for (const variant of ["restore", "restoreLate"]) {
      const world = driver.createWorld(PI, { width: 100 });
      await driver[variant](world, entries);
      shots[variant] = driver.dump(world).lines.join("\n");
    }
    check("resume orders converge", shots.restore === shots.restoreLate,
      `--- start then mount ---\n${shots.restore}\n--- mount then start ---\n${shots.restoreLate}`);
    check("resume keeps the thinking count",
      shots.restore.includes("1 thinking") && shots.restoreLate.includes("1 thinking"),
      JSON.stringify([shots.restore, shots.restoreLate]));
  }

  // R5. the deferred history plan settles on the first poll — which can
  // land MID-TURN. The re-plan must not scatter the live runs into one-run-
  // per-tool (that produced adjacent blocks with no visible message
  // between them): live tools keep their grouping.
  {
    const world = driver.createWorld(PI, { width: 100 });
    const hist = loadFixture("history-split").restore;
    await driver.armRestore(world, hist);
    // Live turn starts while the history plan is still pending.
    await driver.runLive(world, loadFixture("live-consecutive-turns").live.slice(0, 9));
    driver.tickOnce(world); // settle fires here, mid-turn
    await driver.runLive(world, loadFixture("live-consecutive-turns").live.slice(9));
    driver.tickOnce(world);
    const shot = driver.dump(world);
    const headers = shot.lines.filter((l) => l.trim().startsWith(">"));
    check("mid-turn settle keeps one header for the live segment",
      headers.length === 3 && headers[2].includes("3 bash") && headers[2].includes("1 write"),
      shot.lines.join("\n"));
  }

  // R6. spacing: a header never glues to a prose row above it (blank line
  // kept), and the run's own rows stay glued together.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, loadFixture("prose-blank-trailing-thinking").restore);
    const lines = driver.dump(world).lines;
    const prose = lines.findIndex((l) => l.includes("That's a faithful live session"));
    const header = lines.findIndex((l, i) => i > prose && l.trim().startsWith(">"));
    check("blank line between prose and the header below it",
      prose >= 0 && header > prose && lines.slice(prose + 1, header).some((l) => l.trim() === ""),
      JSON.stringify(lines.slice(Math.max(0, prose - 2), header + 2)));
    check("no blank between the block's own header and rows",
      lines.filter((l) => l.trim() === "").length > 0,
      JSON.stringify(lines));
  }

  console.log(failures === 0 ? "PASS: collapse replay" : `FAILURES: ${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("FATAL", e); process.exitCode = 1; });
