// Tests for collapse/logic.ts — pure formatting helpers for the collapsed
// tool/thinking view. No pi imports; load via jiti.
// Run: node logic.test.cjs
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
const { createJiti } = require(path.join(PI, "node_modules", "jiti"));
const jiti = createJiti(__filename, { interopDefault: true, fsCache: false, moduleCache: false });

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${extra !== undefined ? `: ${extra}` : ""}`);
  }
}

(async () => {
  const logic = await jiti.import(path.join(__dirname, "logic.ts"));

  // formatCharCount (always k-form, matching the 5.3k / 0.1k / 1.5k examples)
  check("count 0", logic.formatCharCount(0) === "0.0k ch", logic.formatCharCount(0));
  check("count 100", logic.formatCharCount(100) === "0.1k ch", logic.formatCharCount(100));
  check("count 1000", logic.formatCharCount(1000) === "1.0k ch", logic.formatCharCount(1000));
  check("count 1500", logic.formatCharCount(1500) === "1.5k ch", logic.formatCharCount(1500));
  check("count 5300", logic.formatCharCount(5300) === "5.3k ch", logic.formatCharCount(5300));
  check("count 12345", logic.formatCharCount(12345) === "12.3k ch", logic.formatCharCount(12345));
  check("count negative", logic.formatCharCount(-5) === "0.0k ch", logic.formatCharCount(-5));

  // splitDirBase
  check(
    "split abs",
    JSON.stringify(logic.splitDirBase("/path/to/file")) === JSON.stringify({ dir: "/path/to/", base: "file" }),
    JSON.stringify(logic.splitDirBase("/path/to/file")),
  );
  check(
    "split bare",
    JSON.stringify(logic.splitDirBase("file")) === JSON.stringify({ dir: "", base: "file" }),
    JSON.stringify(logic.splitDirBase("file")),
  );
  check(
    "split root",
    JSON.stringify(logic.splitDirBase("/file")) === JSON.stringify({ dir: "/", base: "file" }),
    JSON.stringify(logic.splitDirBase("/file")),
  );
  check(
    "split empty",
    JSON.stringify(logic.splitDirBase("")) === JSON.stringify({ dir: "", base: "" }),
    JSON.stringify(logic.splitDirBase("")),
  );

  // formatLineRange
  check("range empty", logic.formatLineRange(null, null) === "", logic.formatLineRange(null, null));
  check("range both", logic.formatLineRange(10, 11) === ":10-20", logic.formatLineRange(10, 11));
  check("range offset only", logic.formatLineRange(10, null) === ":10", logic.formatLineRange(10, null));
  check("range limit only", logic.formatLineRange(null, 20) === ":1-20", logic.formatLineRange(null, 20));
  check("range single line", logic.formatLineRange(1, 1) === ":1-1", logic.formatLineRange(1, 1));

  // collapseWhitespace
  check("collapse basic", logic.collapseWhitespace("a\nb\tc  d") === "a b c d", JSON.stringify(logic.collapseWhitespace("a\nb\tc  d")));
  check("collapse trim", logic.collapseWhitespace("  hello  \n\n world ") === "hello world", JSON.stringify(logic.collapseWhitespace("  hello  \n\n world ")));
  check("collapse empty", logic.collapseWhitespace("") === "", JSON.stringify(logic.collapseWhitespace("")));

  // truncateMiddle
  check("middle short", logic.truncateMiddle("hello", 10) === "hello", logic.truncateMiddle("hello", 10));
  check("middle exact", logic.truncateMiddle("hello", 5) === "hello", logic.truncateMiddle("hello", 5));
  check("middle cut", logic.truncateMiddle("abcdefghij", 7) === "abc…hij", logic.truncateMiddle("abcdefghij", 7));
  check("middle tiny", logic.truncateMiddle("abcdef", 3) === "a…f", logic.truncateMiddle("abcdef", 3));

  // truncateEnd
  check("end short", logic.truncateEnd("hello", 10) === "hello", logic.truncateEnd("hello", 10));
  check("end cut", logic.truncateEnd("abcdefghij", 7) === "abcdef…", logic.truncateEnd("abcdefghij", 7));
  check("end tiny", logic.truncateEnd("abcdef", 2) === "a…", logic.truncateEnd("abcdef", 2));

  // thinkingPreview
  check(
    "preview collapse",
    logic.thinkingPreview("  hello\nworld  ", 64) === "hello world",
    JSON.stringify(logic.thinkingPreview("  hello\nworld  ", 64)),
  );
  check(
    "preview middle",
    logic.thinkingPreview("about something really long here and more words follow", 20) ===
      logic.truncateMiddle("about something really long here and more words follow", 20),
    logic.thinkingPreview("about something really long here and more words follow", 20),
  );

  // buildThinkingLabel
  check("label empty", logic.buildThinkingLabel("") === "Thinking… 0.0k ch", JSON.stringify(logic.buildThinkingLabel("")));
  check(
    "label short",
    logic.buildThinkingLabel("hello") === "Thinking hello 0.0k ch",
    JSON.stringify(logic.buildThinkingLabel("hello")),
  );
  {
    const thinking = "a".repeat(1500);
    const expected = `Thinking ${"a".repeat(32)}…${"a".repeat(31)} 1.5k ch`;
    check("label long", logic.buildThinkingLabel(thinking) === expected, JSON.stringify(logic.buildThinkingLabel(thinking)).slice(0, 120));
  }

  // firstWord / summarizeBashCommand (no fixed cap: the row truncates to width)
  check("first word", logic.firstWord("timeout 25 ls some/dist") === "timeout", logic.firstWord("timeout 25 ls some/dist"));
  check("first word empty", logic.firstWord("   ") === "", JSON.stringify(logic.firstWord("   ")));
  check(
    "bash short",
    logic.summarizeBashCommand("timeout 25 ls some/dist") === "timeout 25 ls some/dist",
    logic.summarizeBashCommand("timeout 25 ls some/dist"),
  );
  check(
    "bash collapse",
    logic.summarizeBashCommand("  echo   hi\nbye ") === "echo hi bye",
    JSON.stringify(logic.summarizeBashCommand("  echo   hi\nbye ")),
  );
  check(
    "bash long not capped",
    logic.summarizeBashCommand("x".repeat(100)) === "x".repeat(100),
    logic.summarizeBashCommand("x".repeat(100)).length,
  );

  // readLineParts
  check(
    "read parts",
    JSON.stringify(logic.readLineParts({ path: "/path/to/file", offset: 10, limit: 11 })) ===
      JSON.stringify({ dir: "/path/to/", base: "file", range: ":10-20" }),
    JSON.stringify(logic.readLineParts({ path: "/path/to/file", offset: 10, limit: 11 })),
  );
  check(
    "read parts file_path",
    JSON.stringify(logic.readLineParts({ file_path: "/a/b" })) === JSON.stringify({ dir: "/a/", base: "b", range: "" }),
    JSON.stringify(logic.readLineParts({ file_path: "/a/b" })),
  );
  check(
    "read parts empty",
    JSON.stringify(logic.readLineParts({})) === JSON.stringify({ dir: "", base: "", range: "" }),
    JSON.stringify(logic.readLineParts({})),
  );

  // summarizeArgs
  check("args null", logic.summarizeArgs(null, 80) === "", JSON.stringify(logic.summarizeArgs(null, 80)));
  check(
    "args object",
    logic.summarizeArgs({ a: 1, b: "x" }, 80) === 'a=1 b="x"',
    JSON.stringify(logic.summarizeArgs({ a: 1, b: "x" }, 80)),
  );
  check("args empty obj", logic.summarizeArgs({}, 80) === "", JSON.stringify(logic.summarizeArgs({}, 80)));

  // extractThinkingText / findLatestThinkingText
  check(
    "extract none",
    logic.extractThinkingText({ role: "assistant", content: [{ type: "text", text: "hi" }] }) === undefined,
    "should be undefined",
  );
  check(
    "extract skips empty",
    logic.extractThinkingText({ role: "assistant", content: [{ type: "thinking", thinking: "  " }] }) === undefined,
    "should be undefined",
  );
  check(
    "extract joins",
    logic.extractThinkingText({ role: "assistant", content: [{ type: "thinking", thinking: "a" }, { type: "thinking", thinking: "b" }] }) === "a\n\nb",
    JSON.stringify(logic.extractThinkingText({ role: "assistant", content: [{ type: "thinking", thinking: "a" }] })),
  );
  check(
    "extract non-assistant",
    logic.extractThinkingText({ role: "user", content: [{ type: "thinking", thinking: "a" }] }) === undefined,
    "should be undefined",
  );
  {
    const entries = [
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "old" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] } },
      { type: "custom", data: 1 },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "new" }] } },
    ];
    check("latest thinking", logic.findLatestThinkingText(entries) === "new", JSON.stringify(logic.findLatestThinkingText(entries)));
    check("latest thinking empty", logic.findLatestThinkingText([]) === undefined, "should be undefined");
    check("latest thinking non-array", logic.findLatestThinkingText(null) === undefined, "should be undefined");
  }

  // labelBudget / padLabel (label must be exactly columns-3: pad + scrollbar)
  check("budget wide", logic.labelBudget(200) === 197, logic.labelBudget(200));
  check("budget fallback", logic.labelBudget(undefined) === 77, logic.labelBudget(undefined));
  check("budget narrow", logic.labelBudget(10) === 16, logic.labelBudget(10));
  check("budget zero", logic.labelBudget(0) === 77, logic.labelBudget(0));
  check("budget pad 0", logic.labelBudget(200, 0) === 199, logic.labelBudget(200, 0));
  check("budget pad 0 fallback", logic.labelBudget(undefined, 0) === 79, logic.labelBudget(undefined, 0));
  check(
    "pad fit",
    logic.padLabel("ab", "12", 10) === "ab      12",
    JSON.stringify(logic.padLabel("ab", "12", 10)),
  );
  check(
    "pad overflow",
    logic.padLabel("abcdefghij", "12", 8) === "a… 12",
    JSON.stringify(logic.padLabel("abcdefghij", "12", 8)),
  );

  // searchParts / lsParts
  check(
    "search parts",
    JSON.stringify(logic.searchParts({ pattern: "foo.*", path: "/a" })) ===
      JSON.stringify({ pattern: "foo.*", path: "/a" }),
    JSON.stringify(logic.searchParts({ pattern: "foo.*", path: "/a" })),
  );
  check(
    "search parts empty",
    JSON.stringify(logic.searchParts({})) === JSON.stringify({ pattern: "", path: "" }),
    JSON.stringify(logic.searchParts({})),
  );
  check(
    "ls parts",
    JSON.stringify(logic.lsParts({ path: "/some/dir" })) === JSON.stringify({ path: "/some/dir" }),
    JSON.stringify(logic.lsParts({ path: "/some/dir" })),
  );
  check(
    "ls parts empty",
    JSON.stringify(logic.lsParts({})) === JSON.stringify({ path: "" }),
    JSON.stringify(logic.lsParts({})),
  );

  // textCharCount
  check(
    "char count blocks",
    logic.textCharCount([{ type: "text", text: "hello" }, { type: "image" }, { type: "text", text: "!" }]) === 6,
    logic.textCharCount([{ type: "text", text: "hello" }, { type: "image" }, { type: "text", text: "!" }]),
  );
  check("char count non-array", logic.textCharCount(undefined) === 0, logic.textCharCount(undefined));

  // thinkingLabelForWidth: no prefix, preview + right-aligned count.
  // Pi renders the label as chalk.italic(...) over the whole string, and
  // chalk 6 re-opens its own style after every \x1b[23m it finds — so the
  // reset is written as \x1b[23;23m, which chalk leaves alone and terminals
  // read as italic-off.
  {
    const ANSI = /\x1b\[[0-9;]*m/g;
    const visible = (text) => text.replace(ANSI, "");

    const short = logic.thinkingLabelForWidth("hello", 80);
    check("label no prefix", visible(short).startsWith("hello"), JSON.stringify(short));
    check("label short fills width", visible(short).length === 77, `${visible(short).length}`);
    check("label short count", short.endsWith("\x1b[23;23m0.0k ch"), JSON.stringify(short.slice(-20)));
    check("label only count leaves italic", (short.match(/\x1b\[23;23m/g) ?? []).length === 1 && short.endsWith("\x1b[23;23m0.0k ch"), JSON.stringify(short.slice(-20)));
    check("label visible matches plain pad", visible(short) === logic.padLabel("hello", "0.0k ch", 77), JSON.stringify(visible(short)));

    const long = logic.thinkingLabelForWidth("a".repeat(1500), 100);
    check("label long fills width", visible(long).length === 97, `${visible(long).length}`);
    check("label long has middle cut", !long.startsWith("Thinking") && long.includes("…"), JSON.stringify(long.slice(0, 60)));
    check("label long ends count", long.endsWith("\x1b[23;23m1.5k ch"), JSON.stringify(long.slice(-20)));
    // preview keeps head and tail around the middle cut
    const expectedPreview = `${"a".repeat(44)}…${"a".repeat(44)}`;
    check("label pad 0 wider", visible(logic.thinkingLabelForWidth("hello", 80, 0)).length === 79, `${visible(logic.thinkingLabelForWidth("hello", 80, 0)).length}`);
    check("label long middle exact", long.startsWith(expectedPreview), JSON.stringify(long.slice(0, 100)));
  }

  // hasLeadingVisibleContent: does anything render above this message's tools?
  {
    const hv = logic.hasLeadingVisibleContent;
    check("leading text", hv({ role: "assistant", content: [{ type: "text", text: "hi" }] }) === true);
    check("leading thinking", hv({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }) === true);
    check("blank text is invisible", hv({ role: "assistant", content: [{ type: "text", text: "  " }] }) === false);
    check("blank thinking is invisible", hv({ role: "assistant", content: [{ type: "thinking", thinking: "\n " }] }) === false);
    check("tool first", hv({ role: "assistant", content: [{ type: "toolCall", name: "bash", id: "1" }, { type: "text", text: "after" }] }) === false);
    check("text before tool", hv({ role: "assistant", content: [{ type: "text", text: "before" }, { type: "toolCall", name: "bash", id: "1" }] }) === true);
    check("thinking before tool", hv({ role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "toolCall", name: "bash", id: "1" }] }) === true);
    check("tool only", hv({ role: "assistant", content: [{ type: "toolCall", name: "bash", id: "1" }] }) === false);
    check("user is not assistant", hv({ role: "user", content: [{ type: "text", text: "x" }] }) === false);
    check("empty content", hv({ role: "assistant", content: [] }) === false);
  }

  // genericToolSummary: makes ANY tool name-able on one row
  {
    const g = logic.genericToolSummary;
    check("generic uses name", g({ name: "api-check" }) === "api-check", g({ name: "api-check" }));
    check("generic uses description", g({ description: "Check the API" }) === "Check the API", g({ description: "Check the API" }));
    check("generic uses prompt first line", g({ prompt: "Do a thing\nand more" }) === "Do a thing", g({ prompt: "Do a thing\nand more" }));
    check("generic prefers command", g({ command: "  ls   -la  /tmp " }) === "ls -la /tmp", g({ command: "  ls   -la  /tmp " }));
    check("generic uses path", g({ path: "/a/b.txt" }) === "/a/b.txt", g({ path: "/a/b.txt" }));
    check("generic falls back to first string", g({ whatever: "value" }) === "value", g({ whatever: "value" }));
    check("generic empty for nothing", g({}) === "", g({}));
    check("generic collapses whitespace", g({ description: "a\n\n  b" }) === "a b", g({ description: "a\n\n  b" }));
  }

  // planToolRuns: group contiguous history tools so the rebuild layout
  // matches live runs (no teleporting: never span visible content).
  {
    const msg = (role, content) => ({ type: "message", message: { role, content } });
    const call = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
    const text = (t) => ({ type: "text", text: t });
    const think = (t) => ({ type: "thinking", thinking: t });
    const own = (name) => ["read", "bash"].includes(name);
    const plan = (entries) => logic.planToolRuns(entries, own);
    check("contiguous tools group",
      JSON.stringify(plan([msg("assistant", [call("a", "read"), call("b", "bash")])])) === '[["a","b"]]');
    check("tool-only turns merge",
      JSON.stringify(plan([msg("assistant", [call("a", "read")]), msg("assistant", [call("b", "bash")])])) === '[["a","b"]]');
    check("prose between splits",
      JSON.stringify(plan([msg("assistant", [call("a", "read")]), msg("user", [text("hi")]), msg("assistant", [call("b", "bash")])])) === '[["a"],["b"]]');
    check("leading thinking splits",
      JSON.stringify(plan([msg("assistant", [call("a", "read")]), msg("assistant", [think("hmm"), call("b", "bash")])])) === '[["a"],["b"]]');
    check("thinking between tools splits",
      JSON.stringify(plan([msg("assistant", [call("a", "read"), think("hmm"), call("b", "bash")])])) === '[["a"],["b"]]');
    check("trailing text does not split",
      JSON.stringify(plan([msg("assistant", [call("a", "read"), text("done")]), msg("assistant", [call("b", "bash")])])) === '[["a","b"]]');
    check("tool results do not split",
      JSON.stringify(plan([
        msg("assistant", [call("a", "read")]),
        { type: "message", message: { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "x" }] } },
        msg("assistant", [call("b", "bash")]),
      ])) === '[["a","b"]]');
    check("foreign tools split",
      JSON.stringify(plan([msg("assistant", [call("a", "read"), call("f", "mcp_x")]), msg("assistant", [call("b", "bash")])])) === '[["a"],["b"]]');
    check("empty thinking is invisible",
      JSON.stringify(plan([msg("assistant", [call("a", "read")]), msg("assistant", [think("  "), call("b", "bash")])])) === '[["a","b"]]');
    check("missing ids are skipped",
      JSON.stringify(plan([msg("assistant", [call("a", "read"), { type: "toolCall", name: "bash" }])])) === '[["a"]]');
  }

  // isSafeToDetach: detach hides nothing but hidden-thinking label rows.
  // Mirror of assistant-message.js updateContent; blank runs never consume an index.
  {
    const think = (t) => ({ type: "thinking", thinking: t });
    const text = (t) => ({ type: "text", text: t });
    const tool = (id) => ({ type: "toolCall", id, name: "read", arguments: {} });
    const safe = logic.isSafeToDetach;
    check("thinking+tools hidden detaches",
      safe({ content: [think("plan"), tool("a")], stopReason: "toolUse" }, true) === true, "");
    check("visible thinking never detaches",
      safe({ content: [think("plan"), tool("a")], stopReason: "toolUse" }, false) === false, "");
    check("visible text blocks detach",
      safe({ content: [think("plan"), text("hello"), tool("a")], stopReason: "toolUse" }, true) === false, "");
    check("blank text is not visible text",
      safe({ content: [think("plan"), text("   "), tool("a")], stopReason: "toolUse" }, true) === true, "");
    check("tools-only has nothing to hide",
      safe({ content: [tool("a")], stopReason: "toolUse" }, true) === false, "");
    check("thinking-only is content-safe (host check lives in the detach pass)",
      safe({ content: [think("plan")], stopReason: "stop" }, true) === true, "");
    check("length stop keeps its error line",
      safe({ content: [think("plan"), tool("a")], stopReason: "length" }, true) === false, "");
    check("aborted with tools stays suppressed",
      safe({ content: [think("plan"), tool("a")], stopReason: "aborted" }, true) === true, "");
    check("aborted without tools keeps its line",
      safe({ content: [think("plan")], stopReason: "aborted" }, true) === false, "");
    check("error without tools keeps its line",
      safe({ content: [think("plan")], stopReason: "error" }, true) === false, "");
    check("blank thinking runs do not count",
      safe({ content: [think("   "), think("plan"), tool("a")], stopReason: "toolUse" }, true) === true, "");
    check("all-blank thinking is nothing to hide",
      safe({ content: [think("  "), tool("a")], stopReason: "toolUse" }, true) === false, "");
    check("click-opened run blocks detach",
      safe({ content: [think("plan"), tool("a")], stopReason: "toolUse" }, true, new Map([[0, false]])) === false, "");
    check("split runs both hidden still detach",
      safe({ content: [think("a"), tool("x"), think("b"), tool("c")], stopReason: "toolUse" }, true, new Map([[0, true]])) === true, "");
    check("second run open blocks detach",
      safe({ content: [think("a"), tool("x"), think("b"), tool("c")], stopReason: "toolUse" }, true, new Map([[1, false]])) === false, "");
    check("missing content is unsafe",
      safe({}, true) === false, "");
  }

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("PASS: collapse logic");
})().catch((error) => {
  console.error(`FAIL - ${error?.stack ?? error}`);
  process.exit(1);
});

