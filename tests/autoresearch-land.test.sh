#!/usr/bin/env bash
# Tests for the autoresearch skill's landing script. Each case builds a
# throwaway repo with one explorer worktree, runs land.sh, and checks the
# single line it prints and its exit code. Run: bash tests/autoresearch-land.test.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAND="${LAND:-$REPO/pi/agent/skills/autoresearch/scripts/land.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0

# new_case NAME: a base commit on main, the loop branch, and an explorer
# worktree detached at the base. Sets RP (repo), WT (worktree), BASE.
new_case() {
  local d="$TMP/$1"
  RP="$d/repo"
  WT="$d/wt"
  mkdir -p "$RP/src" "$RP/shared"
  git -C "$RP" init -q -b main
  git -C "$RP" config user.email test@example.invalid
  git -C "$RP" config user.name test
  seq 1 30 | sed 's/^/line /' > "$RP/shared/limits.txt"
  printf 'a = 1\n' > "$RP/src/a.txt"
  printf 'b = 2\n' > "$RP/src/b.txt"
  printf 'frozen = yes\n' > "$RP/src/bench.txt"
  git -C "$RP" add -A
  git -C "$RP" commit -q -m base
  git -C "$RP" switch -q -c loop
  BASE=$(git -C "$RP" rev-parse HEAD)
  git -C "$RP" worktree add -q --detach "$WT" "$BASE"
}

wt_commit() { git -C "$WT" add -A && git -C "$WT" commit -q -m "$1"; }
champ_commit() { git -C "$RP" add -A && git -C "$RP" commit -q -m "$1"; }

# land ARGS...: runs land.sh, sets RC (exit code) and OUT (its output).
land() {
  RC=0
  OUT=$("$LAND" "$@" 2>&1) || RC=$?
}

# expect NAME RC PREFIX: checks the last land() result.
expect() {
  if [ "$RC" = "$2" ] && [[ "$OUT" == "$3"* ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1: want rc=$2 out starting [$3]; got rc=$RC out=[$OUT]"
    fails=$((fails + 1))
  fi
}

check() { # check NAME CONDITION-RESULT: a plain yes/no check
  if [ "$2" = yes ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}

# 1. One in-scope commit; champion is still the base, so nothing moves.
new_case ok
echo 'a = 5' > "$WT/src/a.txt"
wt_commit "exp: a"
SHA=$(git -C "$WT" rev-parse HEAD)
TREE=$(git -C "$WT" rev-parse "$SHA^{tree}")
land "$WT" "$BASE" "$BASE" src/ src/bench.txt
expect "ok: in-scope commit on base" 0 "ok $SHA $TREE"

# 2. Untracked scratch file left in the worktree.
new_case dirty
echo 'a = 5' > "$WT/src/a.txt"
wt_commit "exp: a"
echo junk > "$WT/src/scratch.txt"
land "$WT" "$BASE" "$BASE" src/ src/bench.txt
expect "reject: dirty tree" 1 "reject: dirty tree"

# 3. Two commits on top of the base.
new_case two
echo 'a = 5' > "$WT/src/a.txt"
wt_commit "exp: a5"
echo 'a = 6' > "$WT/src/a.txt"
wt_commit "exp: a6"
SHA=$(git -C "$WT" rev-parse HEAD)
TREE=$(git -C "$WT" rev-parse "$SHA^{tree}")
land "$WT" "$BASE" "$BASE" src/ src/bench.txt
expect "ok: two commits on base" 0 "ok $SHA $TREE"

# 4. No commit at all (explorer blocked).
new_case none
land "$WT" "$BASE" "$BASE" src/ src/bench.txt
expect "reject: no commit" 1 "reject: no commits on base"

# 5. An empty commit.
new_case empty
git -C "$WT" commit -q --allow-empty -m "exp: nothing"
land "$WT" "$BASE" "$BASE" src/ src/bench.txt
expect "reject: empty commit" 1 "reject: no changes"

# 6. A change outside the target folder.
new_case outside
echo 'line 1 changed' > "$WT/shared/limits.txt"
wt_commit "exp: shared"
land "$WT" "$BASE" "$BASE" src/ src/bench.txt
expect "reject: outside target" 1 "reject: outside target: shared/limits.txt"

# 7. A change to a frozen file that sits inside the target.
new_case frozen
echo 'frozen = no' > "$WT/src/bench.txt"
wt_commit "exp: bench"
land "$WT" "$BASE" "$BASE" src/ src/bench.txt
expect "reject: frozen file" 1 "reject: frozen: src/bench.txt"

# 8. Regression: moving an out-of-scope file into the target. Rename
# detection would list only the new path and pass; the old path must fail.
new_case rename
git -C "$WT" mv shared/limits.txt src/limits.txt
sed -i '1s/.*/line 1 changed/' "$WT/src/limits.txt"
wt_commit "exp: move limits"
land "$WT" "$BASE" "$BASE" src/ src/bench.txt
expect "reject: rename out of scope" 1 "reject: outside target: shared/limits.txt"

# 9. The champion moved in another file: the candidate is rebased onto it.
new_case moved
echo 'a = 5' > "$WT/src/a.txt"
wt_commit "exp: a5"
echo 'b = 9' > "$RP/src/b.txt"
champ_commit "keep: b9"
CHAMP=$(git -C "$RP" rev-parse HEAD)
land "$WT" "$BASE" "$CHAMP" src/ src/bench.txt
expect "ok: rebased onto moved champion" 0 "ok "
check "rebased commit sits on the champion" \
  "$([ "$(git -C "$WT" rev-parse HEAD^)" = "$CHAMP" ] && echo yes || echo no)"

# 10. The champion changed the same line: conflict. The worktree is left
# at the candidate commit, with no rebase in progress.
new_case conflict
echo 'a = 5' > "$WT/src/a.txt"
wt_commit "exp: a5"
SHA=$(git -C "$WT" rev-parse HEAD)
echo 'a = 7' > "$RP/src/a.txt"
champ_commit "keep: a7"
CHAMP=$(git -C "$RP" rev-parse HEAD)
land "$WT" "$BASE" "$CHAMP" src/ src/bench.txt
expect "conflict" 0 "conflict"
check "conflict leaves the candidate checked out" \
  "$([ "$(git -C "$WT" rev-parse HEAD)" = "$SHA" ] && [ -z "$(git -C "$WT" status --porcelain)" ] && echo yes || echo no)"

# 11. The champion already has the same change: duplicate.
new_case dup
echo 'a = 5' > "$WT/src/a.txt"
wt_commit "exp: a5"
echo 'a = 5' > "$RP/src/a.txt"
champ_commit "keep: a5 by hand"
CHAMP=$(git -C "$RP" rev-parse HEAD)
land "$WT" "$BASE" "$CHAMP" src/ src/bench.txt
expect "duplicate of champion" 0 "duplicate"

# 12. Missing arguments.
land
expect "usage error" 2 "usage:"

if [ "$fails" -gt 0 ]; then
  echo "$fails failed"
  exit 1
fi
echo "all passed"
