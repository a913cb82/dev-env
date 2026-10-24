---
name: android-development
description: Build, install, debug, and test Android apps from WSL, without Android Studio. Covers toolchain setup, the adb bridge, the PC-first dev loop, OEM-ROM gotchas, optional native-engine and device-probe specializations. Use when the task touches an Android build, adb, or a real device.
---

# Android Development

## When To Use

Use this skill when the task touches an Android build. Use this skill when the task touches `adb`. Use this skill when the task touches a real device. Use this skill when device behavior differs from the code logic.

## Terms

Core terms (every project):

- WSL means Windows Subsystem for Linux. All commands run in WSL unless marked PowerShell.
- `adb` means the Android Debug Bridge.
- Package means one app on the phone (example: `com.example.app`).
- Device-active means seconds the phone spends working for a test. Waiting on the PC does not count.
- Fire time means the moment a decision runs (alarm, receiver, user tap).

Conditional terms (only for the specialization named):

- FGS means foreground service. Only if the app does background work.
- HyperOS means the Xiaomi Android skin. Only on Xiaomi devices; its power manager breaks standard Android assumptions.
- Reference app means a third-party APK you decompile to copy its exact recipe. Only for native-engine or third-party-integration work.

## Environment

Do the one-time setup before any dev work. See [env setup](references/env-setup.md).

- Match the project's JDK, Gradle wrapper, AGP, compileSdk, and build-tools. Discover them from the project; the reference file lists where. Never hard-pin from memory.
- Do not use Android Studio. Put the SDK under `~/Android/Sdk`. Point to it from untracked `local.properties`.
- Connect the phone to WSL through `usbipd` (bind once, auto-attach on logon). Add a udev rule per observed vendor ID.
- Grant up front, by app type — always: USB debugging (+ Security settings for input/screenshots), install via USB. Only if background work: battery unrestricted, autostart, pin in Recents.

## Dev Loop

Each iteration follows the same loop. See [dev loop](references/dev-loop.md).

1. Build and prove on PC: discover the project's formatter, unit-test, assemble, and lint tasks first (formatter-aware, flavor-aware), then run them.
2. Install fast: push, then md5, then `pm install`, then timestamp check. About 5s total when healthy. Never background-and-poll, never `adb install` over usbip.
3. Check without touching the phone: `logcat`, `uiautomator dump`, `screencap`.
4. Encode each check as a `scripts/verify-<feature>.sh` PASS/FAIL script (`verify` here is part of the filename and stays).

Rules for the loop:

- PC proof comes first. Write a failing unit test (RED). Then fix the code (GREEN). Only then touch the phone.
- When a test fails, check the fixture's own assumptions before the production code.
- Change one causal variable per build. Batch only independent changes. A build that changes three things answers nothing about any of them.
- If the UI uses stacked Compose gesture detectors, see [compose gestures](references/compose-gestures.md) before debugging gesture feel as logic. Detectors fail silently (restart amputation, eaten downs, held taps).
- Check that the APK holds the change before install. Use `unzip -l` for assets. Use `unzip -p` plus `strings` for code. aapt2 transforms some assets.
- Only if the app does background work: never judge a feature before the power exemptions hold (FGS plus battery unrestricted plus autostart). The OS starves the rest silently.
- Never `force-stop` a dev app casually. It drops state and (especially for accessibility apps) bindings that reinstalls do not restore. Never `uninstall` casually. Fresh installs need a manual Allow tap plus fresh permission grants.
- A locked phone cannot unlock over `adb`. Detection, alarms, and screenshots work locked. UI checks need it unlocked.
- Take a screenshot after each tap step. Layouts shift between builds. Blind coordinates hit the wrong control.
- Keep a device-active budget. Wrap `adb` calls with `time`. Record seconds in a ledger. Example starting point from one project: under 10 minutes total and under 5 minutes per test. Set your own cap per project.

## Testing Order

Test in this order, cheapest first:

1. Pure Kotlin with no Android imports, under JUnit. Write pure modules for decisions (math, timers, state machines).
2. Run `lint` plus the project's formatter check in the same build command.
3. `adb` black box: `logcat` plus `uiautomator` plus `dumpsys`.
4. Screenshots. The agent inspects them. No human eyes are necessary.
5. Do the human on-device pass last. Use it only for feel, latency, and aesthetics.

## Specializations (opt in only)

- Bundled native engine (prebuilt `.so` plus models — examples: KataGo, Lc0): see [native engine](references/native-engine.md). Adds a second build system and a second failure mode.
- Latency tuning: see [performance](references/performance.md). Measure by phase before changing anything. The engine story there is one worked example.
- Probe scripts and FIFO harnesses: see [device probe](references/device-probe.md). A probe runs in seconds where a rebuild plus install costs much more.
- Xiaomi/HyperOS devices: see [gotchas](references/hyperos-gotchas.md). Standard APIs lie there. Re-check every entry on a new ROM.

## Design Rules

- Separate pure logic (zero Android imports) from the Android layer. The layer stays thin.
- Prefer deadlines over polling for countdowns. Each countdown is a one-shot deadline, recomputed on transitions. Exception: poll only when no callback API exists, and then bound it.
- Prefer declared state over ROM detection when the ROM blinds detection. Detection a skinned ROM blinds loses to a user toggle every time.
- Start decisions use live truth at fire time. Sticky state (last known value, cached flags) is a fallback only.
- Every background feature ships a kill switch plus an emergency `adb` path.
- Match a third-party engine or app by reading its exact recipe first. Decompile it. Read its strings, configs, and argv. Guessing its behavior is the longest debugging stretch on record.

## References

- See [env setup](references/env-setup.md) for toolchain discovery, bridge, and phone grants.
- See [dev loop](references/dev-loop.md) for the iteration loop, check commands, and budgets.
- See [HyperOS gotchas](references/hyperos-gotchas.md) for the Xiaomi-only gotcha catalog.
- See [compose gestures](references/compose-gestures.md) for pointer-input rules: restarts, consumption, tap latency, finger tracking.
- See [native engine](references/native-engine.md) for vendoring, starting, and patching native binaries.
- See [performance](references/performance.md) for measurement method and tuning order.
- See [device probe](references/device-probe.md) for probe scripts, FIFO harnesses, and UI hygiene.
- See [templates](templates/install-poll.sh) for the install-and-check loop.
