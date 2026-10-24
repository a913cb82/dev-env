// Pure formatting helpers for the collapse extension (collapsed tool and
// thinking rows). Dependency-free so tests load it without the Pi bundle.

/** One-cell left rule that groups a run of collapsed rows. It lives in
 *  column 1 and replaces the leading pad cell, so content still starts on
 *  column 2 — see the rows.ts render. */
export const ROW_RAIL = "\u258f";

export function formatCharCount(chars: number): string {
  const n = Math.max(0, Math.floor(chars));
  return `${(n / 1000).toFixed(1)}k ch`;
}

export function splitDirBase(filePath: string): { dir: string; base: string } {
  const index = filePath.lastIndexOf("/");
  if (index === -1) return { dir: "", base: filePath };
  return { dir: filePath.slice(0, index + 1), base: filePath.slice(index + 1) };
}

export function formatLineRange(offset?: number | null, limit?: number | null): string {
  if (offset == null && limit == null) return "";
  const start = offset ?? 1;
  if (limit == null) return `:${start}`;
  return `:${start}-${start + limit - 1}`;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < 2) return text.slice(0, maxChars);
  const start = Math.ceil((maxChars - 1) / 2);
  const end = maxChars - 1 - start;
  return `${text.slice(0, start)}…${text.slice(text.length - end)}`;
}

export function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < 2) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

/** A collapsed one-line preview: middle-truncated, so it keeps the head AND
 *  the tail. Collapsing the whole text first would make the label cost
 *  O(thinking) — a megabyte block took ~8ms, and the label is rebuilt on
 *  every streaming delta and every resize frame. The preview shows at most
 *  one line, so only the head and tail windows are collapsed; the window
 *  doubles when a whitespace-heavy head or tail cannot fill its half, which
 *  keeps the result byte-identical to the exact path and never costs more
 *  than the old behaviour. */
export function thinkingPreview(text: string, maxChars = 64): string {
  if (maxChars < 2) return truncateMiddle(collapseWhitespace(text), maxChars);
  const start = Math.ceil((maxChars - 1) / 2);
  const end = Math.max(0, maxChars - 1 - start);
  let window = Math.max(256, maxChars * 4);
  for (;;) {
    if (text.length <= window * 2) return truncateMiddle(collapseWhitespace(text), maxChars);
    const head = collapseWhitespace(text.slice(0, window));
    const tail = collapseWhitespace(text.slice(-window));
    if (head.length >= start && tail.length >= end) {
      return `${head.slice(0, start)}\u2026${end > 0 ? tail.slice(tail.length - end) : ""}`;
    }
    window *= 2;
  }
}

export function buildThinkingLabel(thinking: string, maxPreview = 64): string {
  const count = formatCharCount(thinking.length);
  const collapsed = collapseWhitespace(thinking);
  if (!collapsed) return `Thinking… ${count}`;
  return `Thinking ${truncateMiddle(collapsed, maxPreview)} ${count}`;
}

export function firstWord(command: string): string {
  return collapseWhitespace(command).split(" ")[0] ?? "";
}

export type BashSegment =
  | { kind: "space"; text: string }
  | { kind: "op"; text: string }
  | { kind: "cmd"; text: string }
  | { kind: "plain"; text: string }
  | { kind: "dim"; text: string }
  | { kind: "accent"; text: string }
  | { kind: "path"; dir: string; base: string };

