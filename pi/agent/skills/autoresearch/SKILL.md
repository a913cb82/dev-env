---
name: autoresearch
description: Improve code through isolated experiments scored by a fixed exam. Use subagents to explore; the coordinator measures and keeps winners.
---

# autoresearch

Use when code has a repeatable score. You coordinate and score; subagents explore and propose changes.

## Core loop

1. Set a target, frozen test, fixed inputs, baseline/noise bar, queue, and loop branch. See [setup](references/setup.md).
2. Give each explorer one idea and a private worktree. It runs only the blind gate and returns one code commit plus separate notes. See [run](references/run.md).
3. Check and score it yourself. Keep only gains larger than measured baseline noise; log the result and repeat.

## Never break

- Explorers never run the scored exam or read candidate scores. The coordinator chooses inputs and scores.
- Keep the exam and inputs fixed within a run; changes require a new run tag and folder.
- Untested code stays detached. Cherry-pick only tested winners to the loop branch, never the base ref.
- Keep score and decision logs append-only. Copy notes before removing a worktree.

Details: [scoring and guards](references/exam.md), [worktrees](references/worktrees.md). Copy the run templates during setup; use `BRIEF` for each explorer.
