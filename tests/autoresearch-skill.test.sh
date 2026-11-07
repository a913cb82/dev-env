#!/usr/bin/env bash
# Guard for autoresearch skill slimming: the skill must still describe the
# full process. If this fails after editing SKILL.md, the slim cut too much.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL="$REPO/pi/agent/skills/autoresearch/SKILL.md"
fails=0
need() { grep -qi -- "$2" "$SKILL" || { echo "FAIL: missing $1 ($2)"; fails=$((fails+1)); }; }
need "target/frozen" "target.*frozen\|frozen.*target"
need "gate" "gate"
need "exam SCORE" "SCORE <number>"
need "direction" "direction"
need "holdout" "holdout"
need "explorers parallel" "explorers"
need "candidate budget" "candidate budget"
need "explorer budget" "explorer budget"
need "margin noise" "margin.*max.*noise\|noise.*margin"
need "baseline 3 runs" "baseline"
need "queue best-first" "QUEUE.md.*best\|best.*first"
need "worktree detach" "worktree add --detach"
need "brief" "BRIEF.md"
need "land.sh usage" "land.sh.*WORKTREE.*BASE.*CHAMPION\|land.sh <worktree>"
need "conflict handling" "conflict"
need "duplicate/seen handling" "duplicate\|already appears\|seen"
need "gate+exam validate" "Gate.*Exam\|Validate"
need "confirm two runs" "again.*-2.log\|mean of both\|confirm"
need "ff-only keep" "--ff-only"
need "progress record" "PROGRESS.jsonl"
need "lost crashed" "lost.*cancelled\|cancelled.*crashed\|lost"
need "restart recovery" "restart.*re-read\|re-read.*worktree list"
need "run dir outside repo" "outside the repo"
need "exam fixed per run" "fixed per run dir\|new run dir"
need "never merge base" "Never merge into the base"
need "push only if asked" "Push only if asked"
need "explorers never exam" "never run the exam\|Never.*exam"
# templates still carry TODOs
grep -q TODO "$REPO/pi/agent/skills/autoresearch/templates/EXAM.md" || { echo "FAIL: EXAM.md lost TODOs"; fails=$((fails+1)); }
grep -q TODO "$REPO/pi/agent/skills/autoresearch/templates/QUEUE.md" || { echo "FAIL: QUEUE.md lost TODOs"; fails=$((fails+1)); }
grep -q TODO "$REPO/pi/agent/skills/autoresearch/templates/BRIEF.md" || { echo "FAIL: BRIEF.md lost TODOs"; fails=$((fails+1)); }
[ -x "$REPO/pi/agent/skills/autoresearch/scripts/land.sh" ] || { echo "FAIL: land.sh not executable"; fails=$((fails+1)); }
if [ "$fails" = 0 ]; then echo "PASS: autoresearch skill complete"; else exit 1; fi
