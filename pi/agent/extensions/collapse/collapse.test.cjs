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

// Rows are asserted with two themes (marker tags and real ANSI), so
// strip both before looking at the visible text.
// Layout/width assertions need REAL escape codes: visibleWidth strips ANSI
// but not the marker tags above, so measuring marker rows would be wrong.
const ansiTheme = {
  fg: (_color, text) => `\x1b[38;5;240m${text}\x1b[39m`,
  bg: (_color, text) => `\x1b[48;5;240m${text}\x1b[49m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
  style: (text, opts) => `\x1b[1m${opts?.fg ? "" : ""}${text}\x1b[22m`,
};

// SGR plus OSC (Pi marks message parts with OSC 133; rows can carry them).
const plainText = (line) => String(line)
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-9;]*m/g, "")
  .replace(/<[^>]*>/g, "");
const isRow = (line) => plainText(line).startsWith("▏");

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
    check("read starts at column 2", isRow(line), JSON.stringify(line));
    check("read tool bold", line.includes("<b:accent>read "), JSON.stringify(line));
    check("read dir dim", line.includes("<dim>/path/to/</>"), JSON.stringify(line));
    check("read base plain", line.includes("</>file") && !line.includes("<b>file"), JSON.stringify(line));
    check("read range dim", line.includes("<dim>:10-20</>") && !line.includes("<error>"), JSON.stringify(line));
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
    const lines = read.renderCall(ctx.args, ansiTheme, { ...ctx, state }).render(100);
    check("read count shown", plainText(lines[0]).endsWith("5.3k ch"), JSON.stringify(plainText(lines[0])));
    check("read padded to width", plainText(lines[0]).length === 98, `${plainText(lines[0]).length}: ${JSON.stringify(plainText(lines[0]))}`);
  }

  // 4. read failure: tool name red bold
  {
    const read = pi.tools.get("read");
    const { ctx } = callContext({ args: { path: "/path/to/file" }, isError: true, state: { count: 12 } });
    const line = read.renderCall(ctx.args, theme, ctx).render(80)[0];
    check("read failure red bold", line.includes("<b:error>read </b>"), JSON.stringify(line));
  }

  // 5. bash collapsed call: prompt accent bold, command word bold
  {
    const bash = pi.tools.get("bash");
    const { ctx } = callContext({ args: { command: "timeout 25 ls some/dist" } });
    const line = bash.renderCall(ctx.args, theme, ctx).render(100)[0];
    check("bash starts at column 2", isRow(line), JSON.stringify(line));
    check("bash prompt accent", line.includes("<b:accent>$</b> <b>timeout</b>"), JSON.stringify(line));
    check("bash command bold", line.includes("<b>timeout</b>") && !line.includes("<error>"), JSON.stringify(line));
  }

  // 5b. env assignments: only the variable name is highlighted
  {
    const bash = pi.tools.get("bash");
    const { ctx } = callContext({ args: { command: "PIN=/x ls /y" } });
    const line = bash.renderCall(ctx.args, theme, ctx).render(80)[0];
    check("bash env name accent", line.includes("<b:accent>$</b> <b:accent>PIN</b><dim>=/x</>"), JSON.stringify(line));
    check("bash env value not accent", line.includes("=/x") && !line.includes("<b:accent>=/x"), JSON.stringify(line));
  }

  // 6. bash failure: `$ first` red bold
  {
    const bash = pi.tools.get("bash");
    const { ctx } = callContext({ args: { command: "timeout 25 ls some/dist" }, isError: true, state: { count: 100 } });
    const line = bash.renderCall(ctx.args, theme, ctx).render(100)[0];
    check("bash failure red bold", line.includes("<b:error>$</b> <b>timeout</b>"), JSON.stringify(line));
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
    check("wrapped rest is one row", beforeClick.length === 2 && isRow(beforeClick[1]), JSON.stringify(beforeClick));
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

  // 8. the hidden thinking label is Pi's own: the extension never sets it,
  // so every collapsed row shows the stock "Thinking..." default.
  {
    const calls = [];
    const ui = { setHiddenThinkingLabel: (value) => { calls.push(value); } };
    const handlers = pi.handlers.get("message_end") ?? [];
    for (const h of handlers) {
      await h({ message: { role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(1500) }] } }, { hasUI: true, ui });
    }
    const shandlers = pi.handlers.get("session_start") ?? [];
    for (const h of shandlers) {
      await h({}, { hasUI: true, ui, sessionManager: { getEntries: () => [
        { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "old" }] } },
      ] } });
    }
    check("label never set", calls.length === 0, JSON.stringify(calls));
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
    const line = bash.renderCall(ctx.args, ansiTheme, ctx).render(50)[0];
    check("row middle keeps head", plainText(line).includes("$ ru"), JSON.stringify(plainText(line)));
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
    check("collapse reports stock label", notes.join("").includes("Pi stock"), JSON.stringify(notes));
    const notes2 = [];
    await pi.commands.get("collapse").handler("", { ui: { notify: (msg) => notes2.push(msg) } });
    check("collapse reports compact mode", notes2.join("").includes("compact rows"), JSON.stringify(notes2));
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

  // 8e. outputPad 0 widens the row fill
  {
    pi._pad = 0;
    try {
      const read = pi.tools.get("read");
      const state = { count: 100 };
      const { ctx: rctx } = callContext({ args: { path: "/path/to/file" }, state });
      const rows = read.renderCall(rctx.args, ansiTheme, { ...rctx, state }).render(80);
      // Marker theme adds literal tag characters: measure what the terminal sees.
      const visible = plainText(rows[0]);
      check("pad 0 row fills width", visible.length === 79, `${visible.length}: ${JSON.stringify(visible)}`);
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
      grepLine.includes("<b:accent>grep </b>") && grepLine.includes("foo.*") && !grepLine.includes("<b>foo") && grepLine.includes("<dim>/a</>"),
      JSON.stringify(grepLine),
    );
    const find = pi.tools.get("find");
    const { ctx: findCtx } = callContext({ args: { pattern: "*.ts" }, state: { count: 300 } });
    const findLine = find.renderCall(findCtx.args, theme, findCtx).render(100)[0];
    check("find row", findLine.includes("<b:accent>find </b>") && findLine.includes("*.ts") && !findLine.includes("<b>*.ts"), JSON.stringify(findLine));
    const ps = pi.tools.get("powershell");
    const { ctx: psCtx } = callContext({ args: { command: "Get-ChildItem" }, state: { count: 300 } });
    const psLine = ps.renderCall(psCtx.args, theme, psCtx).render(100)[0];
    check("powershell row", psLine.includes("<b:accent>PS></b> <b>Get-ChildItem</b>"), JSON.stringify(psLine));
  }

  // 9. message_end reconciles per-row labels but never the global setter
  {
    let globalCalls = 0;
    const ui = { setHiddenThinkingLabel: () => { globalCalls++; } };
    const handlers = pi.handlers.get("message_end") ?? [];
    check("message_end subscribed", handlers.length === 1, String(handlers.length));
    await handlers[0]({ message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }, { hasUI: true, ui });
    check("global setter untouched", globalCalls === 0, String(globalCalls));
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
    check("ansi padded to width", tui.visibleWidth(lines[0]) === 58, `${tui.visibleWidth(lines[0])}: ${JSON.stringify(lines[0])}`);
    check("ansi keeps count", lines[0].endsWith("\x1b[31m5.3k ch\x1b[0m"), JSON.stringify(lines[0]).slice(-40));
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
    check("sibling stays collapsed", opened.some((l) => isRow(l) && l.includes("read") && !l.includes("toolSuccessBg")), JSON.stringify(opened).slice(0, 200));
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
    await handlers.get("message_start")[0]({ message: { role: "assistant", content: [] } }, {});
    render("x2", "echo two");
    const merged = render("x1", "echo one").render(90);
    check("cross-turn tool-only rows merge", merged.length === 2, JSON.stringify(merged));
    check("merged keeps both rows", merged[0].includes("one") && merged[1].includes("two"), JSON.stringify(merged));

    // 14b. visible text between turns still splits the run
    resetTrace();
    render("y1", "echo one");
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
    check("depth0 rest is one line", rest.length === 1 && isRow(rest[0]), JSON.stringify(rest));
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
    check("expanded rest is one line", restB.length === 1 && isRow(restB[0]), JSON.stringify(restB));
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
    check("second click returns to row", closed.length === 1 && isRow(closed[0]), JSON.stringify(closed));
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
    check("generic tool collapses to one row", row.length === 1 && isRow(row[0]), JSON.stringify(row));
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

  // 24. A wrapped tool with no summarizable args shows just its name:
  // no "…" placeholder, collapsed or opened.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map();
    const piW = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: () => {},
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piW);
    const wrapped = mod.collapseDefinition(
      { name: "check_subagents", description: "d", parameters: {}, async execute() { return {}; } }, piW);
    const ctx = (id, args) => ({
      args, toolCallId: id, invalidate: () => {}, lastComponent: undefined, state: {},
      cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false,
    });
    const row = wrapped.renderCall({ wait: true, timeoutMs: 120000 }, theme, ctx("e1", { wait: true })).render(90);
    check("empty summary shows name only", row.length === 1 && plainText(row[0]) === "▏check_subagents", JSON.stringify(row));
    // opened (clicked) rows show the same name-only call line
    const opened = wrapped.renderCall({ wait: true }, theme, { ...ctx("e1", { wait: true }), state: {} }).render(90);
    check("opened name-only row has no ellipsis", !opened.some((l) => l.includes("…")), JSON.stringify(opened));
  }

  // 25. post-reload history merges contiguous groups: the rebuild renders
  // one run per tool, then session_start merges each group so repaints cost
  // one blank line per group instead of per tool. Positions never move.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map();
    const handlers = new Map();
    const piH = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piH);
    // History pass: phase armed, one run per tool (the pre-reload layout).
    const read = tools.get("read");
    const bash = tools.get("bash");
    const ctxFor = (id, args) => ({
      args, toolCallId: id, invalidate: () => {}, lastComponent: undefined,
      state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false,
    });
    const h1 = read.renderCall({ path: "/a" }, theme, ctxFor("h1", { path: "/a" }));
    const h2 = read.renderCall({ path: "/b" }, theme, ctxFor("h2", { path: "/b" }));
    const h3 = bash.renderCall({ command: "ls" }, theme, ctxFor("h3", { command: "ls" }));
    check("history pass renders separately",
      h1.render(80).length === 1 && h2.render(80).length === 1 && h3.render(80).length === 1,
      `${h1.render(80).length}/${h2.render(80).length}/${h3.render(80).length}`);
    // session_start sees the transcript: h1+h2 contiguous, h3 after prose.
    const entries = [
      { type: "message", message: { role: "assistant", content: [
        { type: "thinking", thinking: "plan" },
        { type: "toolCall", id: "h1", name: "read", arguments: {} },
        { type: "toolCall", id: "h2", name: "read", arguments: {} },
      ] } },
      { type: "message", message: { role: "assistant", content: [
        { type: "text", text: "a note" },
        { type: "toolCall", id: "h3", name: "bash", arguments: {} },
      ] } },
    ];
    await handlers.get("session_start")[0](
      {}, { hasUI: false, sessionManager: { getEntries: () => entries } });
    const merged = read.renderCall({ path: "/a" }, theme, ctxFor("h1", { path: "/a" })).render(80);
    check("contiguous history merges", merged.length === 2, JSON.stringify(merged));
    check("merged history keeps order",
      plainText(merged[0]).endsWith("/a") && plainText(merged[1]).endsWith("/b"), JSON.stringify(merged));
    const alone = bash.renderCall({ command: "ls" }, theme, ctxFor("h3", { command: "ls" })).render(80);
    check("prose-split history stays separate", alone.length === 1 && alone[0].includes("ls"), JSON.stringify(alone));
  }

  // 26. tree-walk per-row labels: each thinking row shows its own message.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map();
    const handlers = new Map();
    const commands = new Map();
    const piL = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: (n, o) => commands.set(n, o),
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piL);
    const widgets = new Map();
    const ui = { setWidget: (key, factory) => widgets.set(key, factory), setHiddenThinkingLabel: () => { throw new Error("global setter must not be called"); } };
    await handlers.get("session_start")[0]({}, { hasUI: true, ui, sessionManager: { getEntries: () => [] } });
    check("walker widget registered", widgets.size === 1, [...widgets.keys()].join(","));
    const thinkMsg = (text) => ({ role: "assistant", content: [{ type: "thinking", thinking: text }] });
    const mkRow = (text) => ({
      lastMessage: thinkMsg(text),
      hiddenThinkingLabel: "Thinking...",
      updateContent() {},
      setHiddenThinkingLabel(v) { this.hiddenThinkingLabel = v; },
    });
    const rowA = mkRow("alpha thinking here");
    const rowB = mkRow("beta thinking here with more words");
    const fakeTui = { children: [{ children: [{ children: [rowA, { junk: true }, rowB] }] }] };
    for (const factory of widgets.values()) factory(fakeTui, {});
    await handlers.get("message_end")[0]({ message: thinkMsg("latest") }, { hasUI: true, ui });
    check("row A shows its own thinking", rowA.hiddenThinkingLabel.includes("alpha"), JSON.stringify(rowA.hiddenThinkingLabel));
    check("row B shows its own thinking", rowB.hiddenThinkingLabel.includes("beta"), JSON.stringify(rowB.hiddenThinkingLabel));
    check("rows differ", rowA.hiddenThinkingLabel !== rowB.hiddenThinkingLabel, `${rowA.hiddenThinkingLabel} vs ${rowB.hiddenThinkingLabel}`);
    let said = "";
    await commands.get("collapse").handler("", { ui: { notify: (m) => { said = m; } } });
    check("collapse reports walk status", said.includes("thinking walk:"), said);
  }

  // 27. walker ignores rows without thinking, junk nodes, and missing handle.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const handlers = new Map();
    const piL = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piL);
    const ui = { setWidget: () => {}, setHiddenThinkingLabel: () => { throw new Error("global setter must not be called"); } };
    // reconcile with no TUI handle captured: silent no-op
    await handlers.get("message_end")[0]({ message: { role: "assistant", content: [] } }, { hasUI: true, ui });
    check("no handle no crash", true, "");
    const plain = {
      lastMessage: { role: "assistant", content: [{ type: "text", text: "visible" }] },
      hiddenThinkingLabel: "Thinking...",
      updateContent() {},
      setHiddenThinkingLabel(v) { this.hiddenThinkingLabel = v; },
    };
    const widgets = [];
    const ui2 = { setWidget: (k, f) => widgets.push(f), setHiddenThinkingLabel: () => { throw new Error("nope"); } };
    await handlers.get("session_start")[0]({}, { hasUI: true, ui: ui2, sessionManager: { getEntries: () => [] } });
    widgets[0]({ children: [plain, { junk: 1 }, null, "str"] }, {});
    await handlers.get("turn_end")[0]({}, { hasUI: true, ui: ui2 });
    check("thinking-less row keeps stock", plain.hiddenThinkingLabel === "Thinking...", plain.hiddenThinkingLabel);
  }

  // 28. labels converge after finalize: partial streaming message, then final.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const handlers = new Map();
    const piL = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piL);
    const widgets = [];
    const ui = { setWidget: (k, f) => widgets.push(f), setHiddenThinkingLabel: () => { throw new Error("nope"); } };
    await handlers.get("session_start")[0]({}, { hasUI: true, ui, sessionManager: { getEntries: () => [] } });
    const streaming = { role: "assistant", content: [{ type: "thinking", thinking: "partial" }] };
    const row = {
      lastMessage: streaming,
      hiddenThinkingLabel: "Thinking...",
      updateContent() {},
      setHiddenThinkingLabel(v) { this.hiddenThinkingLabel = v; },
    };
    widgets[0]({ children: [row] }, {});
    await handlers.get("message_end")[0]({ message: streaming }, { hasUI: true, ui });
    check("streaming label applied", row.hiddenThinkingLabel.includes("partial"), row.hiddenThinkingLabel);
    row.lastMessage = { role: "assistant", content: [{ type: "thinking", thinking: "final full thought" }] };
    await handlers.get("turn_end")[0]({}, { hasUI: true, ui });
    check("final label converges", row.hiddenThinkingLabel.includes("final full"), row.hiddenThinkingLabel);
  }

  // 29. detach pass hides only SAFE+hosted thinking rows (flag-gated, default off).
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map(), handlers = new Map(), commands = new Map();
    const piL = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: (n, o) => commands.set(n, o),
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piL);
    const detach = mod;
    detach.resetDetachState?.();
    const think = (t) => ({ type: "thinking", thinking: t });
    const text = (t) => ({ type: "text", text: t });
    const tool = (id) => ({ type: "toolCall", id, name: "read", arguments: {} });
    const mkRow = (message) => ({
      lastMessage: message, hiddenThinkingLabel: "Thinking...",
      updateContent() {}, setHiddenThinkingLabel(v) { this.hiddenThinkingLabel = v; },
    });
    const msgSafe = { role: "assistant", content: [think("plan a"), tool("h1")], stopReason: "toolUse" };
    const msgText = { role: "assistant", content: [think("plan b"), text("hello"), tool("h2")], stopReason: "toolUse" };
    const msgLonely = { role: "assistant", content: [think("plan c")], stopReason: "stop" };
    const rowSafe = mkRow(msgSafe), rowText = mkRow(msgText), rowLonely = mkRow(msgLonely);
    const chat = { children: [rowSafe, rowText, rowLonely],
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); } };
    const widgets = [];
    const entries = [
      { id: "e1", type: "message", message: msgSafe },
      { id: "e2", type: "message", message: msgText },
      { id: "e3", type: "message", message: msgLonely },
    ];
    const sessionManager = { getEntries: () => entries };
    const ui = { setWidget: (k, f) => widgets.push(f), setHiddenThinkingLabel: () => {} };
    widgets.length = 0;
    await handlers.get("session_start")[0]({}, { hasUI: true, ui, sessionManager });
    widgets[0]({ children: [chat] }, {});
    widgets[0]({ children: [chat] }, {});
    // flag off by default: nothing detached
    delete process.env.COLLAPSE_HIDE_THINKING;
    let r = detach.detachPass(piL, sessionManager);
    check("flag off detaches nothing", r.detached === 0 && chat.children.length === 3, JSON.stringify(r));
    // flag on: only the SAFE+hosted row goes (lonely thinking has no host run)
    process.env.COLLAPSE_HIDE_THINKING = "1";
    const bash = tools.get("bash");
    const theme = { fg: (c, t) => t, style: (t) => t };
    const mk = (t, id, args) => ({ args, toolCallId: id, invalidate() {}, lastComponent: undefined,
      state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false });
    bash.renderCall({ command: "echo host" }, theme, mk(bash, "h1", { command: "echo host" }));
    bash.renderCall({ command: "echo two" }, theme, mk(bash, "h2", { command: "echo two" }));
    r = detach.detachPass(piL, sessionManager);
    check("SAFE+hosted row detached", !chat.children.includes(rowSafe), chat.children.length);
    check("text row stays mounted", chat.children.includes(rowText), "");
    check("lonely thinking stays (no host run)", chat.children.includes(rowLonely), "");
    check("detach recorded", detach.isMessageHidden("e1") === true, "");
    check("others not recorded", detach.isMessageHidden("e2") === false && detach.isMessageHidden("e3") === false, "");
    delete process.env.COLLAPSE_HIDE_THINKING;
    detach.resetDetachState?.();
  }

  // 30. fail-open coupling: replacement preview renders iff detach confirmed.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map(), handlers = new Map();
    const piL = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piL);
    const detach = mod;
    detach.resetDetachState?.();
    process.env.COLLAPSE_HIDE_THINKING = "1";
    const theme = { fg: (c, t) => t, bold: (t) => t, italic: (t) => t, style: (t) => t };
    const bash = tools.get("bash");
    const mk = (t, id, args) => ({ args, toolCallId: id, invalidate() {}, lastComponent: undefined,
      state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false });
    const out1 = bash.renderCall({ command: "echo one" }, theme, mk(bash, "f1", { command: "echo one" }));
    const lines1 = out1.render(100);
    check("no preview without confirmed detach", !lines1.some((l) => l.includes("plan")), lines1.length);
    // confirm detach for run of f1 via the recorded id, then re-render builds preview
    const msg = { role: "assistant", content: [
      { type: "thinking", thinking: "plan for one" },
      { type: "toolCall", id: "f1", name: "bash", arguments: {} },
    ], stopReason: "toolUse" };
    const fakeParent = { children: [], removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); } };
    const row = { lastMessage: msg, hiddenThinkingLabel: "T", updateContent() {}, setHiddenThinkingLabel() {} };
    fakeParent.children.push(row);
    const widgets = [];
    const ui = { setWidget: (k, f) => widgets.push(f), setHiddenThinkingLabel: () => {} };
    await handlers.get("session_start")[0]({}, { hasUI: true, ui, sessionManager: { getEntries: () => [] } });
    widgets[0]({ children: [fakeParent] }, {});
    detach.detachPass(piL, { getEntries: () => [{ id: "ef1", type: "message", message: msg }] });
    const out2 = bash.renderCall({ command: "echo one" }, theme, mk(bash, "f1", { command: "echo one" }));
    const lines2 = out2.render(100);
    check("preview appears after confirmed detach", lines2.some((l) => l.includes("plan for one")), lines2.join("|").slice(0, 160));
    delete process.env.COLLAPSE_HIDE_THINKING;
    detach.resetDetachState?.();
  }

  // 31. session_start backfills history rows and stashes text for reload.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map(), handlers = new Map(), commands = new Map();
    const piL = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: (n, o) => commands.set(n, o),
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piL);
    const detach = mod;
    detach.resetDetachState?.();
    process.env.COLLAPSE_HIDE_THINKING = "1";
    const theme = { fg: (c, t) => t, style: (t) => t };
    const read = tools.get("read");
    const mk = (t, id, args) => ({ args, toolCallId: id, invalidate() {}, lastComponent: undefined,
      state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false });
    const histMsg = { role: "assistant", content: [
      { type: "thinking", thinking: "historical plan" },
      { type: "toolCall", id: "old1", name: "read", arguments: { path: "/f" } },
    ], stopReason: "toolUse" };
    const histRow = { lastMessage: histMsg, hiddenThinkingLabel: "T", updateContent() {}, setHiddenThinkingLabel() {} };
    const chat = { children: [histRow],
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); } };
    const widgets = [];
    const sessionManager = { getEntries: () => [
      { id: "hid1", type: "message", message: histMsg },
      { id: "hid1r", type: "message", message: { role: "toolResult", toolCallId: "old1", content: [{ type: "text", text: "ok" }] } },
    ]};
    const ui = { setWidget: (k, f) => widgets.push(f), setHiddenThinkingLabel: () => {} };
    await handlers.get("session_start")[0]({}, { hasUI: true, ui, sessionManager });
    widgets[0]({ children: [chat] }, {});
    read.renderCall({ path: "/f" }, theme, mk(read, "old1", { path: "/f" }));
    const said = [];
    await commands.get("collapse").handler("", { ui: { notify: (m) => said.push(m) } });
    check("history row detached at startup", !chat.children.includes(histRow), chat.children.length);
    check("stash has history text", (detach.runThinkingForTool("old1") ?? "").includes("historical plan"), detach.runThinkingForTool("old1") ?? "(none)");
    check("collapse reports hidden count", said.join("").includes("hidden:"), said.join("").slice(0, 200));
    delete process.env.COLLAPSE_HIDE_THINKING;
    detach.resetDetachState?.();
  }

  // 32. reload replanning: detach after applyPlannedRuns, or the preview
  // keys a stale run id (caught live: hidden:1 reported, no preview row).
  // Same container cleared+rebuilt (production reload shape), so the
  // session_start detach sees the fresh rows directly.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const tools = new Map(), handlers = new Map();
    const piL = {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piL);
    const detach = mod;
    detach.resetDetachState?.();
    process.env.COLLAPSE_HIDE_THINKING = "1";
    const theme = { fg: (c, t) => t, bold: (t) => t, italic: (t) => t, style: (t) => t };
    const read = tools.get("read");
    const mk = (t, id, args) => ({ args, toolCallId: id, invalidate() {}, lastComponent: undefined,
      state: {}, cwd: "/repo", executionStarted: true, argsComplete: true, isPartial: false,
      expanded: false, showImages: true, isError: false });
    const histMsg = { role: "assistant", content: [
      { type: "thinking", thinking: "reloadable plan" },
      { type: "toolCall", id: "rr1", name: "read", arguments: { path: "/g" } },
    ], stopReason: "toolUse" };
    const entries = [
      { id: "rid1", type: "message", message: histMsg },
      { id: "rid1r", type: "message", message: { role: "toolResult", toolCallId: "rr1", content: [{ type: "text", text: "ok" }] } },
    ];
    const sm = { getEntries: () => entries };
    const widgets = [];
    const ui = { setWidget: (k, f) => widgets.push(f), setHiddenThinkingLabel: () => {} };
    // session 1: handle captured, row detached live.
    await handlers.get("session_start")[0]({}, { hasUI: true, ui, sessionManager: sm });
    const chat = { children: [],
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); } };
    const row1 = { lastMessage: histMsg, hiddenThinkingLabel: "T", updateContent() {}, setHiddenThinkingLabel() {} };
    chat.children.push(row1);
    widgets[0]({ children: [chat] }, {});
    read.renderCall({ path: "/g" }, theme, mk(read, "rr1", { path: "/g" }));
    detach.detachPass(piL, sm);
    check("session 1 detached", !chat.children.includes(row1), "");
    // reload: same container cleared+rebuilt with fresh rows, same message
    // refs (entry.message identity holds); rebuild renders before the event.
    const row2 = { lastMessage: histMsg, hiddenThinkingLabel: "T", updateContent() {}, setHiddenThinkingLabel() {} };
    chat.children.push(row2);
    read.renderCall({ path: "/g" }, theme, mk(read, "rr1", { path: "/g" }));
    await handlers.get("session_start")[0]({}, { hasUI: true, ui, sessionManager: sm });
    const out = read.renderCall({ path: "/g" }, theme, mk(read, "rr1", { path: "/g" }));
    const lines = out.render(100).join("\n");
    check("reload detaches fresh row", !chat.children.includes(row2), chat.children.length);
    check("preview keys the final run", lines.includes("reloadable plan"), lines.slice(0, 160));
    delete process.env.COLLAPSE_HIDE_THINKING;
    detach.resetDetachState?.();
  }

  // 33. event handlers leak no return values Pi validates (user_bash
  // rejected traceBoundary's string: "Invalid user_bash handler result").
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const handlers = new Map();
    const piL = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piL);
    for (const [name, fns] of handlers) {
      for (const fn of fns) {
        let r;
        try {
          r = fn({ message: { role: "assistant", content: [] } }, { hasUI: false, ui: {}, sessionManager: { getEntries: () => [] } });
          if (r && typeof r.then === "function") await r;
        } catch { continue; }
        check(`handler ${name} returns undefined`, r === undefined, `${name} returned ${JSON.stringify(r)}`);
      }
    }
  }

  // 34-44 run on a FRESH activation: the shared reset slot now belongs to
  // a later import (block 33 reassigns it), so the outer registry keeps
  // stale runs that fresh ids would join (block 17 hit the same quirk).
  // A private instance keeps ownership assertions deterministic.
  const modW = await jiti.import(path.join(HERE, "index.ts"));
  const piW = createMockPi();
  (modW.default ?? modW)(piW);
  resetTrace = modW.resetTraceState ?? resetTrace;
  // Doubles mirror Pi's real class names (constructor.name checks must match).
  class Spacer { render() { return [""]; } }
  class Text { constructor(text) { this.text = text; } render() { return [this.text]; } }
  class MouseRegion { constructor(child) { this.child = child; } }
  class Markdown { constructor(text) { this.text = text; } }
  // Mirror Pi's real nesting: spacers/labels live in contentContainer.
  const thinkingRow = (children) => {
    const contentContainer = {
      children,
      removeChild(c) {
        const list = this.children;
        const i = list.indexOf(c);
        if (i >= 0) list.splice(i, 1);
      },
    };
    return {
      lastMessage: { role: "assistant", content: [] },
      hiddenThinkingLabel: "T",
      updateContent() {},
      setHiddenThinkingLabel(label) { this.hiddenThinkingLabel = label; },
      children: [contentContainer],
      contentContainer,
    };
  };
  const toolComp = (id, shell, lines) => ({
    toolCallId: id,
    getRenderShell: () => shell,
    render: (_w) => [...lines],
    handleMouse: (e) => (e.y <= 0 || e.y > lines.length - 1 ? undefined : `hit${e.y - 1}`),
  });

  // 34. render-wrap strips the tool component's leading blank (run owner only)
  {
    check("wrappingPass exported", typeof modW.wrappingPass === "function", typeof modW.wrappingPass);
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-wrap" });
    read.renderCall(ctx.args, theme, ctx); // registers trace entry; t-wrap owns its run
    const fake = toolComp("t-wrap", "self", ["", "› read /a"]);
    modW.captureWalkerTui({ children: [thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]), fake] });
    const res = modW.wrappingPass(piW);
    check("owner wrapped", res && res.wrapped === 1, JSON.stringify(res));
    const out = fake.render(100);
    check("leading blank stripped", out.length === 1 && out[0] === "› read /a", JSON.stringify(out));
  }

  // 35. clicks re-base by exactly the stripped line (Pi rejects y<=0, delegates y-1)
  {
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-click" });
    read.renderCall(ctx.args, theme, ctx);
    const fake = toolComp("t-click", "self", ["", "r1", "r2"]);
    modW.captureWalkerTui({ children: [thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]), fake] });
    modW.wrappingPass(piW);
    check("displayed y=0 reaches content row 0", fake.handleMouse({ y: 0 }) === "hit0", String(fake.handleMouse({ y: 0 })));
    check("displayed y=1 reaches content row 1", fake.handleMouse({ y: 1 }) === "hit1", String(fake.handleMouse({ y: 1 })));
    check("above-block click hits nothing", fake.handleMouse({ y: -1 }) === undefined, String(fake.handleMouse({ y: -1 })));
    check("below-block click hits nothing", fake.handleMouse({ y: 2 }) === undefined, String(fake.handleMouse({ y: 2 })));
  }

  // 36. only the run owner is ever wrapped
  {
    resetTrace();
    const read = piW.tools.get("read");
    const bash = piW.tools.get("bash");
    const c1 = callContext({ args: { path: "/a" }, toolCallId: "t-own" });
    read.renderCall(c1.ctx.args, theme, c1.ctx);
    bash.renderCall({ command: "ls" }, theme, { ...c1.ctx, args: { command: "ls" }, state: {}, toolCallId: "t-next" });
    const owner = toolComp("t-own", "self", ["", "› t-own"]);
    const nonOwner = toolComp("t-next", "self", ["", "› t-next"]);
    const foreign = toolComp("t-foreign", "self", ["", "› t-foreign"]);
    const stock = toolComp("t-stock", "default", ["", "› t-stock"]);
    modW.captureWalkerTui({ children: [thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]), owner, nonOwner, foreign, stock] });
    const res = modW.wrappingPass(piW);
    check("only owner wrapped", res.wrapped === 1, JSON.stringify(res));
    check("owner stripped", owner.render(100)[0] === "› t-own", JSON.stringify(owner.render(100)));
    check("non-owner untouched", nonOwner.render(100)[0] === "", JSON.stringify(nonOwner.render(100)));
    check("foreign untouched", foreign.render(100)[0] === "", JSON.stringify(foreign.render(100)));
    check("default-shell untouched", stock.render(100)[0] === "", JSON.stringify(stock.render(100)));
    // Visible mode: previously wrapped instances self-bypass, nothing new wraps.
    piW._hidden = false;
    const resV = modW.wrappingPass(piW);
    check("visible mode wraps nothing", resV.wrapped === 0, JSON.stringify(resV));
    check("visible mode restores blank", owner.render(100)[0] === "", JSON.stringify(owner.render(100)));
    piW._hidden = true;
  }

  // 37. wrapping is idempotent and reversible
  {
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-re" });
    read.renderCall(ctx.args, theme, ctx);
    const fake = toolComp("t-re", "self", ["", "r1", "r2"]);
    modW.captureWalkerTui({ children: [thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]), fake] });
    const res1 = modW.wrappingPass(piW);
    const res2 = modW.wrappingPass(piW);
    check("first pass wraps", res1.wrapped === 1, JSON.stringify(res1));
    check("second pass wraps nothing new", res2.wrapped === 0 && res2.already === 1, JSON.stringify(res2));
    check("exactly one line stripped", JSON.stringify(fake.render(100)) === JSON.stringify(["r1", "r2"]), JSON.stringify(fake.render(100)));
    modW.unwrapAll();
    check("unwrap restores blank", fake.render(100)[0] === "", JSON.stringify(fake.render(100)));
    check("unwrap restores clicks", fake.handleMouse({ y: 1 }) === "hit0", String(fake.handleMouse({ y: 1 })));
  }

  // 38. fresh instances wrap after rebuild; empty tree is a no-op
  {
    modW.captureWalkerTui({ children: [] });
    const res = modW.wrappingPass(piW);
    check("empty tree wraps nothing", res.wrapped === 0, JSON.stringify(res));
    check("wrap status reported", /wrapped|idle|inactive/.test(modW.wrapStatus()), modW.wrapStatus());
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-new" });
    read.renderCall(ctx.args, theme, ctx);
    // Rebuild replaces the instance: a fresh object with the same id wraps.
    const fresh = toolComp("t-new", "self", ["", "› read /a"]);
    modW.captureWalkerTui({ children: [thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]), fresh] });
    const res2 = modW.wrappingPass(piW);
    check("fresh instance wraps", res2.wrapped === 1 && fresh.render(100)[0] === "› read /a", JSON.stringify(res2));
    modW.captureWalkerTui({ children: [] });
  }

  // 39. prose directly above the owner keeps the separator (and clicks stay stock)
  {
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-prose" });
    read.renderCall(ctx.args, theme, ctx);
    const prosePrev = thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking...")), new Spacer(), new Markdown("some prose")]);
    const fake = toolComp("t-prose", "self", ["", "› read /a"]);
    modW.captureWalkerTui({ children: [prosePrev, fake] });
    const res = modW.wrappingPass(piW);
    check("prose-prev owner still wrapped", res.wrapped === 1, JSON.stringify(res));
    check("prose-prev keeps blank", JSON.stringify(fake.render(100)) === JSON.stringify(["", "› read /a"]), JSON.stringify(fake.render(100)));
    check("blank click hits nothing", fake.handleMouse({ y: 0 }) === undefined, String(fake.handleMouse({ y: 0 })));
    check("content click still hits", fake.handleMouse({ y: 1 }) === "hit0", String(fake.handleMouse({ y: 1 })));
  }

  // 40. a tool row above the owner still glues (r31 tool-to-tool contiguity)
  {
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-chain" });
    read.renderCall(ctx.args, theme, ctx);
    const prevTool = toolComp("t-prev", "self", ["", "› prev"]);
    const fake = toolComp("t-chain", "self", ["", "› read /a"]);
    modW.captureWalkerTui({ children: [prevTool, fake] });
    const res = modW.wrappingPass(piW);
    check("tool-prev owner wrapped", res.wrapped === 1, JSON.stringify(res));
    check("tool-prev glues", fake.render(100)[0] === "› read /a", JSON.stringify(fake.render(100)));
  }

  // 41. a first-child owner keeps its blank (nothing rendered above it)
  {
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-first" });
    read.renderCall(ctx.args, theme, ctx);
    const fake = toolComp("t-first", "self", ["", "› read /a"]);
    modW.captureWalkerTui({ children: [fake] });
    modW.wrappingPass(piW);
    check("first-child keeps blank", JSON.stringify(fake.render(100)) === JSON.stringify(["", "› read /a"]), JSON.stringify(fake.render(100)));
  }

  // 42. a thinking-only row directly after tools loses its leading spacer
  {
    resetTrace();
    const prevTool = toolComp("t-before", "self", ["", "› prev"]);
    const label = new MouseRegion(new Text("Thinking..."));
    const row = thinkingRow([new Spacer(), label]);
    modW.captureWalkerTui({ children: [prevTool, row] });
    const res = modW.wrappingPass(piW);
    check("leading spacer dropped", res.spacers === 1, JSON.stringify(res));
    check("spacer gone, label kept", row.contentContainer.children.length === 1 && row.contentContainer.children[0] === label, JSON.stringify(row.contentContainer.children.length));
    // Prose rows and non-tool predecessors are untouched.
    const prose = thinkingRow([new Spacer(), new Markdown("prose")]);
    const row2 = thinkingRow([new Spacer(), new MouseRegion(new Text("T"))]);
    modW.captureWalkerTui({ children: [prose, row2] });
    const res2 = modW.wrappingPass(piW);
    check("non-tool predecessor keeps spacer", res2.spacers === 0 && row2.contentContainer.children.length === 2, `${res2.spacers}/${row2.contentContainer.children.length}`);
  }

  // 43. spacer surgery is idempotent and visible-mode skips it
  {
    resetTrace();
    const prevTool = toolComp("t-b3", "self", ["", "› prev"]);
    const row = thinkingRow([new Spacer(), new MouseRegion(new Text("T"))]);
    modW.captureWalkerTui({ children: [prevTool, row] });
    modW.wrappingPass(piW);
    const res2 = modW.wrappingPass(piW);
    check("second pass drops nothing new", res2.spacers === 0, JSON.stringify(res2));
    check("label survives re-pass", row.contentContainer.children.length === 1, String(row.contentContainer.children.length));
    piW._hidden = false;
    const rowV = thinkingRow([new Spacer(), new MouseRegion(new Text("T"))]);
    modW.captureWalkerTui({ children: [prevTool, rowV] });
    const resV = modW.wrappingPass(piW);
    check("visible mode keeps spacer", resV.spacers === 0 && rowV.contentContainer.children.length === 2, `${resV.spacers}/${rowV.contentContainer.children.length}`);
    piW._hidden = true;
    modW.captureWalkerTui({ children: [] });
  }

  // 44. [text, thinking] order still glues: the label trails, prose keeps its own seam
  {
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-order" });
    read.renderCall(ctx.args, theme, ctx);
    const prev = thinkingRow([new Spacer(), new Markdown("prose first"), new MouseRegion(new Text("Thinking..."))]);
    const fake = toolComp("t-order", "self", ["", "› read /a"]);
    modW.captureWalkerTui({ children: [prev, fake] });
    modW.wrappingPass(piW);
    check("trailing label glues", fake.render(100)[0] === "› read /a", JSON.stringify(fake.render(100)));
  }

  // 45. a row's updateContent re-heals its spacer synchronously (toggle path)
  {
    resetTrace();
    const prevTool = toolComp("t-b4", "self", ["", "› prev"]);
    const label = new MouseRegion(new Text("Thinking..."));
    let origCalls = 0;
    const container = { children: [new Spacer(), label], removeChild(c) { const i = container.children.indexOf(c); if (i >= 0) container.children.splice(i, 1); } };
    const row = {
      lastMessage: { role: "assistant", content: [] },
      hiddenThinkingLabel: "T",
      setHiddenThinkingLabel() {},
      children: [container],
      contentContainer: container,
      updateContent() { origCalls++; container.children = [new Spacer(), label]; return "orig-result"; },
    };
    modW.captureWalkerTui({ children: [prevTool, row] });
    modW.wrappingPass(piW);
    check("pass drops initial spacer", container.children.length === 1, String(container.children.length));
    // Pi's toggle path rebuilds children (spacer returns); the shadow must
    // re-heal synchronously and preserve orig behavior.
    const ret = row.updateContent({}, true);
    check("orig updateContent still runs", origCalls === 1 && ret === "orig-result", `${origCalls}/${ret}`);
    check("spacer re-healed synchronously", container.children.length === 1 && container.children[0] === label, String(container.children.length));
    modW.unwrapAll();
    row.updateContent({}, true);
    check("unwrap restores updateContent", origCalls === 2 && container.children.length === 2, `${origCalls}/${container.children.length}`);
  }

  // 46. a scheduled pass runs right after capture (no 1s-tick wait)
  {
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-sched" });
    read.renderCall(ctx.args, theme, ctx);
    const fake = toolComp("t-sched", "self", ["", "› read /a"]);
    modW.captureWalkerTui({ children: [thinkingRow([new Spacer(), new MouseRegion(new Text("T"))]), fake] });
    check("schedule exported", typeof modW.scheduleWrappingPass === "function", typeof modW.scheduleWrappingPass);
    modW.scheduleWrappingPass(piW);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check("scheduled pass stripped", fake.render(100)[0] === "› read /a", JSON.stringify(fake.render(100)));
    check("schedule status live", /wrapped/.test(modW.wrapStatus()), modW.wrapStatus());
    modW.captureWalkerTui({ children: [] });
  }

  // 47. expanded thinking under tools loses its top spacer too
  {
    resetTrace();
    const prevTool = toolComp("t-b5", "self", ["", "› prev"]);
    const expanded = new MouseRegion(new Markdown("full expanded thinking"));
    const row = thinkingRow([new Spacer(), expanded]);
    modW.captureWalkerTui({ children: [prevTool, row] });
    const res = modW.wrappingPass(piW);
    check("expanded top spacer dropped", res.spacers === 1, JSON.stringify(res));
    check("expanded content kept", row.contentContainer.children.length === 1 && row.contentContainer.children[0] === expanded, String(row.contentContainer.children.length));
  }

  // 48. tools under expanded thinking stay glued (symmetric bottom seam)
  {
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-exp" });
    read.renderCall(ctx.args, theme, ctx);
    const prev = thinkingRow([new Spacer(), new MouseRegion(new Markdown("expanded"))]);
    const fake = toolComp("t-exp", "self", ["", "› read /a"]);
    modW.captureWalkerTui({ children: [prev, fake] });
    modW.wrappingPass(piW);
    check("expanded label above glues", fake.render(100)[0] === "› read /a", JSON.stringify(fake.render(100)));
    modW.captureWalkerTui({ children: [] });
  }

  // 49. streaming relabel: the live row shows OUR preview, never stock
  {
    resetTrace();
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(500) }] };
    const row = thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]);
    row.lastMessage = msg;
    row.hiddenThinkingLabel = "Thinking...";
    modW.captureWalkerTui({ children: [row] });
    check("streaming relabel exported", typeof modW.reconcileStreamingLabel === "function", typeof modW.reconcileStreamingLabel);
    modW.reconcileStreamingLabel(piW, msg, 1000);
    check("streaming label is ours, not stock", row.hiddenThinkingLabel !== "Thinking..." && /ch/.test(row.hiddenThinkingLabel), row.hiddenThinkingLabel);
    check("streaming label carries the preview", /x/.test(row.hiddenThinkingLabel), row.hiddenThinkingLabel);
  }

  // 50. the count grows with the text; updates are throttled but never stuck
  {
    resetTrace();
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(400) }] };
    const row = thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]);
    row.lastMessage = msg;
    row.hiddenThinkingLabel = "";
    modW.captureWalkerTui({ children: [row] });
    modW.reconcileStreamingLabel(piW, msg, 5000);
    const first = row.hiddenThinkingLabel;
    // A delta inside the throttle window must not thrash the label.
    msg.content[0].thinking = "a".repeat(4000);
    modW.reconcileStreamingLabel(piW, msg, 5050);
    check("throttled delta keeps label", row.hiddenThinkingLabel === first, `${row.hiddenThinkingLabel} VS ${first}`);
    // Once the window passes, the bigger text lands (smooth growth).
    modW.reconcileStreamingLabel(piW, msg, 5200);
    check("throttle window releases", row.hiddenThinkingLabel !== first && /ch/.test(row.hiddenThinkingLabel), row.hiddenThinkingLabel);
  }

  // 51. no thinking text renders no region, so no label is written at all
  {
    resetTrace();
    const prose = { role: "assistant", content: [{ type: "text", text: "hello" }] };
    const empty = { role: "assistant", content: [{ type: "thinking", thinking: "   " }] };
    const row = thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]);
    row.lastMessage = prose;
    row.hiddenThinkingLabel = "Thinking...";
    modW.captureWalkerTui({ children: [row] });
    modW.reconcileStreamingLabel(piW, prose, 9000);
    check("prose-only row keeps stock label", row.hiddenThinkingLabel === "Thinking...", row.hiddenThinkingLabel);
    row.lastMessage = empty;
    modW.reconcileStreamingLabel(piW, empty, 9200);
    check("blank thinking writes nothing", row.hiddenThinkingLabel === "Thinking...", row.hiddenThinkingLabel);
  }

  // 52. only the streaming row is touched; history rows keep their labels
  {
    resetTrace();
    const hist = { role: "assistant", content: [{ type: "thinking", thinking: "old thoughts here" }] };
    const live = { role: "assistant", content: [{ type: "thinking", thinking: "n".repeat(300) }] };
    const oldRow = thinkingRow([new Spacer(), new MouseRegion(new Text("T"))]);
    oldRow.lastMessage = hist;
    oldRow.hiddenThinkingLabel = "OLD-LABEL";
    const liveRow = thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]);
    liveRow.lastMessage = live;
    liveRow.hiddenThinkingLabel = "Thinking...";
    modW.captureWalkerTui({ children: [oldRow, liveRow] });
    modW.reconcileStreamingLabel(piW, live, 12000);
    check("history row untouched", oldRow.hiddenThinkingLabel === "OLD-LABEL", oldRow.hiddenThinkingLabel);
    check("live row relabeled", /ch/.test(liveRow.hiddenThinkingLabel), liveRow.hiddenThinkingLabel);
  }

  // 53. the settle pass still writes the final count after streaming
  {
    resetTrace();
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "z".repeat(300) }] };
    const row = thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]);
    row.lastMessage = msg;
    row.hiddenThinkingLabel = "";
    modW.captureWalkerTui({ children: [row] });
    modW.reconcileStreamingLabel(piW, msg, 15000);
    const during = row.hiddenThinkingLabel;
    msg.content[0].thinking = "z".repeat(9000);
    // Streaming wrote labels without caching, so the settle pass recomputes.
    modW.reconcileThinkingLabels(piW);
    check("settle pass corrects the count", row.hiddenThinkingLabel !== during && /ch/.test(row.hiddenThinkingLabel), `${row.hiddenThinkingLabel} VS ${during}`);
  }

  // 54. message_start/message_update schedule a pass (row shadowed promptly)
  {
    resetTrace();
    const prevTool = toolComp("t-b9", "self", ["", "› prev"]);
    const row = thinkingRow([new Spacer(), new MouseRegion(new Text("T"))]);
    modW.captureWalkerTui({ children: [prevTool, row] });
    const starts = piW.handlers.get("message_start") ?? [];
    for (const fn of starts) fn({ message: { role: "assistant", content: [] } }, { hasUI: false });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check("message_start heals the fresh row", row.contentContainer.children.length === 1, String(row.contentContainer.children.length));
    // A later delta rebuilds the children (Pi path); the row shadow heals it.
    row.contentContainer.children = [new Spacer(), new MouseRegion(new Text("T"))];
    for (const fn of piW.handlers.get("message_update") ?? []) fn({ message: { role: "assistant", content: [{ type: "thinking", thinking: "live text" }] } }, {});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check("update pass heals the rebuilt row", row.contentContainer.children.length === 1, String(row.contentContainer.children.length));
    modW.captureWalkerTui({ children: [] });
  }

  // 55. streaming rows are matched by their own isStreaming flag, not by
  // event identity (our handler can run before Pi updates the row, so the
  // row's message is one delta behind the event's)
  {
    resetTrace();
    const stale = { role: "assistant", content: [{ type: "thinking", thinking: "s".repeat(600) }] };
    const evt = { role: "assistant", content: [{ type: "thinking", thinking: "s".repeat(700) }] };
    const row = thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]);
    row.lastMessage = stale;
    row.isStreaming = true;
    row.hiddenThinkingLabel = "Thinking...";
    modW.captureWalkerTui({ children: [row] });
    modW.reconcileStreamingLabel(piW, evt, 20000);
    check("stale-identity streaming row labeled", row.hiddenThinkingLabel !== "Thinking..." && /ch/.test(row.hiddenThinkingLabel), row.hiddenThinkingLabel);
    check("label follows the row's own text", /s/.test(row.hiddenThinkingLabel), row.hiddenThinkingLabel);
  }

  // 56. settled rows are never touched by the streaming path
  {
    resetTrace();
    const settled = { role: "assistant", content: [{ type: "thinking", thinking: "c".repeat(400) }] };
    const evt = { role: "assistant", content: [{ type: "thinking", thinking: "d".repeat(400) }] };
    const row = thinkingRow([new Spacer(), new MouseRegion(new Text("T"))]);
    row.lastMessage = settled;
    row.isStreaming = false;
    row.hiddenThinkingLabel = "SETTLED";
    modW.captureWalkerTui({ children: [row] });
    modW.reconcileStreamingLabel(piW, evt, 22000);
    check("settled row untouched", row.hiddenThinkingLabel === "SETTLED", row.hiddenThinkingLabel);
  }

  // 57. the deferred pass relabels any live row (post-UI-update ordering)
  {
    resetTrace();
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "p".repeat(800) }] };
    const row = thinkingRow([new Spacer(), new MouseRegion(new Text("Thinking..."))]);
    row.lastMessage = msg;
    row.isStreaming = true;
    row.hiddenThinkingLabel = "Thinking...";
    modW.captureWalkerTui({ children: [row] });
    modW.reconcileStreamingLabel(piW, undefined, 24000);
    check("no-arg pass labels live rows", /ch/.test(row.hiddenThinkingLabel), row.hiddenThinkingLabel);
    modW.captureWalkerTui({ children: [] });
  }

  // 58. end-to-end against Pi's REAL component: a streaming row renders our
  // preview, not the stock label (proves isStreaming + extraction line up)
  {
    resetTrace();
    const agent = await jiti.import("@earendil-works/pi-coding-agent");
    const row = new agent.AssistantMessageComponent(
      undefined, true, undefined, "Thinking...", 1, [],
    );
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: "real ".repeat(200) }] };
    row.updateContent(msg, true);
    modW.captureWalkerTui({ children: [row] });
    modW.reconcileStreamingLabel(piW, undefined, 30000);
    const rendered = row.render(100).join("\n");
    check("real streaming row drops stock label", !rendered.includes("Thinking..."), rendered.slice(0, 80));
    check("real streaming row renders our preview", /ch/.test(rendered) && /real/.test(rendered), rendered.slice(0, 80));
    // Settling turns the flag off: the streaming path must then leave it alone.
    row.updateContent(msg, false);
    row.setHiddenThinkingLabel("SETTLED");
    modW.reconcileStreamingLabel(piW, undefined, 30200);
    check("settled real row untouched", row.hiddenThinkingLabel === "SETTLED", String(row.hiddenThinkingLabel));
    modW.captureWalkerTui({ children: [] });
  }

  // 59. wrap status distinguishes cumulative work from an idle last pass
  {
    resetTrace();
    const read = piW.tools.get("read");
    const { ctx } = callContext({ args: { path: "/a" }, toolCallId: "t-tot" });
    read.renderCall(ctx.args, theme, ctx);
    const prevTool = toolComp("t-b10", "self", ["", "› prev"]);
    const fake = toolComp("t-tot", "self", ["", "› read /a"]);
    const row = thinkingRow([new Spacer(), new MouseRegion(new Text("T"))]);
    modW.captureWalkerTui({ children: [prevTool, fake, row] });
    const num = (text, re) => Number(re.exec(text)?.[1] ?? NaN);
    const before = modW.wrapStatus();
    const baseWrapped = num(before, /total (\d+) wrapped/);
    const baseSpacers = num(before, /total \d+ wrapped, (\d+) spacer/);
    modW.wrappingPass(piW);
    const first = modW.wrapStatus();
    // Second pass has nothing left to do; the report must still show the work
    // done, not just this pass's zeros (which read as "wrap is broken").
    modW.wrappingPass(piW);
    const second = modW.wrapStatus();
    check("pass tallies the work", num(first, /total (\d+) wrapped/) >= baseWrapped + 1 && /last pass 1 new/.test(first), first);
    check("pass tallies spacers", num(first, /total \d+ wrapped, (\d+) spacer/) >= baseSpacers + 1, first);
    check("idle pass still shows totals", num(second, /total (\d+) wrapped/) === num(first, /total (\d+) wrapped/) && /last pass 0 new/.test(second), second);
    check("idle pass names the already count", /1 already/.test(second), second);
    modW.captureWalkerTui({ children: [] });
  }

  // 60. expanding a self-shell tool (edit) shows its result, byte-identical
  // to a real ToolExecutionComponent (the diff lives in the RESULT renderer,
  // so dropping it leaves a header with no body)
  {
    resetTrace();
    const agent = await jiti.import("@earendil-works/pi-coding-agent");
    agent.initTheme("light");
    const themeMod = await jiti.import(
      path.join(PI, "dist", "modes", "interactive", "theme", "theme.js"),
    );
    const realTheme = themeMod.loadThemeFromPath(
      path.join(PI, "dist", "modes", "interactive", "theme", "light.json"),
      "truecolor",
    );
    const edit = piW.tools.get("edit");
    // A real file, because edit's renderCall kicks off a disk-based preview.
    const tmpFile = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "collapse-edit-")), "notes.txt");
    fs.writeFileSync(tmpFile, "alpha line\n");
    const args = { path: tmpFile, oldText: "alpha line", newText: "beta line" };
    // The diff edit actually renders comes from details.diff, applied by
    // renderResult into the CALL component's state.
    const result = {
      content: [{ type: "text", text: "Successfully edited " + tmpFile }],
      details: { diff: "-alpha line\n+beta line", firstChangedLine: 1 },
    };
    const { ctx } = callContext({ args, toolCallId: "t-edit" });
    edit.renderCall(args, realTheme, ctx);
    edit.renderResult(result, { expanded: false, isPartial: false }, realTheme, { ...ctx, lastComponent: undefined });
    const rest = edit.renderCall(args, realTheme, ctx).render(100);
    check("edit rest is one row", rest.length === 1, JSON.stringify(rest));
    const row = edit.renderCall(args, realTheme, ctx).children[0];
    row.onMouse({ type: "click", button: "left" });
    const opened = edit.renderCall(args, realTheme, ctx).render(100);
    const stock = (() => {
      const c = new agent.ToolExecutionComponent(
        "edit", "stockE", args, { showImages: true, imageWidthCells: 60 },
        agent.createEditToolDefinition(path.dirname(tmpFile)), { requestRender() {} }, path.dirname(tmpFile),
      );
      c.setExpanded(false);
      c.markExecutionStarted();
      c.setArgsComplete();
      c.updateResult(result, false);
      return c.render(100).slice(1);
    })();
    const joined = opened.join("\n");
    check("edit expanded shows the change", /beta/.test(joined), joined.slice(0, 200));
    const firstDiff = opened.findIndex((line, i) => line !== stock[i]);
    check("edit expanded matches stock", JSON.stringify(opened) === JSON.stringify(stock), `line ${firstDiff}: ${JSON.stringify(opened[firstDiff])} VS ${JSON.stringify(stock[firstDiff])}`);

    // ctrl+o (Pi expanded) must hold the same line, at the deeper cell.
    const ctxX = { ...callContext({ args, toolCallId: "t-edit-x", expanded: true }).ctx };
    edit.renderCall(args, realTheme, ctxX);
    edit.renderResult(result, { expanded: true, isPartial: false }, realTheme, { ...ctxX, lastComponent: undefined });
    edit.renderCall(args, realTheme, ctxX).children[0].onMouse({ type: "click", button: "left" });
    const openedX = edit.renderCall(args, realTheme, ctxX).render(100);
    const stockX = (() => {
      const c = new agent.ToolExecutionComponent(
        "edit", "stockX", args, { showImages: true, imageWidthCells: 60 },
        agent.createEditToolDefinition(path.dirname(tmpFile)), { requestRender() {} }, path.dirname(tmpFile),
      );
      c.setExpanded(true);
      c.markExecutionStarted();
      c.setArgsComplete();
      c.updateResult(result, false);
      return c.render(100).slice(1);
    })();
    check("edit deep cell shows the change", /beta/.test(openedX.join("\n")), openedX.join("\n").slice(0, 200));
    check("edit deep cell matches stock", JSON.stringify(openedX) === JSON.stringify(stockX), `line ${openedX.findIndex((l, i) => l !== stockX[i])}`);
  }

  // 61. generalization matrix: EVERY builtin opens byte-identical to stock
  // at both depths (default-shell box path and self-shell compose path)
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
    const cwd = "/repo";
    const text = (body) => ({ content: [{ type: "text", text: body }], details: {} });
    const cases = [
      ["read", { path: "/repo/a.txt", offset: 1, limit: 3 }, text("one\ntwo\nthree")],
      ["bash", { command: "ls -la" }, text("total 0\ndrwxr-xr-x  2 me me 4096 .")],
      ["powershell", { command: "Get-ChildItem" }, text("Name\n----")],
      ["write", { path: "/repo/b.txt", content: "hello" }, text("Wrote /repo/b.txt")],
      ["grep", { pattern: "alpha", path: "/repo" }, text("a.txt:1:alpha")],
      ["find", { pattern: "**/*.ts", path: "/repo" }, text("src/a.ts\nsrc/b.ts")],
      ["ls", { path: "/repo" }, text("a.txt\nb.txt")],
    ];
    const factories = {
      read: agent.createReadToolDefinition, bash: agent.createBashToolDefinition,
      powershell: agent.createPowerShellToolDefinition, write: agent.createWriteToolDefinition,
      grep: agent.createGrepToolDefinition, find: agent.createFindToolDefinition,
      ls: agent.createLsToolDefinition,
    };
    for (const [name, args, result] of cases) {
      for (const expanded of [false, true]) {
        resetTrace();
        const tool = piW.tools.get(name);
        const { ctx } = callContext({ args, toolCallId: `card-${name}-${expanded}`, expanded });
        tool.renderCall(args, realTheme, ctx);
        tool.renderResult(result, { expanded, isPartial: false }, realTheme, { ...ctx, lastComponent: undefined });
        const rest = tool.renderCall(args, realTheme, ctx);
        if (!rest.children?.[0]?.onMouse) {
          check(`${name} matrix row exists (${expanded ? "deep" : "shallow"})`, false, "no clickable row");
          continue;
        }
        rest.children[0].onMouse({ type: "click", button: "left" });
        const ours = tool.renderCall(args, realTheme, ctx).render(100);
        const stockComp = new agent.ToolExecutionComponent(
          name, `stock-${name}-${expanded}`, args, { showImages: true, imageWidthCells: 60 },
          factories[name](cwd), { requestRender() {} }, cwd,
        );
        stockComp.setExpanded(expanded);
        stockComp.markExecutionStarted();
        stockComp.setArgsComplete();
        stockComp.updateResult(result, false);
        const stock = stockComp.render(100).slice(1);
        const at = ours.findIndex((line, i) => line !== stock[i]);
        check(
          `${name} opens like stock (${expanded ? "deep" : "shallow"})`,
          JSON.stringify(ours) === JSON.stringify(stock),
          `line ${at}: ${JSON.stringify(ours[at])} VS ${JSON.stringify(stock[at])}`,
        );
      }
    }
  }

  // 62. opt-in tools are covered too: a self-shell custom definition whose
  // result renderer stakes the body into the CALL component (the edit
  // pattern) still opens correctly, because the opened row always runs both.
  {
    resetTrace();
    const tui = await jiti.import("@earendil-works/pi-tui");
    const wrap = globalThis.__collapseWrapTool;
    check("wrap slot available for custom tools", typeof wrap === "function", typeof wrap);
    const custom = {
      name: "custom_stateful",
      parameters: {},
      async execute() { return "ran"; },
      renderShell: "self",
      renderCall(_args, theme, context) {
        const box = context.state.customBox ?? new tui.Container();
        context.state.customBox = box;
        box.clear();
        box.addChild(new tui.Text(theme.bold("custom header"), 0, 0));
        return box;
      },
      renderResult(result, _options, theme, context) {
        // Mutates the call component, returns an empty container - exactly
        // how edit delivers its diff.
        const box = context.state.customBox;
        if (box) {
          box.clear();
          box.addChild(new tui.Text(theme.bold("custom header"), 0, 0));
          box.addChild(new tui.Text(`body: ${result.details.body}`, 0, 0));
        }
        return new tui.Container();
      },
    };
    const wrapped = wrap(custom);
    const args = { anything: 1 };
    const result = { content: [{ type: "text", text: "ok" }], details: { body: "PAYLOAD" } };
    const { ctx } = callContext({ args, toolCallId: "t-custom", name: "custom_stateful" });
    wrapped.renderCall(args, theme, ctx);
    wrapped.renderResult(result, { expanded: false, isPartial: false }, theme, { ...ctx, lastComponent: undefined });
    const rest = wrapped.renderCall(args, theme, ctx);
    check("custom row rests as one line", rest.render(100).length === 1, JSON.stringify(rest.render(100)));
    rest.children[0].onMouse({ type: "click", button: "left" });
    const opened = wrapped.renderCall(args, theme, ctx).render(100).join("\n");
    check("custom opened shows header", /custom header/.test(opened), opened.slice(0, 160));
    check("custom opened shows result-injected body", /PAYLOAD/.test(opened), opened.slice(0, 160));
  }

  // 63. the count streams: partial results re-run renderResult and the row
  // repaints with the new size (Pi sends tool_execution_update ->
  // updateResult(partial, isPartial: true))
  {
    resetTrace();
    const bash = piW.tools.get("bash");
    const { ctx } = callContext({ args: { command: "seq 1 100" }, toolCallId: "t-stream" });
    bash.renderCall(ctx.args, theme, ctx);
    const partial = (chars, isPartial) =>
      bash.renderResult(
        { content: [{ type: "text", text: "x".repeat(chars) }], details: {} },
        { expanded: false, isPartial },
        theme,
        { ...ctx, lastComponent: undefined },
      );
    partial(120, true);
    const during = bash.renderCall(ctx.args, theme, ctx).render(80).join("");
    check("partial output shows a count", /0\.1k ch/.test(during), during);
    partial(2500, true);
    const grown = bash.renderCall(ctx.args, theme, ctx).render(80).join("");
    check("count grows while output streams", /2\.5k ch/.test(grown), grown);
    partial(4200, false);
    const settled = bash.renderCall(ctx.args, theme, ctx).render(80).join("");
    check("final count lands", /4\.2k ch/.test(settled), settled);
    check("row stays one line", bash.renderCall(ctx.args, theme, ctx).render(80).length === 1, "multi-line");
  }

  // 64. formatting hierarchy: BOLD = identity (tool / command), PLAIN = the
  // one specific thing (file name, pattern), DIM = everything else
  // (prefix, dirs, ranges, timeouts, sizes, generic summaries)
  {
    const row = (name, args, state = {}) => {
      resetTrace();
      const tool = piW.tools.get(name);
      const { ctx } = callContext({ args, toolCallId: `fmt-${name}`, state });
      return tool.renderCall(ctx.args, theme, { ...ctx, state }).render(100)[0];
    };
    // dim prefix on every row
    for (const [name, args] of [
      ["read", { path: "/a/b.txt" }], ["bash", { command: "ls -la" }],
      ["grep", { pattern: "x", path: "/a" }], ["ls", { path: "/a" }],
    ]) {
      check(`${name} carries the rail`, plainText(row(name, args)).startsWith("▏") && plainText(row(name, args))[1] !== " ", row(name, args));
    }
    // tool head carries accent + bold
    for (const [name, args, head] of [
      ["read", { path: "/a/b.txt" }, "<b:accent>read </b>"],
      ["edit", { path: "/a/b.txt" }, "<b:accent>edit </b>"],
      ["write", { path: "/a/b.txt" }, "<b:accent>write </b>"],
      ["grep", { pattern: "x", path: "/a" }, "<b:accent>grep </b>"],
      ["find", { pattern: "*.ts", path: "/a" }, "<b:accent>find </b>"],
      ["ls", { path: "/a" }, "<b:accent>ls </b>"],
    ]) {
      check(`${name} head accent+bold`, row(name, args).includes(head), row(name, args));
    }
    // the specific target stays PLAIN: not bold, not dim
    check("edit base plain", row("edit", { path: "/a/b.txt" }).includes("</>b.txt") && !row("edit", { path: "/a/b.txt" }).includes("<b>b.txt"), row("edit", { path: "/a/b.txt" }));
    check("write base plain", row("write", { path: "/a/b.txt" }).includes("</>b.txt"), row("write", { path: "/a/b.txt" }));
    check("grep pattern plain", !row("grep", { pattern: "needle", path: "/a" }).includes("<b>needle"), row("grep", { pattern: "needle", path: "/a" }));
    // everything else dim: dir, range, timeout, size, generic summary
    check("read dir dim", row("read", { path: "/a/b.txt" }).includes("<dim>/a/</>"), row("read", { path: "/a/b.txt" }));
    check("read range dim", row("read", { path: "/a/b.txt", offset: 5, limit: 6 }).includes("<dim>:5-10</>"), row("read", { path: "/a/b.txt", offset: 5, limit: 6 }));
    check("bash timeout dim", row("bash", { command: "ls", timeout: 25 }).includes("<dim> (timeout 25s)</>"), row("bash", { command: "ls", timeout: 25 }));
    check("size dim", row("bash", { command: "ls" }, { count: 1200 }).includes("<dim>1.2k ch</>"), row("bash", { command: "ls" }, { count: 1200 }));
    const custom = globalThis.__collapseWrapTool;
    const wrapped = custom({ name: "mcp_thing", parameters: {}, async execute() {} });
    const { ctx: cctx } = callContext({ args: { query: "find the thing" }, toolCallId: "fmt-custom" });
    const customRow = wrapped.renderCall(cctx.args, theme, { ...cctx, args: { query: "find the thing" } }).render(100)[0];
    check("generic summary dim", customRow.includes("<dim>find the thing</>"), customRow);
  }

  // 65. bash token grammar: prompt accent, command words bold, path leaves
  // plain, syntax/flags/numbers/dirs dim.
  {
    const row = (name, args) => {
      resetTrace();
      const tool = piW.tools.get(name);
      const { ctx } = callContext({ args, toolCallId: `bash-${name}-${args.command ?? ""}` });
      return tool.renderCall(ctx.args, theme, { ...ctx, args }).render(400)[0];
    };
    const A = "<dim>▏</><b:accent>$</b>";
    const PS = "<dim>▏</><b:accent>PS></b>";
    check(
      "bash chain styles each part",
      row("bash", { command: "cd /path/to/thing && cat > /tmp/real/thing | tail -n 3" }) ===
        `${A} <b>cd</b> <dim>/path/to/</>thing <dim>&&</> <b>cat</b> <dim>></> <dim>/tmp/real/</>thing <dim>|</> <b>tail</b> <dim>-n</> <dim>3</>`,
      row("bash", { command: "cd /path/to/thing && cat > /tmp/real/thing | tail -n 3" }),
    );
    check(
      "bash args stay plain, flags dim",
      row("bash", { command: "npm test -- --watch=false" }) === `${A} <b>npm</b> test <dim>--</> <dim>--watch=false</>`,
      row("bash", { command: "npm test -- --watch=false" }),
    );
    check(
      "bash assignment name accent, value dim",
      row("bash", { command: "PIN=/x ls /y" }) === `${A} <b:accent>PIN</b><dim>=/x</> <b>ls</b> <dim>/</>y`,
      row("bash", { command: "PIN=/x ls /y" }),
    );
    check(
      "bash quoted argument keeps quotes dim",
      row("bash", { command: 'echo "hello world" > /tmp/out/thing.txt' }) ===
        `${A} <b>echo</b> <dim>"</>hello world<dim>"</> <dim>></> <dim>/tmp/out/</>thing.txt`,
      row("bash", { command: 'echo "hello world" > /tmp/out/thing.txt' }),
    );
    check(
      "bash url stays one plain token",
      row("bash", { command: "curl https://api.example.com/v1/x" }) === `${A} <b>curl</b> https://api.example.com/v1/x`,
      row("bash", { command: "curl https://api.example.com/v1/x" }),
    );
    check(
      "bash redirect fd and target",
      row("bash", { command: "make 2>/dev/null" }) === `${A} <b>make</b> <dim>2></><dim>/dev/</>null`,
      row("bash", { command: "make 2>/dev/null" }),
    );
    check(
      "powershell prompt and pipeline",
      row("powershell", { command: "Get-ChildItem | Select-Object Name" }) ===
        `${PS} <b>Get-ChildItem</b> <dim>|</> <b>Select-Object</b> Name`,
      row("powershell", { command: "Get-ChildItem | Select-Object Name" }),
    );
    check("bash empty command dim ellipsis", row("bash", { command: "   " }) === `${A} <dim>…</>` , row("bash", { command: "   " }));
    check("bash keeps timeout hint dim", row("bash", { command: "ls", timeout: 25 }).endsWith("<dim> (timeout 25s)</>"), row("bash", { command: "ls", timeout: 25 }));
  }

  // 66. resize relabels: a label built for a wider terminal must be rebuilt
  // when the terminal narrows, otherwise Text word-wraps the count.
  {
    const mod = await jiti.import(path.join(HERE, "index.ts"));
    resetTrace = mod.resetTraceState ?? resetTrace;
    const handlers = new Map();
    const piL = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
      getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }),
    };
    (mod.default ?? mod)(piL);
    const widgets = new Map();
    const ui = { setWidget: (k, f) => widgets.set(k, f), setHiddenThinkingLabel: () => { throw new Error("global setter must not be called"); } };
    await handlers.get("session_start")[0]({}, { hasUI: true, ui, sessionManager: { getEntries: () => [] } });
    const message = { role: "assistant", content: [{ type: "thinking", thinking: "word ".repeat(400) }] };
    const row = {
      lastMessage: message,
      hiddenThinkingLabel: "Thinking...",
      updateContent() {},
      setHiddenThinkingLabel(v) { this.hiddenThinkingLabel = v; },
    };
    for (const factory of widgets.values()) factory({ children: [row] }, {});
    const setColumns = (value) => Object.defineProperty(process.stdout, "columns", { value, configurable: true, writable: true });
    const visibleLen = (label) => label.replace(/\x1b\[[0-9;]*m/g, "").length;
    try {
      setColumns(120);
      await handlers.get("message_end")[0]({ message }, { hasUI: true, ui });
      const wide = row.hiddenThinkingLabel;
      check("wide label sized to terminal", visibleLen(wide) === 117, `${visibleLen(wide)}`);
      setColumns(80);
      await handlers.get("message_end")[0]({ message }, { hasUI: true, ui });
      const narrow = row.hiddenThinkingLabel;
      check("resize rebuilds label", visibleLen(narrow) === 77, `${visibleLen(narrow)} vs ${visibleLen(wide)}`);
      check("resize keeps the count", narrow.endsWith("\x1b[23;23m2.0k ch"), JSON.stringify(narrow.slice(-20)));
    } finally {
      delete process.stdout.columns;
    }
  }

  // 67. one width source: the thinking label is sized from
  // process.stdout.columns, so tool counts must end on that same column even
  // when the row is rendered one column narrower (Pi's chat does that).
  {
    const logicLib = await jiti.import(path.join(HERE, "logic.ts"));
    const tuiLib = await jiti.import("@earendil-works/pi-tui");
    // Own activation per pad: the shared-trace owner decides which instance
    // renders, and the row's pad comes from the same settings the label uses.
    const activation = async (pad) => {
      const mod = await jiti.import(path.join(HERE, "index.ts"));
      const pi = { registerTool: (t) => pi.tools.set(t.name, t), tools: new Map(), registerCommand: () => {}, on: () => {},
        getSettings: () => ({ outputPad: pad, hideThinkingBlock: true }) };
      (mod.default ?? mod)(pi);
      return { pi, reset: mod.resetTraceState ?? (() => {}) };
    };
    const setColumns = (value) => Object.defineProperty(process.stdout, "columns", { value, configurable: true, writable: true });
    const end = (line) => plainText(line).replace(/\s+$/, "").length;
    const labelEnd = (cols, pad) => {
      const label = logicLib.thinkingLabelForWidth("word ".repeat(400), cols, pad);
      return pad + plainText(label).length;
    };
    try {
      for (const pad of [1, 0]) {
        const { pi: piE, reset: resetE } = await activation(pad);
        for (const [cols, renderWidth] of [[100, 100], [100, 99], [80, 80], [80, 79]]) {
        setColumns(cols);
        resetE();
        const tool = piE.tools.get("bash");
        const { ctx } = callContext({ args: { command: "ls" }, toolCallId: `edge-${cols}-${renderWidth}-${pad}`, state: { count: 5300 } });
        const line = tool.renderCall(ctx.args, ansiTheme, { ...ctx, args: { command: "ls" } }).render(renderWidth)[0];
        const expected = labelEnd(cols, pad);
        check(
          `count column matches thinking at cols=${cols} render=${renderWidth} pad=${pad}`,
          end(line) === expected,
          `tool ends ${end(line)}, label ends ${expected}, line width ${tuiLib.visibleWidth(line)} vs ${renderWidth}`,
        );
        check(`row fits render width at cols=${cols} render=${renderWidth} pad=${pad}`, tuiLib.visibleWidth(line) <= renderWidth, `${tuiLib.visibleWidth(line)} > ${renderWidth}`);
        }
      }
    } finally {
      delete process.stdout.columns;
    }
  }


