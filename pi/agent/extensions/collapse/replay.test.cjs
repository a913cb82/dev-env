// Replay tests for collapse: real Pi components, scripted transcripts.
//
// Instead of hand-built fake rows, the replay driver mounts the REAL
// AssistantMessageComponent / UserMessageComponent classes and the
// extension's wrapped tool renderers (in a minimal self-shell host that
// mirrors Pi's separator blank), feeds them a scripted transcript, and
// screenshots the chat with component.render(width). If the extension
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
  const parity = require("./replay/parity.cjs");

  // R0. The parity checker must recognize the markers this extension
  // actually renders. A stale marker made every adjacency check vacuous.
  {
    const adjacent = parity.adjacencyViolations([
      "▸1 bash  2s",
      "▸1 bash  2s",
    ]);
    check("parity catches adjacent current headers", adjacent.length === 1, JSON.stringify(adjacent));
    check("parity counts current block headers", parity.blockHeaderCount(["▸1 bash", "▏row", "▸1 thinking"]) === 2,
      String(parity.blockHeaderCount(["▸1 bash", "▏row", "▸1 thinking"])));
    const wheel = parity.adjacencyViolations([
      "⠋1 thinking  1s",
      "▸1 thinking  2s",
    ]);
    check("parity catches adjacent wheel headers", wheel.length === 1, JSON.stringify(wheel));
    const prose = parity.adjacencyViolations([
      "> 3 bash",
      "▸1 bash  2s",
    ]);
    check("parity does not treat a blockquote as a header", prose.length === 0, JSON.stringify(prose));
    check("parity no longer recognizes the retired > marker",
      parity.blockHeaderCount([">1 bash", ">1 thinking"]) === 0,
      JSON.stringify(parity.blockHeaderCount([">1 bash", ">1 thinking"])));
    const withThinking = parity.probes([{
      role: "assistant",
      content: [{ type: "thinking", thinking: "DISTINCTIVE THINKING TEXT" }],
    }], { thinking: true });
    check("parity probes include thinking when asked",
      withThinking.some((p) => p.kind === "thinking"), JSON.stringify(withThinking));
    const missingThinking = parity.orderViolations(
      ["▏DISTINCTIVE THINKING TEXT  10 ch"], withThinking,
    );
    check("parity can order thinking on a rail", missingThinking.length === 0, JSON.stringify(missingThinking));
  }

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
      at("▸2 bash") > at("Rule confirmed"),
      shot.lines.join("\n"));
    check("no thinking preview inside the tools block",
      !shot.lines.slice(at("▸2 bash")).some((l) => l.includes("Designing") || l.includes("Evaluating")),
      shot.lines.join("\n"));
    check("thinking text stays hidden (count only, expands on click)",
      !shot.text.includes("Designing") && !shot.text.includes("Evaluating"),
      shot.lines.join("\n"));

    // The same row, through the real detach pass and the real component:
    // clicking its collapsed header opens the block, not Pi's full text.
    const plain = (line) => String(line)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;]*m/g, "");
    const rowLines = (row) => row.render(100).map(plain);
    const blockRow = [...world.assistantComps.values()].find((row) => {
      const lines = rowLines(row);
      return lines.length === 2 && lines[0] === "" && /^\s*▸1 thinking\b/.test(lines[1]);
    });
    check("a detached standalone is one block line", !!blockRow,
      blockRow ? rowLines(blockRow).join("\n") : "no standalone row");
    if (blockRow) {
      blockRow.handleMouse({ type: "click", button: "left", y: 1, width: 100, height: 2 });
      const opened = rowLines(blockRow);
      check("detached standalone header opens the block",
        opened.length === 4 && opened[0] === "" && opened[1].startsWith("▾1 thinking") &&
        opened[2].startsWith("▏") && opened[3].startsWith("▴Collapse"),
        opened.join("\n"));
    }
  }

  // R1b. the committed adjacent-groups fixture: two tool batches separated
  // only by a thinking-only message must share one run (no visible message
  // means no breakpoint).
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, loadFixture("adjacent-groups").live);
    driver.tickOnce(world);
    const lines = driver.dump(world).lines;
    const header = lines.find((l) => l.trim().startsWith("▸"));
    check("adjacent groups share one header",
      !!header && header.includes("4 bash") && header.includes("1 thinking"), lines.join("\n"));
    driver.openRun(world, "a1");
    const opened = driver.dump(world).lines.filter((l) => l.includes("echo "));
    check("adjacent groups keep all four rows", opened.length === 4, opened.join("\n"));
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
      before.split("\n").filter((l) => l.startsWith("▸")).length === 2, before);
    await driver.reload(world);
    const after = driver.dump(world).lines.join("\n");
    check("reload reproduces the restore screenshot", after === before,
      `--- before ---\n${before}\n--- after ---\n${after}`);
  }

  // R2b. a settled transcript must not keep the live wheel: mountTool used
  // to pass `isPartial: false` as render options while leaving the render
  // context's flag true, so every restored row spun forever.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, loadFixture("history-split").restore);
    const restored = driver.dump(world).lines;
    check("settled replay has no live wheel",
      !restored.some((l) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l)), restored.join("\n"));
    // A live call that received its result must settle too: the render
    // context's isPartial flag drives the wheel, not the render options.
    const live = driver.createWorld(PI, { width: 100 });
    await driver.restore(live, []);
    // A call mounted while args are still partial: the option says settled
    // later, but the render context must settle too.
    await driver.runLive(live, [
      { op: "user", text: "go" },
      { op: "start", id: "pm1" },
      { op: "tool", id: "pm1", toolId: "p1", name: "bash", args: { command: "sleep 1" }, partial: true },
      { op: "result", toolId: "p1", text: "done" },
      { op: "end", id: "pm1", stop: "toolUse" },
      { op: "turn" },
      { op: "tick" },
    ]);
    driver.tickOnce(live);
    const settled = driver.dump(live).lines;
    check("a live result clears the wheel",
      !settled.some((l) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l)), settled.join("\n"));
    driver.openRun(live, "p1");
    const opened = driver.dump(live).lines;
    check("a live result updates the row", opened.some((l) => l.includes("0.0k")), opened.join("\n"));
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
    const headers = shot.lines.filter((l) => l.trim().startsWith("▸"));
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
    const header = lines.findIndex((l, i) => i > prose && l.trim().startsWith("▸"));
    check("blank line between prose and the header below it",
      prose >= 0 && header > prose && lines.slice(prose + 1, header).some((l) => l.trim() === ""),
      JSON.stringify(lines.slice(Math.max(0, prose - 2), header + 2)));
    // Open the run: the header must sit directly on its rows, with the
    // separator blank only above the header.
    driver.openRun(world, "x1");
    const opened = driver.dump(world).lines;
    const openHeader = opened.findIndex((l) => l.trim().startsWith("▾"));
    const footer = opened.findIndex((l) => l.includes("Collapse"));
    check("no blank between the block's own header and rows",
      openHeader >= 0 && footer > openHeader &&
        opened.slice(openHeader + 1, footer).every((l) => l.trim() !== ""),
      JSON.stringify(opened.slice(Math.max(0, openHeader - 1), footer + 1)));
  }

  // R7. a thinking followed by ITS OWN message's prose must not be hoisted
  // into a block that mounts below that prose: the preview would read as if
  // the thinking happened after the prose. It stands alone above it.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, loadFixture("thinking-prose-same-message").live);
    const lines = driver.dump(world).lines;
    const standalone = lines.findIndex((l) => /^\s*▸\d+ thinking\b/.test(l));
    const prose = lines.findIndex((l) => l.includes("Real Pi confirms the blank fix"));
    // A standalone thinking is itself `>N thinking`; the run header is the
    // `>` line that is not one.
    const header = lines.findIndex((l) => l.trim().startsWith("▸") && !/^\s*▸\d+ thinking\b/.test(l));
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
    const standalone = lines.findIndex((l) => /^\s*▸\d+ thinking\b/.test(l));
    const prose = lines.findIndex((l) => l.includes("Order is right, so the gate"));
    const header = lines.findIndex((l) => l.trim().startsWith("▸") && !/^\s*▸\d+ thinking\b/.test(l));
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
    const header = lines.findIndex((l) => l.trim().startsWith("▸") && !/^\s*▸\d+ thinking\b/.test(l));
    check("thinking after tools attaches to the block above",
      header >= 0 && lines[header].includes("2 bash") && lines[header].includes("1 thinking"),
      JSON.stringify(lines[header]));
    check("thinking after tools has no standalone row",
      !lines.some((l) => /^\s*▸\d+ thinking\b/.test(l)), lines.join("\n"));
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
    const header = lines.findIndex((l) => l.trim().startsWith("▸") && !/^\s*▸\d+ thinking/.test(l));
    const secs = /\b(\d+)s\b/.exec(lines[header] ?? "");
    check("abort: the aborted tool has no false duration", header >= 0 && (!secs || secs[1] === "0"), JSON.stringify(lines[header]));
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

  // R14. A thinking-only row that is still streaming belongs to the block
  // above: it must not linger as a separate row until message_end. Live
  // frames showed `>6 bash · 4 thinking` and then a standalone streaming
  // preview below it.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "go" },
      { op: "start", id: "a" },
      { op: "tool", id: "a", toolId: "a1", name: "bash", args: { command: "echo one" } },
      { op: "end", id: "a", stop: "toolUse" },
      { op: "result", toolId: "a1", text: "one" },
      { op: "tick" },
      { op: "start", id: "b" },
      { op: "thinking", id: "b", text: "LIVEALPHA " },
      { op: "thinking", id: "b", text: "LIVEBETA" },
    ]);
    const shot = driver.dump(world);
    const header = shot.lines.findIndex((l) => /^[▸⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l.trim()));
    check("streaming thinking joins the block count",
      header >= 0 && shot.lines[header].includes("1 bash") && shot.lines[header].includes("1 thinking"),
      shot.lines.join("\n"));
    check("streaming thinking has no separate row",
      !shot.lines.some((l) => l.includes("LIVEALPHA")), shot.lines.join("\n"));
    const comp = driver.openRun(world, "a1");
    const opened = driver.dump(world).lines;
    const toolRow = opened.findIndex((l) => l.includes("echo one"));
    const preview = opened.findIndex((l) => l.includes("LIVEALPHA"));
    const footerAt = opened.findIndex((l) => l.includes("Collapse"));
    check("streaming thinking preview is inside the opened block",
      preview > toolRow && footerAt > preview, opened.slice(Math.max(0, toolRow - 1), footerAt + 1).join("\n"));
    check("opening the block leaves the live row mounted but empty",
      comp.children.length >= 2, String(comp.children.length));

    // Close the run again before comparing with a collapsed restore.
    const footer = comp.children[comp.children.length - 1];
    footer?.onMouse?.({ type: "click", button: "left" });
    comp.render(world.width);
    // Once it settles the provisional item is replaced by the completed
    // detach; live and restore must agree.
    await driver.runLive(world, [
      { op: "end", id: "b", stop: "stop" },
      { op: "tick" },
    ]);
    const settled = driver.dump(world).lines.join("\n");
    check("settled thinking stays in the block",
      settled.includes("1 bash") && settled.includes("1 thinking") &&
      !settled.split("\n").some((l) => l.includes("LIVEALPHA")), settled);
    const restored = driver.createWorld(PI, { width: 100 });
    await driver.restore(restored, world.entries);
    check("live streaming thinking matches restore", settled === driver.dump(restored).lines.join("\n"),
      `--- live ---\n${settled}\n--- restore ---\n${driver.dump(restored).lines.join("\n")}`);
  }

  // R15. A streaming mixed row (thinking then its own prose) must NOT be
  // hosted: the prose follows the thinking, so the collapsed thinking block
  // belongs above the prose, not inside a block below it.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "go" },
      { op: "start", id: "a" },
      { op: "tool", id: "a", toolId: "a1", name: "bash", args: { command: "echo one" } },
      { op: "end", id: "a", stop: "toolUse" },
      { op: "result", toolId: "a1", text: "one" },
      { op: "tick" },
      { op: "start", id: "b" },
      { op: "thinking", id: "b", text: "LIVEOWN" },
      { op: "text", id: "b", text: "PROSE AFTER LIVEOWN" },
      { op: "tick" },
    ]);
    const lines = driver.dump(world).lines;
    const header = lines.findIndex((l) => l.trim().startsWith("▸"));
    check("mixed streaming row is not hoisted into the block",
      header >= 0 && lines[header].includes("1 bash") && !lines[header].includes("thinking"),
      lines.join("\n"));
    // The thinking is not hoisted into the run (the run header has no
    // thinking), but it is still a collapsed block in place above the prose.
    const block = lines.findIndex((l) => l.includes("1 thinking") && !l.includes("bash"));
    const prose = lines.findIndex((l) => l.includes("PROSE AFTER"));
    check("mixed streaming row keeps a collapsed block above its prose",
      block >= 0 && prose > block && !lines[block].includes("LIVEOWN"), lines.join("\n"));
  }

  // R16. Prose arriving after the live host must pull the thinking back
  // above its own prose as a collapsed block; the run must not keep counting
  // it.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "go" },
      { op: "start", id: "a" },
      { op: "tool", id: "a", toolId: "a1", name: "bash", args: { command: "echo one" } },
      { op: "end", id: "a", stop: "toolUse" },
      { op: "result", toolId: "a1", text: "one" },
      { op: "tick" },
      { op: "start", id: "b" },
      { op: "thinking", id: "b", text: "LIVEPROSE" },
      { op: "text", id: "b", text: "PROSE ARRIVES" },
    ]);
    const lines = driver.dump(world).lines;
    const header = lines.findIndex((l) => l.includes("bash"));
    check("prose arrival releases the live thinking",
      header >= 0 && !lines[header].includes("thinking"), lines.join("\n"));
    const block = lines.findIndex((l) => /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏▸]1 thinking\b/.test(l));
    const prose = lines.findIndex((l) => l.includes("PROSE ARRIVES"));
    check("prose arrival keeps the collapsed block above its prose",
      block >= 0 && prose > block && !lines.some((l) => l.includes("LIVEPROSE")), lines.join("\n"));
  }

  // R17. The message's own tool mounts after the thinking: the live item
  // moves under that tool (before it), not after the previous block.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "go" },
      { op: "start", id: "a" },
      { op: "tool", id: "a", toolId: "a1", name: "bash", args: { command: "echo one" } },
      { op: "end", id: "a", stop: "toolUse" },
      { op: "result", toolId: "a1", text: "one" },
      { op: "tick" },
      { op: "start", id: "b" },
      { op: "thinking", id: "b", text: "LIVEOWNTOOL" },
      { op: "tool", id: "b", toolId: "b1", name: "bash", args: { command: "echo two" } },
      { op: "tick" },
    ]);
    const header = driver.dump(world).lines.find((l) => l.includes("bash")) ?? "";
    check("own tool keeps the live thinking in one block",
      header.includes("2 bash") && header.includes("1 thinking"), header);
    driver.openRun(world, "a1");
    const opened = driver.dump(world).lines;
    const one = opened.findIndex((l) => l.includes("echo one"));
    const live = opened.findIndex((l) => l.includes("LIVEOWNTOOL"));
    const two = opened.findIndex((l) => l.includes("echo two"));
    check("own tool anchors the live preview before it",
      one >= 0 && live > one && two > live, opened.join("\n"));
  }

  // R18. A first-turn thinking with no block to join stays visible as a
  // collapsed block; live hosting must never hide a row with nowhere to go.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "go" },
      { op: "start", id: "b" },
      { op: "thinking", id: "b", text: "LIVEALONE" },
      { op: "tick" },
    ]);
    const lines = driver.dump(world).lines;
    const block = lines.findIndex((l) => /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]1 thinking\b/.test(l));
    check("first-turn live thinking is a collapsed block",
      block >= 0 && !lines.some((l) => l.includes("LIVEALONE")), lines.join("\n"));
    check("first-turn live thinking has no empty block",
      !lines.some((l) => l.trim().startsWith("▸")), lines.join("\n"));
  }

  // R19. Pi's event order, not an approximation: extension handlers run
  // before the UI listener, and message_end runs BEFORE the message is
  // persisted. The replay driver used to persist first, hiding every
  // settled-vs-live difference at message_end.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "order check" },
      { op: "start", id: "ord" },
      { op: "text", id: "ord", text: "answer" },
      { op: "end", id: "ord", stop: "stop" },
      { op: "turn" },
    ]);
    const extEnd = world.events.find((e) => e.type === "message_end" && e.role === "assistant");
    const persist = world.events.find((e) => e.side === "persist" && e.role === "assistant");
    check("message_end extension sees the message unpersisted",
      !!extEnd && extEnd.side === "extension" && extEnd.entryCount === 1,
      JSON.stringify(world.events.filter((e) => e.role === "assistant")));
    const uiEnd = world.events.find((e) => e.side === "ui" && e.type === "message_end" && e.role === "assistant");
    check("extension -> UI -> persistence is the event order",
      !!extEnd && !!uiEnd && !!persist && extEnd.seq < uiEnd.seq && uiEnd.seq < persist.seq,
      JSON.stringify(world.events.filter((e) => e.role === "assistant")));
    check("message_update reaches the extension as a Pi copy",
      world.messageCopies.length >= 1 && world.messageCopies.every((e) => e.message !== e.canonical),
      `${world.messageCopies.length} copies`);
  }

  // R20. The replay host must be Pi's REAL ToolExecutionComponent, with the
  // real lifecycle. The old fake host could not expose argsComplete,
  // executionStarted, result errors, or the stock click path.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "tool check" },
      { op: "start", id: "tc" },
      { op: "tool", id: "tc", toolId: "tc1", name: "bash", args: { command: "echo one" } },
      { op: "end", id: "tc", stop: "toolUse" },
      { op: "result", toolId: "tc1", text: "one" },
      { op: "turn" },
    ]);
    const slot = world.toolComps.get("tc1");
    check("replay mounts a real ToolExecutionComponent",
      !!slot && !!world.PI.ToolExecutionComponent && slot.comp instanceof world.PI.ToolExecutionComponent,
      slot ? slot.comp?.constructor?.name : "no slot");
    check("tool lifecycle marks execution and args complete",
      !!slot && slot.comp.executionStarted === true && slot.comp.argsComplete === true,
      slot ? JSON.stringify({ started: slot.comp.executionStarted, args: slot.comp.argsComplete }) : "no slot");
    check("tool result reaches the real component",
      !!slot && slot.comp.result?.content?.[0]?.text === "one" && slot.comp.isPartial === false,
      slot ? JSON.stringify(slot.comp.result) : "no slot");
    check("tool execution events are emitted",
      world.events.some((e) => e.type === "tool_execution_start") &&
      world.events.some((e) => e.type === "tool_execution_end"),
      JSON.stringify(world.events.map((e) => e.type)));
    check("toolResult messages use message_start/message_end",
      world.events.some((e) => e.type === "message_start" && e.role === "toolResult") &&
      world.events.some((e) => e.type === "message_end" && e.role === "toolResult"),
      JSON.stringify(world.events.map((e) => `${e.type}:${e.role ?? ""}`)));
  }

  // R21. Abort must follow Pi's message_end UI branch: pending tools get an
  // error result, are marked complete, and the row renders "Operation
  // aborted". The old driver only changed stopReason, so R12 missed it.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, loadFixture("aborted-mixed").live);
    const slot = world.toolComps.get("x1");
    check("abort gives the pending tool an error result",
      !!slot && slot.comp.result?.isError === true,
      slot ? JSON.stringify(slot.comp.result) : "no slot");
    check("abort leaves args incomplete like Pi (no setArgsComplete)",
      !!slot && slot.comp.argsComplete === false && slot.comp.isPartial === false,
      slot ? JSON.stringify({ args: slot.comp.argsComplete, partial: slot.comp.isPartial }) : "no slot");
    check("abort renders the stock tool error",
      driver.dump(world).lines.some((l) => l.includes("Operation aborted")),
      driver.dump(world).lines.join("\n"));
  }

  // R21b. Error uses Pi's same interactive-mode cleanup branch, with the
  // message's errorMessage (or its fallback) instead of the abort text.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "error check" },
      { op: "start", id: "err" },
      { op: "tool", id: "err", toolId: "err1", name: "bash", args: { command: "echo fail" } },
      { op: "end", id: "err", stop: "error" },
    ]);
    const slot = world.toolComps.get("err1");
    check("error gives the pending tool an error result",
      !!slot && slot.comp.result?.isError === true,
      slot ? JSON.stringify(slot.comp.result) : "no slot");
    check("error leaves args incomplete like Pi",
      !!slot && slot.comp.argsComplete === false && slot.comp.isPartial === false,
      slot ? JSON.stringify({ args: slot.comp.argsComplete, partial: slot.comp.isPartial }) : "no slot");
  }

  // R22. The real extension prefers the compaction-aware context. A raw
  // branch is not enough: Pi moves the newest summary to the front before
  // rendering, and planning from the branch splits one run around it.
  {
    const world = driver.createWorld(PI, { width: 100 });
    check("driver exposes buildContextEntries",
      typeof world.sm.buildContextEntries === "function", typeof world.sm.buildContextEntries);
    const entries = loadFixture("history-split").restore;
    await driver.restore(world, entries);
    world.sm.getBranch = () => [];
    world.sm.getEntries = () => [];
    await world.fire("session_start", {}, { hasUI: true, ui: world.ui, sessionManager: world.sm });
    driver.tickOnce(world);
    check("history loads through buildContextEntries",
      driver.dump(world).lines.some((l) => l.includes("1 thinking")),
      driver.dump(world).lines.join("\n"));
  }

  // R23. `/reload` builds a NEW extension runner from a fresh module. The
  // old driver reused the module and its state, so fresh-instance bugs were
  // invisible.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, loadFixture("history-split").restore);
    const beforeMod = world.mod;
    const before = driver.dump(world).lines.join("\n");
    await driver.reload(world);
    check("reload loads a fresh extension module", world.mod !== beforeMod,
      `${beforeMod === world.mod ? "same" : "different"} module`);
    check("fresh reload reproduces the screenshot", driver.dump(world).lines.join("\n") === before,
      `--- before ---\n${before}\n--- after ---\n${driver.dump(world).lines.join("\n")}`);
  }

  // R24. History must include visible custom entries and compaction
  // summaries. Dropping them from the replay model turned a real boundary
  // into adjacent blocks (and parity only read type:"message" lines).
  {
    const world = driver.createWorld(PI, { width: 100 });
    const entries = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } },
      { id: "a1", type: "message", message: {
        role: "assistant", timestamp: Date.now() - 2000,
        content: [{ type: "toolCall", id: "h1", name: "bash", arguments: { command: "echo one" } }],
      } },
      { id: "r1", type: "message", message: {
        role: "toolResult", toolCallId: "h1", toolName: "bash",
        content: [{ type: "text", text: "one" }],
      } },
      { id: "c1", type: "custom_message", customType: "note", content: [{ type: "text", text: "CUSTOM BOUNDARY" }], display: true, timestamp: Date.now() },
      { id: "a2", type: "message", message: {
        role: "assistant", timestamp: Date.now() - 1000,
        content: [{ type: "toolCall", id: "h2", name: "bash", arguments: { command: "echo two" } }],
      } },
      { id: "r2", type: "message", message: {
        role: "toolResult", toolCallId: "h2", toolName: "bash",
        content: [{ type: "text", text: "two" }],
      } },
    ];
    await driver.restore(world, entries);
    const lines = driver.dump(world).lines;
    const custom = lines.findIndex((l) => l.includes("CUSTOM BOUNDARY"));
    const headers = lines.map((l, i) => (/^\s*▸/.test(l) ? i : -1)).filter((i) => i >= 0);
    check("custom history row renders", custom >= 0, lines.join("\n"));
    check("custom row separates the two blocks",
      custom >= 0 && headers.length === 2 && headers[0] < custom && headers[1] > custom,
      JSON.stringify({ custom, headers }));
  }

  // R25. A compaction is a checkpoint, not a transcript separator. Pi
  // renders the newest summary first, then the kept entries and everything
  // after it. Planning from the raw branch put the summary between two tool
  // runs and produced touching headers with no visible content between them.
  {
    const world = driver.createWorld(PI, { width: 100 });
    const entries = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } },
      { id: "a1", type: "message", message: {
        role: "assistant", timestamp: Date.now() - 2000,
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo one" } }],
      } },
      { id: "r1", type: "message", message: {
        role: "toolResult", toolCallId: "c1", toolName: "bash",
        content: [{ type: "text", text: "one" }],
      } },
      { id: "cmp", type: "compaction", firstKeptEntryId: "a1", summary: "COMPACTION SUMMARY", timestamp: Date.now() },
      { id: "a2", type: "message", message: {
        role: "assistant", timestamp: Date.now() - 1000,
        content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "echo two" } }],
      } },
      { id: "r2", type: "message", message: {
        role: "toolResult", toolCallId: "c2", toolName: "bash",
        content: [{ type: "text", text: "two" }],
      } },
    ];
    await driver.restore(world, entries);
    const lines = driver.dump(world).lines;
    const summary = lines.findIndex((l) => l.includes("COMPACTION SUMMARY"));
    const headers = lines.map((l, i) => (/^\s*▸/.test(l) ? i : -1)).filter((i) => i >= 0);
    check("compaction summary renders first", summary >= 0 && summary < headers[0], lines.join("\n"));
    check("compaction keeps both tool runs in one block",
      headers.length === 1, JSON.stringify({ summary, headers }));
  }

  // R26. Every row in a multi-tool run shows its own duration. The opened
  // row builder gets the run owner's context, so inheriting `durationMs`
  // made each later row report the first tool's time (`Took 0.0s` when the
  // owner was fast). The real ToolExecutionComponent supplies the event
  // duration; the trace entry must carry its own copy to the row.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "duration check" },
      { op: "start", id: "dur" },
      { op: "tool", id: "dur", toolId: "dur-a", name: "bash", args: { command: "echo one" } },
      { op: "tool", id: "dur", toolId: "dur-b", name: "bash", args: { command: "echo two" } },
      { op: "result", toolId: "dur-a", text: "one", durationMs: 0 },
      { op: "result", toolId: "dur-b", text: "two", durationMs: 5000 },
      { op: "end", id: "dur", stop: "stop" },
    ]);
    driver.openRun(world, "dur-a");
    const slot = world.toolComps.get("dur-a");
    const trace = slot.comp.callRendererComponent ?? slot.inner;
    trace.children[2]?.onMouse?.({ type: "click", button: "left" });
    trace.render?.(100);
    const lines = driver.dump(world).lines.join("\n");
    check("each expanded row shows its own tool duration",
      lines.includes("Took 5.0s") && !lines.includes("Took 0.0s"), lines);
    const entries = world.mod.traceEntries;
    const map = typeof entries === "function" ? entries() : entries;
    check("trace entries keep per-row durations",
      map.get("dur-a")?.durationMs === 0 && map.get("dur-b")?.durationMs === 5000,
      JSON.stringify([map.get("dur-a")?.durationMs, map.get("dur-b")?.durationMs]));
  }

  // R27. A thinking that already grew its own tool is done: its preview
  // must not keep the live wheel while the tool builds/executes. Only the
  // tool row spins; the thinking preview settles to the rail.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "go" },
      { op: "start", id: "m1" },
      { op: "thinking", id: "m1", text: "thinking text here " },
      { op: "tool", id: "m1", toolId: "k1", name: "bash", args: { command: "echo two" } },
    ]);
    driver.openRun(world, "k1");
    const lines = driver.dump(world).lines;
    const wheel = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
    const thinkIdx = lines.findIndex((l) => l.includes("thinking text here"));
    const toolIdx = lines.findIndex((l) => l.includes("echo two"));
    check("thinking preview settles once its own tool builds",
      thinkIdx >= 0 && !wheel.test(lines[thinkIdx]), lines.join("\n"));
    check("the building tool row keeps the wheel",
      toolIdx >= 0 && wheel.test(lines[toolIdx]), lines.join("\n"));
  }

  // R28. The thinking joins its own tool's run as soon as the tool arrives
  // (same message), without waiting for a tick/end: no standalone thinking
  // line lingers underneath the new header.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "first" },
      { op: "start", id: "m0" },
      { op: "tool", id: "m0", toolId: "k0", name: "bash", args: { command: "echo one" } },
      { op: "end", id: "m0", stop: "toolUse" },
      { op: "result", toolId: "k0", text: "one" },
      { op: "turn" },
      { op: "tick" },
      { op: "user", text: "second" },
      { op: "start", id: "m1" },
      { op: "thinking", id: "m1", text: "new turn thinking " },
      { op: "tool", id: "m1", toolId: "k1", name: "bash", args: { command: "echo two" } },
    ]);
    const lines = driver.dump(world).lines;
    const standalone = lines.filter((l) => /^\s*[▸⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\d+ thinking\b/.test(l));
    const header = lines.find((l) => l.includes("echo") || (l.includes("1 bash") && l.includes("1 thinking")));
    check("no standalone thinking lingers under the new header",
      standalone.length === 0, lines.join("\n"));
    check("the new header counts the thinking",
      lines.some((l) => l.includes("1 bash") && l.includes("1 thinking")), lines.join("\n"));
  }

  // R29. Interrupting while the latest row is a streaming thinking-only
  // message must not strand it outside the block. The thinking joins its
  // run (header counts it, preview inside the open run); Pi's own
  // "Operation aborted" line stays mounted, so the interrupt is still
  // visible — partial detach removes only the thinking children.
  {
    const world = driver.createWorld(PI, { width: 100 });
    await driver.restore(world, []);
    await driver.runLive(world, [
      { op: "user", text: "go" },
      { op: "start", id: "m1" },
      { op: "tool", id: "m1", toolId: "k1", name: "bash", args: { command: "echo one" } },
      { op: "end", id: "m1", stop: "toolUse" },
      { op: "start", id: "m2" },
      { op: "thinking", id: "m2", text: "Analyzing a code condition for tool calls " },
      { op: "abort", id: "m2" },
      { op: "result", toolId: "k1", text: "one" },
      { op: "turn" },
      { op: "tick" },
    ]);
    const lines = driver.dump(world).lines;
    check("interrupted thinking joins the run header",
      lines.some((l) => l.includes("1 bash") && l.includes("1 thinking")), lines.join("\n"));
    check("the interrupt stays visible",
      lines.some((l) => l.includes("Operation aborted")), lines.join("\n"));
    check("no stranded stock thinking row outside the block",
      !lines.some((l) => l.includes("Analyzing a code condition")), lines.join("\n"));
  }

  console.log(failures === 0 ? "PASS: collapse replay" : `FAILURES: ${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("FATAL", e); process.exitCode = 1; });
