// Real-Pi integration smoke test.
//
// The replay driver is deliberately a headless emulation. This file closes
// the remaining gap: it builds an actual AgentSession from the installed Pi
// release, loads this extension through Pi's real DefaultResourceLoader,
// binds a UI context, and drives Pi's real agent loop with a fake provider
// stream. No chat/mount/session code is reimplemented here.
//
// What it pins:
//   - the extension loads and registers through Pi itself;
//   - session_start reaches the extension and installs the walker widget;
//   - Pi's real message_start -> message_end -> SessionManager.appendMessage
//     order (message_end sees the branch BEFORE the message is persisted);
//   - a real tool call executes the extension-loaded bash tool, emits
//     tool_execution_start/end, and persists a toolResult message pair;
//   - a real session.reload re-runs session_start with reason "reload";
//   - the extension remains loaded after reload.
//
// Run: node replay/real-session.test.cjs
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${extra !== undefined ? `: ${extra}` : ""}`);
  }
}

(async () => {
  const { PI, findPiAiRoot } = require("../test-pi.cjs");
  const agent = await import(path.join(PI, "dist", "bundle", "index.js"));
  const piAi = await import(path.join(findPiAiRoot(), "dist", "index.js"));

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "collapse-real-pi-"));
  const settings = agent.SettingsManager.inMemory({ hideThinkingBlock: true });
  const sessionManager = agent.SessionManager.inMemory(cwd);

  const probe = [];
  const probeExtension = (pi) => {
    for (const type of [
      "session_start", "session_shutdown", "message_start", "message_end",
      "tool_execution_start", "tool_execution_end", "turn_end",
    ]) {
      pi.on(type, (event, ctx) => {
        probe.push({
          type,
          reason: event?.reason,
          role: event?.message?.role,
          branch: typeof ctx?.sessionManager?.getBranch === "function"
            ? ctx.sessionManager.getBranch().length
            : -1,
          hasMessage: !!event?.message,
        });
      });
    }
  };

  const loader = new agent.DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    additionalExtensionPaths: [path.join(__dirname, "..", "index.ts")],
    extensionFactories: [probeExtension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const model = {
    id: "fake-model", name: "Fake", api: "openai-completions", provider: "fake",
    baseUrl: "", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000, maxTokens: 1000,
  };
  const { session } = await agent.createAgentSession({
    cwd, agentDir: cwd, model,
    sessionManager, settingsManager: settings, resourceLoader: loader, tools: ["bash"],
  });

  let widgetFactory;
  const ui = {
    setWidget: (key, factory) => { widgetFactory = { key, factory }; },
    setHiddenThinkingLabel: () => {},
    requestRender: () => {},
    notify: () => {},
  };
  await session.bindExtensions({ mode: "rpc", uiContext: ui });

  const commands = session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName);
  check("real Pi loads the extension", commands.includes("collapse"), JSON.stringify(commands));
  check("real Pi session_start installs the walker widget", !!widgetFactory, JSON.stringify(widgetFactory?.key));
  let walker;
  try { walker = widgetFactory?.factory?.({ requestRender() {} }); } catch (e) { walker = e; }
  check("walker widget factory returns a component",
    !!walker && typeof walker.render === "function",
    String(walker?.message ?? walker));
  check("probe observed session_start", probe.some((e) => e.type === "session_start"), JSON.stringify(probe));

  // A real Pi assistant response, shaped like pi-ai's stream events.
  const final = {
    role: "assistant",
    content: [{ type: "text", text: "real reply" }],
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    durationMs: 5,
  };
  const stream = piAi.createAssistantMessageEventStream();
  const partial = { ...final, stopReason: null, content: [] };
  stream.push({ type: "start", partial });
  stream.push({ type: "text_start", contentIndex: 0, partial });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "real reply", partial });
  stream.push({ type: "text_end", contentIndex: 0, content: "real reply", partial });
  stream.push({ type: "done", reason: "stop", message: final });
  session.agent.streamFunction = () => stream;
  const baseBranch = sessionManager.getBranch().length;

  await session.agent.prompt([{ role: "user", content: [{ type: "text", text: "hello" }] }]);

  const branch = sessionManager.getBranch();
  check("real Pi persists the user and assistant messages",
    branch.filter((e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")).length === 2,
    JSON.stringify(branch.map((e) => `${e.type}:${e.message?.role ?? ""}`)));
  const end = probe.filter((e) => e.type === "message_end" && e.role === "assistant").at(-1);
  check("message_end runs before SessionManager persists the assistant",
    !!end && end.branch === branch.length - 1,
    `${JSON.stringify(probe.filter((e) => e.type.startsWith("message")))} base=${baseBranch} final=${branch.length}`);
  check("assistant message_start saw the user already persisted",
    probe.some((e) => e.type === "message_start" && e.role === "assistant" && e.branch === branch.length - 1),
    JSON.stringify(probe.filter((e) => e.type === "message_start")));
  check("real Pi emits turn_end", probe.some((e) => e.type === "turn_end"), JSON.stringify(probe));

  // A real tool call: Pi's agent loop must execute the extension-loaded bash
  // tool, emit tool events, then a toolResult message pair, then a second
  // assistant response. The probe sees the extension side of that order.
  const toolCall = {
    type: "toolCall", id: "real-tool-1", name: "bash",
    arguments: { command: "printf real-tool" },
  };
  const toolFinal = {
    ...final, content: [toolCall], stopReason: "toolUse", timestamp: Date.now(),
  };
  const secondText = { ...final, content: [{ type: "text", text: "after tool" }], timestamp: Date.now() };
  let streamCalls = 0;
  session.agent.streamFunction = () => {
    streamCalls++;
    if (streamCalls === 1) {
      const s = piAi.createAssistantMessageEventStream();
      const partialTool = { ...toolFinal, stopReason: null };
      s.push({ type: "start", partial: partialTool });
      s.push({ type: "done", reason: "toolUse", message: toolFinal });
      return s;
    }
    const s = piAi.createAssistantMessageEventStream();
    const partialText = { ...secondText, stopReason: null };
    s.push({ type: "start", partial: partialText });
    s.push({ type: "text_start", contentIndex: 0, partial: partialText });
    s.push({ type: "text_delta", contentIndex: 0, delta: "after tool", partial: partialText });
    s.push({ type: "text_end", contentIndex: 0, content: "after tool", partial: partialText });
    s.push({ type: "done", reason: "stop", message: secondText });
    return s;
  };
  await session.agent.prompt([{ role: "user", content: [{ type: "text", text: "run a tool" }] }]);
  const toolBranch = sessionManager.getBranch();
  check("real Pi executes the extension tool and persists its result",
    toolBranch.some((e) => e.type === "message" && e.message?.role === "toolResult" &&
      JSON.stringify(e.message.content).includes("real-tool")),
    JSON.stringify(toolBranch.map((e) => `${e.type}:${e.message?.role ?? ""}`)));
  check("real Pi emits tool_execution_start and end",
    probe.some((e) => e.type === "tool_execution_start") &&
    probe.some((e) => e.type === "tool_execution_end"),
    JSON.stringify(probe.filter((e) => e.type.startsWith("tool_"))));
  const toolResultPair = probe.filter((e) => e.type === "message_start" || e.type === "message_end");
  check("real Pi emits toolResult as message_start/message_end",
    toolResultPair.some((e) => e.role === "toolResult" && e.type === "message_start") &&
    toolResultPair.some((e) => e.role === "toolResult" && e.type === "message_end"),
    JSON.stringify(toolResultPair));

  await session.reload();
  check("real reload re-runs session_start with reason reload",
    probe.some((e) => e.type === "session_start" && e.reason === "reload"),
    JSON.stringify(probe.filter((e) => e.type === "session_start")));
  check("extension remains registered after reload",
    session.extensionRunner.getRegisteredCommands().some((c) => c.invocationName === "collapse"),
    JSON.stringify(session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName)));

  console.log(failures === 0 ? "PASS: real Pi session" : `FAILURES: ${failures}`);
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("FATAL", e); process.exitCode = 1; });