// ---------------------------------------------------------------------------
// 68. The run rail: column 1 marks a tool run without moving the content.
// ---------------------------------------------------------------------------
{
  const RAIL = "▏";
  const rowsLib = await jiti.import(path.join(HERE, "rows.ts"));
  const tuiLib = await jiti.import("@earendil-works/pi-tui");
  const { CollapsedLine } = rowsLib;
  check("rows.ts exports CollapsedLine", typeof CollapsedLine === "function");

  const before = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", { value: 60, configurable: true, writable: true });
  // Real escapes for width math: marker tags would count as visible text.
  const LEFT = ansiTheme.fg("accent", "$ ls");
  const RIGHT = ansiTheme.fg("dim", "1.0k ch");
  const line = (opts) => new CollapsedLine(LEFT, RIGHT, opts.pad ?? 1, ansiTheme, opts.rail ?? true).render(60)[0];
  const dimRail = ansiTheme.fg("dim", RAIL);

  const tool = line({});
  check("tool row opens with the dim rail", tool.startsWith(dimRail), JSON.stringify(tool.slice(0, 24)));
  check("rail is one cell and content starts on column 2",
    tuiLib.visibleWidth(tool.slice(0, tool.indexOf("$"))) === 1 && plainText(tool).indexOf("$") === 1,
    JSON.stringify(plainText(tool).slice(0, 8)));
  check("rail keeps the row at the label column", tuiLib.visibleWidth(tool) === 58 && 58 <= 60, `${tuiLib.visibleWidth(tool)}`);
  check("count still ends one column inside the edge",
    plainText(tool).replace(/\s+$/, "").length === 58, `${plainText(tool).replace(/\s+$/, "").length}`);


  const noPad = line({ pad: 0 });
  check("no pad: no rail, content on column 1", !plainText(noPad).includes(RAIL) && plainText(noPad).startsWith("$"), JSON.stringify(plainText(noPad).slice(0, 6)));

  const plainRow = new CollapsedLine("<accent>$</><b>ls</b>", "<dim>1.0k ch</>", 1).render(60)[0];
  check("theme-less row still gets the rail glyph", plainText(plainRow).startsWith(RAIL));

  if (before === undefined) delete process.stdout.columns;
  else Object.defineProperty(process.stdout, "columns", { value: before, configurable: true, writable: true });
}


