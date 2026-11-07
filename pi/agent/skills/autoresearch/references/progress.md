# Progress row schema (the database)

One `PROGRESS.jsonl` row per evaluation (`decision`: `baseline`, `keep`, `discard`, `stale`, `holdout`). Every evaluated row stays in the database, so subset-best lines remain available as future priors.

```json
{"date":"2025-01-02","idea":"cache lookups","decision":"keep","why":"confirmed","sha":"ab12cd3","tree":"9f8e7d6","runs":[4.10,4.02],"score":4.06,"metrics":{"lookup_ms":4.06},"priors":["9f8e7d6"],"champion":"ab12cd3","learned":"Lookups dominate the profile; caching cut them."}
```

Fields: `date`, `idea` (drafted from priors + code), `decision`, `why`, `sha` (landed commit), `tree` (its tree), `runs` (primary exam scores), `score` (their mean), `metrics` (per-name means, optional), `priors` (shas sampled for this attempt = lineage), `champion` (loop HEAD after decision), `learned` (one line for future briefs).
