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
const mode = fs.readFileSync('$ROOT/dist/modes/interactive/interactive-mode.js', 'utf8');
assert(mode.includes('chatContainer'), 'chatContainer anchor in interactive-mode');
assert(mode.includes('setHiddenThinkingLabel'), 'global label fan-out anchor in interactive-mode');
" || fail "Pi internals changed — see output above"

echo "PASS: pi internals"
