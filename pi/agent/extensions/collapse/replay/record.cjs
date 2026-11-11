// Record a replay fixture from a real Pi session file.
//
// The session JSONL holds every entry; the driver replays message entries
// (+ visible customs) through the real components. Slice to the turns you
// care about — a whole session replays too, but a focused fixture reads
// better and keeps thinking text (sometimes megabytes) out of the repo.
//
// Usage:
//   node replay/record.cjs <session.jsonl> [--from N] [--to N] [--out <name>]
// Without --out it prints the entry summary so you can pick a range; with
// --out it writes replay/fixtures/<name>.json. Sanitize the fixture before
// committing (thinking blocks can carry secrets).
const path = require("node:path");
const fs = require("node:fs");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node replay/record.cjs <session.jsonl> [--from N] [--to N] [--out <name>]");
  process.exit(1);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const from = opt("--from") === undefined ? 0 : Number(opt("--from"));
const to = opt("--to") === undefined ? Infinity : Number(opt("--to"));
const out = opt("--out");

const kept = [];
const roles = {};
let index = -1;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    index++;
    if (index < from || index > to) continue;
    kept.push({ id: entry.id, type: "message", message: entry.message });
    const role = entry.message.role ?? "?";
    roles[role] = (roles[role] ?? 0) + 1;
  } else if (entry.type === "custom_message" && entry.display !== false) {
    index++;
    if (index < from || index > to) continue;
    kept.push(entry);
    roles.custom = (roles.custom ?? 0) + 1;
  }
}

console.log(`message entries: ${JSON.stringify(roles)} (range ${from}..${to === Infinity ? "end" : to})`);
kept.forEach((e, i) => {
  const m = e.message;
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
  const head = m.role === "user"
    ? JSON.stringify(blocks.map((b) => b.text ?? b.type).join(" ")).slice(0, 60)
    : blocks.map((b) => b.type === "toolCall" ? `tool:${b.name}` : b.type).join("+");
  console.log(`  [${from + i}] ${m.role} ${head.slice(0, 80)}`);
});

if (out) {
  const dest = out.includes("/") ? (out.endsWith(".json") ? out : `${out}.json`) : path.join(__dirname, "fixtures", `${out}.json`);
  const bytes = kept.reduce((n, e) => n + JSON.stringify(e).length, 0);
  if (bytes > 1024 * 1024) console.error(`warning: fixture is ${(bytes / 1048576).toFixed(1)}MB — slice tighter`);
  fs.writeFileSync(dest, JSON.stringify({ name: out, note: `Recorded from ${path.basename(file)}`, restore: kept }, null, 2));
  console.log(`wrote ${dest}`);
}
