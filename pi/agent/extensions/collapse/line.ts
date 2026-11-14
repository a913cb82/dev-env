// One collapsed line: the shared visual grammar for run headers, data rows,
// footers, and standalone thinking blocks. Kept separate from rows.ts so the
// label/detach path can render a block without importing the tool pipeline.
import { Markdown, Text, sliceByColumn, visibleWidth, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { ROW_RAIL, WHEEL_FRAMES, wheelFrameAt } from "./logic.js";
import { currentColumns } from "./settings.js";

const COUNT_GAP = 2;

/** Middle-truncate styled text to a visible width: keep the head and the
 *  tail around "…" (end truncation would eat the file name / command
 *  tail that identifies the row). Falls back to a plain slice when the
 *  budget is too small for both sides. */
function truncateMiddleWidth(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth < 4) return sliceByColumn(text, 0, Math.max(0, maxWidth));
  const keep = maxWidth - 1;
  const start = Math.ceil(keep / 2);
  const end = keep - start;
  return `${sliceByColumn(text, 0, start)}…${sliceByColumn(text, visibleWidth(text) - end, end)}`;
}

/** Markdown theme over the active theme. Pi's `getMarkdownTheme()` is
 *  global; this keeps the colors and decorations of the row's theme so the
 *  expanded thinking block matches the visible assistant block (and test
 *  themes keep their markers). Missing decorations degrade to plain text;
 *  syntax highlighting still comes from Pi's global highlighter. */
function thinkingMarkdownTheme(theme: Theme): MarkdownTheme {
  const source = theme as any;
  const fg = (token: string, text: string): string => {
    try {
      return typeof source?.fg === "function" ? source.fg(token, text) : text;
    } catch {
      return text;
    }
  };
  const decorate = (name: string, text: string): string => {
    try {
      return typeof source?.[name] === "function" ? source[name](text) : text;
    } catch {
      return text;
    }
  };
  let highlightCode: MarkdownTheme["highlightCode"];
  try {
    highlightCode = getMarkdownTheme().highlightCode;
  } catch {
    // No global theme/highlighter: plain code blocks are still readable.
  }
  return {
    heading: (text) => fg("mdHeading", text),
    link: (text) => fg("mdLink", text),
    linkUrl: (text) => fg("mdLinkUrl", text),
    code: (text) => fg("mdCode", text),
    codeBlock: (text) => fg("mdCodeBlock", text),
    codeBlockBorder: (text) => fg("mdCodeBlockBorder", text),
    quote: (text) => fg("mdQuote", text),
    quoteBorder: (text) => fg("mdQuoteBorder", text),
    hr: (text) => fg("mdHr", text),
    listBullet: (text) => fg("mdListBullet", text),
    bold: (text) => decorate("bold", text),
    italic: (text) => decorate("italic", text),
    strikethrough: (text) => decorate("strikethrough", text),
    underline: (text) => decorate("underline", text),
    ...(highlightCode ? { highlightCode } : {}),
  };
}

/** Expanded thinking text: the same Markdown renderer and thinking style Pi
 *  uses when thinking is visible. Falls back to plain text if the renderer
 *  cannot be constructed. */
export function thinkingMarkdown(text: string, pad: number, theme: Theme): Component {
  try {
    return new Markdown(text, pad, 0, thinkingMarkdownTheme(theme), {
      color: (value) => (typeof theme?.fg === "function" ? theme.fg("thinkingText", value) : value),
      italic: true,
    });
  } catch {
    return new Text(text, pad, 0);
  }
}

/** Single collapsed row: styled summary left, char count right-aligned.
 *  Fills to width-outputPad, not width: thinking rows are indented by
 *  Pi's outputPad, so their counts end at W-pad — ending tool rows there
 *  too keeps both counts on the same column. */
export class CollapsedLine implements Component {
  constructor(
    private left: string,
    private right: string,
    private pad = 1,
    private theme?: Theme,
    private live = false,
    private marker?: string,
  ) {}

  /** Column 1 carries the rail — or the wheel while live, or the
   *  run-level marker (`▸`/`▾` header, `▴` footer). With no pad there is
   *  no free cell before the content, but a marker/live control still owns
   *  column 1 and the content moves one cell in: an affordance the user can
   *  see beats preserving alignment on a header/footer-only line. A plain
   *  data row at outputPad=0 still starts on column 1. */
  private prefix(): string {
    const pad = " ".repeat(Math.max(0, this.pad));
    const glyph = this.marker ?? (this.live ? WHEEL_FRAMES[wheelFrameAt()]! : this.pad < 1 ? undefined : ROW_RAIL);
    if (glyph === undefined) return pad;
    const color = this.marker !== undefined ? "accent" : this.live ? "accent" : "dim";
    const styled = this.theme ? this.theme.fg(color, glyph) : glyph;
    return this.pad < 1 ? styled : styled + pad.slice(1);
  }

  render(width: number): string[] {
    // The thinking label is sized from the terminal columns, but Pi can hand
    // a component a width one column narrower. Both counts must land on the
    // same column, so derive the target from the SAME source the label uses
    // (labelBudget: pad + (cols-1-2*pad) is the label's last column), and
    // clamp to the render width so a narrower host never overflows.
    const cols = currentColumns();
    // Never render wider than the host asked for, even for a degenerate
    // width: Math.max(8, ...) used to overflow a very narrow pane.
    const target = Math.max(1, Math.min(width, (cols ?? width) - 1 - this.pad));
    // No trailing space after the rail: it occupies column 1 alone, so the
    // first content glyph still lands on column 2 — the column Pi's prose
    // (outputPad), hidden-thinking rows (Text pad) and stock tool cells
    // (Box(1, 1)) start on. A row therefore expands into its stock cell
    // without its text moving sideways, and the repeated rail groups a run.
    const prefix = this.prefix();
    const prefixWidth = visibleWidth(prefix);
    const rightWidth = visibleWidth(this.right);
    const leftWidth = visibleWidth(this.left);
    let left = this.left;
    const available = target - prefixWidth - rightWidth - COUNT_GAP;
    if (available >= 4 && leftWidth > available) {
      left = truncateMiddleWidth(this.left, available);
    }
    const gap = this.right ? Math.max(1, target - prefixWidth - visibleWidth(left) - rightWidth) : 0;
    const line = `${prefix}${left}${" ".repeat(gap)}${this.right}`;
    return [visibleWidth(line) > width ? sliceByColumn(line, 0, Math.max(0, width)) : line];
  }

  invalidate(): void {}
}
