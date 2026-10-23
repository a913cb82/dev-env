// Read-live Pi settings used by the renderers. Each helper takes `pi`
// explicitly: activations stay self-contained (no module-level api state), so
// a reload cannot leave an old instance writing through a stale reference.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Compact one-line rows only make sense in the hidden-thinking workflow:
 *  when thinking blocks are visible the transcript goes back to stock tool
 *  sections. Read live (per render) so the visibility toggle takes effect
 *  on the next update without a reload. Fail open: when the setting is
 *  unreadable, render stock. */
export function isHiddenThinking(pi: ExtensionAPI): boolean {
  try {
    return (pi?.getSettings?.()?.hideThinkingBlock ?? false) === true;
  } catch {
    return false;
  }
}

/** Pi's message indent (Text outputPad), read live per render/event.
 *  Takes pi explicitly — activations stay self-contained (no module state). */
export function liveOutputPad(pi: ExtensionAPI): number {
  try {
    const pad = pi?.getSettings?.()?.outputPad;
    return pad === 0 ? 0 : 1;
  } catch {
    return 1;
  }
}

/** Live terminal width (tty only). */
export function currentColumns(): number | undefined {
  return typeof process.stdout?.columns === "number" ? process.stdout.columns : undefined;
}

