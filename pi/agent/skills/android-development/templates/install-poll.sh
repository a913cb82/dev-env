#!/usr/bin/env bash
# Install an APK in the background and wait until the device runs it.
#
#   ./install-poll.sh app/build/outputs/apk/debug/app-debug.apk <pkg>
#
# Prints LANDED with the new versionCode, or the install log when the install
# failed. Designed for MIUI/HyperOS, where streamed installs can take minutes
# and report nothing while they work. Poll, never block.
set -uo pipefail

APK="${1:?usage: install-poll.sh <apk> <package>}"
PKG="${2:?usage: install-poll.sh <apk> <package>}"
LOG="${TMPDIR:-/tmp}/install-$(basename "$PKG").log"

# Unique per build: a repeated versionCode lets the device reuse the old
# install. Timestamp code is the cheapest guarantee.
ver_code() {
  adb shell dumpsys package "$PKG" 2>/dev/null | grep -m1 -o 'versionCode=[0-9]*' | cut -d= -f2
}

BEFORE="$(ver_code)"
echo "before: versionCode=${BEFORE:-<not installed>}"
nohup adb install -r "$APK" > "$LOG" 2>&1 &
INSTALL_PID=$!

for _ in $(seq 1 60); do
  sleep 5
  NOW="$(ver_code)"
  if [ -n "$NOW" ] && [ "$NOW" != "$BEFORE" ]; then
    echo "LANDED: versionCode=$NOW"
    exit 0
  fi
  if ! kill -0 "$INSTALL_PID" 2>/dev/null; then
    echo "install finished without a version change:"
    cat "$LOG"
    exit 1
  fi
done

echo "install still running after 5 minutes; last log:"
cat "$LOG" 2>/dev/null
exit 1
