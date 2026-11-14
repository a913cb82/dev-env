// Parity checks on a REAL session slice.
//
// Three invariants, checked on the same transcript:
//   1. thinking:hidden and thinking:visible render the same ORDER of things
//      (user text, assistant prose, thinking, tool calls).
//   2. two run blocks never sit next to each other without a visible message
//      between them. A standalone `▸N thinking` is the first line of its own
//      message row, so it may follow a run (its prose is below).
//   3. live, /reload and quit->resume (/reload with fresh mount) produce the
//      same screenshot, both for collapsed blocks and for opened ones.
//
//   node replay/parity.cjs <session.jsonl> [--turns N] [--order-turns N] [--width 100]
//
// A real transcript quotes its own screenshots, and probes are substring
// matches: ordering is reliable on a slice whose text is unique, not on a
// whole session full of self-quotes. `--turns` sets the render slice; order
// is checked on the newest `--order-turns` of it (default 8). The
// live/resume/reload and adjacency checks always cover the whole slice.
//
// Exits non-zero when a check fails, so it can gate a commit.
const fs = require("node:fs");
const driver = require("./driver.cjs");

// ---------------------------------------------------------------------------
// Ops from real messages (same shape as from-session.cjs).
// ---------------------------------------------------------------------------
let seq = 0;
const id = (p) => `${p}${++seq}`;

function readEntries(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && typeof e === "object");
}

