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

Two rules keep the loop honest:

- When a test fails, check the fixture's own assumptions before the production
  code. Two real regressions were wrong fixtures, not wrong code.
- One causal variable per build. Batch only independent changes; a build that
  changes three things answers nothing about any of them.

## 2. Install Fast

Device steps take ~5s total. Never background-and-poll, never `adb install`
(it stalls over usbip while shell stays alive). Push, commit on device,
verify — see [install template](../templates/install-poll.sh):

```bash
adb push app.apk /data/local/tmp/app.apk          # ~1s even at 80 MB
adb shell "pm install -r /data/local/tmp/app.apk"  # ~2-4s, prints Success
dumpsys package <pkg> | grep lastUpdateTime        # timestamp must move
```

Budgets (caps, not waits — a cap surfaces a wedge, waiting never fixes one):

- PC rebuild (`assembleDebug`, no adb): under 30s incremental. Never `clean`.
- Each device step: under 10s. Whole push+install+verify: ~5s.
- A step that hits its cap is broken, not slow — diagnose, don't re-wait
  with a bigger number.

Approved caps (expected cost, then the wedge line). One step per command;
never one big timeout around a chained command — put `timeout` on each
step so the failing step names itself:

| Step | Expected | Cap |
|---|---|---|
| shell probe (echo, dumpsys, screencap, tap) | 1–3s | 30s |
| push APK (~80 MB) | ~1s | 12s |
| pm install | 2–4s | 30s |
| powershell.exe interop (cold VM spin-up) | 10–30s | 90s |
| assembleDebug incremental | 8–23s | 90s |
| test + Paparazzi record | 30–60s | 180s |

- No 120s+ caps on adb ops, ever. Only Gradle test/record runs may exceed
  120s, and only under their own cap.
- Chain steps with `&&` so failure exits before the next step burns time.
- Over-budget triage, by empirical record (11 pushes: retry 1/3,
  kill-server 0/2, usbipd rebind 2/2): a push past its 12s cap is a stale
  usbipd attach, not a slow link. Skip retry and kill-server — go straight
  to `usbipd detach + attach`, then push (1s). Shell stays alive through
  bulk stalls, so a shell check predicts nothing; don't spend a step on it.
  If push is fast but pm hangs, the phone wants attention (install prompt,
  doze). Keep the daemon warm between iterations.
- Chain install, launch, and settle-checks in one `adb shell` to save
  round-trips. Poll logcat for the app's ready signal instead of `sleep`.

- Updates (`-r`) are prompt-free. Fresh installs need one on-screen Allow tap.
- A stuck install with no `AdbInstallActivity` in `logcat` means the phone dozes. Wake it with `input keyevent 224`. If still stuck, kill the stale client and retry. A wedged session blocks the next install.
- When `adb install` hangs but shell is alive, split the op: `adb push app.apk /data/local/tmp/x.apk` tests the transport, then `adb shell "pm install -r /data/local/tmp/x.apk"` commits on device. Real case: an 83 MB APK pushed in 1 s while `adb install` hung repeatedly; direct `pm install` returned Success in seconds. The wrapper was wedged, not the link.
- `screen_off_timeout` is ignored by HyperOS. Use `svc power stayon true` while USB-plugged for dev. Revert with `false` after.
- A locked phone cannot unlock over `adb`. This is a hard boundary. Plan UI checks for unlocked windows.

Confirm the install landed:

- The APK holds the change: `unzip -p app.apk classes*.dex | strings | grep <marker>`.
- The APK holds every asset change too: `unzip -l app.apk | grep <asset>`. aapt2
  can rename or transform assets (`*.gz` is decompressed and the suffix
  stripped), so an asset path that works in the source tree can fail on device.
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
- `uiautomator dump` asserts which package owns the screen. Use its bounds for
  taps on text controls instead of screen-fraction math.
- `screencap` works on any screen, locked or not. The agent inspects the image. No human eyes are necessary.
- Screenshot after every tap step. Layouts shift between builds; blind
  coordinates corrupt user state (a blind sequence changed a saved rank).

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
