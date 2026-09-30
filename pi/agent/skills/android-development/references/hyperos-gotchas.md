# HyperOS Gotchas

HyperOS (Xiaomi's Android skin, tested on 15 Ultra / HyperOS 3 / Android 16)
breaks standard Android behavior. Each entry below cost real debugging time.
Re-check each one on any new ROM before trusting the standard API.

## Power Starvation Is Silent

Without FGS presence plus battery-unrestricted plus autostart, the OS starves
background work. Delivery becomes selective. No errors appear. Everything
looks healthy. Exemptions are the baseline for ANY background feature.
Put them in place before judging whether a feature works. The day-one outage
traced to a per-app power restriction, not to any API.

## Never Force-Stop, Never Casual-Uninstall

- `force-stop` drops accessibility bindings and state that reinstalls do not
  always restore.
- A casual `uninstall` needs a manual Allow tap plus fresh grants for every
  permission on reinstall.
- Break-glass stays `adb`-side. `pm disable-user --user 0 <pkg>` stops
  the app and keeps data. `adb uninstall <pkg>` is the nuclear option.

## Window Introspection Is Blind

- Accessibility `event.windowId` is -1. The event-to-window join is dead.
- `getWindows()` returns empty, even with `flagRetrieveInteractiveWindows`.
- `getRootInActiveWindow()` is blind in the same way.
- Consequence: never join events to windows. Never attribute windows to
  packages. For "what is on screen" use the usage-events oracle
  (`UsageStatsManager.queryEvents`), which is system truth, independent of
  window introspection and of `FLAG_SECURE`.
- To prove that no leak existed, ship a build that only logs. Keep behavior
  unchanged. Remove the logging after the verdict. Keep the git tree clean.

## Process Importance Lies

`getRunningAppProcesses()` importance is wrong on HyperOS. We rejected
it as an oracle after live proof. Do not use it as a signal anywhere.

## Manifest Receivers Lose to SmartPower

`USER_PRESENT` and `SCREEN_ON` never reach manifest receivers. The live FGS
holds dynamic receivers instead. Same for any screen-state broadcast the
feature needs.

## Boot Cannot Start an FGS Directly

On API 35+, a boot receiver cannot start a foreground service. Chain four
stages. Boot receiver sets an exact alarm. The alarm fires the supervisor
receiver. The supervisor starts the FGS. Schedule two alarms (60s plus
180s backstop). The supervisor restarts idempotently. So the second alarm
is a pure backstop, never a duplicate. Exact alarms need a runtime grant.
Log `canScheduleExactAlarms()`. Always code the inexact fallback.

## Permission Rules

- `WRITE_SECURE_SETTINGS` is ungrantable, even over `adb` on Android 16.
  Never design around it.
- Usage access IS grantable over `adb`. Run
  `appops set <pkg> GET_USAGE_STATS allow`.
- Alarm pending intents are explicit. Dynamic receivers never match them.
- The system eats same-app implicit broadcasts in a background context.
  A manifest receiver catches one. It forwards to an FGS start. That is
  the whole chain.

## Toasts Are Not Diagnostics

Toasts are rate-limited, queued for seconds, and misleading under bursts.
Log everything. Keep toasts out of test paths.

## DataStore Discipline

- Exactly one `DataStore` instance per file. Always construct from
  `applicationContext`. Activity and Service contexts spawn competing
  instances that silently lose writes. In-memory caches diverge. Last
  writer clobbers.
- Pair every store write with a synchronous in-memory mirror update. Async
  flow collectors converge too late for decisions that come milliseconds
  later.

## Never Decide on Stale State

Decide app starts on live truth queried at fire time. Sticky state (last known
package, cached flags) is a fallback only. Two live incidents proved this.
A blind oracle plus a stale anchor started the block over the wrong app.
The fixes that worked: anchor every real surface (no exclusions for own UI
or survival packages). Prefer a transparent check to a gate in every check.

## Declared Beats Detected

A ROM-blinded detector loses to a user toggle every time. When detection of
an overlay class fails on-device, stop detecting. Ship one flag per app that
the user declares. Seed it with a version. Seeding covers packages that no
picker can show (they have no launcher activity).

## A Verification Screen Can Block the Start

After an install, HyperOS may open a full-screen verification screen ("Open
for 5 minutes" / "Open for 12 seconds"). `am start` still reports success,
the app process starts, and every start assertion fails because the app
never becomes visible. Ask the user to disable the installer verification
once. Or dismiss the dialog. Do this before trusting start assertions.

## USB Vendor ID Can Change

The phone can enumerate under a different vendor ID than usual (observed: an
`18d1` "Google" descriptor instead of the vendor's `2717`). The udev rule
then matches nothing, and `adb devices` shows the serial with
`no permissions`.

```bash
lsusb | grep -iE "2717|18d1"
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0666", GROUP="plugdev"' \
  | sudo tee /etc/udev/rules.d/52-google.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
# replug the cable, then check for the on-phone RSA prompt
```

Keep one rule per observed `idVendor`. The user must run the install command.
The agent usually has no passwordless sudo.

## Installs Use the Fast Path

Streamed installs hang with no error. Never background-and-poll. Push the
APK. Check md5. Commit on device with `pm install`. A wedged session blocks
the next install. The full triage lives in [dev loop](dev-loop.md). Follow
it. Log the install in [install data](install-data.md).
