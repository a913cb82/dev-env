/** Tiny tree-shape helpers shared by the wrap and detach passes.
 *
 *  Pi's components are duck-typed by class name, never `instanceof`: jiti
 *  loads modules more than once, so an instance can come from a different
 *  module copy. dist ships unminified, so constructor names hold; anything
 *  unrecognised fails closed (callers treat it as opaque content).
 */

/** Class name of a node, or undefined when the shape is unreadable. */
export function classNameOf(node: unknown): string | undefined {
  try {
    if (!node || typeof node !== "object") return undefined;
    const name = (node as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** A pi-tui `Spacer`: renders exactly one blank line, carries no content. */
export function isSpacerLike(node: unknown): boolean {
  return classNameOf(node) === "Spacer";
}
