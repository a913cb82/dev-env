/**
 * fullscreen-scroll: configurable mouse-wheel scroll speed for pi's fullscreen TUI.
 *
 * pi already supports per-tick line counts (`wheelScrollLines` on the fullscreen
 * screen) but never wires it to a setting — it hardcodes 1. This extension:
 *   1. Wraps two `InteractiveMode` prototype methods (same-process, live classes
 *      imported from pi's own bundle — no pi files touched, no hashed paths).
 *   2. Injects a "Fullscreen wheel scroll lines" choice row into /settings,
 *      spliced after "Fullscreen copy on select". Enter/click cycles values.
 *   3. Patches the fullscreen screen *prototype* once, so every current and
 *      future instance (including TUI mode switches) scrolls at the configured
 *      rate while preserving pi's alt+wheel fast-scroll multiplier behavior.
 *
 * Value lives in ~/.pi/agent/fullscreen-scroll.json (NOT settings.json, so pi's
 * settings read/write cycle can never strip or fight it).
 *
 * Upgrade contract (see zwkTripwire): every assumption about pi internals is
 * asserted at runtime. If a pi update changes the mechanism, the extension
 * degrades to stock pi behavior and complains LOUDLY (error banner + stderr)
 * instead of silently doing nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const ITEM_ID = "fullscreen-wheel-scroll-lines";
const ITEM_LABEL = "Fullscreen wheel scroll lines";
const CHOICES = ["1", "2", "3", "4", "5", "6", "8", "10"];
const DEFAULT_LINES = 3;
const MIN_LINES = 1;
const MAX_LINES = 100;
const STORE_FILE =
  process.env.PI_FULLSCREEN_SCROLL_STORE ??
  path.join(os.homedir(), ".pi", "agent", "fullscreen-scroll.json");
const GLOBAL_KEY = "__piFullscreenWheelScroll";
const MODE_WRAPPED = Symbol.for("pi.fullscreenScroll.modeWrapped");
const MOUNT_WRAPPED = Symbol.for("pi.fullscreenScroll.mountWrapped");
const INIT_WRAPPED = Symbol.for("pi.fullscreenScroll.initWrapped");
const LAST_MODE_KEY = "__piFullscreenWheelScrollMode";
const SCROLL_PATCHED = Symbol.for("pi.fullscreenScroll.scrollPatched");
const SCROLL_ORIG = Symbol.for("pi.fullscreenScroll.scrollOrig");
const EXT_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "fullscreen-scroll.ts");
/**
 * Matches a *native* wheel-scroll row (any id but ours). Deliberately does NOT
 * match pi's existing "fullscreen-scrollbar" (scrollbar behavior, unrelated).
 */
const NATIVE_PATTERN = /wheel|scroll[-_ ]?(lines|speed)|lines[-_ ]?per/i;

type Shared = {
  lines: number;
  notifier: (message: string) => void;
  lastFailure: string | null;
  /** Set when pi (or another extension) provides its own wheel-scroll row. */
  nativeDetected: string | null;
  /** Alt-screen prototypes we patched (for rollback on native detection). */
  patchedProtos: AnyRecord[];
};

function shared(): Shared {
  const g = globalThis as Record<string, unknown>;
  let s = g[GLOBAL_KEY] as Shared | undefined;
  if (!s) {
    s = { lines: loadLines(), notifier: defaultNotifier, lastFailure: null, nativeDetected: null, patchedProtos: [] };
    g[GLOBAL_KEY] = s;
  }
  if (!Array.isArray(s.patchedProtos)) s.patchedProtos = [];
  return s;
}

function defaultNotifier(message: string): void {
  // eslint-disable-next-line no-console
  console.error(`[fullscreen-scroll] ${message}`);
}

/** Loud failure: error banner in the TUI (when available) + stderr, always. */
function loud(message: string): void {
  const s = shared();
  s.lastFailure = message;
  // eslint-disable-next-line no-console
  console.error(`[fullscreen-scroll] BROKEN: ${message}`);
  try {
    s.notifier(`fullscreen-scroll extension broken: ${message}`);
  } catch {
    // Notifier itself must never break pi.
  }
}

function fail(msg: string): never {
  loud(msg);
  throw new Error(`[fullscreen-scroll] ${msg}`);
}

function loadLines(): number {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const n = Math.floor(Number((JSON.parse(raw) as { lines?: unknown })?.lines));
    if (Number.isFinite(n) && n >= MIN_LINES && n <= MAX_LINES) return n;
  } catch {
    // Missing or corrupt store -> default (a corrupt store is rewritten on next change).
  }
  return DEFAULT_LINES;
}

