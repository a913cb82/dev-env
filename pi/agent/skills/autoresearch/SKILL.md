---
name: autoresearch
description: Run parallel research explorers against a scored codebase. Use when you want many ideas tested at once with subagents while you orchestrate.
---

# autoresearch

You orchestrate. Subagents explore. You plan, launch, harvest, and decide. Use most of the computer power. Start with one explorer. Add more while the computer has room.

## Two phases

Do setup once. Then run the loop.

- **Setup** defines the test, the notes, the work areas, and the baseline. See [setup](references/setup.md).
- **Run** picks ideas, briefs explorers, measures, and keeps winners. See [run](references/run.md).

If the run folder, `EXAM.md`, or `PROGRESS.jsonl` is missing, do setup first. Do not spawn explorers before setup passes.

## Rules

- Gate: explorers only. Exam: you only. Explorers never see scores. See [exam](references/exam.md).
- Use one fixed exam per change.
- Keep untested code off branches. Only a tested change earns a branch or tag.

Details live in the references. This file stays short on purpose.

## Terms

- The loop branch holds winners. It is never `main`. Stay on it.
- `exp:` marks an explorer change. `log:` marks your notes change.

## References

- Setup: [setup](references/setup.md). Run: [run](references/run.md).
- Test: [exam](references/exam.md). Work areas: [worktrees](references/worktrees.md). Notes: [notes](references/notes.md).
- `templates/` holds starter files. Copy them during setup.
