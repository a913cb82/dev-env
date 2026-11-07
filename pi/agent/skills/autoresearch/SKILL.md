---
name: autoresearch
description: Run parallel research explorers against a scored codebase. Use when you want many ideas tested at once with subagents while you orchestrate.
---

# autoresearch

You orchestrate. Subagents explore. You plan, launch, harvest, and decide. Start with one explorer; add only within the resource budget in `EXAM.md`.

## Two phases

- **Setup** defines the test, the notes, the work areas, and the baseline. See [setup](references/setup.md).
- **Run** picks ideas, briefs explorers, measures, and keeps winners. See [run](references/run.md).

If the run config/log is missing or the target, exam, or inputs changed, start a new setup. Do not spawn explorers before it passes.

## Rules

- Gate: explorers only. Exam: you only. Explorers never see scores. See [exam](references/exam.md).
- Use one fixed exam and input set for every candidate in a run.
- Keep untested code off branches. Only a tested change earns a branch or tag.


## Terms

- Winners live on the loop branch — never `main`.
- Prefix explorer-code commits with `exp:` and record-only commits with `log:`.

## References

- Setup: [setup](references/setup.md). Run: [run](references/run.md).
- Test: [exam](references/exam.md). Work areas: [worktrees](references/worktrees.md). Notes: [notes](references/notes.md).
- `templates/` holds starter files: stored `EXAM/QUEUE/WORKLOG/PROGRESS.jsonl`, ephemeral `BRIEF`. Copy them during setup.