const CONTROL_OPS = new Set(["&&", "||", "|&", "|", ";", ";;", "&", "(", "{"]);
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const QUOTED_RE = /^(['"])([\s\S]*)\1$/;
const OPERATOR_CHARS = new Set(["&", "|", ";", "<", ">", "(", ")", "{", "}"]);

/** Split a shell command into words, whitespace, and operators without ever
 *  treating an operator inside quotes as syntax. Whitespace collapses to one
 *  space: rows show a summarized command anyway, and stable spacing keeps
 *  rendering cheap. */
function tokenizeBash(command: string): { kind: "space" | "op" | "word"; text: string }[] {
  const tokens: { kind: "space" | "op" | "word"; text: string }[] = [];
  const fdRedirect = /\d+(?:>&\d+|>>|>|<)/y;
  const operator = /&&|\|\||\|&|;;|>>|<<<|<<|>|<|\||;|&|\(|\)|\{|\}/y;
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (/\s/.test(char)) {
      tokens.push({ kind: "space", text: " " });
      index++;
      while (index < command.length && /\s/.test(command[index])) index++;
      continue;
    }
    fdRedirect.lastIndex = index;
    const fd = fdRedirect.exec(command);
    if (fd) {
      tokens.push({ kind: "op", text: fd[0] });
      index += fd[0].length;
      continue;
    }
    operator.lastIndex = index;
    const op = operator.exec(command);
    if (op) {
      tokens.push({ kind: "op", text: op[0] });
      index += op[0].length;
      continue;
    }
    let end = index;
    let quote: string | null = null;
    while (end < command.length) {
      const current = command[end];
      if (quote) {
        if (current === quote) quote = null;
        end++;
        continue;
      }
      if (current === "'" || current === '"') {
        quote = current;
        end++;
        continue;
      }
      if (current === "\\") {
        end += 2;
        continue;
      }
      if (/\s/.test(current) || OPERATOR_CHARS.has(current)) break;
      end++;
    }
    if (end === index) {
      tokens.push({ kind: "word", text: command[index] });
      index++;
      continue;
    }
    tokens.push({ kind: "word", text: command.slice(index, end) });
    index = end;
  }
  return tokens;
}

/** Inside a word: a URL or a path leaf is the one specific thing (plain), a
 *  bare word is a plain argument, and only the directory part is dim. */
function innerSegments(text: string): BashSegment[] {
  if (URL_RE.test(text)) return [{ kind: "plain", text }];
  if (text.includes("/")) {
    const { dir, base } = splitDirBase(text);
    return [{ kind: "path", dir, base }];
  }
  return [{ kind: "plain", text }];
}

function wordSegments(word: string): BashSegment[] {
  const quoted = QUOTED_RE.exec(word);
  if (quoted) {
    const [, mark, inner] = quoted;
    return [{ kind: "dim", text: mark }, ...innerSegments(inner), { kind: "dim", text: mark }];
  }
  return innerSegments(word);
}

function argumentSegments(word: string): BashSegment[] {
  if (word === "-" || word === "--" || word.startsWith("-")) {
    const eq = word.indexOf("=");
    const value = eq > 0 ? word.slice(eq + 1) : "";
    if (value.includes("/")) {
      return [{ kind: "dim", text: word.slice(0, eq + 1) }, ...innerSegments(value)];
    }
    return [{ kind: "dim", text: word }];
  }
  if (NUMBER_RE.test(word)) return [{ kind: "dim", text: word }];
  if (word.startsWith("$") || word.startsWith("`")) return [{ kind: "dim", text: word }];
  return wordSegments(word);
}

/** Style plan for a bash/powershell row: the first word of each simple
 *  command is the command (bold), path leaves are plain, and the rest —
 *  operators, flags, numbers, expansions, directories — is dim. */
/** Style budget: rows truncate to the terminal width, so styling megabytes of
 *  a pathological command only burns repaint time (one margined call per
 *  token). Anything past this is one dim tail plus an ellipsis. */
const BASH_STYLE_BUDGET = 2048;

const BASH_STYLE_TOKENS = 192;

export function bashSegments(command: string): BashSegment[] {
  const text = command ?? "";
  const clipped = text.length > BASH_STYLE_BUDGET;
  const allTokens = tokenizeBash(clipped ? text.slice(0, BASH_STYLE_BUDGET) : text);
  const tokens = allTokens.slice(0, BASH_STYLE_TOKENS);
  // Skip classification of the overflow but keep its text: joining token
  // texts reproduces the summarized command exactly.
  const overflow = allTokens
    .slice(BASH_STYLE_TOKENS)
    .map((token) => token.text)
    .join("");
  const segments: BashSegment[] = [];
  let expectCommand = true;
  for (const token of tokens) {
    if (token.kind === "space") {
      segments.push({ kind: "space", text: " " });
      continue;
    }
    if (token.kind === "op") {
      segments.push({ kind: "op", text: token.text });
      if (CONTROL_OPS.has(token.text)) expectCommand = true;
      continue;
    }
    if (expectCommand) {
      const assignment = ASSIGNMENT_RE.exec(token.text);
      if (assignment) {
        // VAR=value before the command: the name carries the accent, the
        // assignment itself is metadata and stays quiet.
        segments.push({ kind: "accent", text: assignment[1] });
        segments.push({ kind: "dim", text: `=${assignment[2]}` });
        continue;
      }
      segments.push({ kind: "cmd", text: token.text });
      expectCommand = false;
      continue;
    }
    segments.push(...argumentSegments(token.text));
  }
  if (overflow) segments.push({ kind: "dim", text: `${overflow.trimEnd()}…` });
  else if (clipped) segments.push({ kind: "dim", text: "…" });
  return segments;
}

/** Raw characters collapsed before the style budget applies. A row shows at
 *  most one line and styles at most `BASH_STYLE_BUDGET` characters, so
 *  collapsing more of a pathological command only costs the whole command on
 *  every repaint (33ms for a megabyte). */
const BASH_SUMMARY_WINDOW = 4096;

export function summarizeBashCommand(command: string): string {
  const text = command ?? "";
  return collapseWhitespace(text.length > BASH_SUMMARY_WINDOW ? text.slice(0, BASH_SUMMARY_WINDOW) : text);
}

export interface ReadLineParts {
  dir: string;
  base: string;
  range: string;
}

export function readLineParts(args: {
  path?: unknown;
  file_path?: unknown;
  offset?: number | null;
  limit?: number | null;
}): ReadLineParts {
  const raw = typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
  const { dir, base } = splitDirBase(raw);
  return { dir, base, range: formatLineRange(args?.offset, args?.limit) };
}

export function summarizeArgs(args: unknown, maxChars = 80): string {
  if (args == null) return "";
  if (typeof args === "string") return truncateEnd(collapseWhitespace(args), maxChars);
  if (typeof args !== "object") return truncateEnd(collapseWhitespace(String(args)), maxChars);
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  const pairs = entries.map(([key, value]) => {
    // A row shows 80 characters: stringify the head of a long string instead
    // of a megabyte of it (a file body costs ~3ms per repaint otherwise).
    const shown = JSON.stringify(typeof value === "string" ? value.slice(0, 256) : value);
    return `${key}=${shown ?? String(value)}`;
  });
  return truncateEnd(pairs.join(" "), maxChars);
}

export function extractThinkingText(message: {
  role?: unknown;
  content?: unknown;
}): string | undefined {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const blocks: string[] = [];
  for (const block of message.content) {
    const candidate = block as { type?: unknown; thinking?: unknown } | null | undefined;
    if (
      candidate?.type === "thinking" &&
      typeof candidate.thinking === "string" &&
      candidate.thinking.trim()
    ) {
      blocks.push(candidate.thinking);
    }
  }
  if (blocks.length === 0) return undefined;
  return blocks.join("\n\n");
}

export function findLatestThinkingText(
  entries: Array<{ type?: unknown; message?: unknown }> | undefined | null,
): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") continue;
    const thinking = extractThinkingText(entry.message as { role?: unknown; content?: unknown });
    if (thinking) return thinking;
  }
  return undefined;
}

