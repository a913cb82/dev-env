# Worktrees

Use one detached Git worktree per explorer. Each starts from the SHA in its brief; never reuse a tree after its target code changes.

## Rules

- Create a fresh tree: `git worktree add --detach <path> <start-commit>`.
- Explorers stay in their own tree and never enter yours; stay out of theirs while they work.
- Untested commits stay detached.
- Stay on the loop branch. Merge `main` before a run; do not merge or change the exam mid-run. Promote winners with one cherry-pick each. Push only the loop branch; tags stay local.

## Harvest

1. Copy `<worktree>/NOTES.md` to `<run-folder>/notes/<idea>-<attempt>.md`; verify it, then remove `NOTES.md` from the worktree. If missing, request it; if still absent, reject without scoring and record why.
2. Run guards and the exam before promotion; see [exam](exam.md).
3. If kept, cherry-pick the `exp:` commit. If rejected or stale, do not cherry-pick.
4. After notes are safe, remove the worktree with `git worktree remove --force <path>`.

On crash/cancel, do not test or promote any candidate, even if it committed. Copy and verify partial notes if present; if absent, note the crash. Add an unscored `WORKLOG.md` entry (`crash` or `cancel`), reset the queue row to `open` without incrementing attempts, then remove the dirty tree with `git worktree remove --force <path>`.

One idea per commit; drop mixed diffs. For file-per-entry domains, copy the best file to a new name, add one idea, then delete the old file. Never edit the old file in place.
