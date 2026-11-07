# Setup

Create one run. Freeze its target, exam, and inputs until it ends. Start a new run folder and run tag if any change.

1. Start with a clean tree. Choose the repo's default base ref: inspect `git symbolic-ref --short refs/remotes/origin/HEAD`, or choose explicitly if unset. Fetch first if using a remote-tracking ref. If the loop branch is missing, run `git switch -c <loop-branch> <base-ref>`. Otherwise run `git switch <loop-branch> && git merge <base-ref>`.
2. From the target repo root, set `SKILL_DIR` to the directory containing this `SKILL.md`. Copy only missing templates into an absolute run folder outside candidate worktrees:
   `SKILL_DIR="/path/to/autoresearch" && RUN="$(pwd)/runs/<date>-<slug>" && mkdir -p "$RUN/notes" && cp -n "$SKILL_DIR"/templates/EXAM.md "$SKILL_DIR"/templates/QUEUE.md "$SKILL_DIR"/templates/WORKLOG.md "$SKILL_DIR"/templates/PROGRESS.jsonl "$RUN/"`
3. Complete `EXAM.md`, including the chosen base ref. Fill `QUEUE.md` with ordered ideas, evidence, and owned-file slots.
4. Run the exam on unchanged code at least 3 times on one machine with the same inputs. Append each raw output and score to the `EXAM.md` result log, labeled with baseline ID and repeat number. Record the mean, baseline commit/ID, and `max(score)-min(score)` noise in `EXAM.md`. The baseline is the initial champion; leave `PROGRESS.jsonl` empty.
5. In a temporary detached worktree at the baseline commit, install dependencies, build, and verify the gate. Remove it. Start with one explorer; add workers only up to the `EXAM.md` cap and while the exam stays responsive. Keep one spare worktree path.

Setup passes when the exam runs on baseline, the gate passes in a fresh worktree, EXAM/QUEUE are filled, PROGRESS is empty, and the loop branch is ready.
