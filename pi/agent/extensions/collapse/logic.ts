// Pure formatting helpers for the collapse extension (collapsed tool and
// thinking rows). Dependency-free so tests load it without the Pi bundle.

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

export function thinkingPreview(text: string, maxChars = 64): string {
  return truncateMiddle(collapseWhitespace(text), maxChars);
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

export function summarizeBashCommand(command: string): string {
  // No fixed cap: the row component truncates to the live terminal width at
  // render time, so only collapse whitespace here. Truncating early would cut
  // commands on wide terminals that fit fine.
  return collapseWhitespace(command ?? "");
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
  const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`);
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

/** One-line thinking label sized to the live terminal: middle-truncated
 *  preview with the char count pinned right. No "Thinking" prefix — the
 *  row's position already says what it is. */
export function thinkingLabelForWidth(thinking: string, stdoutColumns?: unknown, outputPad = 1): string {
  const width = labelBudget(stdoutColumns, outputPad);
  const count = formatCharCount(thinking.length);
  const preview = thinkingPreview(thinking, Math.max(8, width - count.length - 1));
  return padLabel(preview, count, width);
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