// ---------------------------------------------------------------------------
// 69. Thinking rows carry the same rail, by replacing Pi's pad cell.
// ---------------------------------------------------------------------------
{
  const labelsLib = await jiti.import(path.join(HERE, "labels.ts"));
  const tuiLib = await jiti.import("@earendil-works/pi-tui");
  check("labels.ts exports the row-rail installer", typeof labelsLib.installRowRail === "function");

  // Pi's Text: pad spaces, then the italic+fg styled label, padded to width.
  const STYLE = "\x1b[3m\x1b[38;5;240m";
  const RESET = "\x1b[0m";
  const text = "weigh the options ".repeat(40);
  const rowOf = (opts = {}) => {
    const row = {
      lastMessage: { role: "assistant", content: opts.content ?? [{ type: "thinking", thinking: text }] },
      hiddenThinkingLabel: "",
      renderLabel: undefined,
      isStreaming: false,
      outputPad: opts.pad ?? 1,
      setHiddenThinkingLabel(label) { row.hiddenThinkingLabel = label; },
      updateContent() {},
      render(width) {
        const label = row.renderLabel ?? row.hiddenThinkingLabel;
        // Pi writes OSC 133 marks around parts; the label row carries them.
        const line = "\x1b]133;B\x07\x1b]133;C\x07" + " ".repeat(row.outputPad) + STYLE + label + RESET;
        const bare = label.replace("\x1b[23;23m", "");
        const same = " ".repeat(row.outputPad) + STYLE + bare + RESET;
        const padTo = (text) => text + " ".repeat(Math.max(0, width - tuiLib.visibleWidth(text)));
        // A lookalike with the same VISIBLE text but without the label's own
        // escape is a different line; only the label may be railed.
        const lookalike = padTo(same);
        return opts.lookalikeFirst
          ? [" plain prose line", lookalike, padTo(line)]
          : [" plain prose line", padTo(line), lookalike];
      },
    };
    return row;
  };

  const before = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true, writable: true });
  const pi = { getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }) };
  const fresh = async (rows) => {
    const module = await jiti.import(path.join(HERE, "labels.ts"));
    module.captureWalkerTui({ children: rows });
    return module;
  };

  {
    const row = rowOf();
    const module = await fresh([row]);
    module.reconcileThinkingLabels(pi);
    check("walker labeled the row", row.hiddenThinkingLabel.length > 0, JSON.stringify(row.hiddenThinkingLabel));
    const lines = row.render(100);
    const visible = plainText(lines[1]);
    check("thinking row opens with the rail", visible.startsWith("▏"), JSON.stringify(visible.slice(0, 6)));
    check("rail sits on column 1, label still starts on column 2",
      tuiLib.visibleWidth(lines[1].slice(0, lines[1].indexOf("w"))) === 1 && visible.indexOf("w") === 1,
      JSON.stringify(visible.slice(0, 6)));
    check("OSC marks survive the rail", lines[1].includes("\x1b]133;B\x07\x1b]133;C\x07".slice(0, 7)) && lines[1].indexOf("\x1b]133;C\x07") < lines[1].indexOf("▏"), JSON.stringify(lines[1].slice(0, 20)));
    check("rail reuses the row's own style", lines[1].includes(STYLE + "▏" + RESET + STYLE), JSON.stringify(lines[1].slice(0, 40)));
    check("thinking row keeps its width", tuiLib.visibleWidth(lines[1]) === 100, `${tuiLib.visibleWidth(lines[1])}`);
    check("thinking count still ends on the label column", visible.trimEnd().length === 98, `${visible.trimEnd().length}`);
    check("prose lines are untouched", lines[0] === " plain prose line", JSON.stringify(lines[0]));
    check("only the label line is railed", !plainText(lines[2]).includes("▏") && plainText(lines[2]).trimEnd().length === 98, JSON.stringify(plainText(lines[2]).slice(0, 8)));
  }

  {
    // Prose that repeats the preview verbatim is not the label row: the
    // label carries its own escape (italic-off), a copy does not.
    const row = rowOf({ lookalikeFirst: true });
    const module = await fresh([row]);
    module.reconcileThinkingLabels(pi);
    const lines = row.render(100);
    check("lookalike with the same visible text is not railed", !plainText(lines[1]).includes("▏"), JSON.stringify(plainText(lines[1]).slice(0, 8)));
    check("the real label is still railed after it", plainText(lines[2]).startsWith("▏"), JSON.stringify(plainText(lines[2]).slice(0, 6)));
  }

  {
    const row = rowOf();
    const module = await fresh([row]);
    module.reconcileThinkingLabels(pi);
    module.reconcileThinkingLabels(pi);
    check("second pass keeps one rail", plainText(row.render(100)[1]).split("▏").length === 2, JSON.stringify(plainText(row.render(100)[1]).slice(0, 8)));
  }

  {
    // pad 2: rail in the first cell, one pad cell left, label on column 3.
    const row = rowOf({ pad: 2 });
    const module = await fresh([row]);
    module.reconcileThinkingLabels({ getSettings: () => ({ outputPad: 2, hideThinkingBlock: true }) });
    const line = row.render(100)[1];
    const text = plainText(line);
    check("pad 2 rails the first cell only", text.startsWith("▏ w") && tuiLib.visibleWidth(line) === 100, JSON.stringify(text.slice(0, 8)));
  }

  {
    const row = rowOf();
    const module = await fresh([row]);
    module.reconcileThinkingLabels(pi);
    const label = row.hiddenThinkingLabel;
    row.renderLabel = "a different label";
    check("mismatched line falls back to stock",
      !plainText(row.render(100)[1]).includes("▏") && row.render(100)[1].includes("a different label"),
      JSON.stringify(plainText(row.render(100)[1]).slice(0, 8)));
    row.renderLabel = undefined;
    row.hiddenThinkingLabel = label;
  }

  {
    // Toggling thinking visible must drop the rail on the next render.
    const settings = { outputPad: 1, hideThinkingBlock: true };
    const livePi = { getSettings: () => settings };
    const row = rowOf();
    const module = await fresh([row]);
    module.reconcileThinkingLabels(livePi);
    check("hidden thinking has the rail", plainText(row.render(100)[1]).startsWith("▏"), JSON.stringify(plainText(row.render(100)[1]).slice(0, 6)));
    settings.hideThinkingBlock = false;
    check("visible thinking has no rail", !plainText(row.render(100)[1]).includes("▏"), JSON.stringify(plainText(row.render(100)[1]).slice(0, 8)));
  }

  {
    const row = rowOf({ pad: 0 });
    const module = await fresh([row]);
    row.hiddenThinkingLabel = "some label";
    module.installRowRail(row, { getSettings: () => ({ outputPad: 0, hideThinkingBlock: true }) });
    check("pad 0 keeps the stock row", !plainText(row.render(100)[1]).includes("▏"), JSON.stringify(plainText(row.render(100)[1]).slice(0, 8)));
  }

  {
    // Streaming: the shadow reads the label live, so a new preview re-rails.
    const row = rowOf();
    const module = await fresh([row]);
    row.isStreaming = true;
    module.reconcileStreamingLabel(pi, undefined, Date.now() + 1000);
    check("streaming row is labeled", row.hiddenThinkingLabel.length > 0, JSON.stringify(row.hiddenThinkingLabel));
    check("streaming row carries the rail", plainText(row.render(100)[1]).startsWith("▏"), JSON.stringify(plainText(row.render(100)[1]).slice(0, 6)));
  }

  if (before === undefined) delete process.stdout.columns;
  else Object.defineProperty(process.stdout, "columns", { value: before, configurable: true, writable: true });
}


