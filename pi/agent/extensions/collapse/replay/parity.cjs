// Parity checks on a REAL session slice.
//
// Three invariants, checked on the same transcript:
//   1. thinking:hidden and thinking:visible render the same ORDER of things
//      (user text, assistant prose, thinking, tool calls).
//   2. two collapsed blocks never sit next to each other without a visible
//      message between them.
//   3. live, /reload and quit->resume (/reload with fresh mount) produce the
//      same screenshot, both for collapsed blocks and for opened ones.
//
//   node replay/parity.cjs <session.jsonl> [--turns N] [--width 100]
//
// Exits non-zero when a check fails, so it can gate a commit.
const fs = require("node:fs");
const driver = require("./driver.cjs");

// ---------------------------------------------------------------------------
// Ops from real messages (same shape as from-session.cjs).
// ---------------------------------------------------------------------------
let seq = 0;
const id = (p) => `${p}${++seq}`;

function readMessages(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.type === "message" && e.message)
    .map((e) => e.message);
}

function sliceTurns(messages, n) {
  // The newest turn is the one being written right now: its blocks are
  // half-finished, so it is not a render of the transcript. Use the last
  // N turns that are followed by another user message.
  const starts = [];
  messages.forEach((m, i) => { if (m.role === "user") starts.push(i); });
  const complete = starts.slice(0, -1); // drop the in-flight final turn
  const from = complete[Math.max(0, complete.length - n)];
  if (from === undefined) return [];
  return messages.slice(from, starts[complete.length]);
}

function turnOps(messages) {
  const ops = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content
        : (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      ops.push({ op: "user", text });
      ops.push({ op: "tick" });
      continue;
    }
    if (m.role === "toolResult") {
      ops.push({ op: "result", toolId: m.toolCallId, text: toolText(m) });
      ops.push({ op: "tick" });
      continue;
    }
    if (m.role !== "assistant") continue;
    const mid = id("m");
    ops.push({ op: "start", id: mid });
    for (const block of m.content || []) {
      if (block.type === "thinking") {
        const text = block.thinking || "";
        const cut = Math.max(1, Math.floor(text.length / 2));
        ops.push({ op: "thinking", id: mid, text: text.slice(0, cut) });
        ops.push({ op: "tick" });
        ops.push({ op: "thinking", id: mid, text: text.slice(cut) });
      } else if (block.type === "text") {
        ops.push({ op: "text", id: mid, text: block.text || "" });
      } else if (block.type === "toolCall") {
        ops.push({ op: "tool", id: mid, toolId: block.id, name: block.name, args: block.arguments || {} });
      }
      ops.push({ op: "tick" });
    }
    ops.push({ op: "end", id: mid, stop: m.stopReason || "stop" });
    ops.push({ op: "tick" });
  }
  return ops;
}

function toolText(m) {
  if (typeof m.content === "string") return m.content;
  return (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// ---------------------------------------------------------------------------
// Order probes: one distinctive fragment per rendered thing, in transcript
// order. A dump is in order when the fragments appear in increasing index.
// ---------------------------------------------------------------------------
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function probes(messages) {
  const out = [];
  const push = (kind, text) => {
    // Renderers wrap and middle-truncate: match the first LINE long enough
    // to be distinctive, not a fragment that spans a newline.
    const line = String(text ?? "").split("\n")
      .map((l) => clean(l).replace(/^[\u2502>\u258f]+\s*/, ""))
      .find((l) => l.length >= 10);
    if (!line) return;
    out.push({ kind, frag: line.slice(0, Math.min(10, line.length)) });
  };
  for (const m of messages) {
    if (m.role === "user" || m.role === "toolResult") {
      if (m.role === "user") push("user", typeof m.content === "string" ? m.content : (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" "));
      continue;
    }
    if (m.role !== "assistant") continue;
    for (const block of m.content || []) {
      // A thinking renders as a count and a preview: its text is often
      // truncated, so order is checked on prose, users and tools.
      if (block.type === "thinking") continue;
      if (block.type === "text") push("prose", block.text);
      else if (block.type === "toolCall") push("tool", probeForTool(block));
    }
  }
  return out;
}

function probeForTool(block) {
  const args = block.arguments && typeof block.arguments === "object" ? block.arguments : {};
  for (const key of ["command", "path", "file_path", "pattern", "query", "description", "prompt"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length >= 8) return value;
  }
  const first = Object.values(args).find((v) => typeof v === "string" && v.trim().length >= 8);
  return first || JSON.stringify(args);
}

// Where a kind of item can legitimately appear. Tool RESULTS echo prose and
// commands (this transcript contains dumps of itself), so a bare substring
// match finds text in the wrong place. Prose lives on indented lines; tool
// rows carry the `▏` rail.
function lineFits(kind, line) {
  if (kind === "tool") return /^\s*▏/.test(line);
  return /^\s*[^\s│┃▏>╭╰]/.test(line);
}

function orderViolations(lines, list, { tools = true } = {}) {
  const problems = [];
  let cursor = 0;
  for (const probe of list) {
    if (!tools && probe.kind === "tool") continue;
    let at = -1;
    for (let i = cursor; i < lines.length; i++) {
      if (lineFits(probe.kind, lines[i]) && lines[i].includes(probe.frag)) { at = i; break; }
    }
    if (at < 0) {
      // Maybe it rendered earlier (out of order) or not at all.
      const anywhere = lines.findIndex((line) => lineFits(probe.kind, line) && line.includes(probe.frag));
      problems.push(anywhere >= 0
        ? `${probe.kind} "…${probe.frag.slice(0, 28)}…" rendered at line ${anywhere}, before line ${cursor}`
        : `${probe.kind} "…${probe.frag.slice(0, 28)}…" missing`);
      continue;
    }
    cursor = at + 1;
  }
  return problems;
}

// Two collapsed blocks may not touch. A block is a `>` line (header or
// standalone thinking); rows are `▏`/`┃`/blank; anything else is a visible
// message and resets the rule.
function adjacencyViolations(lines) {
  const problems = [];
  let lastBlock = -1;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === "" || t.startsWith("▏") || t.startsWith("┃") || t.startsWith("│")) return;
    if (t.startsWith(">")) {
      if (lastBlock >= 0) problems.push(`blocks at lines ${lastBlock} and ${i} with nothing visible between:\n  ${lines[lastBlock]}\n  ${line}`);
      lastBlock = i;
      return;
    }
    lastBlock = -1;
  });
  return problems;
}

