// Headless Pi replay driver: real components, scripted transcripts.
//
// The driver mounts the REAL AssistantMessageComponent /
// UserMessageComponent classes and the extension's own wrapped tools,
// feeds them a scripted transcript (ops), and screenshots the chat with
// component.render(width) — no terminal, no mocks. Phases mirror a real
// session: restore (session restore / initial history render) → live ops
// (streaming messages, tool calls, results, turns) → reload (rebuild from
// the same entries, like /reload).
//
// Persistence timing mirrors Pi's SessionManager: entries land at
// message_end, so the extension's message_end handler always sees them
// (settled), while streaming passes see them unpersisted (live).
//
// Op language (fixtures/*.json):
//   {op:"user", text}                  user message
//   {op:"start", id}                   assistant message_start (mounts row)
//   {op:"thinking"|"text", id, text}    append block + message_update
//   {op:"tool", id, toolId, name, args} append toolCall + mount owner comp
//   {op:"end", id, stop}                persist entry + message_end
//   {op:"result", toolId, text}         tool result (syncs trace, remounts)
//   {op:"turn"}                         turn_end
//   {op:"tick"}                         the 1s poll (detach + wrap + labels)
//   {op:"reload"}                       rebuild chat from entries + session_start
//   {op:"toggle"}                       flip hideThinkingBlock (poll picks it up)
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

function findPiRoot() {
  if (process.env.PI_ROOT) return process.env.PI_ROOT;
  try {
    const version = fs.readFileSync(path.join(process.env.HOME, ".pi/agent/install/current-version"), "utf8").trim();
    const root = path.join(process.env.HOME, ".pi/agent/install/releases", version,
      "node_modules/@earendil-works/pi-coding-agent");
    if (fs.existsSync(path.join(root, "dist", "bundle", "index.js"))) return root;
  } catch { /* legacy layout */ }
  const real = fs.realpathSync(execSync("command -v pi", { encoding: "utf8" }).trim());
  return path.resolve(path.dirname(real), "..", "..");
}

const PI = findPiRoot();
const PIN = path.join(PI, "node_modules");
const HERE = path.join(__dirname, "..");
let jiti;

async function loadPi() {
  if (!jiti) {
    ({ createJiti } = require(path.join(PIN, "jiti")));
    jiti = createJiti(__filename, {
      interopDefault: true,
      fsCache: true,
      moduleCache: false,
      alias: {
        "@earendil-works/pi-coding-agent": path.join(PI, "dist", "bundle", "index.js"),
        "@earendil-works/pi-tui": path.join(PIN, "@earendil-works", "pi-tui", "dist", "index.js"),
        typebox: require.resolve("typebox", { paths: [PI] }),
      },
    });
  }
  const mod = await jiti.import(path.join(HERE, "index.ts"));
  const agent = await jiti.import("@earendil-works/pi-coding-agent");
  const tui = await jiti.import("@earendil-works/pi-tui");
  agent.initTheme("light");
  const compDir = path.join(PI, "dist", "modes", "interactive", "components");
  const { AssistantMessageComponent } = await import(path.join(compDir, "assistant-message.js"));
  const { UserMessageComponent } = await import(path.join(compDir, "user-message.js"));
  const mdTheme = agent.getMarkdownTheme();
  // Marker theme (same as unit tests): deterministic, stripped by dump().
  const theme = {
    fg: (color, text) => `<${color}>${text}</>`,
    bg: (color, text) => `<bg:${color}>${text}</>`,
    bold: (text) => `<b>${text}</b>`,
    italic: (text) => `<i>${text}</i>`,
    style: (text) => `<b>${text}</b>`,
  };
  return { mod, agent, tui, AssistantMessageComponent, UserMessageComponent, mdTheme, theme };
}

function resetAll(mod) {
  for (const fn of ["resetTraceState", "resetDetachState", "resetLabelsState", "resetWrapState", "resetRowsState"]) {
    try { mod[fn]?.(); } catch {}
  }
  try { mod.captureWalkerTui?.({ children: [] }); } catch {}
}

