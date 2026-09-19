# Dev Loop

Every iteration runs the same loop. All steps stay PC-side. The goal is zero phone taps.

## 1. Build and Prove on PC

```bash
./gradlew ktlintFormat testDebugUnitTest assembleDebug lintDebug
```

PC proof comes first, always:

- Write a failing unit test for the decision (RED).
- Fix the production code (GREEN).
- Run the full suite plus `lint`.
- Only then touch the phone.

Pure Kotlin modules (no Android imports) carry all decisions: math, timers, state machines, verdicts. The Android layer stays thin. A bug caught by a unit test costs seconds. The same bug on the phone costs minutes.

## 2. Install in Background

Foreground shell calls die on long hangs. MIUI verification takes 1 to 4 minutes even when healthy. Background the install and poll a log file:

```bash
nohup adb install -r app.apk > install.log 2>&1 &
# poll install.log; report streaming waits separately from test time
```

- Updates (`-r`) are prompt-free. Fresh installs need one on-screen Allow tap.
- A stuck install with no `AdbInstallActivity` in `logcat` means the phone dozes. Wake it with `input keyevent 224`. If still stuck, kill the stale client and retry. A wedged session blocks the next install.
- `screen_off_timeout` is ignored by HyperOS. Use `svc power stayon true` while USB-plugged for dev. Revert with `false` after.
- A locked phone cannot unlock over `adb`. This is a hard boundary. Plan UI checks for unlocked windows.

Confirm the install landed:

- The APK holds the change: `unzip -p app.apk classes*.dex | strings | grep <marker>`.
- The device runs it: `dumpsys package <pkg> | grep lastUpdateTime`.
- `versionCode` rises per installed build, so `dumpsys` always tells which build is live.

## 3. Verify Without Touching the Phone

Clear deliberately (`logcat -c` destroys evidence, so dump first). Then drive transitions and read results:

```bash
adb logcat -c
adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1
adb shell am start -n <pkg>/<activity>
adb shell input keyevent 3   # home
adb logcat -d | grep <TAG>
adb shell uiautomator dump /dev/stdout | grep -oE 'package="[^"]+"'
adb exec-out screencap -p > shot.png
```

- `monkey` opens apps. `am start` opens exact activities. `keyevent 3` goes home.
- `uiautomator dump` asserts which package owns the screen.
- `screencap` works on any screen, locked or not. The agent inspects the image. No human eyes are necessary.

Encode each check as a script: `scripts/verify-<feature>.sh` with PASS/FAIL output. Every install then self-certifies. This replaces all "can you check X" messages. Example shape:

```bash
adb shell pidof <pkg> >/dev/null || fail "process not running"
adb logcat -c
# drive transitions...
LOG="$(adb logcat -d -s <TAG>:D)"
echo "$LOG" | grep -q "<expected line>" || fail "not detected"
pass "description"
```

## 4. Phone-Active Budget

The phone is a scarce resource. The PC is not. Budget phone seconds explicitly:

- Wrap `adb` calls with `time`.
- Keep a ledger per session: what ran, active seconds, cumulative total.
- Stay under 10 minutes total and under 5 minutes per test.
- PC waits (install streaming, sleeps, verdict polling) do not count. Report them separately.
- Batch independent reads into one `adb` round where possible.
- Coordinate human taps (unlock, Allow, alarm stop) in one message with exact steps.

## 5. Human Pass Last

The human pass covers only feel, latency, and aesthetics. Everything checkable stays in steps 1 to 4. Hand over an APK plus a 5-line checklist for taps the agent cannot do: restricted settings, accessibility toggle, autostart, battery, usage access.
