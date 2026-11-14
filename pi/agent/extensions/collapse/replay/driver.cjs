// Headless Pi replay driver: real components, scripted transcripts.
//
// The driver mounts the REAL AssistantMessageComponent, UserMessageComponent,
// ToolExecutionComponent, and CustomMessageComponent classes and the
// extension's own wrapped tools. No terminal is needed. The host around them
// (chat container, event dispatch, SessionManager) is emulated, but the
// ordering it emulates is Pi's and is asserted in replay.test.cjs:
//
//   extension handlers -> interactive-mode/UI update -> appendMessage
//
// message_end therefore sees the branch BEFORE the message is persisted, and
// every streamed message is a shallow copy (as Pi's agent loop sends it).
// `/reload` builds a fresh extension module, not a reused one.
//
// Phases mirror a real session: restore (session restore / initial history
// render) -> live ops (streaming messages, tool calls, results, turns) ->
// reload (fresh module, rebuild from the same entries, like /reload).
//
// Op language (fixtures/*.json):
//   {op:"user", text, timestamp?}       user message_start + message_end
//   {op:"custom", text, customType?}    visible custom message row
//   {op:"start", id, timestamp?}        assistant message_start (mounts row)
//   {op:"thinking"|"text", id, text}    append block + message_update
//   {op:"tool", id, toolId, name, args} append toolCall + real tool host
//   {op:"end", id, stop, timestamp?, durationMs?} assistant message_end, then persist
//   {op:"abort", id, stop?}             abort branch (error results in UI)
//   {op:"result", toolId, text, timestamp?} tool_execution_end + toolResult events
//   {op:"turn"}                         turn_end
//   {op:"tick"}                         the 1s poll (detach + wrap + labels)
//   {op:"reload"}                       fresh module, rebuild + session_start
//   {op:"toggle"}                       flip hideThinkingBlock (poll picks it up)
const path = require("node:path");

const { PI, vreq } = require("../test-pi.cjs");
// Before 1.5.x the deps lived under the pi package; afterwards npm hoists them
// to the release root. Resolve through Node so both layouts work.
const HERE = path.join(__dirname, "..");
let jiti;