function createWorld(PIloaded, { width = 100, hideThinkingBlock = true } = {}) {
  const { mod, tui } = PIloaded;
  resetAll(mod);
  const tools = new Map(), handlers = new Map();
  const settings = { outputPad: 1, hideThinkingBlock };
  const pi = {
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: () => {},
    on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
    getSettings: () => settings,
  };
  (mod.default ?? mod)(pi);
  const chat = new tui.Container();
  mod.captureWalkerTui({ children: [chat] });
  const entries = [];
  const sm = { getEntries: () => entries };
  const ui = {
    setWidget: () => {},
    setHiddenThinkingLabel: () => {},
    requestRender: () => {},
    notify: () => {},
  };
  const world = {
    PI: PIloaded, mod, pi, tools, handlers, settings, chat, entries, sm, ui,
    width, messages: new Map(), assistantComps: new Map(), toolComps: new Map(),
  };
  const fire = async (event, data = {}, ctx = {}) => {
    for (const h of handlers.get(event) ?? []) await h(data, ctx);
  };
  world.fire = fire;
  return world;
}

// One production poll tick (settle plan, detach, wrap, relabel), run to
// convergence: the first detach often vetoes on the stock label, the
// relabel fixes it, the next detach lands. Mirrors multi-poll healing.
function ticks(world, n = 3) {
  for (let i = 0; i < n; i++) {
    try { world.mod.collapseTick(world.pi); } catch {}
  }
}

const msgId = (() => { let n = 0; return (p) => `${p ?? "m"}-${++n}`; })();

function ctxFor(toolCallId, args, partial) {
  return {
    args, toolCallId,
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: !partial,
    isPartial: !!partial,
    expanded: false,
    showImages: true,
    isError: false,
  };
}

function userText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}

function mountAssistant(world, message, entryId) {
  const { AssistantMessageComponent, mdTheme } = world.PI;
  const comp = new AssistantMessageComponent(
    message, world.settings.hideThinkingBlock, mdTheme, "Thinking...", 1, [],
    entryId, message?.timestamp ?? Date.now());
  world.chat.addChild(comp);
  return comp;
}

function mountTool(world, name, toolCallId, args, partial) {
  const tool = world.tools.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  // Production fidelity: ToolExecutionComponent.invalidate() calls
  // updateDisplay(), which re-invokes renderCall (remount) and repaints.
  // A stale screenshot after a poll/click would hide real bugs, so the
  // driver must do the same.
  const ctx = ctxFor(toolCallId, args, partial);
  ctx.invalidate = () => refreshTool(world, toolCallId);
  const inner = tool.renderCall(args, world.PI.theme, ctx);
  // Pi mounts a ToolExecutionComponent, not the renderer's component:
  // for the `self` shell it pushes a separator blank and delegates, and the
  // extension's render wrap then strips that blank when the block glues to
  // the row above. Emulate both, or spacing in the dump is fiction.
  const node = {
    toolCallId,
    getRenderShell: () => "self",
    handleMouse: () => undefined,
    invalidate() { ctx.invalidate(); },
    render(width) {
      if (this.inner !== inner) this.inner = inner;
      const lines = inner.render(width);
      if (lines.length === 0) return lines;
      return ["", ...lines];
    },
    inner,
  };
  const prevOf = () => {
    const at = world.chat.children.indexOf(node);
    return at > 0 ? world.chat.children[at - 1] : undefined;
  };
  try { world.mod.wrapToolComponent?.(node, world.pi, prevOf); } catch {}
  world.chat.addChild(node);
  world.toolComps.set(toolCallId, { comp: node, inner, ctx, name });
  return node;
}

