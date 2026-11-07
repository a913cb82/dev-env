#!/bin/sh
# Check one explorer commit, then rebase it onto the current champion.
#
# usage: land.sh WORKTREE BASE CHAMPION TARGET [FROZEN...]
#   WORKTREE  the explorer's detached worktree
#   BASE      the commit the explorer started from
#   CHAMPION  the current loop-branch commit
#   TARGET    the folder the explorer may edit, e.g. src/
#   FROZEN    paths nobody may edit, even inside TARGET
#
# Prints one line, then exits:
#   ok <sha> <tree>   rebased onto CHAMPION; the worktree is at <sha>   (0)
#   duplicate         same tree as CHAMPION after rebase                (0)
#   conflict          rebase failed; the worktree is back at the commit (0)
#   reject: <reason>  a check failed; nothing changed                   (1)
#   usage: ...        bad arguments                                     (2)
set -eu

if [ "$#" -lt 4 ]; then
  echo "usage: land.sh WORKTREE BASE CHAMPION TARGET [FROZEN...]" >&2
  exit 2
fi

wt=$1
base=$2
champ=$3
target=${4%/}
shift 4

git_wt() { git -C "$wt" "$@"; }
reject() { echo "reject: $1"; exit 1; }

if ! git_wt rev-parse -q --verify "$base^{commit}" >/dev/null ||
   ! git_wt rev-parse -q --verify "$champ^{commit}" >/dev/null; then
  echo "usage: BASE and CHAMPION must be commits" >&2
  exit 2
fi

[ -z "$(git_wt status --porcelain)" ] || reject "dirty tree"

count=$(git_wt rev-list --count "$base..HEAD")
[ "$count" = 1 ] || reject "need exactly one commit on base, found $count"
[ "$(git_wt rev-parse 'HEAD^')" = "$base" ] || reject "commit is not directly on base"

# Tree-to-tree diff, renames off: a moved file shows its old path too.
names=$(git_wt diff --no-renames --name-only "$base" HEAD)
[ -n "$names" ] || reject "no changes"

IFS='
'
set -f
for path in $names; do
  case $path in
    "$target"/*) ;;
    *) reject "outside target: $path" ;;
  esac
  for f in "$@"; do
    f=${f%/}
    case $path in
      "$f"|"$f"/*) reject "frozen: $path" ;;
    esac
  done
done
set +f
unset IFS

if ! git_wt rebase -q "$champ" >/dev/null 2>&1; then
  git_wt rebase --abort >/dev/null 2>&1 || true
  echo conflict
  exit 0
fi

if [ "$(git_wt rev-parse 'HEAD^{tree}')" = "$(git_wt rev-parse "$champ^{tree}")" ]; then
  echo duplicate
  exit 0
fi

echo "ok $(git_wt rev-parse HEAD) $(git_wt rev-parse 'HEAD^{tree}')"
