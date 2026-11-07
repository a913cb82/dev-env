# Setup

Do not spawn explorers until setup passes. Freeze target, exam, and inputs until the run ends.

## When

Start a new run if its config/log is missing, the target moved, or the exam or input set changed. Otherwise go to [run](run.md).

## Steps

1. Use a dedicated loop branch. If missing, run `git switch -c <loop-branch> main`; otherwise run `git switch <loop-branch> && git merge main`. Never run on `main`.
2. From the target repository root, set `SKILL_DIR` to the directory containing this `SKILL.md`. Create the run folder and copy templates without overwriting existing files:
   `SKILL_DIR="/path/to/autoresearch" && RUN="$(pwd)/runs/<date>-<slug>" && mkdir -p "$RUN/notes" && cp -n "$SKILL_DIR"/templates/EXAM.md "$SKILL_DIR"/templates/QUEUE.md "$SKILL_DIR"/templates/WORKLOG.md "$SKILL_DIR"/templates/PROGRESS.jsonl "$RUN/"`
   The run folder must be in the coordinator tree, outside candidate worktrees.
3. Fill `EXAM.md` with target, frozen paths, commands, pass rule, score direction, tie rule, fixed inputs, and tag. Seed `QUEUE.md` with ordered ideas, evidence, and owned-file slots.
4. Run the exam on unchanged code at least 3 times on one machine with the same inputs. Baseline is the mean; noise floor is `max(score) - min(score)`. Record both in `EXAM.md`. The baseline is the initial champion, ID `<target>-<short baseline SHA>`; leave `PROGRESS.jsonl` empty. Include baseline and noise in each brief.
5. Create a temporary detached worktree at the baseline commit (`git worktree add --detach <probe-path> <baseline-SHA>`). Install dependencies, build, verify the gate, and estimate one explorer's peak resource use; remove it with `git worktree remove --force <probe-path>`. Set share, exam reserve, explorer peak, and N: `N = floor((share - exam reserve) / explorer peak)`. Start at 1. If N is 0, reduce load or use a larger machine. Keep one spare worktree path available; create a fresh tree at each explorer's start commit.
6. Fill `EXAM.md`'s forbidden list with past failures. `BRIEF.md` is an ephemeral spawn prompt, not a stored file.

## Exit checklist

- [ ] `EXAM.md` is complete; gate passes in a fresh tree and the exam runs end to end on baseline.
- [ ] Baseline/noise use at least 3 same-machine runs on the fixed inputs.
- [ ] Run folder has filled `EXAM.md` and `QUEUE.md`, the `WORKLOG.md` template, `notes/`, and empty `PROGRESS.jsonl`.
- [ ] The probe worktree builds; N fits the resource budget and one spare path is available.
- [ ] A patch-id is scored once, apart from one close-call repeat; notes-only commits get no exam.