function refreshTool(world, toolCallId) {
  // What Pi does inside invalidate() -> updateDisplay(): re-invoke
  // renderCall and swap the mounted component.
  const slot = world.toolComps.get(toolCallId);
  if (!slot) return;
  const tool = world.tools.get(slot.name);
  slot.inner = tool.renderCall(slot.ctx.args, world.PI.theme, slot.ctx);
  return slot.comp;
}

// Restore: entries load BEFORE session_start (production order — the
// manager already holds them), then mount every entry oldest-first,
// then converge over several poll ticks.
function mountEntries(world, entries) {
  for (const entry of entries) {
    const message = entry?.message;
    if (!message || typeof message !== "object") continue;
    if (entry.type !== "message" && entry.type !== undefined) continue;
    if (message.role === "assistant") {
      const comp = mountAssistant(world, message, entry.id);
      comp.updateContent(message, false);
      world.assistantComps.set(entry.id ?? msgId("e"), comp);
      for (const block of message.content ?? []) {
        if (block?.type === "toolCall") {
          const rendered = mountTool(world, block.name, block.id, block.arguments ?? {});
          void rendered;
        }
      }
    } else if (message.role === "user") {
      const comp = new world.PI.UserMessageComponent(
        userText(message.content), world.PI.mdTheme, 1, [], entry.id, message.timestamp ?? Date.now());
      world.chat.addChild(comp);
    } else if (message.role === "toolResult") {
      const slot = world.toolComps.get(message.toolCallId);
      if (slot) {
        const tool = world.tools.get(slot.name);
        tool.renderResult?.({ content: message.content ?? [] }, { isPartial: false }, world.PI.theme, slot.ctx);
        refreshTool(world, message.toolCallId);
      }
    }
    // custom/system entries: no mounted row in v1 (entries still gate
    // segments); compaction/usage/branch rows mount nothing either.
  }
}

async function restore(world, entries) {
  for (const entry of entries) world.entries.push(entry);
  await world.fire("session_start", {}, { hasUI: true, ui: world.ui, sessionManager: world.sm });
  mountEntries(world, entries);
  ticks(world);
}

// Restore variant for `pi -r`: history mounts BEFORE session_start (the
// registry is non-empty when the event lands, so the start seals instead
// of arming). Same converge after.
async function restoreLate(world, entries) {
  for (const entry of entries) world.entries.push(entry);
  mountEntries(world, entries);
  await world.fire("session_start", {}, { hasUI: true, ui: world.ui, sessionManager: world.sm });
  ticks(world);
}