// ---------------------------------------------------------------------------
// 70. A resize relabels in the frame it lands, without rebuilding the message.
// ---------------------------------------------------------------------------
{
  const labelsLib = await jiti.import(path.join(HERE, "labels.ts"));
  const tuiLib = await jiti.import("@earendil-works/pi-tui");
  const logicLib = await jiti.import(path.join(HERE, "logic.ts"));
  const STYLE = "\x1b[3m\x1b[38;5;240m";
  const RESET = "\x1b[0m";
  const text = "weigh the options ".repeat(200);

  // Pi's row: contentContainer -> MouseRegion -> Text(label). The double
  // rebuilds its label Texts only through Pi's setter, which is what a
  // resize must not have to do.
  const rowOf = (opts = {}) => {
    const spy = { updates: 0, sets: 0, writes: 0 };
    const texts = [];
    const children = [{ child: { render: () => ["prose"] } }]; // a prose child
    for (let i = 0; i < (opts.runs ?? 1); i++) {
      const node = {
        text: STYLE + "Thinking..." + RESET,
        setText(next) { this.text = next; spy.writes++; },
      };
      texts.push(node);
      children.push({ child: node });
    }
    const row = {
      lastMessage: { role: "assistant", content: [{ type: "thinking", thinking: text }] },
      hiddenThinkingLabel: "Thinking...",
      outputPad: 1,
      contentContainer: opts.noContainer ? undefined : { children },
      isStreaming: false,
      updateContent() { spy.updates++; },
      setHiddenThinkingLabel(label) { row.hiddenThinkingLabel = label; spy.sets++; row.updateContent(); },
      render(width) {
        const styled = STYLE + row.hiddenThinkingLabel + RESET;
        const padTo = (t) => t + " ".repeat(Math.max(0, width - tuiLib.visibleWidth(t)));
        return [" prose line", padTo(" " + styled), ...texts.slice(1).map((n) => padTo(" " + n.text))];
      },
    };
    return { row, spy, texts };
  };

  const before = process.stdout.columns;
  const setCols = (n) => Object.defineProperty(process.stdout, "columns", { value: n, configurable: true, writable: true });
  const pi = { getSettings: () => ({ outputPad: 1, hideThinkingBlock: true }) };
  const fresh = async (rows) => {
    const module = await jiti.import(path.join(HERE, "labels.ts"));
    module.captureWalkerTui({ children: rows });
    return module;
  };

  {
    const { row, spy, texts: ts } = rowOf();
    const module = await fresh([row]);
    setCols(100);
    module.reconcileThinkingLabels(pi);
    check("first label is written in place (no message rebuild)", spy.updates === 0 && spy.sets === 0, "updates=" + spy.updates + " sets=" + spy.sets);
    check("label wrapper survives the in-place write", ts[0].text.startsWith(STYLE) && ts[0].text.endsWith(RESET), JSON.stringify(ts[0].text.slice(0, 12)));

    const wide = ts[0].text;
    setCols(80);
    const line = row.render(80)[1];
    const visible = plainText(line);
    check("the resize frame already carries the narrow label", visible.trimEnd().length === 78 && tuiLib.visibleWidth(line) === 80, String(visible.trimEnd().length));
    check("the narrow label was written in place, no rebuild", spy.updates === 0 && ts[0].text !== wide, "updates=" + spy.updates);
    check("narrow label matches the width math", ts[0].text.includes(logicLib.thinkingLabelForWidth(text, 80, 1)), JSON.stringify(plainText(ts[0].text).slice(-12)));
    check("rail still lands on the resized row", visible.startsWith("▏"), JSON.stringify(visible.slice(0, 6)));

    const writes = spy.writes;
    row.render(80);
    check("same width does not rewrite the label", spy.writes === writes, spy.writes + " vs " + writes);
  }

  {
    // Every thinking run in a message shares the label: patch them all.
    const { row, spy, texts: ts } = rowOf({ runs: 2 });
    const module = await fresh([row]);
    setCols(100);
    module.reconcileThinkingLabels(pi);
    check("every hidden-label run is patched", ts.every((t) => t.text.includes(row.hiddenThinkingLabel)) && spy.updates === 0, JSON.stringify(ts.map((t) => plainText(t.text).length)));
  }

  {
    // Unexpected shape: fall back to Pi's setter rather than losing the label.
    const { row, spy } = rowOf({ noContainer: true });
    const module = await fresh([row]);
    setCols(100);
    module.reconcileThinkingLabels(pi);
    check("unknown row shape falls back to setHiddenThinkingLabel", spy.sets === 1 && row.hiddenThinkingLabel.length > 0, "sets=" + spy.sets);
  }

  {
    // Streaming labels take the same in-place path.
    const { row, spy } = rowOf();
    const module = await fresh([row]);
    setCols(100);
    row.isStreaming = true;
    module.reconcileStreamingLabel(pi, undefined, Date.now() + 1000);
    check("streaming label is written in place", row.hiddenThinkingLabel.length > 0 && spy.updates === 0, "updates=" + spy.updates);
  }

  if (before === undefined) delete process.stdout.columns;
  else Object.defineProperty(process.stdout, "columns", { value: before, configurable: true, writable: true });
}


