// Tests for collapse/index.ts — compact tool renderers + dynamic hidden
// thinking label. Mocks pi + theme; loads TS via jiti with the real bundle
// aliased (same approach as subagents/*.test.cjs).
// Run: node collapse.test.cjs
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

function findPiRoot() {
  if (process.env.PI_ROOT) return process.env.PI_ROOT;
  // Pinned managed install: ~/.pi/agent/install/releases/<ver>/node_modules/@earendil-works/pi-coding-agent
  try {
    const version = fs.readFileSync(path.join(process.env.HOME, ".pi/agent/install/current-version"), "utf8").trim();
    const root = path.join(
      process.env.HOME,
      ".pi/agent/install/releases",
      version,
      "node_modules/@earendil-works/pi-coding-agent",
    );
    if (fs.existsSync(path.join(root, "dist", "bundle", "index.js"))) return root;
  } catch { /* fall through to legacy layout */ }
  const bin = execSync("command -v pi", { encoding: "utf8" }).trim();
  const real = fs.realpathSync(bin);
  // <root>/dist/bundle/cli.js
  return path.resolve(path.dirname(real), "..", "..");
}

const PI = findPiRoot();
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

// Reset hook of the newest activation (each jiti import is its own module
// instance, so the registry under test is the one last activated).
let resetTrace = () => {};
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${extra !== undefined ? `: ${extra}` : ""}`);
  }
}

// Marker theme: visible styling assertions without ANSI.
const theme = {
  fg: (color, text) => `<${color}>${text}</>`,
  bg: (color, text) => `<bg:${color}>${text}</>`,
  bold: (text) => `<b>${text}</b>`,
  italic: (text) => `<i>${text}</i>`,
  style: (text, opts) => `<b${opts.fg ? `:${opts.fg}` : ""}>${text}</b>`,
};

function createMockPi() {
  const tools = new Map();
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    tools,
    handlers,
    commands,
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name, opts) => {
      commands.set(name, opts);
    },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    _pad: 1,
    _hidden: true,
    getSettings: () => ({ outputPad: pi._pad, hideThinkingBlock: pi._hidden }),
  };
  return pi;
}

function callContext(overrides = {}) {
  // Each render test starts a fresh tool run (production runs are bounded
  // by message/turn events; the linear suite has none between tests).
  resetTrace();
  let invalidated = 0;
  const ctx = {
    args: {},
    toolCallId: "t1",
    invalidate: () => {
      invalidated++;
    },
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    ...overrides,
  };
  return { ctx, invalidated: () => invalidated };
}

function textResult(chars) {
  return { content: [{ type: "text", text: "x".repeat(chars) }], details: {} };
}

(async () => {
  const mod = await jiti.import(path.join(HERE, "index.ts"));
  resetTrace = mod.resetTraceState ?? resetTrace;
  const factory = mod.default ?? mod;
  const pi = createMockPi();
  factory(pi);

  // 1. registers all eight built-in tools
  const builtins = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
  for (const name of builtins) {
    check(`registers ${name}`, pi.tools.has(name), [...pi.tools.keys()].join(","));
  }

  // 1b. self framing: no Box background, border, indent, or padding gaps
  for (const name of builtins) {
    check(`${name} self shell`, pi.tools.get(name).renderShell === "self", pi.tools.get(name).renderShell);
  }

  // 2. read collapsed call before result: one line, styled parts, no count
  {
    const read = pi.tools.get("read");
    const { ctx } = callContext({ args: { path: "/path/to/file", offset: 10, limit: 11 } });
    const lines = read.renderCall(ctx.args, theme, ctx).render(80);
    check("read one line", lines.length === 1, JSON.stringify(lines));
    const line = lines[0];
    check("read prefix", line.startsWith("› "), JSON.stringify(line));
    check("read tool bold", line.includes("<b:accent>read "), JSON.stringify(line));
    check("read dir grey", line.includes("<dim>/path/to/</>"), JSON.stringify(line));
    check("read base bold", line.includes("<b>file</b>"), JSON.stringify(line));
    check("read range red", line.includes("<error>:10-20</>"), JSON.stringify(line));
    check("read no count yet", !line.includes("ch"), JSON.stringify(line));
  }

  // 3. read result stores count + invalidates; re-render shows right-aligned count
  {
    const read = pi.tools.get("read");
    const state = {};
    let invalidated = 0;
    const ctx = {
      ...callContext({ args: { path: "/path/to/file", offset: 10, limit: 11 }, state }).ctx,
      state,
      invalidate: () => {
        invalidated++;
      },
    };
    const out = read.renderResult(textResult(5300), { expanded: false, isPartial: false }, theme, ctx);
    check("read result collapsed empty", out.render(80).join("") === "", JSON.stringify(out.render(80)));
    check("read result stores count", state.count === 5300, JSON.stringify(state));
    check("read result invalidates", invalidated === 1, String(invalidated));
    const lines = read.renderCall(ctx.args, theme, { ...ctx, state }).render(100);
    check("read count shown", lines[0].endsWith("<dim>5.3k ch</>"), JSON.stringify(lines[0]));
    check("read padded to width", lines[0].length === 99, `${lines[0].length}: ${JSON.stringify(lines[0])}`);
  }

  // 4. read failure: tool name red bold
  {
    const read = pi.tools.get("read");
    const { ctx } = callContext({ args: { path: "/path/to/file" }, isError: true, state: { count: 12 } });
    const line = read.renderCall(ctx.args, theme, ctx).render(80)[0];
    check("read failure red bold", line.includes("<b:error>read </b>"), JSON.stringify(line));
  }

  // 5. bash collapsed call: `$ first` bold, rest plain
  {
    const bash = pi.tools.get("bash");
    const { ctx } = callContext({ args: { command: "timeout 25 ls some/dist" } });
    const line = bash.renderCall(ctx.args, theme, ctx).render(100)[0];
    check("bash prefix", line.startsWith("› "), JSON.stringify(line));
    check("bash head bold", line.includes("<b:accent>$ timeout</b>"), JSON.stringify(line));
    check("bash rest plain", line.includes(" 25 ls some/dist"), JSON.stringify(line));
  }

  // 5b. env assignments: only the variable name is highlighted
  {
    const bash = pi.tools.get("bash");
    const { ctx } = callContext({ args: { command: "PIN=/x ls /y" } });
    const line = bash.renderCall(ctx.args, theme, ctx).render(80)[0];
    check("bash env name bold", line.includes("<b:accent>$ PIN</b>=/x"), JSON.stringify(line));
    check("bash env value plain", !line.includes("=/x</b>"), JSON.stringify(line));
  }

  // 6. bash failure: `$ first` red bold
  {
    const bash = pi.tools.get("bash");
    const { ctx } = callContext({ args: { command: "timeout 25 ls some/dist" }, isError: true, state: { count: 100 } });
    const line = bash.renderCall(ctx.args, theme, ctx).render(100)[0];
    check("bash failure red bold", line.includes("<b:error>$ timeout</b>"), JSON.stringify(line));
  }

  // 7. Pi-expanded rest is still one row; a click opens the stock box
  {
    const read = pi.tools.get("read");
    const args = { path: "/path/to/file", offset: 10, limit: 11 };
    const { ctx } = callContext({ args, expanded: true, isPartial: true });
    const rest = read.renderCall(args, theme, ctx).render(80);
    check("expanded rest stays a row", rest.length === 1, JSON.stringify(rest));
    read.renderCall(args, theme, ctx).children[0].onMouse({ type: "click", button: "left" });
    const lines = read.renderCall(args, theme, ctx).render(80);
    check("opened call boxed", lines.length > 2, `${lines.length}`);
    check("opened call pending bg", lines[0].includes("toolPendingBg"), JSON.stringify(lines[0]));
    check("opened call keeps content", lines.some((l) => l.includes("/path/to/file")), JSON.stringify(lines).slice(0, 200));
    const { ctx: doneCtx } = callContext({ args, expanded: true, isPartial: false });
    read.renderCall(args, theme, doneCtx).children[0].onMouse({ type: "click", button: "left" });
    const doneLines = read.renderCall(args, theme, doneCtx).render(80);
    check("opened call success bg", doneLines[0].includes("toolSuccessBg"), JSON.stringify(doneLines[0]));
  }

  // 7b. expanded result is boxed too; edit (self-shell stock) stays bare.
  // Pi always runs call before result in one pass and shows the call-slot
  // component, so drive both and read the box from the call slot.
  {
    const read = pi.tools.get("read");
    const state = {};
    const args = { path: "/path/to/file" };
    const { ctx } = callContext({ args, expanded: true, state });
    read.renderCall(args, theme, { ...ctx, state });
    read.renderResult(textResult(5300), { expanded: true, isPartial: false }, theme, { ...ctx, state });
    read.renderCall(args, theme, { ...ctx, state }).children[0].onMouse({ type: "click", button: "left" });
    const lines = read.renderCall(args, theme, { ...ctx, state }).render(80);
    check("opened result boxed", lines.length > 2 && lines[0].includes("toolSuccessBg"), JSON.stringify(lines[0]));
    const edit = pi.tools.get("edit");
    const { ctx: ectx } = callContext({ args: { path: "/f", edits: [{ oldText: "a", newText: "b" }] }, expanded: true });
    edit.renderCall(ectx.args, theme, ectx).children[0].onMouse({ type: "click", button: "left" });
    const elines = edit.renderCall(ectx.args, theme, ectx).render(80);
    check("edit opened stays bare", !elines.some((l) => l.includes("toolSuccessBg")), JSON.stringify(elines).slice(0, 160));
  }

  // 7c. expanded is one continuous box, stable across updates (no reuse poisoning)
  {
    resetTrace();
    const agent = await jiti.import("@earendil-works/pi-coding-agent");
    const tui = await jiti.import("@earendil-works/pi-tui");
    agent.initTheme("light");
    const themeMod = await jiti.import(
      path.join(PI, "dist", "modes", "interactive", "theme", "theme.js"),
    );
    const realTheme = themeMod.loadThemeFromPath(
      path.join(PI, "dist", "modes", "interactive", "theme", "light.json"),
      "truecolor",
    );
    const mkcomp = (def) => {
      const c = new agent.ToolExecutionComponent(
        "bash",
        "t1",
        { command: "echo hi" },
        { showImages: true, imageWidthCells: 60 },
        def,
        { requestRender() {} },
        "/repo",
      );
      c.setExpanded(true);
      c.markExecutionStarted();
      c.setArgsComplete();
      return c;
    };
    const wrapped = mkcomp(pi.tools.get("bash"));
    const stock = mkcomp(agent.createBashToolDefinition("/repo"));
    wrapped.updateResult({ content: [{ type: "text", text: "hi" }], details: {} }, false);
    stock.updateResult({ content: [{ type: "text", text: "hi" }], details: {} }, false);
    // Pi-expanded rest is one row; open it to reach the stock section.
    const beforeClick = wrapped.render(100);
    check("wrapped rest is one row", beforeClick.length === 2 && beforeClick[1].startsWith("› "), JSON.stringify(beforeClick));
    wrapped.callRendererComponent.children[0].onMouse({ type: "click", button: "left" });
    wrapped.invalidate();
    const wlines = wrapped.render(100);
    const slines = stock.render(100);
    check("expanded single box", wlines.length === slines.length, `${wlines.length} vs ${slines.length}`);
    check("expanded box aligned", JSON.stringify(wlines) === JSON.stringify(slines), "wrapped differs from stock");
    // second update pass: stock reuse chain must survive (no fallback)
    wrapped.updateResult({ content: [{ type: "text", text: "hi\nbye" }], details: {} }, false);
    const wlines2 = wrapped.render(100);
    const flat = wlines2.map((l) => tui.stripTerminalSequences(l)).join("\n");
    check("expanded update keeps chrome", wlines2.some((l) => l.includes("48;2")) && flat.includes("$ echo hi"), flat.slice(0, 200));
  }

  // 8. message_end with thinking updates the hidden label with preview + count
  // test env has no tty columns, so the width fallback (77) applies
  {
    const handlers = pi.handlers.get("message_end") ?? [];
    check("message_end subscribed", handlers.length === 1, String(handlers.length));
    let label;
    const ctx = { hasUI: true, ui: { setHiddenThinkingLabel: (value) => { label = value; } } };
    const thinking = "a".repeat(1500);
    await handlers[0]({ message: { role: "assistant", content: [{ type: "thinking", thinking }] } }, ctx);
    const expected = `${"a".repeat(34)}…${"a".repeat(34)} 1.5k ch`;
    check("thinking label preview+count", label === expected, JSON.stringify(label)?.slice(0, 120));
    check("thinking label has no prefix", !label.startsWith("Thinking"), JSON.stringify(label)?.slice(0, 40));
    check("thinking label fills width", label.length === 77, `${label.length}: ${JSON.stringify(label)}`);
  }

  // 8a1. explicit terminal width widens the preview budget
  {
    const realColumns = process.stdout.columns;
    process.stdout.columns = 200;
    try {
      const handlers = pi.handlers.get("message_end") ?? [];
      let label;
      const ctx = { hasUI: true, ui: { setHiddenThinkingLabel: (value) => { label = value; } } };
      await handlers[0](
        { message: { role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(1500) }] } },
        ctx,
      );
      check("wide label fills width", label.length === 197, `${label.length}`);
      check("wide label keeps tail", label.endsWith("1.5k ch"), JSON.stringify(label).slice(-40));
    } finally {
      process.stdout.columns = realColumns;
    }
  }

  // 8a. long commands are not pre-truncated: only the row width cuts
  {
    const bash = pi.tools.get("bash");
    const cmd = `run ${"x".repeat(100)} end`;
    const { ctx } = callContext({ args: { command: cmd }, state: { count: 10 } });
    const line = bash.renderCall(ctx.args, theme, ctx).render(200)[0];
    check("bash long kept", line.includes("end"), JSON.stringify(line).slice(-80));
    check("bash long no early ellipsis", !line.includes("…"), JSON.stringify(line).slice(-80));
  }

  // 8a2. narrow rows truncate in the middle: head and tail survive
  {
    const bash = pi.tools.get("bash");
    const cmd = `run ${"x".repeat(100)} end`;
    const { ctx } = callContext({ args: { command: cmd }, state: { count: 10 } });
    const line = bash.renderCall(ctx.args, theme, ctx).render(50)[0];
    check("row middle keeps head", line.includes("$ ru"), JSON.stringify(line));
    check("row middle keeps tail", line.includes("end"), JSON.stringify(line).slice(-60));
    check("row middle cuts middle", line.includes("…"), JSON.stringify(line));
  }

  // 8b. partial (streaming) results stay collapsed too
  {
    const bash = pi.tools.get("bash");
    const state = {};
    const { ctx } = callContext({ args: { command: "timeout 25 ls some/dist" }, state });
    const out = bash.renderResult(textResult(50), { expanded: false, isPartial: true }, theme, ctx);
    check("partial collapsed empty", out.render(80).join("") === "", JSON.stringify(out.render(80)));
    check("partial stores count", state.count === 50, JSON.stringify(state));
  }

  // 8c. /collapse reports the loaded revision and last thinking label
  {
    check("collapse command registered", pi.commands.has("collapse"), [...pi.commands.keys()].join(","));
    const fresh = createMockPi();
    factory(fresh);
    const notes = [];
    await fresh.commands.get("collapse").handler("", { ui: { notify: (msg) => notes.push(msg) } });
    check("collapse reports revision", notes.join("").includes("collapse r"), JSON.stringify(notes));
    check("collapse reports default label", notes.join("").includes("default"), JSON.stringify(notes));
    const handlers = pi.handlers.get("message_end") ?? [];
    await handlers[0](
      { message: { role: "assistant", content: [{ type: "thinking", thinking: "hello world" }] } },
      { hasUI: true, ui: { setHiddenThinkingLabel: () => {} } },
    );
    const notes2 = [];
    await pi.commands.get("collapse").handler("", { ui: { notify: (msg) => notes2.push(msg) } });
    check("collapse reports last label", notes2.join("").includes("hello world"), JSON.stringify(notes2));
    check("collapse label has no prefix", !notes2.join("").includes("Thinking hello"), JSON.stringify(notes2));
    check("collapse reports compact mode", notes2.join("").includes("compact rows"), JSON.stringify(notes2));
  }

  // 8d. session_start backfills the label from history
  {
    const handlers = pi.handlers.get("session_start") ?? [];
    check("session_start subscribed", handlers.length === 1, String(handlers.length));
    let label;
    const entries = [
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "older" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "newer turn" }] } },
    ];
    await handlers[0](
      {},
      { hasUI: true, ui: { setHiddenThinkingLabel: (value) => { label = value; } }, sessionManager: { getEntries: () => entries } },
    );
    check(
      "session_start backfills",
      label.startsWith("newer turn") && !label.startsWith("Thinking") && label.endsWith("0.0k ch") && label.length === 77,
      JSON.stringify(label),
    );
    let called = false;
    await handlers[0](
      {},
      { hasUI: true, ui: { setHiddenThinkingLabel: () => { called = true; } }, sessionManager: { getEntries: () => [] } },
    );
    check("session_start empty history quiet", called === false, String(called));
  }

  // 8d2. thinking visible restores stock tool sections (same chrome as expanded)
  {
    pi._hidden = false;
    try {
      const read = pi.tools.get("read");
      const args = { path: "/path/to/file", offset: 10, limit: 11 };
      const { ctx } = callContext({ args });
      const lines = read.renderCall(args, theme, ctx).render(80);
      check("visible call stock chrome", lines.length > 2 && lines[0].includes("toolSuccessBg"), JSON.stringify(lines[0]));
      check("visible call keeps content", lines.some((l) => l.includes("/path/to/file")), JSON.stringify(lines).slice(0, 200));
      check("visible call not collapsed", !lines.some((l) => l.includes("5.3k ch")), JSON.stringify(lines).slice(0, 200));
      const state = {};
      const { ctx: rctx } = callContext({ args, state });
      const out = read.renderResult(textResult(5300), { expanded: false, isPartial: false }, theme, { ...rctx, state });
      const rlines = out.render(80);
      check("visible result matches stock (empty when settled)", rlines.join("") === "", JSON.stringify(rlines));
      const notes = [];
      await pi.commands.get("collapse").handler("", { ui: { notify: (msg) => notes.push(msg) } });
      check("collapse reports stock mode", notes.join("").includes("stock sections"), JSON.stringify(notes));
    } finally {
      pi._hidden = true;
    }
  }

  // 8e. outputPad 0 widens both the label budget and the row fill
  {
    pi._pad = 0;
    try {
      const handlers = pi.handlers.get("message_end") ?? [];
      let label;
      const ctx = { hasUI: true, ui: { setHiddenThinkingLabel: (value) => { label = value; } } };
      await handlers[0](
        { message: { role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(1500) }] } },
        ctx,
      );
      check("pad 0 label wider", label.length === 79, `${label.length}`);
      const read = pi.tools.get("read");
      const state = { count: 100 };
      const { ctx: rctx } = callContext({ args: { path: "/path/to/file" }, state });
      const rows = read.renderCall(rctx.args, theme, { ...rctx, state }).render(80);
      check("pad 0 row fills width", rows[0].length === 80, `${rows[0].length}: ${JSON.stringify(rows[0])}`);
    } finally {
      pi._pad = 1;
    }
  }

  // 8e2. ls / grep / find / powershell rows
  {
    const ls = pi.tools.get("ls");
    const { ctx: lsCtx } = callContext({ args: { path: "/some/dir" }, state: { count: 300 } });
    const lsLine = ls.renderCall(lsCtx.args, theme, lsCtx).render(100)[0];
    check("ls row", lsLine.includes("<b:accent>ls </b>") && lsLine.includes("<dim>/some/dir</>"), JSON.stringify(lsLine));
    const grep = pi.tools.get("grep");
    const { ctx: grepCtx } = callContext({ args: { pattern: "foo.*", path: "/a" }, state: { count: 300 } });
    const grepLine = grep.renderCall(grepCtx.args, theme, grepCtx).render(100)[0];
    check(
      "grep row",
      grepLine.includes("<b:accent>grep </b>") && grepLine.includes("<b>foo.*</b>") && grepLine.includes("<dim>/a</>"),
      JSON.stringify(grepLine),
    );
    const find = pi.tools.get("find");
    const { ctx: findCtx } = callContext({ args: { pattern: "*.ts" }, state: { count: 300 } });
    const findLine = find.renderCall(findCtx.args, theme, findCtx).render(100)[0];
    check("find row", findLine.includes("<b:accent>find </b>") && findLine.includes("<b>*.ts</b>"), JSON.stringify(findLine));
    const ps = pi.tools.get("powershell");
    const { ctx: psCtx } = callContext({ args: { command: "Get-ChildItem" }, state: { count: 300 } });
    const psLine = ps.renderCall(psCtx.args, theme, psCtx).render(100)[0];
    check("powershell row", psLine.includes("<b:accent>PS> Get-ChildItem</b>"), JSON.stringify(psLine));
  }

  // 9. message_end without thinking leaves the label alone
  {
    const handlers = pi.handlers.get("message_end") ?? [];
    let called = false;
    const ctx = { hasUI: true, ui: { setHiddenThinkingLabel: () => { called = true; } } };
    await handlers[0]({ message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }, ctx);
    check("no thinking no label", called === false, String(called));
  }

  // 10. real ANSI: padding/truncation measured by visible width
  {
    const ansiTheme = {
      fg: (color, text) => `\x1b[31m${text}\x1b[0m`,
      bold: (text) => `\x1b[1m${text}\x1b[22m`,
      italic: (text) => text,
      style: (text, opts) =>
        `${opts.fg ? "\x1b[31m" : ""}${opts.bold ? "\x1b[1m" : ""}${text}\x1b[22m${opts.fg ? "\x1b[39m" : ""}`,
    };
    const tui = await jiti.import("@earendil-works/pi-tui");
    const read = pi.tools.get("read");
    const { ctx } = callContext({
      args: { path: "/very/long/path/that/keeps/going/on/and/on/file.txt" },
      state: { count: 5300 },
    });
    const lines = read.renderCall(ctx.args, ansiTheme, ctx).render(60);
    check("ansi one line", lines.length === 1, JSON.stringify(lines));
    check("ansi padded to width", tui.visibleWidth(lines[0]) === 59, `${tui.visibleWidth(lines[0])}: ${JSON.stringify(lines[0])}`);
    check("ansi keeps count", lines[0].endsWith("\x1b[31m5.3k ch\x1b[0m"), JSON.stringify(lines[0]).slice(-40));
  }

  // 11. terminal resize rebuilds the thinking label at the new width
  {
    const slot = "__collapseResizeHandler";
    const resize = globalThis[slot];
    check("resize handler installed", typeof resize === "function", typeof resize);
    const handlers = pi.handlers.get("message_end") ?? [];
    const seen = [];
    const ctx = { hasUI: true, ui: { setHiddenThinkingLabel: (value) => { seen.push(value); } } };
    await handlers[0](
      { message: { role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(1500) }] } },
      ctx,
    );
    const realColumns = process.stdout.columns;
    process.stdout.columns = 120;
    try {
      const before = seen.length;
      await resize();
      check("resize reissues label", seen.length === before + 1, `${seen.length} vs ${before}`);
      const relabeled = seen[seen.length - 1];
      check("resized label fills width", relabeled.length === 117, `${relabeled.length}`);
      check("resized label keeps tail", relabeled.endsWith("1.5k ch"), JSON.stringify(relabeled).slice(-24));
      await resize();
      check("same width no-op", seen.length === before + 1, `${seen.length} vs ${before}`);
    } finally {
      process.stdout.columns = realColumns;
    }
    const previous = globalThis[slot];
    factory(pi);
    check("re-activation replaces listener", globalThis[slot] !== previous, "slot unchanged");
  }

  // 12. visibility toggle pokes settled rows into the other mode
  {
    factory(pi); // reclaim slots with the primary mock (8c used a fresh one)
    resetTrace();
    const poll = globalThis.__collapsePollTick;
    check("poll slot installed", !!poll?.tick && !!poll?.timer, typeof poll);
    const read = pi.tools.get("read");
    const args = { path: "/path/to/file" };
    let calls = 0;
    const state = {};
    const ctx = {
      args, toolCallId: "t", invalidate: () => { calls++; }, lastComponent: undefined,
      state, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false,
    };
    pi._hidden = true;
    await poll.tick(); // baseline records without poking
    read.renderCall(args, theme, ctx); // registers + collapsed row
    await poll.tick();
    check("steady no poke", calls === 0, String(calls));
    pi._hidden = false;
    await poll.tick();
    check("toggle pokes", calls === 1, String(calls));
    const lines = read.renderCall(args, theme, ctx).render(80);
    check("poked row goes stock", lines.length > 2 && lines[0].includes("toolSuccessBg"), JSON.stringify(lines[0]));
    await pi.handlers.get("session_start")[0](
      {},
      { hasUI: true, ui: { setHiddenThinkingLabel() {} }, sessionManager: { getEntries: () => [] } },
    );
    pi._hidden = true;
    await poll.tick();
    check("cleared registry stays quiet", calls === 1, String(calls));
  }


  // 13. adjacent same-turn tools share one trace component (no gaps between)
  {
    const read = pi.tools.get("read");
    const bash = pi.tools.get("bash");
    const readState = {};
    const { ctx: rctx } = callContext({ args: { path: "/path/to/file" }, state: readState });
    const bashState = {};
    const bctx = { ...rctx, args: { command: "echo hi" }, state: bashState, toolCallId: "t-bash" };
    read.renderCall(rctx.args, theme, { ...rctx, state: readState });
    const hidden = bash.renderCall(bctx.args, theme, bctx).render(80);
    const trace = read.renderCall(rctx.args, theme, { ...rctx, state: readState }).render(80);
    check("trace has both rows", trace.length === 2, JSON.stringify(trace));
    check("trace keeps read row", trace[0].includes("file"), JSON.stringify(trace[0]));
    check("trace keeps bash row", trace[1].includes("echo"), JSON.stringify(trace[1]));
    check("non-owner renders nothing", hidden.join("") === "", JSON.stringify(hidden));
    check("trace itself has no blanks", !trace.some((l) => l.trim() === ""), JSON.stringify(trace));
    // result counts flow into the shared trace via the owner
    const st = { ...bctx, state: bashState };
    bash.renderResult(textResult(5300), { expanded: false, isPartial: false }, theme, st);
    const trace2 = read.renderCall(rctx.args, theme, { ...rctx, state: readState }).render(80);
    check("trace shows shared counts", trace2[1].includes("5.3k ch"), JSON.stringify(trace2[1]));
  }

  // 13b. a user message splits runs; clicking a row opens just that row
  {
    const read = pi.tools.get("read");
    const bash = pi.tools.get("bash");
    const { ctx: actx } = callContext({ args: { path: "/a" }, state: {} });
    const a1 = read.renderCall(actx.args, theme, actx).render(80);
    check("first run renders", a1.length === 1, JSON.stringify(a1));
    await pi.handlers.get("message_start")[0]({ message: { role: "user", content: [] } }, {});
    const { ctx: bctx } = callContext({ args: { command: "echo hi" }, state: {} });
    const b1 = bash.renderCall(bctx.args, theme, { ...bctx, toolCallId: "t-b2" }).render(80);
    check("user turn renders alone", b1.length === 1 && b1[0].includes("echo"), JSON.stringify(b1));
    // click the bash row inside the read-owned trace from test 13's run? fresh run:
    resetTrace();
    const { ctx: rctx } = callContext({ args: { path: "/p" }, state: {} });
    read.renderCall(rctx.args, theme, rctx);
    const bState = {};
    bash.renderCall({ command: "ls" }, theme, { ...rctx, args: { command: "ls" }, state: bState, toolCallId: "t-click" });
    const traceComp = read.renderCall(rctx.args, theme, rctx);
    const row2 = traceComp.children[1];
    check("row region clickable", !!row2?.onMouse, typeof row2?.onMouse);
    const res = row2.onMouse({ type: "click", button: "left" });
    check("click handled", !!res?.handled, JSON.stringify(res));
    const opened = read.renderCall(rctx.args, theme, rctx).render(80);
    check("clicked row shows stock cell", opened.some((l) => l.includes("toolSuccessBg")), JSON.stringify(opened[0]));
    check("sibling stays collapsed", opened.some((l) => l.startsWith("› ") && l.includes("read") && !l.includes("toolSuccessBg")), JSON.stringify(opened).slice(0, 200));
  }

  // 13c. Pi-expanded at rest still shows one-line rows in one trace
  {
    resetTrace();
    const read = pi.tools.get("read");
    const bash = pi.tools.get("bash");
    const { ctx: rctx } = callContext({ args: { path: "/p" }, state: {}, expanded: true });
    read.renderCall(rctx.args, theme, rctx);
    bash.renderCall({ command: "ls" }, theme, { ...rctx, args: { command: "ls" }, state: {}, toolCallId: "t-all", expanded: true });
    const lines = read.renderCall(rctx.args, theme, rctx).render(100);
    check("pi-expand rows stay one-line", lines.length === 2, JSON.stringify(lines));
    check("pi-expand rows unboxed", !lines.some((l) => l.includes("toolSuccessBg")), JSON.stringify(lines[0]));
    check("pi-expand keeps both", lines[0].includes("read") && lines[1].includes("ls"), JSON.stringify(lines).slice(0, 200));
  }

  // 13d. foreign tools split runs
  {
    resetTrace();
    const read = pi.tools.get("read");
    const ls = pi.tools.get("ls");
    const { ctx: actx } = callContext({ args: { path: "/a" }, state: {} });
    read.renderCall(actx.args, theme, actx);
    await pi.handlers.get("tool_execution_start")[0]({ toolName: "custom-thing", toolCallId: "x1", args: {} }, {});
    const { ctx: bctx } = callContext({ args: { path: "/b" }, state: {} });
    const alone = ls.renderCall(bctx.args, theme, { ...bctx, toolCallId: "t-after-foreign" }).render(80);
    check("foreign tool splits run", alone.length === 1 && alone[0].includes("/b"), JSON.stringify(alone));
  }

  // 14. cross-turn merging: no line gaps between tool rows in consecutive turns
  // (Requires importing the module fresh for each scenario: trace state is
  // module-global, and these tests drive renderCall directly without events.)
    const mod2 = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod2.resetTraceState ?? resetTrace;
    const factory2 = mod2.default ?? mod2;
    const agent = await jiti.import("@earendil-works/pi-coding-agent");
    agent.initTheme("light");
    const tools = new Map();
    const handlers = new Map();
    const pi2 = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => {
        if (!handlers.has(e)) handlers.set(e, []);
        handlers.get(e).push(h);
      },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
      _hidden: true,
    };
    factory2(pi2);
    resetTrace();

    const bash = tools.get("bash");
    const render = (id, cmd, extra = {}) => {
      const ctx = {
        args: { command: cmd }, toolCallId: id, invalidate: () => {}, lastComponent: undefined,
        state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
        expanded: false, showImages: true, isError: false, ...extra,
      };
      return bash.renderCall(ctx.args, theme, ctx);
    };

    // 14a. two turns that each contain only tool calls merge into one run
    render("x1", "echo one");
    await handlers.get("message_end")[0]({ message: { role: "assistant", content: [] } }, { hasUI: false });
    await handlers.get("message_start")[0]({ message: { role: "assistant", content: [] } }, {});
    render("x2", "echo two");
    const merged = render("x1", "echo one").render(90);
    check("cross-turn tool-only rows merge", merged.length === 2, JSON.stringify(merged));
    check("merged keeps both rows", merged[0].includes("one") && merged[1].includes("two"), JSON.stringify(merged));

    // 14b. visible text between turns still splits the run
    resetTrace();
    render("y1", "echo one");
    await handlers.get("message_end")[0]({ message: { role: "assistant", content: [] } }, { hasUI: false });
    await handlers.get("message_start")[0]({ message: { role: "assistant", content: [] } }, {});
    await handlers.get("message_update")[0](
      { message: { role: "assistant", content: [{ type: "text", text: "now some prose" }] } },
      {},
    );
    const split = render("y2", "echo two").render(90);
    check("visible text splits runs", split.length === 1 && split[0].includes("two"), JSON.stringify(split));

    // 14c. a leading-content turn (text before its tool call) also splits
    resetTrace();
    render("z1", "echo one");
    await handlers.get("message_end")[0]({ message: { role: "assistant", content: [] } }, { hasUI: false });
    await handlers.get("message_start")[0]({ message: { role: "assistant", content: [] } }, {});
    await handlers.get("message_update")[0](
      { message: { role: "assistant", content: [
        { type: "text", text: "leading prose" },
        { type: "toolCall", name: "bash", id: "z2", arguments: { command: "echo two" } },
      ] } },
      {},
    );
    const lead = render("z2", "echo two").render(90);
    check("leading content splits runs", lead.length === 1 && lead[0].includes("two"), JSON.stringify(lead));

    // 14d. empty/whitespace-only thinking is not visible content
    resetTrace();
    render("w1", "echo one");
    await handlers.get("message_end")[0]({ message: { role: "assistant", content: [] } }, { hasUI: false });
    await handlers.get("message_start")[0]({ message: { role: "assistant", content: [] } }, {});
    await handlers.get("message_update")[0](
      { message: { role: "assistant", content: [{ type: "thinking", thinking: "   " }] } },
      {},
    );
    render("w2", "echo two");
    const emptyThinking = render("w1", "echo one").render(90);
    check("empty thinking still merges", emptyThinking.length === 2, JSON.stringify(emptyThinking));


  // 14c. history rebuild must not stack past tools into one row (teleport)
  {
    // Fresh activation: renders before session_start are the history pass.
    const tools = new Map();
    const handlers = new Map();
    const pi3 = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    // Fresh module = fresh activation state (history phase armed), like a start.
    const mod3 = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod3.resetTraceState ?? resetTrace;
    (mod3.default ?? mod3)(pi3);
    const hist = tools.get("bash");
    const ctxFor = (id, cmd) => ({
      args: { command: cmd }, toolCallId: id, invalidate: () => {}, lastComponent: undefined,
      state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false,
    });
    const h1 = hist.renderCall({ command: "echo past1" }, theme, ctxFor("past1", "echo past1"));
    const h2 = hist.renderCall({ command: "echo past2" }, theme, ctxFor("past2", "echo past2"));
    check("history rows stay separate", h1.render(90).length === 1 && h2.render(90).length === 1, `${h1.render(90).length}/${h2.render(90).length}`);
    check("history row keeps its own text", h2.render(90)[0].includes("past2"), JSON.stringify(h2.render(90)));
    // After session_start, live tools merge again.
    await handlers.get("session_start")[0](
      {},
      { hasUI: false, sessionManager: { getEntries: () => [] } },
    );
    const l1 = hist.renderCall({ command: "echo live1" }, theme, ctxFor("live1", "echo live1"));
    const l2 = hist.renderCall({ command: "echo live2" }, theme, ctxFor("live2", "echo live2"));
    // The owner rebuilds on its next render pass (the poke path in production).
    const l1b = hist.renderCall({ command: "echo live1" }, theme, ctxFor("live1", "echo live1"));
    check("live rows merge after start", l1b.render(90).length === 2, `${l1b.render(90).length}`);
    check("merged row keeps order", l1b.render(90)[0].includes("live1") && l1b.render(90)[1].includes("live2"), JSON.stringify(l1b.render(90)));
    check("non-owner after merge renders empty", l2.render(90).length === 0, `${l2.render(90).length}`);
  }

  // 15. click-depth spec: rest is always a one-liner; a click opens the
  // stock cell at the CURRENT Pi expansion depth.
  //   Pi collapsed -> click shows the stock collapsed cell
  //   Pi expanded  -> click shows the stock expanded cell
  {
    const agent = await jiti.import("@earendil-works/pi-coding-agent");
    agent.initTheme("light");
    const themeMod = await jiti.import(
      path.join(PI, "dist", "modes", "interactive", "theme", "theme.js"),
    );
    const realTheme = themeMod.loadThemeFromPath(
      path.join(PI, "dist", "modes", "interactive", "theme", "light.json"),
      "truecolor",
    );
    const fresh = async () => {
      const mod = await jiti.import(path.join(HERE, "index.ts"));
      const tools = new Map();
      const handlers = new Map();
      const piX = {
        registerTool: (t) => tools.set(t.name, t),
        registerCommand: () => {},
        on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
        getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
      };
      resetTrace = mod.resetTraceState ?? resetTrace;
      (mod.default ?? mod)(piX);
      await handlers.get("session_start")[0]({}, { hasUI: false, sessionManager: { getEntries: () => [] } });
      return tools.get("read");
    };
    // A read result with enough lines that collapsed and expanded differ.
    const body = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = { content: [{ type: "text", text: body }], details: {} };
    const args = { path: "/repo/notes.txt" };
    const base = {
      args, invalidate: () => {}, lastComponent: undefined, state: {}, cwd: "/repo",
      executionStarted: true, argsComplete: true, isPartial: false, showImages: true,
      isError: false,
    };
    const stockLines = (expanded) => {
      const c = new agent.ToolExecutionComponent(
        "read", "stock1", args, { showImages: true, imageWidthCells: 60 },
        agent.createReadToolDefinition("/repo"), { requestRender() {} }, "/repo",
      );
      c.setExpanded(expanded);
      c.markExecutionStarted();
      c.setArgsComplete();
      c.updateResult(result, false);
      return c.render(100).slice(1); // drop the leading "" Pi adds per component
    };

    // 15a. Pi collapsed: rest is one line; click == stock collapsed cell
    const read = await fresh();
    const ctxA = { ...base, toolCallId: "d1", expanded: false };
    read.renderCall(args, realTheme, ctxA);
    read.renderResult(result, { expanded: false, isPartial: false }, realTheme, { ...ctxA, lastComponent: undefined });
    const rest = read.renderCall(args, realTheme, ctxA).render(100);
    check("depth0 rest is one line", rest.length === 1 && rest[0].startsWith("› "), JSON.stringify(rest));
    const rowA = read.renderCall(args, realTheme, ctxA).children[0];
    rowA.onMouse({ type: "click", button: "left" });
    const openedA = read.renderCall(args, realTheme, ctxA).render(100);
    const stA = stockLines(false);
    check("collapsed click matches stock collapsed", JSON.stringify(openedA) === JSON.stringify(stA), JSON.stringify(openedA[1] ?? openedA[0]) + " VS " + JSON.stringify(stA[1] ?? stA[0]));
    check("collapsed click hides full body", !openedA.join("").includes("line 14"), JSON.stringify(openedA).slice(0, 160));

    // 15b. Pi expanded: rest is STILL one line; click == stock expanded cell
    const readB = await fresh();
    const ctxB = { ...base, toolCallId: "d2", expanded: true };
    readB.renderCall(args, realTheme, ctxB);
    readB.renderResult(result, { expanded: true, isPartial: false }, realTheme, { ...ctxB, lastComponent: undefined });
    const restB = readB.renderCall(args, realTheme, ctxB).render(100);
    check("expanded rest is one line", restB.length === 1 && restB[0].startsWith("› "), JSON.stringify(restB));
    const rowB = readB.renderCall(args, realTheme, ctxB).children[0];
    rowB.onMouse({ type: "click", button: "left" });
    const openedB = readB.renderCall(args, realTheme, ctxB).render(100);
    const stB = stockLines(true);
    const firstDiff = openedB.findIndex((l, i) => l !== stB[i]);
    check("expanded click matches stock expanded", JSON.stringify(openedB) === JSON.stringify(stB), `line ${firstDiff}: ${JSON.stringify(openedB[firstDiff])} VS ${JSON.stringify(stB[firstDiff])}`);
    check("expanded click shows full body", openedB.join("").includes("line 14"), JSON.stringify(openedB).slice(0, 160));

    // 15c. clicking again closes back to the one-liner
    const rowClose = readB.renderCall(args, realTheme, ctxB).children[0];
    rowClose.onMouse({ type: "click", button: "left" });
    const closed = readB.renderCall(args, realTheme, ctxB).render(100);
    check("second click returns to row", closed.length === 1 && closed[0].startsWith("› "), JSON.stringify(closed));
  }

  // 16. /collapse reports WHY runs split (live diagnostics)
  {
    resetTrace();
    const report = [];
    const ctx = { hasUI: true, ui: { notify: (m) => report.push(m) } };
    await pi.commands.get("collapse").handler("", ctx);
    check("collapse reports boundaries", /boundar/i.test(report.at(-1) ?? ""), report.at(-1));
    // A turn with leading prose must record that reason.
    await pi.handlers.get("message_start")[0]({ message: { role: "assistant", content: [] } }, {});
    await pi.handlers.get("message_update")[0](
      { message: { role: "assistant", content: [{ type: "text", text: "prose" }] } },
      {},
    );
    await pi.commands.get("collapse").handler("", ctx);
    check("boundary reason recorded", /leading-content/.test(report.at(-1) ?? ""), report.at(-1));
  }

  // 16b. /collapse reports the newest run's row count (gap forensics)
  {
    resetTrace();
    const read = pi.tools.get("read");
    const bash = pi.tools.get("bash");
    const { ctx } = callContext({ args: { path: "/a" }, state: {} });
    read.renderCall(ctx.args, theme, ctx);
    bash.renderCall({ command: "ls" }, theme, { ...ctx, args: { command: "ls" }, state: {}, toolCallId: "t-sum" });
    const report = [];
    await pi.commands.get("collapse").handler("", { hasUI: true, ui: { notify: (m) => report.push(m) } });
    check("collapse reports run size", /newest run #\d+ has 2 row/.test(report.at(-1) ?? ""), report.at(-1));
  }

  // 17. toolResult messages arrive as message_start too and must NOT split
  {
    resetTrace();
    const bash = pi.tools.get("bash");
    const mk = (id, cmd) => {
      const ctx = {
        args: { command: cmd }, toolCallId: id, invalidate: () => {}, lastComponent: undefined,
        state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
        expanded: false, showImages: true, isError: false,
      };
      return bash.renderCall(ctx.args, theme, ctx);
    };
    // Start a run on THIS activation's registry (the global reset slot now
    // belongs to a later activation, so bump via a user turn instead).
    await pi.handlers.get("message_start")[0]({ message: { role: "user", content: [] } }, {});
    mk("tr1", "echo one");
    await pi.handlers.get("message_start")[0]({ message: { role: "toolResult", content: [] } }, {});
    mk("tr2", "echo two");
    const merged = mk("tr1", "echo one").render(90);
    check("toolResult does not split", merged.length === 2, JSON.stringify(merged));
    // A real user turn still splits.
    await pi.handlers.get("message_start")[0]({ message: { role: "user", content: [] } }, {});
    mk("tr3", "echo three");
    const split = mk("tr3", "echo three").render(90);
    check("user still splits after toolResult", split.length === 1, JSON.stringify(split));
  }

  // 18. switching/forking sessions rebuilds the transcript: history from the
  // NEW branch must not stack into one row slot (each tool gets its own run).
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map();
    const handlers = new Map();
    const piS = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piS);
    const bash = tools.get("bash");
    const mk = (id, cmd) => {
      const ctx = {
        args: { command: cmd }, toolCallId: id, invalidate: () => {}, lastComponent: undefined,
        state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
        expanded: false, showImages: true, isError: false,
      };
      return bash.renderCall(ctx.args, theme, ctx);
    };
    await handlers.get("session_start")[0]({}, { hasUI: false, sessionManager: { getEntries: () => [] } });
    // live turns merge
    mk("s1", "echo one");
    mk("s2", "echo two");
    check("switch: baseline merges", mk("s1", "echo one").render(90).length === 2, JSON.stringify(mk("s1", "echo one").render(90)));
    // resume another session: its history renders before session_start
    await handlers.get("session_before_switch")[0]({ reason: "resume" }, {});
    const h1 = mk("other1", "echo old one");
    const h2 = mk("other2", "echo old two");
    check("switch: other branch rows stay separate", h1.render(90).length === 1 && h2.render(90).length === 1, `${h1.render(90).length}/${h2.render(90).length}`);
    check("switch: other branch row keeps its own text", h2.render(90)[0].includes("old two"), JSON.stringify(h2.render(90)));
    // after the switch settles, live turns merge again
    await handlers.get("session_start")[0]({}, { hasUI: false, sessionManager: { getEntries: () => [] } });
    mk("n1", "echo new one");
    mk("n2", "echo new two");
    const merged = mk("n1", "echo new one").render(90);
    check("switch: live turns merge after settle", merged.length === 2, JSON.stringify(merged));
  }

  // 18b. tree navigation arms the history phase too
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map();
    const handlers = new Map();
    const piT = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piT);
    const bash = tools.get("bash");
    const mk = (id, cmd) => bash.renderCall({ command: cmd }, theme, {
      args: { command: cmd }, toolCallId: id, invalidate: () => {}, lastComponent: undefined,
      state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false,
    });
    await handlers.get("session_start")[0]({}, { hasUI: false, sessionManager: { getEntries: () => [] } });
    await handlers.get("session_before_tree")[0]({}, {});
    const t1 = mk("tree1", "echo branch one");
    const t2 = mk("tree2", "echo branch two");
    check("tree: branch rows stay separate", t1.render(90).length === 1 && t2.render(90).length === 1, `${t1.render(90).length}/${t2.render(90).length}`);
    await handlers.get("session_tree")[0]({}, {});
    mk("tree3", "echo live one");
    const live = mk("tree3", "echo live one").render(90);
    mk("tree4", "echo live two");
    const live2 = mk("tree3", "echo live one").render(90);
    check("tree: live merges after settle", live.length === 1 && live2.length === 2, `${live.length}/${live2.length}`);
  }

  // 18c. a transcript rebuild re-registers the SAME ids: rows must keep their
  // existing runs instead of being merged into one (settings changes rebuild).
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map();
    const handlers = new Map();
    const piR = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piR);
    const bash = tools.get("bash");
    const mk = (id, cmd) => bash.renderCall({ command: cmd }, theme, {
      args: { command: cmd }, toolCallId: id, invalidate: () => {}, lastComponent: undefined,
      state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false,
    });
    await handlers.get("session_start")[0]({}, { hasUI: false, sessionManager: { getEntries: () => [] } });
    mk("rb1", "echo one");
    mk("rb2", "echo two");
    check("rebuild: baseline merged", mk("rb1", "echo one").render(90).length === 2, "");
    // Simulate outputPad/cache-notice rebuild: same ids rendered again.
    mk("rb1", "echo one");
    mk("rb2", "echo two");
    const again = mk("rb1", "echo one").render(90);
    check("rebuild: rows keep their own runs", again.length === 2, JSON.stringify(again));
  }

  // 19. sync must not re-serialize args on every render pass (same object
  // comes back each pass; a different object with equal content is no change)
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map();
    const handlers = new Map();
    const piJ = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piJ);
    await handlers.get("session_start")[0]({}, { hasUI: false, sessionManager: { getEntries: () => [] } });
    const bash = tools.get("bash");
    // Poison toJSON: if the renderer stringifies the same object again, throw.
    let serialized = 0;
    const args = { command: "echo x" };
    args.toJSON = () => { serialized++; return { command: "echo x" }; };
    const ctx = {
      args, toolCallId: "j1", invalidate: () => {}, lastComponent: undefined,
      state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false,
    };
    bash.renderCall(args, theme, ctx);
    const first = serialized;
    bash.renderCall(args, theme, ctx);
    bash.renderCall(args, theme, ctx);
    check("sync serializes args once", serialized === first && first <= 1, `calls=${serialized}`);
    // Equal-but-new object: content comparison must still detect no change
    // (row stays single, no duplicate registration).
    const twin = { command: "echo x" };
    bash.renderCall(twin, theme, { ...ctx, args: twin });
    const rows = bash.renderCall(twin, theme, { ...ctx, args: twin }).render(90);
    check("equal args keep one row", rows.length === 1, JSON.stringify(rows));
    // Second pass with the adopted object must not serialize again.
    const beforeTwin = serialized;
    bash.renderCall(twin, theme, { ...ctx, args: twin });
    check("adopted args stop re-serializing", serialized === beforeTwin, `${beforeTwin} -> ${serialized}`);
  }

  // 15d. an open row re-depths live when Pi's expansion flag flips
  //      (ctrl+o) — no second click needed
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map();
    const handlers = new Map();
    const piD = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piD);
    await handlers.get("session_start")[0]({}, { hasUI: false, sessionManager: { getEntries: () => [] } });
    const read = tools.get("read");
    const args = { path: "/repo/notes.txt" };
    const body = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n");
    const base = {
      args, invalidate: () => {}, lastComponent: undefined, state: {}, cwd: "/repo",
      executionStarted: true, argsComplete: true, isPartial: false, showImages: true,
      isError: false, toolCallId: "depth1", expanded: false,
    };
    read.renderCall(args, theme, base);
    read.renderResult({ content: [{ type: "text", text: body }], details: {} }, { expanded: false, isPartial: false }, theme, { ...base, lastComponent: undefined });
    read.renderCall(args, theme, base).children[0].onMouse({ type: "click", button: "left" });
    const atCollapsed = read.renderCall(args, theme, base).render(100).join("\n");
    check("depth follows: collapsed cell first", !atCollapsed.includes("line 14"), "");
    // Pi expands (ctrl+o): same row, no click, must now show the expanded cell.
    const atExpanded = read.renderCall(args, theme, { ...base, expanded: true }).render(100).join("\n");
    check("depth follows: expanded cell after ctrl+o", atExpanded.includes("line 14"), "");
  }

  // 21. ANY tool collapses: extension/MCP tools register through
  // collapseDefinition and get a generic row (name + best argument).
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const rows = mod;
    const tools = new Map();
    const handlers = new Map();
    const piE = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piE);
    await handlers.get("session_start")[0]({}, { hasUI: false, sessionManager: { getEntries: () => [] } });
    // A tool with NO renderers of its own, like spawn_agent.
    const bare = {
      name: "spawn_agent",
      description: "Start a background subagent",
      parameters: {},
      async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
    };
    const wrapped = rows.collapseDefinition(bare, piE);
    check("wrapped keeps execute", typeof wrapped.execute === "function", typeof wrapped.execute);
    check("wrapped keeps parameters", wrapped.parameters === bare.parameters, "");
    check("wrapped is self shell", wrapped.renderShell === "self", wrapped.renderShell);
    const ctx = (id, args) => ({
      args, toolCallId: id, invalidate: () => {}, lastComponent: undefined, state: {},
      cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false,
    });
    const args = { name: "api-check", prompt: "Check the API\nmore text" };
    const row = wrapped.renderCall(args, theme, ctx("e1", args)).render(90);
    check("generic tool collapses to one row", row.length === 1 && row[0].startsWith("› "), JSON.stringify(row));
    check("generic row names the tool", row[0].includes("spawn_agent"), JSON.stringify(row[0]));
    check("generic row shows the argument", row[0].includes("api-check"), JSON.stringify(row[0]));
    // Two different extension tools in one message share a run.
    const other = rows.collapseDefinition({ ...bare, name: "check_subagents" }, piE);
    const oargs = { target: "api-check" };
    other.renderCall(oargs, theme, ctx("e2", oargs));
    const merged = wrapped.renderCall(args, theme, ctx("e1", args)).render(90);
    check("generic tools share a run", merged.length === 2, JSON.stringify(merged));
    // Result count flows into the row.
    wrapped.renderResult({ content: [{ type: "text", text: "x".repeat(2400) }], details: {} },
      { expanded: false, isPartial: false }, theme, ctx("e1", args));
    const withCount = wrapped.renderCall(args, theme, ctx("e1", args)).render(90);
    check("generic row shows count", withCount[0].includes("2.4k ch"), JSON.stringify(withCount[0]));
  }

  // 21b. The opt-in slot: collapse publishes a wrapper other extensions can
  // apply to their own definition, preserving execute and idempotent.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const handlers = new Map();
    const piE = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
      getAllTools: () => [{ name: "spawn_agent" }, { name: "read" }],
    };
    mod.default(piE);
    const wrap = globalThis.__collapseWrapTool;
    check("slot published", typeof wrap === "function", typeof wrap);
    const def = { name: "spawn_agent", parameters: {}, async execute() { return "ran"; } };
    const wrapped = wrap(def);
    check("slot keeps execute", wrapped.execute === def.execute, "");
    check("slot marks wrapper", wrapped.__collapseWrapped === true, "");
    check("slot is idempotent", wrap(wrapped) === wrapped, "");
    // The report lists tools that never opted in, and not the ones that did.
    await handlers.get("session_start")[0]({}, { hasUI: false, sessionManager: { getEntries: () => [] } });
    let said = "";
    const reportPi = { ...piE, getAllTools: () => [{ name: "spawn_agent" }, { name: "read" }, { name: "mcp_weird" }] };
    const mod2 = await jiti.import(path.join(HERE, "index.ts"));
    const handlers2 = new Map();
    mod2.default({ ...reportPi, registerTool: () => {}, registerCommand: (n, o) => handlers2.set("cmd", o),
      on: (e, h) => { if (!handlers2.has(e)) handlers2.set(e, []); handlers2.get(e).push(h); } });
    const wrap2 = globalThis.__collapseWrapTool;
    wrap2({ name: "spawn_agent", parameters: {}, async execute() {} });
    await handlers2.get("cmd").handler("", { ui: { notify: (m) => { said = m; } } });
    check("report lists uncollapsed tools", said.includes("mcp_weird"), said);
    check("report omits wrapped tools", !said.includes("spawn_agent"), said);
  }

  // 22. Repeating the same thinking label does not re-render every row.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const handlers = new Map();
    const labels = [];
    const piE = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piE);
    const ctx = { hasUI: true, ui: { setHiddenThinkingLabel: (l) => labels.push(l) } };
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "Analyzing the day structure carefully" }, { type: "text", text: "" }] };
    for (let i = 0; i < 3; i += 1) handlers.get("message_end")[0]({ message: msg }, ctx);
    check("identical label set once", labels.length === 1, JSON.stringify(labels));
    const msg2 = { role: "assistant", content: [{ type: "thinking", thinking: "A different line of reasoning entirely" }] };
    handlers.get("message_end")[0]({ message: msg2 }, ctx);
    check("new label still applied", labels.length === 2, JSON.stringify(labels));
  }

  // 23. wrapped foreign tools merge: opting in through the slot makes them
  // own rows, so tool_execution_start must not split the run for them.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map();
    const handlers = new Map();
    const commands = new Map();
    const piW = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: (n, o) => commands.set(n, o),
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piW);
    await handlers.get("session_start")[0]({}, { hasUI: false, sessionManager: { getEntries: () => [] } });
    const read = tools.get("read");
    const mk = (tool, id, args) => {
      const ctx = {
        args, toolCallId: id, invalidate: () => {}, lastComponent: undefined,
        state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
        expanded: false, showImages: true, isError: false,
      };
      return tool.renderCall(ctx.args, theme, ctx);
    };
    mk(read, "r1", { path: "/a" });
    const spawn = mod.collapseDefinition(
      { name: "spawn_agent", description: "d", parameters: {}, async execute() { return {}; } }, piW);
    await handlers.get("tool_execution_start")[0]({ toolName: "spawn_agent", toolCallId: "t-sp", args: {} }, {});
    mk(spawn, "t-sp", { name: "demo" });
    const checker = mod.collapseDefinition(
      { name: "check_subagents", description: "d", parameters: {}, async execute() { return {}; } }, piW);
    await handlers.get("tool_execution_start")[0]({ toolName: "check_subagents", toolCallId: "t-cs", args: {} }, {});
    mk(checker, "t-cs", { target: "demo" });
    const lines = mk(read, "r1", { path: "/a" }).render(80);
    check("wrapped foreign tools share the run", lines.length === 3, JSON.stringify(lines));
    let said = "";
    await commands.get("collapse").handler("", { ui: { notify: (m) => { said = m; } } });
    check("no foreign boundary for wrapped tools", !said.includes("foreign-tool:spawn_agent") && !said.includes("foreign-tool:check_subagents"), said);
  }

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("PASS: collapse extension");
})().catch((error) => {
  console.error(`FAIL - ${error?.stack ?? error}`);
  process.exit(1);
});
