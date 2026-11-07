# Notes

## Files

Stored (required):

| Path | Role |
|---|---|
| `EXAM.md` | test config, budget, tag, gate, stop, baseline, noise, limits |
| `QUEUE.md` | live idea list (statuses plus doctrine header) |
| `WORKLOG.md` | one entry per candidate outcome, never edited; cites `PROGRESS.jsonl` IDs when scored |
| `PROGRESS.jsonl` | one JSON line per scored candidate, append-only; spec in [exam](exam.md) |

Exam output: `results.log` (append-only; path in `EXAM.md`).

Ephemeral (never stored): `BRIEF.md` — the spawn prompt; gate and baseline copied per spawn.

Ad-hoc: `RESEARCH.md` — literature-heavy runs only. Else use one-line `source:` in the `WORKLOG.md` learned line.

## QUEUE.md

One line per live idea (`open`, `trying`, `done`, `dropped`, `parked`). Keep order and source/evidence. `trying` rows list owned files; reset to `open` on steer, cancel, or crash.

## WORKLOG.md

One entry per candidate outcome, schema in the template, never edited. Cite the `PROGRESS.jsonl` result ID when scored; also log unscored rejections and crashes. Commit records as `log: <idea>`.