// ---------------------------------------------------------------------------
// 71. Args change detection is bounded: a megabyte of streaming content must
//     not be re-serialized on every delta.
// ---------------------------------------------------------------------------
{
  const traceLib = await jiti.import(path.join(HERE, "trace.ts"));
  traceLib.resetTraceState();
  const def = { name: "write", renderCall: () => null, renderResult: () => null };
  const ctx = { isError: false, isPartial: true, executionStarted: true, argsComplete: false, state: {} };
  const entryOf = (id) => traceLib.traceUpsert("write", id, def);

  {
    const entry = entryOf("small");
    const first = { path: "/a/b.txt", offset: 1 };
    check("first small args are a change", traceLib.traceSync(entry, first, ctx) === true, "first");
    check("same args object is not a change", traceLib.traceSync(entry, first, ctx) === false, "identity");
    check("changed small args are a change", traceLib.traceSync(entry, { path: "/a/b.txt", offset: 2 }, ctx) === true, "content");
  }

  {
    // Large args: the row shows a head and a tail, so those decide a repaint.
    const entry = entryOf("large");
    const content = "x".repeat(200000);
    traceLib.traceSync(entry, { path: "/a/big", content }, ctx);
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) traceLib.traceSync(entry, { path: "/a/big", content }, ctx);
    const ms = (Date.now() - t0) / 100;
    check("large unchanged args are cheap and not a change", ms < 0.1 && traceLib.traceSync(entry, { path: "/a/big", content }, ctx) === false, ms.toFixed(4) + "ms");
    check("a different tail is a change", traceLib.traceSync(entry, { path: "/a/big", content: content + "y" }, ctx) === true, "tail");
    check("a different head is a change", traceLib.traceSync(entry, { path: "/a/big", content: "y" + content.slice(1) }, ctx) === true, "head");
    // Re-adopt the baseline first: the head check above changed the head.
    traceLib.traceSync(entry, { path: "/a/big", content }, ctx);
    check("a middle-only change is not (it cannot show)", traceLib.traceSync(entry, { path: "/a/big", content: "x".repeat(100000) + "y" + "x".repeat(99999) }, ctx) === false, "middle");
  }
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
