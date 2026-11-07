# Notes

Run-folder notes: four stored files, one ephemeral prompt, one ad-hoc file.

## Files

Stored (required):

| Path | Role |
|---|---|
| `EXAM.md` | test config, budget, tag, gate, stop, baseline, noise, limits |
| `QUEUE.md` | live idea list (statuses plus doctrine header) |
| `WORKLOG.md` | one entry per round, never edited; verdicts cite `PROGRESS.jsonl` rows |
| `PROGRESS.jsonl` | one JSON line per round, append-only; spec in [exam](exam.md) |

Ephemeral (never stored): `BRIEF.md` — the spawn prompt; gate and baseline copied per spawn.

Ad-hoc: `RESEARCH.md` — literature-heavy runs only. Else one-line `source:` in the `WORKLOG.md` learned line. A claim without a source is a rumor.

## QUEUE.md

One line per live idea (`open`, `trying`, `done`, `dropped`, `parked`). In order; promote on each finish. `trying` rows record owned files; reset to `open` on steer, cancel, or crash.

## WORKLOG.md

One entry per round, schema in the template, never edited. Cite the `PROGRESS.jsonl` row; the entry holds verdict plus reasoning, not a second ledger. Mark the row; commit `log: <idea>`.
