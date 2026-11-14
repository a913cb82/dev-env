// Replay a real session slice through the LIVE path.
//
// The fixtures are hand-written, so they have only ever exercised shapes the
// extension author thought of. This reads an actual session JSONL and turns
// it into driver ops in the order Pi produced them: message_start, streamed
// deltas, tool_execution_start, message_end, tool results, and poll ticks in
// between (the extension converges on a 1s timer in production).
//
//   node replay/from-session.cjs <session.jsonl> [--turn N] [--ticks]
//
// --turn N replays the Nth-from-last turn (1 = last). Default 1.
const fs = require("node:fs");
const parity = require("./parity.cjs");

function lastTurns(messages) {
  const starts = [];
  messages.forEach((m, i) => { if (m.role === "user") starts.push(i); });
  return starts.map((s, k) => [s, k + 1 < starts.length ? starts[k + 1] : messages.length]);
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node replay/from-session.cjs <session.jsonl> [--turn N] [--ticks]");
    process.exit(2);
  }
  const turnArg = process.argv.indexOf("--turn");
  const n = turnArg > 0 ? Number(process.argv[turnArg + 1]) : 1;
  const entries = parity.contextEntries(parity.readEntries(file));
  const messages = parity.messagesFromEntries(entries);
  const turns = lastTurns(messages);
  const [from, to] = turns[turns.length - n] || [0, messages.length];
  const ops = parity.turnOps(messages.slice(from, to));

  if (process.argv.includes("--dump-ops")) {
    require("node:fs").writeFileSync("/tmp/ops.json", JSON.stringify(ops));
    console.log("wrote /tmp/ops.json");
    return;
  }
  const driver = require("./driver.cjs");
  const PI = await driver.loadPi();
  const world = driver.createWorld(PI, { width: 100 });
  await driver.restore(world, []);
  await driver.runLive(world, ops);
  // Extra polls: a converging render must be a fixed point, not drift
  // between a standalone label and an in-block cell (the flicker).
  for (let i = 0; i < 5; i++) driver.tickOnce(world);
  const shot = driver.dump(world);
  console.log(`turn ${n}: messages ${from}..${to - 1}, ${ops.length} ops`);
  console.log(shot.lines.map((l) => (l.trim() === "" ? "<BLANK>" : l.trimEnd())).join("\n"));
  console.log("diag:", shot.diag);
  if (process.argv.includes("--rows")) {
    for (const [i, c] of world.chat.children.entries()) {
      const msg = c.lastMessage;
      const kinds = msg ? (msg.content || []).map((b) => b.type === "thinking" ? "th" : b.type === "text" ? "tx" : b.type === "toolCall" ? "TO" : b.type).join("+") : "";
      let out = [];
      try { out = c.render(100).map((l) => (typeof l === "string" ? l : (l.text ?? ""))); } catch (e) { out = ["THREW"]; }
      const head = out.map((l) => String(l).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 2).join(" / ").slice(0, 90);
      console.log(`row ${i} ${c.constructor.name.replace("Component", "")}[${kinds}] -> ${JSON.stringify(head)}`);
    }
  }
  const again = driver.dump(world).lines.join("\n");
  if (again !== shot.lines.join("\n")) console.log("WARNING: render is not a fixed point");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
