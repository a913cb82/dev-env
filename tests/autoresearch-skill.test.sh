#!/usr/bin/env bash
# Guard: autoresearch stays at the minimum — parallel generators, inline
# serial scoring, database priors. Fails if required elements are lost
# or if pruned machinery (queues, probe, slot math) creeps back in.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SK="$REPO/pi/agent/skills/autoresearch/SKILL.md"
fails=0
need() { grep -qi -- "$2" "$SK" || { echo "FAIL: missing $1 ($2)"; fails=$((fails+1)); }; }
need "target/frozen" "target.*frozen\|frozen.*target"
need "exam SCORE" "SCORE <number>"
need "direction" "direction"
need "holdout" "holdout"
need "explorers parallel" "explorers"
need "candidate budget" "candidate budget"
need "explorer budget" "explorer budget"
need "margin noise" "margin.*max.*noise\|noise.*margin"
need "baseline runs" "baseline"
need "worktree detach" "worktree add --detach"
need "brief" "BRIEF.md"
need "land.sh usage" "land.sh.*WORKTREE.*BASE.*CHAMPION\|land.sh <worktree>"
need "conflict handling" "conflict"
need "duplicate/seen handling" "duplicate\|already appears\|seen"
need "confirm two runs" "again.*-2.log\|mean of both\|confirm"
need "ff-only keep" "--ff-only"
need "progress database" "PROGRESS.jsonl"
need "lost crashed" "lost"
need "restart recovery" "restart.*re-read\|re-read.*worktree list"
need "run dir outside repo" "outside the repo"
need "exam fixed per run" "fixed per run dir\|new run dir"
need "never merge base" "Never merge into the base"
need "push only if asked" "Push only if asked"
need "database priors" "database"
need "diverse priors" "diverse\|subset\|best-per-metric\|per-metric"
need "thinking levels" "thinking"
need "priors with scores" "priors.*score\|score.*priors"
need "prior logs" "prior.*log\|log.*prior\|results.*log"
need "focused diffs" "SEARCH/REPLACE\|focused.*change\|commits are diffs"
need "cascade stages" "cascade\|cheap.*expensive\|stages"
need "qualitative checks" "qualitative\|model-graded"
need "evolve blocks" "EVOLVE-BLOCK\|blocks"
need "search program unit" "search program\|search heuristic\|time budget"
need "lineage" "lineage\|priors used\|which priors"
need "no human queue" "without.*queue\|no queue\|no human queue\|draft.*from.*database\|database.*draft"
need "serial scoring" "one at a time\|serial"
need "timeout stale" "timeout.*stale"
# pruned machinery must stay out
gone() { if grep -qi -- "$2" "$SK"; then echo "FAIL: bloatback $1 ($2)"; fails=$((fails+1)); fi; }
gone "jobs queue" "jobs\.md"
gone "evals queue" "evals\.md"
gone "slot caps" "EVAL_SLOTS\|MAXW"
gone "probe script" "probe\.sh"
gone "live gate" "load1\|loadavg"
gone "backpressure" "backpressure\|backlog"
[ ! -e "$REPO/pi/agent/skills/autoresearch/templates/QUEUE.md" ] || { echo "FAIL: QUEUE.md back"; fails=$((fails+1)); }
[ ! -e "$REPO/pi/agent/skills/autoresearch/scripts/probe.sh" ] || { echo "FAIL: probe.sh back"; fails=$((fails+1)); }
[ ! -e "$REPO/pi/agent/skills/autoresearch/references/pipeline.md" ] || { echo "FAIL: pipeline.md back"; fails=$((fails+1)); }
[ ! -e "$REPO/tests/autoresearch-probe.test.sh" ] || { echo "FAIL: probe test back"; fails=$((fails+1)); }
grep -q TODO "$REPO/pi/agent/skills/autoresearch/templates/EXAM.md" || { echo "FAIL: EXAM.md lost TODOs"; fails=$((fails+1)); }
grep -q TODO "$REPO/pi/agent/skills/autoresearch/templates/BRIEF.md" || { echo "FAIL: BRIEF.md lost TODOs"; fails=$((fails+1)); }
[ -x "$REPO/pi/agent/skills/autoresearch/scripts/land.sh" ] || { echo "FAIL: land.sh not executable"; fails=$((fails+1)); }
if [ "$fails" = 0 ]; then echo "PASS: autoresearch skill minimal and complete"; else exit 1; fi