/** Does anything visible render ABOVE this message's first tool call?
 *  Mirrors Pi's own test in AssistantMessageComponent (trimmed text or
 *  trimmed thinking), so tool rows may merge across turns only when no
 *  visible block would be left between them. Content after the first tool
 *  call renders below the rows and does not split them. */
export function hasLeadingVisibleContent(message: {
  role?: unknown;
  content?: unknown;
}): boolean {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return false;
  for (const block of message.content) {
    const candidate = block as
      | { type?: unknown; text?: unknown; thinking?: unknown }
      | null
      | undefined;
    if (candidate?.type === "toolCall") return false;
    if (candidate?.type === "text" && typeof candidate.text === "string" && candidate.text.trim()) {
      return true;
    }
    if (
      candidate?.type === "thinking" &&
      typeof candidate.thinking === "string" &&
      candidate.thinking.trim()
    ) {
      return true;
    }
  }
  return false;
}

/** Exact width for the one-line thinking label. The label renders inside a
 *  Text with outputPad (each side) inside the transcript ScrollView, which
 *  reserves 1 column for the always-on scrollbar — so exactly
 *  columns-1-2*outputPad. Shorter leaves the count short of the right edge,
 *  longer wraps the tail onto a second line. Measured against the real
 *  components. */
export function labelBudget(stdoutColumns?: unknown, outputPad = 1): number {
  const cols =
    typeof stdoutColumns === "number" && stdoutColumns > 0 ? Math.floor(stdoutColumns) : 80;
  const pad = outputPad === 0 ? 0 : 1;
  // Pi renders at the terminal width, and the label sits in a Text with `pad`
  // columns on each side. One column is held back on purpose: a label built
  // for a wider terminal (before a resize) must not exactly fill the line,
  // or Text word-wraps the trailing count onto a second line. The resize
  // relabel removes stale labels; this margin makes even a stale one safe.
  // Collapsed tool rows end their count on the same column (width-pad-1).
  return Math.max(16, cols - 1 - 2 * pad);
}

