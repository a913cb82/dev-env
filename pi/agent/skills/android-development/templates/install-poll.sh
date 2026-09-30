#!/usr/bin/env bash
# Fast install: push the APK, commit on device, verify it landed.
#
#   ./install-poll.sh app/build/outputs/apk/debug/app-debug.apk <pkg>
#
# Prints LANDED with the new lastUpdateTime, or fails fast. Device steps
# take ~5s total (push ~1s, pm install ~2-4s); each step has a tight cap so
# a wedged transport surfaces immediately instead of hanging the loop.
# Never background-and-poll: `adb install` streaming stalls over usbip
# while push + `pm install` on the same link flies.
set -uo pipefail

APK="${1:?usage: install-poll.sh <apk> <package>}"
PKG="${2:?usage: install-poll.sh <apk> <package>}"
ADB="${ADB:-adb}"
TMP_APK="/data/local/tmp/$(basename "$APK")"

stamp() {
  $ADB shell dumpsys package "$PKG" 2>/dev/null | grep -m1 lastUpdateTime || true
}

BEFORE="$(stamp)"
echo "before: ${BEFORE:-<not installed>}"

timeout 12 $ADB push "$APK" "$TMP_APK" > /dev/null || {
  echo "PUSH FAILED: stale usbipd attach (shell may still answer; retry and"
  echo "kill-server have losing records against this). Rebind, then rerun:"
  echo "  powershell.exe -NoProfile -Command \"usbipd detach --busid <BUSID>\""
  echo "  powershell.exe -NoProfile -Command \"usbipd attach --wsl --busid <BUSID>\""
  exit 1
}

timeout 60 $ADB shell "pm install -r $TMP_APK" || {
  echo "PM INSTALL FAILED: on-device commit stuck."
  echo "Check the phone for an install prompt; wake it with: adb shell input keyevent 224"
  exit 1
}

AFTER="$(stamp)"
if [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ]; then
  echo "LANDED: $AFTER"
  exit 0
fi
echo "install returned but timestamp unchanged:"
echo "  before: $BEFORE"
echo "  after:  $AFTER"
exit 1
