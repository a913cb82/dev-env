# Worktrees

Use one detached worktree per explorer, created at the SHA in its brief:
`git worktree add --detach <path> <start-commit>`.

- Never share trees. Explorers stay in theirs; the coordinator stays out until they finish.
- Untested code stays detached. Only cherry-pick a tested winner to the loop branch.
- Merge the `EXAM.md` base ref before a run, not during it. Push only the loop branch.

## Harvest

1. Copy and verify `<worktree>/NOTES.md` at `<run-folder>/notes/<idea>-<attempt>.md`, then remove it from the worktree. If missing, request it; if still missing, reject without scoring and record why.
2. Run the guards and exam before promotion ([exam](exam.md)). If kept, cherry-pick the `exp:` commit; otherwise do not.
3. Remove the worktree with `git worktree remove --force <path>` after notes are safe.

On crash/cancel, do not test/promote even a committed candidate. Save partial notes if present; record an unscored `WORKLOG.md` outcome (`crash`/`cancel`), reset the queue row to `open`, and force-remove the dirty tree.
