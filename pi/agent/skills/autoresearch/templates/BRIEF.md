# Brief (one copy per explorer; paste into its task)

- Idea: TODO drafted from priors + code, no human queue
- Priors: TODO sampled sha/score/metrics/log from database; inspect via `git show <sha>` and `results/<sha>-1.log`
- Thinking: TODO level for this explorer (bulk low, breakthrough high)
- Worktree: TODO detached worktree path; work only here
- Start commit: TODO loop HEAD SHA
- Budget: stop coding after TODO; commit what you have
- Setup: TODO bootstrap command (fresh worktrees lack ignored dependencies)
- Stages: TODO cheap checks; run in order, stop at first fail
- Edit: TODO paths under target/blocks only; never touch frozen paths, the run dir, or other worktrees
- Format: focused hunks, one SEARCH/REPLACE-sized change each
- Commit: `exp: TODO idea`; then stop
- Report: candidate SHA, stage/score results, which priors were used
- Never: run the scoring exam, create branches or tags, push, or amend. May read prior results logs.
