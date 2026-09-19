# HyperOS Gotchas

HyperOS (Xiaomi's Android skin, tested on 15 Ultra / HyperOS 3 / Android 16)
breaks standard Android behavior. Each entry below cost real debugging time.
Re-verify each one on any new ROM before trusting the standard API.

## Power Starvation Is Silent

Without FGS presence plus battery-unrestricted plus autostart, the OS starves
background work. Delivery turns selective. No errors appear. Everything looks
healthy. Lesson: exemptions are the baseline for ANY background feature.
Put them in place before judging whether a feature works. The day-one outage
traced to a per-app power restriction, not to any API.

## Never Force-Stop, Never Casual-Uninstall

- `force-stop` drops accessibility bindings and state that reinstalls do not
  always restore.
- A casual `uninstall` needs a manual Allow tap plus fresh grants for every
  permission on reinstall.
- Break-glass stays `adb`-side: `pm disable-user --user 0 <pkg>` stops the app
  and keeps data; `adb uninstall <pkg>` is the nuclear option.

## Window Introspection Is Blind

- Accessibility `event.windowId` is -1. The event-to-window join is dead.
- `getWindows()` returns empty, even with `flagRetrieveInteractiveWindows`.
- `getRootInActiveWindow()` is blind in the same way.
- Consequence: never join events to windows. Never attribute windows to
  packages. For "what is on screen" use the usage-events oracle
  (`UsageStatsManager.queryEvents`), which is system truth, independent of
  window introspection and of `FLAG_SECURE`.
- Proving a negative took a probe-only build: pure logging, behavior
  unchanged, then full removal after the verdict. Tree stays clean.

## Process Importance Lies

`getRunningAppProcesses()` importance is wrong on HyperOS. It was rejected
as an oracle after live proof. Do not use it as a signal anywhere.

## Manifest Receivers Lose to SmartPower

`USER_PRESENT` and `SCREEN_ON` never reach manifest receivers. The live FGS
holds dynamic receivers instead. Same for any screen-state broadcast the
feature needs.

## Boot Cannot Start an FGS Directly

On API 35+, a boot receiver cannot start a foreground service. Chain:
boot receiver to exact alarm to supervisor receiver to FGS. Schedule two
alarms (60s plus 180s backstop); the supervisor restarts idempotently, so the
second alarm is a pure backstop, never a duplicate. Exact alarms need a
runtime grant; log `canScheduleExactAlarms()` and always code the inexact
fallback.

## Permission Realities

- `WRITE_SECURE_SETTINGS` is ungrantable, even over `adb` on Android 16.
  Never design around it.
- Usage access IS grantable over `adb`:
  `appops set <pkg> GET_USAGE_STATS allow`.
- Alarm pending intents are explicit. Dynamic receivers never match them.
  Same-app implicit broadcasts from background contexts get eaten. Use the
  manifest-receiver to FGS-start forward chain.

## Toasts Are Not Diagnostics

Toasts are rate-limited, queued for seconds, and misleading under bursts.
Log everything. Keep toasts out of test paths.

## DataStore Discipline

- Exactly one `DataStore` instance per file. Always construct from
  `applicationContext`. Activity and Service contexts spawn rival instances
  that silently lose writes (in-memory caches diverge; last writer clobbers).
- Pair every store write with a synchronous in-memory mirror update. Async
  flow collectors converge too late for millisecond-later decisions.

## Stale State Must Not Decide

Decide launches on live truth queried at fire time. Sticky state (last known
package, cached flags) is a fallback only. Two live incidents proved this:
a blind oracle plus a stale anchor launched the block over the wrong app.
Fixes that worked: anchor every real surface (no exclusions for own UI or
survival packages), and let transparency win over gating in every check.

## Declared Beats Detected

A ROM-blinded detector loses to a user toggle every time. When detection of
an overlay class fails on-device, stop detecting. Ship a per-app declared
flag with versioned seeding instead. Seeding covers unlistable packages
(no launcher activity) that no picker can ever show.
