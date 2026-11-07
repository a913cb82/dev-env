# Worktrees

One folder per explorer. Delete it after harvest. Git commands below are one way to do this. The rules apply with any version control.

## Detached explorers

- Add each tree detached: `git worktree add --detach <path>`.
- Never share a tree between explorers.
- Do not create a branch for untested code.
- Keep each explorer in its tree. It never enters your tree. You never enter its tree mid-test.

## Your tree

- Stay on the loop branch the whole run.
- To include `main`, run `git merge main` while you stay on the loop branch.
- Check the change size first. Then copy the explorer commit to your branch. Keep commits in one straight line.
- Push the loop branch. Never push `main` or tags. Tags stay local.

## Harvest (numbered — follow in order)

1. Copy the explorer commit to the loop branch: `git cherry-pick <hash>`. Keep commits in one straight line.
2. Copy notes out: `cp <work-area>/NOTES.md notes/<idea>-<n>.md`.
3. Check the file exists. Use one notes name per explorer.
4. Remove the tree: `git worktree remove <work-area>`.
5. Untracked notes die with the tree. Never remove first.

## One idea per commit

- A diff that shows two ideas gets dropped. (Doctrine: `QUEUE.md` header.)

File-per-entry domains only: copy the best files to a new name, add one idea to the copy, delete the old files. Never edit the old files in place.