async function loadPi() {
  if (!jiti) {
    ({ createJiti } = require(vreq("jiti")));
    jiti = createJiti(__filename, {
      interopDefault: true,
      fsCache: true,
      moduleCache: false,
      alias: {
        "@earendil-works/pi-coding-agent": path.join(PI, "dist", "bundle", "index.js"),
        "@earendil-works/pi-tui": vreq("@earendil-works/pi-tui"),
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
  const { ToolExecutionComponent } = await import(path.join(compDir, "tool-execution.js"));
  const { CustomMessageComponent } = await import(path.join(compDir, "custom-message.js"));
  const mdTheme = agent.getMarkdownTheme();
  // Real ANSI, like Pi's live theme. The unit tests use a marker theme
  // because they assert styling directly; here the screenshots must have
  // real layout. Marker tags count as visible characters in visibleWidth(),
  // so a marker theme silently narrows every row and exaggerates truncation
  // — screenshots then differ from the terminal for a reason that is not the
  // extension. dump() strips the escapes.
  const theme = {
    fg: (_color, text) => `\x1b[38;5;240m${text}\x1b[39m`,
    bg: (_color, text) => `\x1b[48;5;240m${text}\x1b[49m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    italic: (text) => `\x1b[3m${text}\x1b[23m`,
    style: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  return {
    mod, agent, tui, AssistantMessageComponent, UserMessageComponent,
    ToolExecutionComponent, CustomMessageComponent, mdTheme, theme,
  };
}

function resetAll(mod) {
  for (const fn of ["resetTraceState", "resetDetachState", "resetLabelsState", "resetWrapState", "resetRowsState"]) {
    try { mod[fn]?.(); } catch {}
  }
  try { mod.captureWalkerTui?.({ children: [] }); } catch {}
}

function createWorld(PIloaded, { width = 100, hideThinkingBlock = true, clock } = {}) {
  const { mod, tui } = PIloaded;
  resetAll(mod);
  // Production modules start in the history phase (see trace.ts). The
  // test reset leaves it live for unit tests; restore this before mounting
  // history so `pi -r`'s mount-before-session_start path is not timed from
  // the wall clock.
  try { mod.armHistoryPhase?.("driver-reset"); } catch {}
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
  const sm = {
    getEntries: () => entries,
    getBranch: () => entries,
    buildContextEntries: () => entries,
  };
  const ui = {
    setWidget: () => {},
    setHiddenThinkingLabel: () => {},
    requestRender: () => {},
    notify: () => {},
  };
  const events = [];
  const messageCopies = [];
  let seq = 0;
  const world = {
    PI: PIloaded, mod, pi, tools, handlers, settings, chat, entries, sm, ui,
    width, clock, messages: new Map(), assistantComps: new Map(), toolComps: new Map(),
    pendingTools: new Map(), events, messageCopies,
  };
  // One ordered log of who saw what. `extension` is the Pi extension event,
  // `ui` is the interactive-mode listener, and `persist` is
  // SessionManager.appendMessage. Tests assert the real order, not just the
  // final text, so a future refactor cannot quietly invert it again.
  world.log = (side, type, data = {}, extra = {}) => {
    events.push({
      seq: ++seq, side, type,
      role: data?.message?.role,
      entryCount: entries.length,
      ...extra,
    });
  };
  const fire = async (event, data = {}, ctx = {}) => {
    world.log("extension", event, data);
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

function mountTool(world, name, toolCallId, args, { partial = false, started = false } = {}) {
  let tool = world.tools.get(name);
  if (!tool) {
    // Sibling extensions (subagents, ...) opt into collapsing at
    // registration, but the replay has no registration hook. Recreate what
    // production would have: a generic definition wrapped by collapse, so
    // old turns that used those tools replay instead of aborting.
    const def = {
      name,
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [] }),
    };
    tool = world.mod.collapseDefinition ? world.mod.collapseDefinition(def, world.pi) : def;
    world.tools.set(name, tool);
  }
  // The host is Pi's REAL component, not a lookalike. It owns args updates,
  // executionStarted/argsComplete, results, errors, expansion, and clicks.
  const host = new world.PI.ToolExecutionComponent(
    name, toolCallId, args,
    { showImages: true, imageWidthCells: 60, outputPad: 1 },
    tool, world.ui, "/repo",
  );
  host.setExpanded(false);
  const slot = { comp: host, inner: host.callRendererComponent, name, args };
  world.chat.addChild(host);
  world.toolComps.set(toolCallId, slot);
  world.log("ui", "tool_mount", { toolCallId, name });
  const prevOf = () => {
    const at = world.chat.children.indexOf(host);
    return at > 0 ? world.chat.children[at - 1] : undefined;
  };
  try { world.mod.wrapToolComponent?.(host, world.pi, prevOf); } catch {}
  if (started) {
    host.markExecutionStarted();
    host.setArgsComplete();
  } else if (partial) {
    // A call first appears while its arguments are still streaming.
    host.isPartial = true;
  }
  slot.inner = host.callRendererComponent ?? slot.inner;
  return host;
}

function refreshTool(world, toolCallId) {
  // A real ToolExecutionComponent rebuilds callRendererComponent inside
  // updateDisplay(); keep the test-facing inner row in step with it.
  const slot = world.toolComps.get(toolCallId);
  if (!slot) return;
  slot.inner = slot.comp.callRendererComponent ?? slot.inner;
  return slot.comp;
}

// Restore: entries load BEFORE session_start (production order — the
// manager already holds them), then mount every entry oldest-first,
// then converge over several poll ticks.
function mountEntries(world, entries) {
  const resultIds = new Set();
  for (const entry of entries) {
    if (entry?.type === "message" && entry.message?.role === "toolResult") {
      resultIds.add(entry.message.toolCallId);
    }
  }
  for (const entry of entries) {
    const message = entry?.message;
    if (entry?.type === "custom" || entry?.type === "custom_message") {
      mountCustom(world, entry);
      continue;
    }
    if (entry?.type === "compaction" || entry?.type === "branch_summary") {
      mountSummary(world, entry);
      continue;
    }
    if (!message || typeof message !== "object") continue;
    if (entry.type !== "message" && entry.type !== undefined) continue;
    if (message.role === "assistant") {
      const comp = mountAssistant(world, message, entry.id);
      comp.updateContent(message, false);
      world.assistantComps.set(entry.id ?? msgId("e"), comp);
      for (const block of message.content ?? []) {
        if (block?.type !== "toolCall") continue;
        mountTool(world, block.name, block.id, block.arguments ?? {}, { started: true });
        // History has no live execution to observe: mark the final state
        // exactly as Pi's restore path does.
        const slot = world.toolComps.get(block.id);
        if (slot) {
          slot.comp.isPartial = true;
          slot.inner = slot.comp.callRendererComponent ?? slot.inner;
        }
      }
      if (message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "length") {
        const errorMessage = message.stopReason === "aborted" ? "Operation aborted" : (message.errorMessage || "Error");
        for (const block of message.content ?? []) {
          if (block?.type !== "toolCall" || resultIds.has(block.id)) continue;
          const slot = world.toolComps.get(block.id);
          if (!slot) continue;
          slot.comp.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true }, false);
          slot.inner = slot.comp.callRendererComponent ?? slot.inner;
        }
      }
    } else if (message.role === "user") {
      const comp = new world.PI.UserMessageComponent(
        userText(message.content), world.PI.mdTheme, 1, [], entry.id, message.timestamp ?? Date.now());
      world.chat.addChild(comp);
    } else if (message.role === "toolResult") {
      const slot = world.toolComps.get(message.toolCallId);
      if (slot) {
        slot.comp.markExecutionStarted();
        slot.comp.setArgsComplete();
        slot.comp.updateResult({
          content: message.content ?? [],
          isError: message.isError === true,
          ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
        }, false);
        slot.inner = slot.comp.callRendererComponent ?? slot.inner;
      }
    }
  }
}

function mountCustom(world, entry) {
  try {
    const message = entry.message ?? {
      role: "custom",
      customType: entry.customType ?? "custom",
      content: entry.content ?? entry.data ?? "",
      display: entry.display,
      timestamp: entry.timestamp,
    };
    if (message.display === false) return;
    const comp = new world.PI.CustomMessageComponent(
      message, undefined, world.PI.mdTheme, 1, [], entry.id, entry.timestamp,
    );
    world.chat.addChild(comp);
  } catch {
    // Unknown custom shape: History still gates boundaries, no row to draw.
  }
}

function mountSummary(world, entry) {
  try {
    const text = entry.summary ?? entry.message?.content ?? "";
    if (typeof text !== "string" || text.trim() === "") return;
    const { Text } = world.PI.tui;
    world.chat.addChild(new Text(text, 1, 0));
  } catch {
    // A summary render failure must not stop restore.
  }
}

// Restore: entries load BEFORE session_start (production order — the
// manager already holds them), then mount every entry oldest-first,
// then converge over several poll ticks.
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

function persist(world, entry) {
  world.entries.push(entry);
  world.log("persist", "entry", { message: entry.message }, { entryType: entry.type });
}

function copyMessage(world, message) {
  const copy = { ...message };
  world.messageCopies.push({ message: copy, canonical: message });
  return copy;
}

function mountPendingTools(world, message) {
  for (const block of message.content ?? []) {
    if (block?.type !== "toolCall") continue;
    const existing = world.pendingTools.get(block.id);
    if (existing) {
      existing.updateArgs(block.arguments ?? {});
      const slot = world.toolComps.get(block.id);
      if (slot) slot.args = block.arguments ?? {};
    } else {
      const host = mountTool(world, block.name, block.id, block.arguments ?? {}, { partial: true });
      world.pendingTools.set(block.id, host);
    }
  }
}

async function finishMessage(world, message, messageId) {
  // Extension listeners run first; Pi persists only after the UI listener.
  await world.fire("message_end", { message }, {});
  const comp = messageId ? world.assistantComps.get(messageId) : undefined;
  if (comp) {
    world.log("ui", "message_end", { message });
    comp.updateContent(message, false);
  }
  if (message.role === "assistant") {
    const failed = message.stopReason === "aborted" || message.stopReason === "error";
    if (failed) {
      const errorMessage = message.stopReason === "aborted"
        ? "Operation aborted"
        : (message.errorMessage || "Error");
      for (const host of world.pendingTools.values()) {
        host.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true }, false);
        world.log("ui", "tool_error", { toolCallId: host.toolCallId });
      }
      world.pendingTools.clear();
    } else {
      for (const [toolId, host] of world.pendingTools) {
        host.setArgsComplete();
        world.log("ui", "tool_args_complete", { toolCallId: toolId });
      }
    }
  }
  persist(world, { id: msgId("e"), type: "message", message });
}

async function runLive(world, ops) {
  const savedNow = Date.now;
  try {
    if (world.clock) Date.now = () => world.clock.value;
    await runOps(world, ops);
  } finally {
    Date.now = savedNow;
  }
}

async function runOps(world, ops) {
  for (const op of ops) {
    if (world.clock && typeof op.timestamp === "number") world.clock.value = op.timestamp;
    if (op.op === "custom") {
      /** @type {any} */
      const message = {
        role: "custom", customType: op.customType ?? "custom",
        content: op.text ?? "", timestamp: Date.now(),
      };
      await world.fire("message_start", { message }, {});
      const comp = new world.PI.CustomMessageComponent(
        message, undefined, world.PI.mdTheme, 1, [], msgId("c"), Date.now(),
      );
      world.chat.addChild(comp);
      world.log("ui", "message_mount", { message });
      await world.fire("message_end", { message }, {});
      persist(world, { id: msgId("e"), type: "custom_message", message });
    } else if (op.op === "user") {
      /** @type {any} */
      const message = { role: "user", content: [{ type: "text", text: op.text }] };
      // Pi emits message_start/message_end for the user's own message. The
      // extension sees both before SessionManager appends it.
      await world.fire("message_start", { message }, {});
      const comp = new world.PI.UserMessageComponent(
        op.text, world.PI.mdTheme, 1, [], msgId("u"), Date.now());
      world.chat.addChild(comp);
      world.log("ui", "message_mount", { message });
      await world.fire("message_end", { message }, {});
      persist(world, { id: msgId("e"), type: "message", message });
    } else if (op.op === "start") {
      /** @type {any} */
      const message = { role: "assistant", content: [], timestamp: op.timestamp ?? Date.now() };
      world.messages.set(op.id, message);
      const copy = copyMessage(world, message);
      await world.fire("message_start", { message: copy }, {});
      const comp = mountAssistant(world, undefined, msgId(op.id));
      world.log("ui", "message_mount", { message: copy });
      comp.updateContent(copy, true);
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
      const copy = copyMessage(world, message);
      await world.fire("message_update", { message: copy }, {});
      const comp = world.assistantComps.get(op.id);
      if (comp) comp.updateContent(copy, true);
      world.log("ui", "message_update", { message: copy });
    } else if (op.op === "tool") {
      const message = world.messages.get(op.id);
      message.content.push({ type: "toolCall", id: op.toolId, name: op.name, arguments: op.args ?? {} });
      const copy = copyMessage(world, message);
      await world.fire("message_update", { message: copy }, {});
      const comp = world.assistantComps.get(op.id);
      if (comp) comp.updateContent(copy, true);
      // The interactive-mode message_update listener creates the real tool
      // host for a newly seen call, then tool_execution_start marks it.
      mountPendingTools(world, copy);
      world.log("ui", "message_update", { message: copy });
      await world.fire("tool_execution_start", {
        toolName: op.name, toolCallId: op.toolId, args: op.args ?? {},
      }, {});
      const host = world.toolComps.get(op.toolId)?.comp;
      if (host) {
        host.markExecutionStarted();
        world.log("ui", "tool_execution_start", { toolCallId: op.toolId });
        refreshTool(world, op.toolId);
      }
    } else if (op.op === "end" || op.op === "abort") {
      const message = world.messages.get(op.id);
      if (!message) throw new Error(`${op.op}: unknown message ${op.id}`);
      message.stopReason = op.op === "abort" ? (op.stop ?? "aborted") : (op.stop ?? "stop");
      // `timestamp` is the clock at completion (used by the render below);
      // Pi keeps message.timestamp at the START of the response. Persisting
      // the end time here made reload reconstruct a different message.
      if (op.durationMs !== undefined) message.durationMs = op.durationMs;
      await finishMessage(world, message, op.id);
    } else if (op.op === "result") {
      const slot = world.toolComps.get(op.toolId);
      /** @type {any} */
      const result = {
        content: [{ type: "text", text: op.text ?? "" }],
        isError: op.isError === true,
      };
      await world.fire("tool_execution_end", {
        toolCallId: op.toolId,
        toolName: slot?.name,
        result,
        isError: result.isError,
      }, {});
      if (slot) {
        slot.comp.updateResult(result, false);
        world.log("ui", "tool_execution_end", { toolCallId: op.toolId });
        slot.inner = slot.comp.callRendererComponent ?? slot.inner;
        world.pendingTools.delete(op.toolId);
      }
      const toolResult = {
        role: "toolResult",
        toolCallId: op.toolId,
        toolName: slot?.name,
        content: result.content,
        isError: result.isError,
        timestamp: op.timestamp ?? Date.now(),
      };
      // toolResult messages are real message_start/message_end events too;
      // the old driver appended an entry and skipped both.
      await world.fire("message_start", { message: toolResult }, {});
      await world.fire("message_end", { message: toolResult }, {});
      persist(world, { id: msgId("e"), type: "message", message: toolResult });
    } else if (op.op === "pending") {
      const message = world.messages.get(op.id);
      message.stopReason = "pending";
      const copy = copyMessage(world, message);
      await world.fire("message_update", { message: copy }, {});
      const comp = world.assistantComps.get(op.id);
      if (comp) comp.updateContent(copy, true);
      world.log("ui", "message_update", { message: copy });
    } else if (op.op === "turn") {
      await world.fire("turn_end", {}, {});
      world.log("ui", "turn_end", {});
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

// Reload: Pi invalidates the old extension runner, reloads resources,
// builds a NEW runner from a fresh module, rebuilds the chat before
// session_start, then emits session_start(reason reload). Keep the entries
// and dimensions; replace everything the module owns.
async function reload(world) {
  await world.fire("session_shutdown", { reason: "reload" }, {});
  const entries = [...world.entries];
  const width = world.width;
  const hideThinkingBlock = world.settings.hideThinkingBlock;
  const fresh = await loadPi();
  const next = createWorld(fresh, { width, hideThinkingBlock });
  await restoreLate(next, entries);
  Object.assign(world, next);
  return world;
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
  // Click the extension row header exactly like the TUI test helper does.
  // With the real host, the row lives in callRendererComponent; the click
  // invalidates -> updateDisplay, so refresh the test-facing inner row.
  const slot = world.toolComps.get(toolCallId);
  if (!slot) throw new Error(`no mounted tool: ${toolCallId}`);
  const host = slot.comp;
  let inner = host.callRendererComponent ?? slot.inner;
  if (inner?.children?.length === 1) {
    inner.children[0]?.onMouse?.({ type: "click", button: "left" });
    try { host.updateDisplay(); } catch { /* compared instead */ }
    try { host.render(world.width); } catch { /* compared instead */ }
    inner = host.callRendererComponent ?? inner;
  }
  slot.inner = inner;
  return inner;
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
