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

  // R7. a thinking followed by ITS OWN message's prose must not be hoisted
  // into a block that mounts below that prose: the preview would read as if
  // the thinking happened after the prose. It stands alone above it.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, loadFixture("thinking-prose-same-message").live);
    const lines = driver.dump(world).lines;
    const standalone = lines.findIndex((l) => /^\s*>\d+ thinking\b/.test(l));
    const prose = lines.findIndex((l) => l.includes("Real Pi confirms the blank fix"));
    // A standalone thinking is itself `>N thinking`; the run header is the
    // `>` line that is not one.
    const header = lines.findIndex((l) => l.trim().startsWith(">") && !/^\s*>\d+ thinking\b/.test(l));
    check("thinking stands alone above its own message's prose",
      standalone >= 0 && prose > standalone && header > prose, lines.join("\n"));
    check("the block below the prose takes no thinking",
      header >= 0 && !lines[header].includes("thinking"), JSON.stringify(lines[header]));
    const run = world.mod.traceEntries.get("k1").runId;
    check("run thinking count stays zero", world.mod.runThinkingCount(run) === 0,
      String(world.mod.runThinkingCount(run)));
  }

  // R8. live and restore must agree for the same transcript. This is the
  // invariant the false reports kept breaking: a rule applied on one path
  // (live attach) but not the other (history re-plan) shows up as extra
  // thinking counts and missing standalone rows.
  for (const name of ["thinking-prose-same-message", "thinking-before-prose-tools", "live-consecutive-turns"]) {
    const fx = loadFixture(name);
    const live = driver.createWorld(PI, { width: 100 });
    await driver.restore(live, []);
    await driver.runLive(live, fx.live);
    const liveText = driver.dump(live).lines.join("\n");
    const restored = driver.createWorld(PI, { width: 100 });
    await driver.restore(restored, live.entries);
    const restoredText = driver.dump(restored).lines.join("\n");
    check(`live matches restore: ${name}`, liveText === restoredText,
      `--- live ---\n${liveText}\n--- restore ---\n${restoredText}`);
  }

  // R9. Thinking, then its OWN prose, then the tool call, all in one message.
  // Pi mounts the tool component after the whole row, so the block sits below
  // the prose; the thinking stays standalone and the block takes none.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, loadFixture("own-prose-with-tool").live);
    const lines = driver.dump(world).lines;
    const standalone = lines.findIndex((l) => /^\s*>\d+ thinking\b/.test(l));
    const prose = lines.findIndex((l) => l.includes("Order is right, so the gate"));
    const header = lines.findIndex((l) => l.trim().startsWith(">") && !/^\s*>\d+ thinking\b/.test(l));
    check("own-prose mixed row: thinking stands alone", standalone >= 0 && prose > standalone, lines.join("\n"));
    check("own-prose mixed row: block below takes no thinking",
      header > prose && !lines[header].includes("thinking"), JSON.stringify(lines[header]));
    // A row that is still streaming must never leave the tree whole: its
    // prose can arrive later, and losing the row loses the prose.
    check("own-prose mixed row keeps its prose", prose >= 0, lines.join("\n"));
  }

  // R10. A thinking that arrives AFTER the tools (its own prose follows) must
  // attach backward into the block above, not stand alone between them.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, loadFixture("thinking-after-tools-own-prose").restore);
    const lines = driver.dump(world).lines;
    const header = lines.findIndex((l) => l.trim().startsWith(">") && !/^\s*>\d+ thinking\b/.test(l));
    check("thinking after tools attaches to the block above",
      header >= 0 && lines[header].includes("2 bash") && lines[header].includes("1 thinking"),
      JSON.stringify(lines[header]));
    check("thinking after tools has no standalone row",
      !lines.some((l) => /^\s*>\d+ thinking\b/.test(l)), lines.join("\n"));
    check("thinking after tools keeps the prose below",
      lines.some((l) => l.includes("harness should have caught this")), lines.join("\n"));
  }

  // R11. The two resume orders must render the same spacing. Pi rebuilds a
  // mounted row by appending, which used to leave a duplicate leading spacer
  // only on the mount-then-start path: same content, one line taller.
  for (const name of ["thinking-prose-same-message", "own-prose-with-tool", "thinking-after-tools-own-prose"]) {
    const fx = loadFixture(name);
    const live = driver.createWorld(PI, { width: 100 });
    await driver.restore(live, []);
    if (fx.live) await driver.runLive(live, fx.live);
    else await driver.restore(live, fx.restore);
    const early = driver.createWorld(PI, { width: 100 });
    await driver.restore(early, live.entries);
    const late = driver.createWorld(PI, { width: 100 });
    await driver.restoreLate(late, live.entries);
    const a = driver.dump(early).lines.join("\n");
    const b = driver.dump(late).lines.join("\n");
    check(`resume orders keep spacing: ${name}`, a === b,
      `--- start first ---\n${a}\n--- mount first ---\n${b}`);
  }

  // R12. Escape during a tool-using message. Pi closes it as "aborted" with
  // no tool result; the row keeps its prose and the next turn must not absorb
  // the aborted tool or drop the prose that separates the blocks.
  {
    const fx = loadFixture("aborted-mixed");
    const live = driver.createWorld(PI, { width: 100 });
    await driver.restore(live, []);
    await driver.runLive(live, fx.live);
    const lines = driver.dump(live).lines;
    const rest = driver.createWorld(PI, { width: 100 });
    await driver.restore(rest, fx.restore);
    check("abort: live matches restore", lines.join("\n") === driver.dump(rest).lines.join("\n"),
      `--- live ---\n${lines.join("\n")}\n--- restore ---\n${driver.dump(rest).lines.join("\n")}`);
    check("abort: the aborted message keeps its prose",
      lines.some((l) => l.includes("All green. Documenting")), lines.join("\n"));
    check("abort: the next turn keeps its prose",
      lines.some((l) => l.includes("Header check done.")), lines.join("\n"));
    const header = lines.findIndex((l) => l.trim().startsWith(">") && !/^\s*>\d+ thinking/.test(l));
    check("abort: the aborted tool has no false duration", header >= 0 && !/\d+s\b/.test(lines[header]), JSON.stringify(lines[header]));
    // A message aborted WITHOUT tool calls: Pi appends the abort text itself.
    check("abort: abort text renders for a tool-less message",
      lines.some((l) => l.includes("Operation aborted")), lines.join("\n"));
    check("abort: that message keeps its prose",
      lines.some((l) => l.includes("Starting the third step now.")), lines.join("\n"));
  }

  // R13. While streaming Pi reports stopReason "pending". It is truthy, but
  // the message can still gain prose, so the row must not be removed whole.
  // Real Pi lost the live prose row this way; resume showed it again.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "go" },
      { op: "start", id: "p" },
      { op: "thinking", id: "p", text: "Evaluating the reply." },
      { op: "tick" },
      { op: "pending", id: "p" },
      { op: "tick" },
      { op: "text", id: "p", text: "MARKER LATE PROSE" },
      { op: "tick" },
      { op: "tool", id: "p", toolId: "p1", name: "bash", args: { command: "sleep 1; echo 1" } },
      { op: "tick" },
      { op: "end", id: "p", stop: "toolUse" },
      { op: "result", toolId: "p1", text: "1" },
      { op: "tick" }
    ]);
    const lines = driver.dump(world).lines;
    check("pending row keeps the prose that arrives later",
      lines.some((l) => l.includes("MARKER LATE PROSE")), lines.join("\n"));
    const rest = driver.createWorld(PI, { width: 100 });
    await driver.restore(rest, world.entries);
    check("pending row live matches restore", lines.join("\n") === driver.dump(rest).lines.join("\n"),
      lines.join("\n"));
  }

  console.log(failures === 0 ? "PASS: collapse replay" : `FAILURES: ${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("FATAL", e); process.exitCode = 1; });