// ---------------------------------------------------------------------------
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node replay/parity.cjs <session.jsonl> [--turns N] [--width N]");
    process.exit(2);
  }
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? Number(process.argv[i + 1]) : def;
  };
  const turns = arg("--turns", 3);
  const width = arg("--width", 100);
  const messages = sliceTurns(readMessages(file), turns);
  const ops = turnOps(messages);
  const list = probes(messages);

  const PI = await driver.loadPi();
  const worlds = {};

  // live
  {
    const world = driver.createWorld(PI, { width });
    await driver.restore(world, []);
    await driver.runLive(world, ops);
    worlds.live = world;
  }
  // quit -> resume (start, then mount)
  {
    const world = driver.createWorld(PI, { width });
    await driver.restore(world, worlds.live.entries);
    worlds.resume = world;
  }
  // /reload on an existing session (mount, then start)
  {
    const world = driver.createWorld(PI, { width });
    await driver.restoreLate(world, worlds.live.entries);
    worlds.reload = world;
  }

  let failures = 0;
  const fail = (name, details) => { failures++; console.log(`FAIL - ${name}\n${details}\n`); };
  const ok = (name) => console.log(`ok - ${name}`);

  if (process.env.PARITY_DUMP) {
    for (const [name, world] of Object.entries(worlds)) {
      require("node:fs").writeFileSync(`${process.env.PARITY_DUMP}.${name}.txt`, driver.dump(world).lines.join("\n"));
    }
  }
  const dumps = {};
  for (const [name, world] of Object.entries(worlds)) {
    dumps[name] = driver.dump(world).lines;
  }

  // (3) all three paths identical, collapsed.
  for (const other of ["resume", "reload"]) {
    const a = dumps.live.join("\n"), b = dumps[other].join("\n");
    const name = `collapsed: live == ${other}`;
    if (a === b) ok(name);
    else fail(name, firstDiff(dumps.live, dumps[other]));
  }

  // (3b) all three identical with every run opened.
  const openDumps = {};
  for (const [name, world] of Object.entries(worlds)) {
    const copy = driver.createWorld(PI, { width });
    await driver.restore(copy, world.entries);
    const runs = runsOf(copy);
    for (const runId of runs) {
      try {
        const owner = ownerToolOf(copy, runId);
        if (owner) driver.openRun(copy, owner);
      } catch { /* structure miss, compared instead */ }
    }
    openDumps[name] = driver.dump(copy).lines;
  }
  for (const other of ["resume", "reload"]) {
    const name = `opened: live == ${other}`;
    if (openDumps.live.join("\n") === openDumps[other].join("\n")) ok(name);
    else fail(name, firstDiff(openDumps.live, openDumps[other]));
  }

  // (1) hidden vs visible ordering, collapsed and opened.
  {
    const world = driver.createWorld(PI, { width, hideThinkingBlock: false });
    await driver.restore(world, worlds.live.entries);
    const visible = driver.dump(world).lines;
    // The collapsed hidden view shows only headers and counts, so it cannot
    // be ordered by content: compare the flattened views.
    for (const [name, lines, opts] of [["hidden+opened", openDumps.live, { tools: true }], ["visible", visible, { tools: false }]]) {
      const problems = orderViolations(lines, list, opts);
      if (problems.length === 0) ok(`order holds: ${name}`);
      else fail(`order broken: ${name}`, problems.slice(0, 8).join("\n") + `\n---\n${lines.join("\n")}`);
    }
  }

  // (2) no adjacent blocks.
  for (const [name, lines] of [["live", dumps.live], ["resume", dumps.resume], ["reload", dumps.reload], ["opened", openDumps.live]]) {
    const problems = adjacencyViolations(lines);
    if (problems.length === 0) ok(`no adjacent blocks: ${name}`);
    else fail(`adjacent blocks: ${name}`, problems.join("\n") + `\n---\n${lines.join("\n")}`);
  }

  console.log(failures === 0 ? "PASS: parity" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

function runsOf(world) {
  const runs = new Set();
  const te = world.mod.traceEntries;
  const map = typeof te === "function" ? te() : te;
  for (const entry of map.values()) if (typeof entry.runId === "number") runs.add(entry.runId);
  return [...runs];
}

function ownerToolOf(world, runId) {
  const te = world.mod.traceEntries;
  const map = typeof te === "function" ? te() : te;
  for (const [toolId, entry] of map) if (entry.runId === runId && world.toolComps.has(toolId)) return toolId;
  return undefined;
}

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  const out = [];
  for (let i = 0; i < n && out.length < 24; i++) {
    if ((a[i] ?? "<missing>") === (b[i] ?? "<missing>")) continue;
    out.push(`line ${i}\n  live:   ${JSON.stringify(a[i] ?? "<missing>")}\n  other:  ${JSON.stringify(b[i] ?? "<missing>")}`);
  }
  return out.join("\n");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