// Include every entry that Pi draws as a visible row. Compaction and branch
// summaries are rendered as Markdown, and extension custom messages are
// boxes; dropping them from the parity model made a boundary look adjacent.
function messagesFromEntries(entries) {
  const entryTime = (entry) => {
    const ms = new Date(entry.timestamp).getTime();
    return Number.isNaN(ms) ? undefined : ms;
  };
  const out = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      // Keep the ENTRY timestamp (what SessionManager persists and what
      // toolTimings uses), not only message.timestamp: they can differ by a
      // second, which made live/restore clock columns disagree.
      out.push({ ...entry.message, entryTime: entryTime(entry) });
    } else if ((entry.type === "custom" || entry.type === "custom_message") && entry.display !== false) {
      out.push({
        role: "custom",
        customType: entry.customType ?? "custom",
        content: entry.content ?? entry.message?.content ?? "",
        timestamp: entry.timestamp,
        entryTime: entryTime(entry),
      });
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.summary) {
      out.push({
        role: "custom", customType: entry.type, content: entry.summary,
        timestamp: entry.timestamp, entryTime: entryTime(entry),
      });
    }
  }
  return out;
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
    if (m.role === "custom") {
      const text = typeof m.content === "string" ? m.content
        : (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      ops.push({ op: "custom", text, customType: m.customType, timestamp: m.entryTime ?? m.timestamp });
      ops.push({ op: "tick" });
      continue;
    }
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content
        : (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      ops.push({ op: "user", text, timestamp: m.entryTime ?? m.timestamp });
      ops.push({ op: "tick" });
      continue;
    }
    if (m.role === "toolResult") {
      ops.push({ op: "result", toolId: m.toolCallId, text: toolText(m), timestamp: m.entryTime ?? m.timestamp });
      ops.push({ op: "tick" });
      continue;
    }
    if (m.role !== "assistant") continue;
    const mid = id("m");
    // A persisted assistant entry is stamped at message_end, but the message's
    // own timestamp is its start. Live replay must use the message clock, or
    // a long thinking block renders as 0s while a restored one shows its
    // durationMs. End is the stated completion when Pi recorded one.
    const startTime = typeof m.timestamp === "number" ? m.timestamp : m.entryTime;
    const endTime = typeof m.timestamp === "number" && typeof m.durationMs === "number"
      ? m.timestamp + m.durationMs
      : m.entryTime ?? m.timestamp;
    ops.push({ op: "start", id: mid, timestamp: startTime });
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
    ops.push({
      op: "end", id: mid, stop: m.stopReason || "stop", timestamp: endTime,
      ...(typeof m.durationMs === "number" ? { durationMs: m.durationMs } : {}),
    });
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

/** Text lines a Markdown renderer shows as prose: fenced blocks are code,
 *  and the parity scans blank them (a quoted screenshot must not read as a
 *  live block), so a probe taken from a fence could never match. */
function proseLines(text) {
  const out = [];
  let fenced = false;
  for (const raw of String(text ?? "").split("\n")) {
    if (raw.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(raw);
  }
  return out;
}

function probes(messages, { thinking = false } = {}) {
  const out = [];
  const push = (kind, text) => {
    // Tool rows show ONE line: the row's head is the first characters of the
    // collapsed argument text, not of its first newline-separated line (a
    // "set -e" first line is too short, and the next line falls in the
    // middle the row cuts away). Prose keeps its line structure and drops
    // fenced code.
    const source = kind === "tool" ? [clean(text)] : proseLines(text);
    const line = source
      .map((l) => clean(l)
        .replace(/^[\u2502>\u258f]+\s*/, "")
        // Markdown consumes emphasis, code and heading markers before
        // rendering; the screenshot has the visible text only.
        .replace(/^#{1,6}\s*/, "")
        .replace(/\*\*|__|`/g, ""))
      .find((l) => l.length >= 10);
    if (!line) return;
    out.push({ kind, frag: line.slice(0, Math.min(10, line.length)) });
  };
  for (const m of messages) {
    if (m.role === "custom") {
      push("prose", typeof m.content === "string" ? m.content : (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" "));
      continue;
    }
    if (m.role === "user" || m.role === "toolResult") {
      if (m.role === "user") push("user", typeof m.content === "string" ? m.content : (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" "));
      continue;
    }
    if (m.role !== "assistant") continue;
    for (const block of m.content || []) {
      // A thinking normally renders as a count and a preview; when it is
      // opened (or thinking is visible) its text is real content and must
      // not be skipped by the order check.
      if (block.type === "thinking") {
        if (thinking && block.thinking) push("thinking", block.thinking);
        continue;
      }
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
  if (kind === "thinking") {
    // Hidden+opened thinking lives on a `▏` rail (preview); visible thinking
    // is ordinary prose. Both are valid places for the text.
    return /^\s*▏/.test(line) || /^\s*[^\s│┃▏>╭╰]/.test(line);
  }
  return /^\s*[^\s│┃▏>╭╰]/.test(line);
}

// A real transcript quotes screenshots in fenced code blocks: those lines
// can start with `>` or `▏` and would otherwise read as live blocks/rows.
// Blank them out (same length, so indices stay meaningful) before scanning.
function unfenced(lines) {
  let fenced = false;
  let openedAt = -1;
  return lines.map((line, i) => {
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      openedAt = fenced ? i : -1;
      return "";
    }
    // A thinking block can end mid-fence; without a cap one unterminated
    // fence would blank the rest of the transcript and hide real adjacency.
    if (fenced && i - openedAt > 200) fenced = false;
    return fenced ? "" : line;
  });
}

function orderViolations(lines, list, { tools = true } = {}) {
  // Search the raw screenshot, fences included: quoted code is visible text
  // too, and probes are already restricted to fragments unique in the slice.
  // Only the adjacency scan needs fenced lines excluded (a quoted `▸` header
  // is not a live block).
  const problems = [];
  // Repeated fragments (the same command or phrase in two turns) cannot be
  // ordered by substring search: they match the first occurrence, not the
  // one this probe names. Check only probes unique in this slice.
  const counts = new Map();
  for (const p of list) counts.set(`${p.kind}|${p.frag}`, (counts.get(`${p.kind}|${p.frag}`) ?? 0) + 1);
  let cursor = 0;
  for (const probe of list) {
    if (!tools && probe.kind === "tool") continue;
    if ((counts.get(`${probe.kind}|${probe.frag}`) ?? 0) > 1) continue;
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

// Current markers: closed run/standalone `▸`, open run/standalone `▾`, and
// the same header while live with a spinner in column one. Keep this grammar
// next to the renderer; a stale marker silently disables the whole check.
const WHEEL = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const BLOCK_HEADER = new RegExp(`^(?:[▸▾]|[${WHEEL}])\\d+\\s`);
const STANDALONE_HEADER = new RegExp(`^(?:[▸▾]|[${WHEEL}])\\d+\\s+thinking\\b`);

/** Every live block header in a screenshot (indices after fence blanking). */
function blockHeaders(rawLines) {
  const lines = unfenced(rawLines);
  const out = [];
  lines.forEach((line, i) => {
    if (BLOCK_HEADER.test(line.trim())) out.push(i);
  });
  return out;
}

function blockHeaderCount(rawLines) {
  return blockHeaders(rawLines).length;
}

// Two collapsed blocks may not touch. A block is a `▸`/wheel line (header or
// standalone thinking); rows are `▏`/`┃`/blank; anything else is a visible
// message and resets the rule.
function adjacencyViolations(rawLines) {
  const lines = unfenced(rawLines);
  const problems = [];
  // A standalone thinking (`▸N thinking`) is the first line of an assistant
  // message that carries its own prose below: it is a visible-message start,
  // not a second run block. A run header directly under one is still wrong
  // (a thinking-only message must attach to a run, not precede one).
  let lastRun = -1;
  let lastStandalone = -1;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === "" || t.startsWith("▏") || t.startsWith("┃") || t.startsWith("│")) return;
    // A prose blockquote (`> 3 bash`) is a visible message, not a block.
    if (BLOCK_HEADER.test(t)) {
      const standalone = STANDALONE_HEADER.test(t);
      // run -> standalone is the intended shape for a thinking followed by
      // its own message's prose (the standalone IS that message's first
      // line). standalone -> anything, and run -> run, have nothing visible
      // between them.
      if (!standalone && (lastRun >= 0 || lastStandalone >= 0)) {
        problems.push(`blocks at lines ${lastRun >= 0 ? lastRun : lastStandalone} and ${i} with nothing visible between:\n  ${lines[lastRun >= 0 ? lastRun : lastStandalone]}\n  ${line}`);
      } else if (standalone && lastStandalone >= 0) {
        problems.push(`two standalone blocks at lines ${lastStandalone} and ${i}:\n  ${lines[lastStandalone]}\n  ${line}`);
      }
      if (standalone) {
        lastStandalone = i;
        lastRun = -1;
      } else {
        lastRun = i;
        lastStandalone = -1;
      }
      return;
    }
    lastRun = -1;
    lastStandalone = -1;
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
  const orderTurns = arg("--order-turns", Math.min(turns, 8));
  const width = arg("--width", 100);
  const allMessages = messagesFromEntries(readEntries(file));
  const messages = sliceTurns(allMessages, turns);
  const ops = turnOps(messages);
  const list = probes(sliceTurns(allMessages, orderTurns));

  const PI = await driver.loadPi();
  const worlds = {};

  // live
  {
    const world = driver.createWorld(PI, {
      width,
      clock: { value: messages[0]?.timestamp ?? Date.now() },
    });
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

  // A recognized marker is itself a precondition: the old `>` check passed
  // every transcript because the renderer had moved to `▸`.
  const liveBlocks = blockHeaderCount(dumps.live);
  if (liveBlocks === 0) fail("no current block headers recognized", dumps.live.join("\n"));
  else ok(`recognized ${liveBlocks} block header(s)`);

  // (3) all three paths identical, collapsed.
  for (const other of ["resume", "reload"]) {
    const a = dumps.live.join("\n"), b = dumps[other].join("\n");
    const name = `collapsed: live == ${other}`;
    if (a === b) ok(name);
    else fail(name, firstDiff(dumps.live, dumps[other]));
  }

  // (3b) all three identical with every run opened. Opening a row can
  // stamp a fallback end for a result observed late; pin the wall clock so
  // the comparison is about layout/ownership, not how long this process
  // has been running.
  const openDumps = {};
  const openNow = Date.now();
  const realNow = Date.now;
  Date.now = () => openNow;
  try {
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
      if (process.env.PARITY_DUMP) {
        require("node:fs").writeFileSync(
          `${process.env.PARITY_DUMP}.opened.${name}.txt`,
          openDumps[name].join("\n"),
        );
      }
    }
  } finally {
    Date.now = realNow;
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
    for (const [name, lines, opts, items] of [
      ["hidden+opened", openDumps.live, { tools: true }, list],
      ["visible", visible, { tools: false }, probes(sliceTurns(allMessages, orderTurns), { thinking: true })],
    ]) {
      const problems = orderViolations(lines, items, opts);
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

module.exports = {
  adjacencyViolations, blockHeaders, blockHeaderCount,
  probes, orderViolations, lineFits,
  readEntries, messagesFromEntries, sliceTurns, turnOps,
};

if (require.main === module) {
  main().catch((e) => { console.error("FATAL", e); process.exit(1); });
}
