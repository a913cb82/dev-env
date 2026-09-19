---
name: android-development
description: Build, install, debug, and test Android apps from WSL, without Android Studio. Covers toolchain setup, the adb bridge, the PC-first dev loop, and HyperOS gotchas. Use when device behavior differs from code logic.
---

# Android Development

## When To Use

Use this skill when the task touches an Android build. Use this skill when the task touches `adb`. Use this skill when the task touches a real device. Use this skill when device behavior differs from the code logic.

## Terms

- WSL means Windows Subsystem for Linux. All commands run in WSL unless marked PowerShell.
- `adb` means the Android Debug Bridge (`~/platform-tools/adb`).
- FGS means foreground service (an always-running app component).
- HyperOS means the Xiaomi Android skin. Its power manager breaks standard Android assumptions.
- Package means one app on the phone (example: `com.example.app`).
- Phone-active means seconds the phone spends working for a test. Waiting on the PC does not count.

## Environment

Do the one time setup before any dev work. See [env setup](references/env-setup.md).

- Java 17, Gradle wrapper pinned, AGP via version catalog. No Android Studio.
- SDK under `~/Android/Sdk`, pointed at by untracked `local.properties`.
- Phone reaches WSL through `usbipd` (bind once, auto-attach on logon) plus a udev rule.
- Phone grants up front: USB debugging, battery unrestricted, autostart, pinned in Recents.

## Dev Loop

Each iteration follows the same loop. See [dev loop](references/dev-loop.md).

1. Build and prove on PC: `./gradlew ktlintFormat testDebugUnitTest assembleDebug lintDebug`.
2. Install in background and poll a log file. MIUI verification takes 1 to 4 minutes when healthy.
3. Verify without touching the phone: `logcat`, `uiautomator dump`, `screencap`.
4. Encode each check as a `scripts/verify-<feature>.sh` PASS/FAIL script.

Rules for the loop:

- PC proof comes first. Write a failing unit test (RED), then fix the code (GREEN). Only then touch the phone.
- Never judge a feature before the power exemptions hold (FGS plus battery unrestricted plus autostart).
- Never `force-stop` a dev app. It drops accessibility bindings. Never `uninstall` casually. Fresh installs need a manual Allow tap plus fresh permission grants.
- A locked phone cannot unlock over `adb`. Detection, alarms, and screenshots work locked. UI checks need it unlocked.
- Keep a phone-active budget. Wrap `adb` calls with `time`. Record seconds in a ledger. Stay under 10 minutes total and under 5 minutes per test.

## Testing Order

Test in this order, cheapest first:

1. Pure Kotlin with no Android imports, under JUnit. Push decisions (math, timers, state machines) into pure modules.
2. `lint` plus `ktlint` in the same build command.
3. `adb` black box: `logcat` plus `uiautomator` plus `dumpsys`.
4. Screenshots. The agent inspects them. No human eyes are necessary.
5. Human on-device pass last. Use it only for feel, latency, and aesthetics.

## HyperOS Gotchas

HyperOS breaks standard Android behavior. See [gotchas](references/hyperos-gotchas.md).

- The OS starves background work without FGS plus exemptions. It fails silent. Everything looks healthy.
- Window introspection is blind (`windowId` is -1, `getWindows()` is empty). Use the usage-events oracle, never window joins.
- `getRunningAppProcesses()` importance lies. Reject it as a signal.
- SmartPower denies `USER_PRESENT` and `SCREEN_ON` to manifest receivers. Hold dynamic receivers in the live FGS.
- Boot receivers cannot start an FGS directly. Chain boot to exact alarm to FGS.
- `WRITE_SECURE_SETTINGS` is ungrantable, even over `adb`. Usage access is grantable over `adb`.
- Toasts are not a diagnostic channel. Log everything.
- `logcat -c` destroys evidence. Dump first. Clear deliberately.
- DataStore needs exactly one instance per file, from `applicationContext`. Pair each store write with a synchronous in-memory mirror update.
- Fast builds lie through up-to-date checks. Confirm the APK holds the change before install. Bump `versionCode` per install and check `lastUpdateTime` after.

## Design Rules

- Engine logic stays pure Kotlin with zero Android imports. The Android layer stays thin.
- Never poll. Each countdown is a one-shot deadline, recomputed on transitions. The process sleeps between transitions.
- Prefer declared state over ROM detection. Detection that HyperOS blinds loses to a user toggle every time.
- Launch decisions use live truth at fire time. Sticky state is a fallback only.
- Every background feature ships a kill switch plus an `adb` break-glass path.

## References

- See [env setup](references/env-setup.md) for toolchain, bridge, and phone grants.
- See [dev loop](references/dev-loop.md) for the iteration loop, verify commands, and budgets.
- See [HyperOS gotchas](references/hyperos-gotchas.md) for the full device gotcha catalog.
