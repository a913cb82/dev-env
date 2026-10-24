#!/usr/bin/env bash
# Guards the Pi internals the collapse extension depends on, resolved
# against the INSTALLED release (whatever `pi update` last installed).
# Run after every `pi update`: a failure means the extension's assumptions
# broke — rows fall back to stock rendering until they are re-mapped.
# (TDD: this pins today's shape; the tree-walk work will extend it.)
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }

if [ -n "${PI_ROOT:-}" ]; then
  ROOT="$PI_ROOT"
elif [ -f "$HOME/.pi/agent/install/current-version" ]; then
  v="$(cat "$HOME/.pi/agent/install/current-version")"
  ROOT="$HOME/.pi/agent/install/releases/$v/node_modules/@earendil-works/pi-coding-agent"
  [ -d "$ROOT" ] || fail "pinned release $v is not installed"
else
  bin="$(command -v pi || true)"
  [ -n "$bin" ] || fail "no Pi install found"
  ROOT="$(dirname "$(dirname "$(realpath "$bin")")")"
fi

node -e "
const C = require('$ROOT/dist/modes/interactive/components/assistant-message.js');
const TE = require('$ROOT/dist/modes/interactive/components/tool-execution.js');
const T = require('$ROOT/node_modules/@earendil-works/pi-tui/dist/index.js');
const fs = require('node:fs');
const assert = (cond, name) => { if (!cond) { console.error('missing: ' + name); process.exit(1); } };
const P = C.AssistantMessageComponent.prototype;
assert(typeof P.updateContent === 'function', 'AssistantMessageComponent.prototype.updateContent');
assert(Function.prototype.toString.call(P.updateContent).includes('hiddenThinkingLabel'), 'updateContent reads the thinking label');
assert(typeof P.setHiddenThinkingLabel === 'function', 'AssistantMessageComponent.prototype.setHiddenThinkingLabel');
assert(typeof P.invalidate === 'function', 'row invalidate (via Container chain)');
assert(typeof T.Container === 'function', 'pi-tui Container');
assert(typeof T.Container.prototype.addChild === 'function', 'Container.addChild');
assert(typeof T.Container.prototype.removeChild === 'function', 'Container.removeChild');
assert(Array.isArray(new T.Container().children), 'Container.children is a live array');
assert(typeof T.MouseRegion === 'function', 'pi-tui MouseRegion (thinking click-to-expand)');
const toolSrc = fs.readFileSync('$ROOT/dist/modes/interactive/components/tool-execution.js', 'utf8');
assert(typeof TE.ToolExecutionComponent === 'function', 'ToolExecutionComponent export');
assert(toolSrc.includes('this.toolCallId'), 'tool component exposes toolCallId (wrap identity)');
assert(toolSrc.includes('getRenderShell'), 'tool component exposes getRenderShell (self-shell gate)');
assert(toolSrc.includes('lines.push(\"\")'), 'self-shell render prepends one blank line (the stripped line)');
assert(toolSrc.includes('y - 1'), 'handleMouse delegates y-1 (click re-base anchor)');
assert(T.Spacer && T.Spacer.name === 'Spacer', 'pi-tui Spacer class name (glue scan identity)');
assert(T.Text && T.Text.name === 'Text', 'pi-tui Text class name (hidden-label identity)');
assert(T.Markdown && T.Markdown.name === 'Markdown', 'pi-tui Markdown class name (visible-thinking identity)');
assert(T.MouseRegion && T.MouseRegion.name === 'MouseRegion', 'pi-tui MouseRegion class name (label wrapper identity)');
const assistSrc = fs.readFileSync('$ROOT/dist/modes/interactive/components/assistant-message.js', 'utf8');
assert(assistSrc.includes('contentContainer'), 'assistant row exposes contentContainer (spacer surgery anchor)');
assert(assistSrc.includes('thinkingBlocks.length === 0'), 'no thinking region renders without text (no stock-label window)');
assert(assistSrc.includes('theme.italic(theme.fg(') && assistSrc.includes('hiddenThinkingLabel)), this.outputPad'), 'thinking label is italicized whole (count needs an in-label italic-off)');
// The extension puts the run rail in the hidden-label row's pad cell: that
// needs the pad to be emitted BEFORE the label's ANSI, and the row to stay
// exactly as wide as the stock one.
const TM = require('$ROOT/dist/modes/interactive/theme/theme.js');
TM.initTheme('light');
const trimAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const railMsg = { role: 'assistant', content: [{ type: 'thinking', thinking: 'weigh the options' }] };
const railRow = new C.AssistantMessageComponent(railMsg, true, undefined, 'RAIL-PROBE', 1, []);
const railLines = railRow.render(60);
const railLine = railLines.find((l) => trimAnsi(l).includes('RAIL-PROBE'));
assert(railLine !== undefined, 'hidden label renders a line');
// Pi marks message parts with OSC 133 (BEL-terminated); the pad cell
// follows the last mark, which is where the extension puts its rail.
const BEL = String.fromCharCode(7);
const padAt = railLine.lastIndexOf(BEL) + 1;
assert(railLine[padAt] === ' ', 'pad cell precedes the label ANSI (rail can replace it)');
assert(trimAnsi(railLine.slice(padAt)).indexOf('RAIL-PROBE') === 1, 'label text starts on column 2');
assert(T.visibleWidth(railLine) === 60, 'label row fills the render width');
// chalk 6 rewrites every copy of its own close code in its input into
// close+open, so a bare SGR 23 cannot end italic inside the label. The
// extension uses 23;23, which chalk leaves alone.
const chalkMod = require('$ROOT/node_modules/chalk/source/index.js');
const chalk = chalkMod.default ?? chalkMod;
chalk.level = 3;
const ESC = String.fromCharCode(27);
assert(chalk.italic('a' + ESC + '[23m' + 'b').includes(ESC + '[23m' + ESC + '[3m'), 'chalk re-opens after its own close code (bare SGR 23 is useless)');
assert(!chalk.italic('a' + ESC + '[23;23m' + 'b').includes(ESC + '[23;23m' + ESC + '[3m'), 'split italic-off is not rewritten by chalk (count leaves italic)');
const mode = fs.readFileSync('$ROOT/dist/modes/interactive/interactive-mode.js', 'utf8');
assert(mode.includes('chatContainer'), 'chatContainer anchor in interactive-mode');
assert(mode.includes('setHiddenThinkingLabel'), 'global label fan-out anchor in interactive-mode');
" || fail "Pi internals changed — see output above"

echo "PASS: pi internals"