/** Right-align `right` within `width` after `left`, truncating left if needed. */
export function padLabel(left: string, right: string, width: number): string {
  const gap = width - left.length - right.length;
  if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;
  const maxLeft = Math.max(1, width - right.length - 4);
  return `${truncateMiddle(left, maxLeft)} ${right}`;
}

export function searchParts(args: {
  pattern?: unknown;
  path?: unknown;
}): { pattern: string; path: string } {
  return {
    pattern: typeof args?.pattern === "string" ? args.pattern : "",
    path: typeof args?.path === "string" ? args.path : "",
  };
}

export function lsParts(args: { path?: unknown }): { path: string } {
  return { path: typeof args?.path === "string" ? args.path : "" };
}

/** Ends an italic run from inside the label: Pi renders the hidden-thinking
 *  label as chalk.italic(theme.fg("thinkingText", label)) — the entire label
 *  — so the count can only escape the italic from within the string. It must
 *  NOT be a bare SGR 23: chalk 6 rewrites every close code it finds in its
 *  input into close+open, which would re-enable italic right after the reset.
 *  `23;23` is the same attribute twice, so chalk does not recognise it as a
 *  close, terminals process it left to right and end up italic-off, and it
 *  leaves the foreground color alone. Escape bytes add no visible width. */
const ITALIC_OFF = "\x1b[23;23m";

/** One-line thinking label sized to the live terminal: middle-truncated
 *  preview with the char count pinned right. No "Thinking" prefix — the
 *  row's position already says what it is. The preview is italic (Pi's
 *  wrapper); the count is not. */
export function thinkingLabelForWidth(thinking: string, stdoutColumns?: unknown, outputPad = 1): string {
  const width = labelBudget(stdoutColumns, outputPad);
  const count = formatCharCount(thinking.length);
  const preview = thinkingPreview(thinking, Math.max(8, width - count.length - 1));
  const padded = padLabel(preview, count, width);
  // padLabel always ends with the count; re-insert it after the italic off.
  return `${padded.slice(0, padded.length - count.length)}${ITALIC_OFF}${count}`;
}

export function textCharCount(
  blocks: Array<{ type?: unknown; text?: unknown }> | undefined | null,
): number {
  if (!Array.isArray(blocks)) return 0;
  let total = 0;
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") total += block.text.length;
  }
  return total;
}

/** Best one-line summary of arbitrary tool args, for tools that ship no
 *  collapse renderer of their own (extension and MCP tools). Prefers the
 *  argument that reads like an intent, then falls back to the first string. */
export function genericToolSummary(args: unknown): string {
  const squash = (value: unknown): string =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const command = squash(record.command) || squash(record.cmd);
  if (command) return summarizeBashCommand(command);
  // Prompts and messages are multi-line: their first line is the intent.
  const firstLineOnly = new Set(["prompt", "message"]);
  for (const key of ["name", "description", "title", "query", "url", "path", "file_path", "pattern", "prompt", "message"]) {
    const raw = typeof record[key] === "string" ? (record[key] as string) : "";
    const value = squash(firstLineOnly.has(key) ? raw.split("\n")[0] : raw);
    if (value) return value.split(" ").slice(0, 12).join(" ");
  }
  for (const value of Object.values(record)) {
    const text = squash(value);
    if (text) return text.split(" ").slice(0, 12).join(" ");
  }
  return "";
}

