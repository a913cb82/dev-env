# Progress row schema

One `PROGRESS.jsonl` row per decision (`decision`: `baseline`, `keep`, `discard`, `stale`, `holdout`):

```json
{"date":"2025-01-02","idea":"cache lookups","decision":"keep","why":"confirmed","sha":"ab12cd3","tree":"9f8e7d6","runs":[4.10,4.02],"score":4.06,"champion":"ab12cd3","learned":"Lookups dominate the profile; caching cut them."}
```

Fields: `date`, `idea`, `decision`, `why`, `sha` (landed commit), `tree` (its tree), `runs` (exam scores), `score` (mean), `champion` (loop HEAD after decision), `learned` (one line for future briefs).
