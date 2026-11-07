# Notes

Notes live in the run folder. Four stored files, one ephemeral prompt, one ad-hoc file.

## Files

Stored (required):

| Path | Role |
|---|---|
| `EXAM.md` | test config: command, budget, tag, gate, stop, baseline, noise, limits |
| `QUEUE.md` | live idea list (statuses plus doctrine header) |
| `WORKLOG.md` | one entry per round, never edited; verdicts cite `PROGRESS.jsonl` rows |
| `PROGRESS.jsonl` | one JSON line per round, append-only; spec in [exam](exam.md) |

Ephemeral (never stored): `BRIEF.md` — the spawn prompt; gate and baseline copied per spawn.

Ad-hoc: `RESEARCH.md` — create only for literature-heavy runs. Otherwise put one-line provenance (`source:`) in the `WORKLOG.md` learned line. A claim without a source is a rumor.

## QUEUE.md

One line per live idea. Statuses: `open`, `trying`, `done`, `dropped`, `parked`. Keep it in order. Promote the next idea on each finish. `trying` rows record owned files; reset to `open` on steer, cancel, or crash.

## WORKLOG.md

One entry per round. Schema in `templates/WORKLOG.md`. Never edit an old entry. Cite the `PROGRESS.jsonl` row; the entry holds verdict plus reasoning, never a second score ledger. Mark the queue row. Commit notes as `log: <idea>`.