async function runLive(world, ops) {
  for (const op of ops) {
    if (op.op === "user") {
      const message = { role: "user", content: [{ type: "text", text: op.text }] };
      const comp = new world.PI.UserMessageComponent(
        op.text, world.PI.mdTheme, 1, [], msgId("u"), Date.now());
      world.chat.addChild(comp);
      world.entries.push({ id: msgId("e"), type: "message", message });
      await world.fire("message_start", { message }, {});
    } else if (op.op === "start") {
      const message = { role: "assistant", content: [] };
      world.messages.set(op.id, message);
      await world.fire("message_start", { message }, {});
      const comp = mountAssistant(world, undefined, msgId(op.id));
      world.assistantComps.set(op.id, comp);
    } else if (op.op === "thinking" || op.op === "text") {
      const message = world.messages.get(op.id);
      // Pi streams deltas into the same block; a new block starts only
      // after another kind intervened. Stacking a block per delta would
      // double the label text (the label joins a run's blocks).
      const blocks = message.content;
      const last = blocks[blocks.length - 1];
      if (op.op === "thinking" && last?.type === "thinking") last.thinking += op.text;
      else if (op.op === "text" && last?.type === "text") last.text += op.text;
      else blocks.push(op.op === "thinking"
        ? { type: "thinking", thinking: op.text }
        : { type: "text", text: op.text });
      await world.fire("message_update", { message }, {});
      world.assistantComps.get(op.id)?.updateContent(message, true);
    } else if (op.op === "tool") {
      const message = world.messages.get(op.id);
      message.content.push({ type: "toolCall", id: op.toolId, name: op.name, arguments: op.args ?? {} });
      await world.fire("message_update", { message }, {});
      world.assistantComps.get(op.id)?.updateContent(message, true);
      mountTool(world, op.name, op.toolId, op.args ?? {}, op.partial);
      await world.fire("tool_execution_start", { toolName: op.name, toolCallId: op.toolId, args: op.args ?? {} }, {});
    } else if (op.op === "end") {
      const message = world.messages.get(op.id);
      message.stopReason = op.stop ?? "stop";
      world.entries.push({ id: msgId("e"), type: "message", message });
      await world.fire("message_end", { message }, {});
      world.assistantComps.get(op.id)?.updateContent(message, false);
    } else if (op.op === "result") {
      const slot = world.toolComps.get(op.toolId);
      if (slot) {
        const tool = world.tools.get(slot.name);
        tool.renderResult?.({ content: [{ type: "text", text: op.text ?? "" }] },
          { isPartial: false }, world.PI.theme, slot.ctx);
        refreshTool(world, op.toolId);
      }
      world.entries.push({ id: msgId("e"), type: "message",
        message: { role: "toolResult", toolCallId: op.toolId, content: [{ type: "text", text: op.text ?? "" }] } });
    } else if (op.op === "turn") {
      await world.fire("turn_end", {}, {});
    } else if (op.op === "tick") {
      ticks(world);
    } else if (op.op === "reload") {
      await reload(world);
    } else if (op.op === "toggle") {
      world.settings.hideThinkingBlock = !world.settings.hideThinkingBlock;
      for (const comp of world.assistantComps.values()) {
        try { comp.setHideThinkingBlock(world.settings.hideThinkingBlock); } catch {}
      }
      ticks(world);
    } else {
      throw new Error(`unknown op: ${op.op}`);
    }
  }
}

// Reload: rebuild the chat from the same entries (like /reload), keeping
// extension module state — the remount must converge, not re-split.
async function reload(world) {
  world.chat.clear();
  world.mod.captureWalkerTui({ children: [world.chat] });
  world.assistantComps.clear();
  world.toolComps.clear();
  world.messages.clear();
  const entries = [...world.entries];
  world.entries.length = 0;
  await restore(world, entries);
}

const stripLine = (line) => String(line)
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-9;]*m/g, "")
  .replace(/<[^>]*>/g, "");

// The screenshot: every mounted child rendered at width, plain text.
function dump(world) {
  const lines = [];
  for (const child of world.chat.children) {
    try {
      for (const line of child.render(world.width)) lines.push(stripLine(line));
    } catch (e) {
      lines.push(`<render-error: ${e?.message ?? e}>`);
    }
  }
  return { lines, text: lines.join("\n"), diag: world.mod.detachDiag() };
}

function openRun(world, toolCallId) {
  // Click the header exactly like the TUI test helper does.
  const slot = world.toolComps.get(toolCallId);
  if (!slot) throw new Error(`no mounted tool: ${toolCallId}`);
  const comp = slot.inner;
  if (comp?.children?.length === 1) comp.children[0]?.onMouse?.({ type: "click", button: "left" });
  return comp;
}

// Production startup, un-converged: push history, fire session_start (which
// arms the deferred plan), mount history with the registry still empty, and
// leave the plan pending. The next poll (collapseTick) settles it — possibly
// mid-turn, which is exactly where a re-plan can scatter live runs.
async function armRestore(world, entries) {
  for (const entry of entries) world.entries.push(entry);
  await world.fire("session_start", {}, { hasUI: true, ui: world.ui, sessionManager: world.sm });
  mountEntries(world, entries);
}

function tickOnce(world) {
  try { world.mod.collapseTick(world.pi); } catch {}
}

module.exports = {
  loadPi, createWorld, restore, restoreLate, armRestore,
  runLive, reload, dump, openRun, tickOnce,
};
