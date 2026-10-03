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
- Change one causal variable per build. Batch only independent changes.
  A build that changes three things answers nothing about any of them.

## 2. Install Fast

> The transport is WORK IN PROGRESS: log every install in
> [install data](install-data.md) and follow it over any prose here.

Device steps take ~5s total when healthy. Never background-and-poll, never
`adb install` (it stalls over usbip while shell stays alive). Push the APK.
Check md5. Commit on device. Check that it landed. See
[install template](../templates/install-poll.sh):

```bash
adb push app.apk /data/local/tmp/app.apk          # ~1s even at 80 MB
adb shell "pm install -r /data/local/tmp/app.apk"  # ~2-4s, prints Success
dumpsys package <pkg> | grep lastUpdateTime        # timestamp must move
```

Budgets. A cap is not a wait. A cap surfaces a wedge. Waiting never fixes one.

- Rebuild on PC (`assembleDebug`, no adb) in under 30s incremental.
  Never `clean`.
- Keep each device step under 10s. Keep the whole push plus install plus
  check under ~5s.
- A step that hits its cap is broken, not slow. Diagnose it. Do not re-wait
  with a bigger number.

Approved caps (expected cost, then the wedge line). Use one step per command.
Never put one big timeout around a chained command. Put `timeout` on each
step, so the failing step names itself:

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
- Over-budget triage, by empirical record: a push past its 12s cap is a
  sick usbip channel, not a slow link. Small transfers keep working, so a
  shell check predicts nothing. Do not spend a step on it. Skip retry
  (1/3) and kill-server (0/2). Rebind once (`usbipd detach + attach`).
  If the push still fails after a rebind, the episode is time-bound.
  Wait 2-3 min and retry. Or abandon USB bulk for the install (below).
- USB bulk can corrupt, not just stall. Full byte counts and exit-0 pushes
  have delivered truncated files (caught by md5) and phantom files that
  vanish before `pm install`. Check md5 on every pushed APK before
  installing. Local md5 is instant. Remote md5 takes ~2s. Trust nothing else.
- WiFi adb bypasses sick USB entirely. `adb tcpip 5555` is a tiny command
  that works over a wedged link. Then run
  `adb connect <wlan-ip>:5555`. About 80 MB pushes in ~7s at 11 MB/s.
  Get the IP once per network (`ip addr show wlan0`). It survives USB
  flaps. Use `-s <ip>:5555` for the push/install/check steps.
- Chain install, launch, and settle-checks in one `adb shell` to save
  round-trips. Poll logcat for the app's ready signal instead of `sleep`.

- Updates (`-r`) need no tap. Fresh installs need one on-screen Allow tap.
- A stuck install with no `AdbInstallActivity` in `logcat` means the phone
  dozes. Wake it with `input keyevent 224`. If it is still stuck, kill the
  stale install client and retry. A wedged session blocks the next install.
- If a streamed install hangs but shell is alive, split it. Push the APK
  to test the transport. Then commit on device with `pm install`.
  Real case: an 83 MB APK pushed in 1 s while `adb install` hung
  repeatedly. Direct `pm install` returned Success in seconds. The wrapper
  hung, not the link.
- HyperOS ignores `screen_off_timeout`. Use `svc power stayon true`
  while USB-plugged for dev. Revert it with `false` after.
- A locked phone cannot unlock over `adb`. This is a hard boundary.
  Plan UI checks for unlocked windows.

Check that the install landed:

- Check that the APK holds the change. Run
  `unzip -p app.apk classes*.dex | strings | grep <marker>`.
- Check that the APK holds every asset change too. Run
  `unzip -l app.apk | grep <asset>`. aapt2 can rename or transform assets.
  aapt2 decompresses `*.gz` and strips the suffix. So an asset path that
  works in the source tree can fail on device.
- Check that the device runs it. Run
  `dumpsys package <pkg> | grep lastUpdateTime`.
- `versionCode` rises per installed build, so `dumpsys` always tells which
  build is live.

## 3. Check Without Touching the Phone

Clear deliberately. `logcat -c` destroys evidence, so dump first. Then drive transitions and read results:

```bash
adb logcat -c
adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1
adb shell am start -n <pkg>/<activity>
adb shell input keyevent 3   # home
adb logcat -d | grep <TAG>
adb shell uiautomator dump /dev/stdout | grep -oE 'package="[^"]+"'
adb exec-out screencap -p > shot.png
```

Probe discipline. A negative probe proves nothing until its channel is
validated:

- Positive control first. Actuate a known-working control and confirm its
  log appears before concluding silent code is dead code. Logcat silence
  indicted a gesture loop that was alive; the injected input never reached
  its composable.
- Synthetic input is a suspect channel. `adb shell input tap` and `swipe`
  can drive buttons while never reaching other composables on the same
  screen. Confirm a synthetic gesture moves your target's state (screenshot
  the before and after) before trusting anything it does not log.
- Execution before theory. When a fix changes nothing, prove the new code
  runs before theorizing about timing. One real case shipped a freezer
  that was never called, then blamed a timer leak that did not exist.
- When logcat stays inconclusive, draw the state on screen. A dot that
  shows while a value is frozen broke a deadlock that three logging rounds
  did not. Remove the probe with the fix.

- `monkey` opens apps. `am start` opens exact activities. `keyevent 3` goes home.
- `uiautomator dump` reports which package owns the screen. Use its bounds
  for taps on text controls instead of screen-fraction math.
- `screencap` works on any screen, locked or not. The agent inspects the
  image. No human eyes are necessary.
- Never tap from screenshot-scaled coordinates. Dump `uiautomator` bounds
  first, tap centers, then screenshot-verify the navigation landed. Guessed
  coordinates hit the wrong control (fourteen wasted taps hit undo instead
  of the chart icon).
- Take a screenshot after every tap step. Layouts shift between builds.
  Blind coordinates corrupt user state (a blind sequence changed a saved
  rank).
- Encode each check as a script: `scripts/verify-<feature>.sh` with
  PASS/FAIL output. Every install then checks itself. This replaces all
  "can you check X" messages. Example shape:

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
