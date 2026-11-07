# Worktrees

One folder per explorer; delete after harvest. Git below is one way; the rules fit any version control.

## Detached explorers

- Add detached: `git worktree add --detach <path>`.
- Never share a tree between explorers.
- No branches for untested code.
- Explorers stay in their trees; you stay out mid-test.

## Your tree

- Stay on the loop branch the whole run.
- To include `main`: `git merge main`, staying put.
- Check size, then copy the commit over. One straight line.
- Push the loop branch. Never `main` or tags; tags stay local.

## Harvest (numbered — follow in order)

1. Cherry-pick the explorer commit: `git cherry-pick <hash>`. One straight line.
2. Copy notes out: `cp <work-area>/NOTES.md notes/<idea>-<n>.md`.
3. Confirm the file. One name per explorer.
4. Remove the tree: `git worktree remove <work-area>`.
5. Untracked notes die with the tree — never remove first.

## One idea per commit

- Mixed diffs get dropped. (Doctrine: `QUEUE.md` header.)

File-per-entry domains only: copy the best files to a new name, add one idea to the copy, delete the old files. Never edit the old files in place.