function saveLines(n: number): void {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, `${JSON.stringify({ lines: n })}\n`);
  } catch (e) {
    loud(`cannot write ${STORE_FILE}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Choice list for the /settings row: curated speeds plus the stored value if exotic. */
export function buildValues(stored: number): string[] {
  const set = new Set<string>(CHOICES);
  if (Number.isFinite(stored) && stored >= MIN_LINES && stored <= MAX_LINES) {
    set.add(String(Math.floor(stored)));
  }
  return [...set].sort((a, b) => Number(a) - Number(b));
}

/**
 * Locate pi's live bundle entry (stable path, no content hashes) from the
 * running process. Overridable for tests.
 */
export function locateBundleIndex(argv1 = process.argv[1]): string {
  if (!argv1) fail("cannot locate pi bundle: process.argv[1] is empty");
  // argv[1] is the *invoked* path: a global install is a bin symlink
  // (bin/pi -> ../lib/node_modules/<pkg>/dist/bundle/cli.js), so resolve it
  // first and fall back to the raw path.
  const candidates: string[] = [];
  try {
    candidates.push(path.join(path.dirname(fs.realpathSync(argv1)), "index.js"));
  } catch {
    // realpath failed; raw path is still worth a try below.
  }
  candidates.push(path.join(path.dirname(argv1), "index.js"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  fail(`cannot locate pi bundle (tried ${candidates.join(", ")}) from argv[1]=${argv1}`);
}

type AnyRecord = Record<string | symbol, any>;

/** Duck-type: is this the live fullscreen screen (or a compatible successor)? */
function isAltScreen(renderer: unknown): renderer is AnyRecord {
  if (!renderer || (typeof renderer !== "object" && typeof renderer !== "function")) return false;
  const r = renderer as AnyRecord;
  return (
    typeof r.getWheelScrollLines === "function" && typeof r.wheelScrollLines === "number"
  );
}

/**
 * Patch the fullscreen screen prototype once so every instance scrolls at the
 * configured rate. Delegates to pi's own method with the field temporarily set,
 * which preserves pi's alt+wheel multiplier without hardcoding its value.
 */
/** Restore a patched prototype to pi stock (used by sanity-fail and native-detect). */
function unpatchScroll(proto: AnyRecord): void {
  if (proto?.[SCROLL_PATCHED] && typeof proto[SCROLL_ORIG] === "function") {
    proto.getWheelScrollLines = proto[SCROLL_ORIG];
  }
  if (proto) {
    delete proto[SCROLL_PATCHED];
    delete proto[SCROLL_ORIG];
  }
  const s = shared();
  s.patchedProtos = s.patchedProtos.filter((p) => p !== proto);
}

function ensureScrollPatch(renderer: unknown): "patched" | "already" | "not-alt-screen" | "native-present" {
  const s = shared();
  if (s.nativeDetected) return "native-present";
  if (!isAltScreen(renderer)) return "not-alt-screen";
  const proto = Object.getPrototypeOf(renderer) as AnyRecord;
  if (!proto || typeof proto.getWheelScrollLines !== "function") {
    fail("alt screen has getWheelScrollLines but its prototype does not (pi internals changed)");
  }
  if (proto[SCROLL_PATCHED]) return "already";
  const orig = proto.getWheelScrollLines;
  proto.getWheelScrollLines = function (button: unknown) {
    const prev = (this as AnyRecord).wheelScrollLines;
    (this as AnyRecord).wheelScrollLines = s.lines;
    try {
      return orig.call(this, button);
    } finally {
      (this as AnyRecord).wheelScrollLines = prev;
    }
  };
  proto[SCROLL_PATCHED] = true;
  proto[SCROLL_ORIG] = orig;
  if (!s.patchedProtos.includes(proto)) s.patchedProtos.push(proto);
  // Sanity: the patched method must report our rate for a plain wheel tick.
  // Button 0 has no alt bit, so this also verifies the method reads the field.
  const check = (renderer as AnyRecord).getWheelScrollLines(0);
  if (check !== s.lines) {
    unpatchScroll(proto);
    fail(
      `scroll patch sanity check failed: expected ${s.lines} lines, got ${check} (pi internals changed)`
    );
  }
  return "patched";
}

/**
 * pi (or another extension) grew its own wheel-scroll row: stand down fully —
 * no injection (avoids a duplicate) and no prototype patch (avoids shadowing
 * the native setting) — and tell the user to delete this extension.
 */
function onNativeDetected(nativeId: string): void {
  const s = shared();
  s.nativeDetected = nativeId;
  for (const proto of [...s.patchedProtos]) {
    try {
      unpatchScroll(proto);
    } catch {
      // Best effort; the flag below already stops future patching.
    }
  }
  loud(
    `pi now provides its own wheel-scroll setting (row "${nativeId}"); ` +
      `this extension is redundant and stands down so it cannot shadow the native setting. ` +
      `Delete ${EXT_PATH} and /reload to remove this notice.`
  );
}

function findNativeRow(list: AnyRecord): string | null {
  const hit = list.items.find(
    (i: unknown) =>
      typeof (i as AnyRecord)?.id === "string" &&
      (i as AnyRecord).id !== ITEM_ID &&
      NATIVE_PATTERN.test((i as AnyRecord).id)
  ) as AnyRecord | undefined;
  return hit?.id ?? null;
}

/** Remember the live InteractiveMode so session_start can patch a pre-mounted renderer (e.g. /reload). */
function rememberMode(mode: unknown): void {
  if (!mode || (typeof mode !== "object" && typeof mode !== "function")) return;
  try {
    (globalThis as Record<string, unknown>)[LAST_MODE_KEY] = mode;
  } catch {
    // Global stash must never break pi.
  }
}

function patchModeRenderer(mode: unknown, where: string): void {
  if (mode == null) return;
  rememberMode(mode);
  try {
    ensureScrollPatch((mode as AnyRecord)?.renderer);
  } catch (e) {
    loud(`scroll patch failed ${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Patch the remembered mode, if any (covers /reload where mount already happened). */
function patchRememberedMode(where: string): void {
  try {
    const mode = (globalThis as Record<string, unknown>)[LAST_MODE_KEY];
    if (mode) patchModeRenderer(mode, where);
  } catch {
    // Best effort only.
  }
}

/** Duck-type: is this component the /settings dialog? */
function getSettingsList(component: unknown): AnyRecord | null {
  const list = (component as AnyRecord)?.getSettingsList?.();
  if (!list || !Array.isArray(list.items) || typeof list.onChange !== "function") return null;
  return list as AnyRecord;
}

function injectSettingsItem(list: AnyRecord): "injected" | "already" {
  const s = shared();
  if (list.items.some((i: unknown) => (i as AnyRecord)?.id === ITEM_ID)) {
    list.updateValue?.(ITEM_ID, String(s.lines));
    return "already";
  }
  const item = {
    id: ITEM_ID,
    label: ITEM_LABEL,
    description:
      `Mouse wheel scroll speed in fullscreen mode, in lines per tick (default ${DEFAULT_LINES}). Applies immediately.`,
    currentValue: String(s.lines),
    values: buildValues(s.lines),
  };
  const anchor = list.items.findIndex((i: unknown) => (i as AnyRecord)?.id === "fullscreen-copy-on-select");
  if (anchor === -1) list.items.push(item);
  else list.items.splice(anchor + 1, 0, item);

  // Intercept selections of our row; delegate everything else untouched.
  const origOnChange = list.onChange.bind(list);
  list.onChange = (id: unknown, value: unknown) => {
    if (id === ITEM_ID) {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n >= MIN_LINES && n <= MAX_LINES) {
        s.lines = n;
        saveLines(n);
      }
      list.updateValue?.(ITEM_ID, String(s.lines));
      return;
    }
    return origOnChange(id, value);
  };
  return "injected";
}

function onSelectorCreated(mode: unknown, component: unknown): void {
  patchModeRenderer(mode, "on selector open");
  if (component == null) return;
  try {
    const list = getSettingsList(component);
    // Not the settings dialog (model picker, tree, ...) — nothing to do.
    if (!list) return;
    const nativeId = shared().nativeDetected ?? findNativeRow(list);
    if (nativeId) {
      // Nag on every /settings open until the extension is deleted.
      onNativeDetected(nativeId);
      return;
    }
    injectSettingsItem(list);
  } catch (e) {
    loud(`/settings injection failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function loadInteractiveMode(): Promise<AnyRecord> {
  const bundleIndex = locateBundleIndex();
  let mod: AnyRecord;
  try {
    // Native dynamic import: resolves through Node's ESM cache to the SAME
    // module instances pi itself runs (a static import would go through the
    // extension loader's transform pipeline and could yield dead copies).
    mod = (await import(pathToFileURL(bundleIndex).href)) as AnyRecord;
  } catch (e) {
    fail(`cannot import pi bundle at ${bundleIndex}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const IM = mod.InteractiveMode;
  if (typeof IM !== "function") fail("pi bundle no longer exports InteractiveMode (pi internals changed)");
  const proto = IM.prototype as AnyRecord;
  if (typeof proto?.showSelector !== "function" || typeof proto?.switchTuiMode !== "function") {
    fail("InteractiveMode.prototype lost showSelector/switchTuiMode (pi internals changed)");
  }
  return proto;
}

/** Wrap prototype methods idempotently (survives /reload: guards live on the prototype). */
function wrapModeMethods(proto: AnyRecord): void {
  // Separate guards per method so installs from before mount/init wrapping
  // upgrade cleanly on /reload instead of skipping the new wrappers.
  if (!proto[MODE_WRAPPED] && typeof proto.showSelector === "function" && typeof proto.switchTuiMode === "function") {
    const origShowSelector = proto.showSelector;
    proto.showSelector = function (factory: unknown) {
      return origShowSelector.call(this, (done: unknown) => {
        const mode = this;
        let created: AnyRecord;
        try {
          created = (factory as (d: unknown) => AnyRecord)(done);
        } catch (e) {
          // Never break dialog creation; complain loudly instead.
          loud(`selector factory threw (pi internals changed?): ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
        try {
          onSelectorCreated(mode, created?.component);
        } catch (e) {
          loud(`selector hook failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return created;
      });
    };
    const origSwitchTuiMode = proto.switchTuiMode;
    proto.switchTuiMode = function (...args: unknown[]) {
      const result = origSwitchTuiMode.apply(this, args);
      patchModeRenderer(this, "after TUI mode switch");
      return result;
    };
    proto[MODE_WRAPPED] = true;
  }
  // Patch at mount: this is the earliest hook with a live renderer. The
  // constructor already created this.renderer, so patching here covers cold
  // start without waiting for the first /settings open.
  if (!proto[MOUNT_WRAPPED] && typeof proto.mountInteractiveTui === "function") {
    const origMount = proto.mountInteractiveTui;
    proto.mountInteractiveTui = function (...args: unknown[]) {
      const result = origMount.apply(this, args);
      patchModeRenderer(this, "after mount");
      return result;
    };
    proto[MOUNT_WRAPPED] = true;
  }
  // Patch at init too (belt and suspenders): init runs once per startup after
  // the constructor, so even if mount is renamed/removed the patch still lands.
  if (!proto[INIT_WRAPPED] && typeof proto.init === "function") {
    const origInit = proto.init;
    proto.init = async function (...args: unknown[]) {
      patchModeRenderer(this, "before init");
      try {
        return await origInit.apply(this, args);
      } finally {
        patchModeRenderer(this, "after init");
      }
    };
    proto[INIT_WRAPPED] = true;
  }
}

async function verifyInteractive(): Promise<void> {
  const proto = await loadInteractiveMode();
  wrapModeMethods(proto);
  // /reload case: mount/init already ran long ago, but the live mode was
  // remembered by the pre-reload wrappers (globalThis survives reload).
  patchRememberedMode("on session start");
}

/** Test hooks (the extension loader only uses the default export). */
export const __fullscreenScrollTest = {
  buildValues,
  locateBundleIndex,
  isAltScreen,
  ensureScrollPatch,
  unpatchScroll,
  getSettingsList,
  injectSettingsItem,
  findNativeRow,
  onNativeDetected,
  onSelectorCreated,
  wrapModeMethods,
  loadInteractiveMode,
  loadLines,
  shared,
  patchModeRenderer,
  patchRememberedMode,
  verifyInteractive,
  ITEM_ID,
  MODE_WRAPPED,
  MOUNT_WRAPPED,
  INIT_WRAPPED,
  SCROLL_PATCHED,
  SCROLL_ORIG,
};

export default function fullscreenScroll(pi: ExtensionAPI): void {
  // Wrap as early as possible (factory load runs before InteractiveMode is
  // constructed), so the mount/init hooks catch the very first TUI startup.
  // session_start re-verifies (idempotent) for /reload upgrades.
  verifyInteractive().catch(() => {
    // loud() already reported; session_start will retry.
  });
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const s = shared();
    s.notifier = (message: string) => {
      try {
        ctx.ui.notify(message, "error");
      } catch {
        // Fall back to stderr (already logged by loud()).
      }
    };
    if (ctx.mode !== "tui") return; // print/json/rpc: dormant, quiet.
    s.lines = loadLines();
    try {
      await verifyInteractive();
    } catch (e) {
      // loud() already reported; keep the session usable (stock pi behavior).
    }
  });
}
