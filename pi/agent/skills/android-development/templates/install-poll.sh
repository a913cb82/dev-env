#!/usr/bin/env bash
# Fast install: push the APK, check md5, commit on device, check it landed.
#
#   ./install-poll.sh app/build/outputs/apk/debug/app-debug.apk <pkg>
#
# Prints LANDED with the new lastUpdateTime, or fails fast. Device steps
# take ~5s total (push ~1s, pm install ~2-4s). Each step has a tight cap.
# A wedged transport surfaces immediately instead of hanging the loop.
# Never background-and-poll. `adb install` streaming stalls over usbip.
# Push plus `pm install` on the same link flies.
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
  echo "PUSH FAILED: sick usbip channel (shell may still answer; retry and"
  echo "kill-server have losing records against this). Rebind once, then rerun:"
  echo "  powershell.exe -NoProfile -Command \"usbipd detach --busid <BUSID>\""
  echo "  powershell.exe -NoProfile -Command \"usbipd attach --wsl --busid <BUSID>\""
  echo "If it still fails after a rebind, wait 2-3 min (episodes self-clear)"
  echo "or switch bulk to WiFi adb: adb tcpip 5555; adb connect <wlan-ip>:5555"
  exit 1
}

# Byte counts lie on a sick channel. Full-size exit-0 pushes delivered
# truncated files and phantoms. md5 is the only truth (local is instant).
LOCAL_MD5="$(md5sum "$APK" | cut -d' ' -f1)"
REMOTE_MD5="$($ADB shell "md5sum $TMP_APK" 2>/dev/null | cut -d' ' -f1)"
if [ "$LOCAL_MD5" != "$REMOTE_MD5" ]; then
  echo "MD5 MISMATCH: local=$LOCAL_MD5 remote=${REMOTE_MD5:-<missing>}"
  echo "The channel corrupted the transfer. Rebind or use WiFi adb, then rerun."
  exit 1
fi
echo "md5 ok: $LOCAL_MD5"

timeout 30 $ADB shell "pm install -r $TMP_APK" || {
  echo "PM INSTALL FAILED: on-device commit stuck."
  echo "Check the phone for an install prompt. Wake it:"
  echo "  adb shell input keyevent 224"
  exit 1
}

AFTER="$(stamp)"
if [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ]; then
  echo "LANDED: $AFTER"
  exit 0
fi
echo "The install returned, but the timestamp did not change:"
echo "  before: $BEFORE"
echo "  after:  $AFTER"
exit 1
