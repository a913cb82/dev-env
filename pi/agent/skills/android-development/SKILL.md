---
name: android-development
description: Build, install, debug, and test Android apps from WSL, without Android Studio. Covers toolchain setup, the adb bridge, the PC-first dev loop, HyperOS gotchas, native engine integration, and device probes. Use when device behavior differs from code logic.
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
- Fire time means the moment a decision runs.

## Environment

Do the one-time setup before any dev work. See [env setup](references/env-setup.md).

- Use Java 17. Pin the Gradle wrapper. Declare AGP in the version catalog. Do not use Android Studio.
- Put the SDK under `~/Android/Sdk`. Point to it from untracked `local.properties`.
- Connect the phone to WSL through `usbipd` (bind once, auto-attach on logon). Add a udev rule per observed vendor ID.
- Grant these up front: USB debugging, battery unrestricted, autostart. Pin the app in Recents.

## Dev Loop

Each iteration follows the same loop. See [dev loop](references/dev-loop.md).

1. Build and prove on PC: `./gradlew ktlintFormat testDebugUnitTest assembleDebug lintDebug`.
2. Install fast: push, then md5, then `pm install`, then timestamp check. About 5s total. Never background-and-poll, never `adb install`.
3. Check without touching the phone: `logcat`, `uiautomator dump`, `screencap`.
4. Encode each check as a `scripts/verify-<feature>.sh` PASS/FAIL script (`verify` here is part of the filename and stays).

Rules for the loop:

- PC proof comes first. Write a failing unit test (RED). Then fix the code (GREEN). Only then touch the phone.
- When a test fails, check the fixture's own assumptions before the production code. Two real failures were wrong fixtures, not wrong code.
- Change one causal variable per build. Batch only independent changes. A build that changes three things answers nothing about any of them.
- Stacked Compose gesture detectors fail silently (restart amputation, eaten downs, held taps). See [compose gestures](references/compose-gestures.md) before debugging gesture feel as logic.
- Check that the APK holds the change before install. Use `unzip -l` for assets. Use `unzip -p` plus `strings` for code. aapt2 transforms some assets (see native engine).
- Never judge a feature before the power exemptions hold (FGS plus battery unrestricted plus autostart).
- Never `force-stop` a dev app. It drops accessibility bindings. Never `uninstall` casually. Fresh installs need a manual Allow tap plus fresh permission grants.
- A locked phone cannot unlock over `adb`. Detection, alarms, and screenshots work locked. UI checks need it unlocked.
- Take a screenshot after each tap step. Layouts shift between builds. Blind coordinates corrupt user state.
- Keep a phone-active budget. Wrap `adb` calls with `time`. Record seconds in a ledger. Stay under 10 minutes total and under 5 minutes per test.

## Testing Order

Test in this order, cheapest first:

1. Pure Kotlin with no Android imports, under JUnit. Write pure modules for decisions (math, timers, state machines).
2. Run `lint` plus `ktlint` in the same build command.
3. `adb` black box: `logcat` plus `uiautomator` plus `dumpsys`.
4. Screenshots. The agent inspects them. No human eyes are necessary.
5. Do the human on-device pass last. Use it only for feel, latency, and aesthetics.

## Native Engines

A bundled native engine (KataGo, Lc0, any prebuilt `.so` plus models) adds a second build system and a second failure mode. See [native engine](references/native-engine.md).

- Start through the system linker: `/system/bin/linker64 <lib.so> <args>`. argv reaches the engine.
- A vendored binary may enforce a package or cwd check. Read its strings and disasm. Then patch with an assertive script. Never trust it to explain its own refusal.
- Stage every `DT_NEEDED` library plus the config into `filesDir`. Carry `LD_LIBRARY_PATH`.
- Send stderr to a file. Watch the file for a ready banner. Log the exit code on death. A pipe can lose the only evidence.
- Record a patch revision file. mtime and size lie across rebuilds. Recopy when the revision changes.
- Parse the protocol of the exact binary version, not the docs of master.

## Measure Before Tuning

Latency work fails when guesses drive it. See [performance](references/performance.md).

- Split timing by phase in one log line (queue wait, setup, search) before any change.
- Measure the engine alone (probe) and in-app. Trust neither alone. A warm probe measures a state that real play may never reach.
- Change one parameter per build. Then A/B it. A single query flag cost seconds per call in one real case.
- Mirror the reference app's recipe before tuning from scratch.

## Device Probes

A probe script runs in seconds where a rebuild plus install costs much more. See [device probe](references/device-probe.md).

- Push a shell script to `/data/local/tmp` and run it with `run-as <pkg>`. It runs as the app uid with the app's private paths.
- Use a FIFO harness for engines that speak on stdin and stdout. Poll with a deadline and print step seconds.
- `python3` is absent on device. Dump raw output. Parse it on the PC.

## HyperOS Gotchas

HyperOS breaks standard Android behavior. See [gotchas](references/hyperos-gotchas.md).

- The OS starves background work without FGS plus exemptions. It fails silently. Everything looks healthy.
- Window introspection is blind (`windowId` is -1, `getWindows()` is empty). Use the usage-events oracle, never window joins.
- `getRunningAppProcesses()` importance lies. Reject it as a signal.
- SmartPower denies `USER_PRESENT` and `SCREEN_ON` to manifest receivers. Hold dynamic receivers in the live FGS.
- Boot receivers cannot start an FGS directly. Chain boot to exact alarm to FGS.
- `WRITE_SECURE_SETTINGS` is ungrantable, even over `adb`. Usage access is grantable over `adb`.
- Toasts are not a diagnostic channel. Log everything.
- `logcat -c` destroys evidence. Dump first. Clear deliberately.
- DataStore needs exactly one instance per file, from `applicationContext`. Pair each store write with a synchronous in-memory mirror update.
- Fast builds lie through up-to-date checks. Check that the APK holds the change before install. Bump `versionCode` per install and check `lastUpdateTime` after.
- An install can open a verification screen that blocks the start. Ask the user to disable it.
- The phone can enumerate under a different USB vendor ID. Keep a udev rule per observed ID.

## Design Rules

- Engine logic stays pure Kotlin with zero Android imports. The Android layer stays thin.
- Never poll. Each countdown is a one-shot deadline, recomputed on transitions. The process sleeps between transitions.
- Prefer declared state over ROM detection. Detection that HyperOS blinds loses to a user toggle every time.
- Start decisions use live truth at fire time. Sticky state is a fallback only.
- Every background feature ships a kill switch plus an emergency `adb` path.
- Match a third-party engine or app by reading its exact recipe first. Decompile it. Read its strings, configs, and argv. Guessing its behavior cost the longest debugging stretch of one project.

## References

- See [env setup](references/env-setup.md) for toolchain, bridge, and phone grants.
- See [dev loop](references/dev-loop.md) for the iteration loop, check commands, and budgets.
- See [HyperOS gotchas](references/hyperos-gotchas.md) for the full device gotcha catalog.
- See [compose gestures](references/compose-gestures.md) for pointer-input rules: restarts, consumption, tap latency, finger tracking.
- See [native engine](references/native-engine.md) for vendoring, starting, and patching native binaries.
- See [performance](references/performance.md) for measurement method and tuning order.
- See [device probe](references/device-probe.md) for probe scripts, FIFO harnesses, and UI hygiene.
- See [templates](templates/install-poll.sh) for the install-and-check loop.
