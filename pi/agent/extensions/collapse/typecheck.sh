#!/usr/bin/env bash
# Strict typecheck of the collapse extension against the installed Pi release.
# The release path is per-machine, so the tsconfig is generated in /tmp instead
# of committed; no files in the repo or in ~/.pi are written.
# Run: ./typecheck.sh   (override the compiler with TSC=/path/to/tsc)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

find_pi() {
  local version root
  version=$(cat "$HOME/.pi/agent/install/current-version" 2>/dev/null || true)
  if [[ -n "$version" ]]; then
    root="$HOME/.pi/agent/install/releases/$version/node_modules/@earendil-works/pi-coding-agent"
    if [[ -d "$root/dist/modes" ]]; then printf '%s\n' "$root"; return 0; fi
  fi
  root=$(ls -d "$HOME"/.pi/agent/install/releases/*/node_modules/@earendil-works/pi-coding-agent 2>/dev/null | sort -V | tail -1)
  if [[ -n "$root" && -d "$root/dist/modes" ]]; then printf '%s\n' "$root"; return 0; fi
  return 1
}

PI=$(find_pi) || { echo "typecheck: no Pi install found (set up ~/.pi/agent/install first)" >&2; exit 1; }
NM=$(cd "$PI/../.." && pwd)
TUI="$NM/@earendil-works/pi-tui/dist/index.d.ts"
AGENT="$PI/dist/index.d.ts"

if [[ -n "${TSC:-}" ]]; then
  TSC_CMD=("$TSC")
elif command -v tsc >/dev/null 2>&1; then
  TSC_CMD=(tsc)
elif command -v npx >/dev/null 2>&1; then
  TSC_CMD=(npx --yes -p typescript@5.9.2 tsc)
else
  echo "typecheck: install TypeScript or set TSC (npx is also accepted)" >&2
  exit 1
fi

CONFIG=$(mktemp --suffix=.json)
trap 'rm -f "$CONFIG"' EXIT
cat > "$CONFIG" <<JSON
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"],
    "typeRoots": ["$NM/@types"],
    "baseUrl": "$HERE",
    "paths": {
      "@earendil-works/pi-tui": ["$TUI"],
      "@earendil-works/pi-coding-agent": ["$AGENT"]
    }
  },
  "include": ["$HERE/*.ts"]
}
JSON
"${TSC_CMD[@]}" -p "$CONFIG"