/** Group history tool calls into shared runs, mirroring the live layout:
 *  contiguous own tools with no visible content between them share a run,
 *  so the rebuild renders them gapless. Anything visible (prose, thinking,
 *  foreign stock blocks, other roles) splits — merging across it would lift
 *  rows above their own context. toolResult entries are skipped: they render
 *  inside the tool component, never between rows. Returns toolCallId groups
 *  in transcript order; entries the planner cannot place keep single runs. */
export function planToolRuns(
  entries: Array<{ type?: unknown; message?: unknown }> | undefined | null,
  isOwnTool: (name: string) => boolean,
): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  const boundary = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };
  const visible = (part: unknown): boolean => {
    if (!part || typeof part !== "object") return false;
    const block = part as { type?: unknown; text?: unknown; thinking?: unknown };
    if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
    if (block.type === "thinking") return typeof block.thinking === "string" && block.thinking.trim().length > 0;
    return false;
  };
  if (!Array.isArray(entries)) return groups;
  for (const entry of entries) {
    if (!entry || entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (!message || typeof message !== "object") continue;
    if (message.role === "toolResult") continue;
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      boundary();
      continue;
    }
    // Visible content before the last tool call of this message splits;
    // trailing content renders below the rows and changes nothing.
    const parts = message.content;
    let lastTool = -1;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as { type?: unknown } | undefined;
      if (part?.type === "toolCall") lastTool = i;
    }
    let seenTool = false;
    let splitBeforeNextTool = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as { type?: unknown; id?: unknown; name?: unknown } | undefined;
      if (part?.type === "toolCall") {
        if (splitBeforeNextTool) {
          boundary();
          splitBeforeNextTool = false;
        }
        const id = typeof part.id === "string" && part.id ? part.id : undefined;
        const name = typeof part.name === "string" ? part.name : "";
        if (id && isOwnTool(name)) {
          current.push(id);
          seenTool = true;
        } else if (id) {
          // Foreign tools render their own stock block: rows never span it.
          boundary();
        }
        continue;
      }
      if (visible(part) && i < lastTool) {
        if (seenTool) splitBeforeNextTool = true;
        else boundary();
      }
    }
  }
  boundary();
  return groups;
}

/** Detach-safety predicate: detaching this assistant component from the
 *  transcript tree hides nothing but hidden-thinking label rows (plus the
 *  ignorable blank spacers Pi puts around them). Mirror of
 *  AssistantMessageComponent.updateContent: text renders per non-blank
 *  block; consecutive thinking blocks coalesce into runs (blank-only runs
 *  are skipped and never consume a run index); toolCall/image blocks never
 *  render; length/aborted/error lines render per stopReason. Requires at
 *  least one hidden thinking run, otherwise there is nothing to hide.
 */
export function isSafeToDetach(
  message: {
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    stopReason?: string;
  } | null | undefined,
  hideThinkingBlock: boolean,
  thinkingVisibilityOverrides?: Map<number, boolean> | Record<number, boolean> | null,
): boolean {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  let hasVisibleText = false;
  let hasToolCalls = false;
  let runIndex = 0;
  let hiddenRuns = 0;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block?.type === "text" && (block.text ?? "").trim() !== "") {
      hasVisibleText = true;
    } else if (block?.type === "toolCall") {
      hasToolCalls = true;
    } else if (block?.type === "thinking") {
      let nonBlank = false;
      for (; i < content.length; i++) {
        const peer = content[i];
        if (peer?.type !== "thinking") break;
        if ((peer.thinking ?? "").trim() !== "") nonBlank = true;
      }
      i--;
      if (!nonBlank) continue;
      const override =
        thinkingVisibilityOverrides instanceof Map
          ? thinkingVisibilityOverrides.get(runIndex)
          : thinkingVisibilityOverrides?.[runIndex];
      if ((override ?? hideThinkingBlock) !== true) return false;
      runIndex++;
      hiddenRuns++;
    }
  }
  if (hasVisibleText) return false;
  if (hiddenRuns === 0) return false;
  if (message?.stopReason === "length") return false;
  if (!hasToolCalls && (message?.stopReason === "aborted" || message?.stopReason === "error")) return false;
  return true;
}
