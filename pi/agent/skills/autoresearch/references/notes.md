# Notes

Notes live in the run folder. Core files first. Rest as needed.

## Files

Required:

| Path | Role |
|---|---|
| `EXAM.md` | test config: command, budget, tag, gate, stop rule |
| `QUEUE.md` | live idea list |
| `WORKLOG.md` | one entry per round, never edited |
| `PROGRESS.jsonl` | one JSON line per round, append-only; spec in [exam](exam.md) |

As needed: `IDEAS.md` (doctrine plus parked backlog), `STRATEGY.md` (best plus baseline), `RESEARCH.md` (sources), `BRIEF.md` (brief template), `CEILING.md` (proved limits).

## QUEUE.md

One line per live idea. Statuses: `open`, `trying`, `done`, `dropped`, `parked`. Keep it in order. Promote the next idea on each finish.

Promotion rule: doctrine plus `parked` ideas live in `IDEAS.md`. Copy an idea into `QUEUE.md` when it becomes live. Statuses live in `QUEUE.md` only.

## WORKLOG.md

One entry per round. Never edit an old entry.

```md
## 1 — <idea> (<date>)
- commit: <short sha>
- score: <score> (spread if you have it)
- best: <value before this round>
- verdict: keep | discard | bold
- what changed: <one sentence>
- what you learned: <one or two sentences>
- next: <one idea>
```

Mark the queue row. Commit notes as `log: <idea>`.

## RESEARCH.md

```md
## <topic> (<date>)
- source: <url or repo path>
- claim: <one sentence>
- evidence: <what it shows>
- novelty: <prior plus why this differs; fill for bold ideas>
- idea: <what it suggests>
```

A claim without a source is a rumor.

## STRATEGY.md

- Best: what the winner does now.
- Baseline and noise floor: score, date, commit, bar, how measured.

## CEILING.md (optional)

- Fixed limits: timeouts, counts, resource rules.
- Proved limits: one line each, with the number and the run that proved it.
