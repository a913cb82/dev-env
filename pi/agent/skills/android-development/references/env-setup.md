# Environment Setup

Do this setup once per PC. Do it once per phone. Never repeat it unless someone rebuilds the machine or the project moves its toolchain.

## Discover the project's toolchain first

Never copy version numbers from memory. Read them from the project:

```bash
cat .github/.java-version 2>/dev/null          # CI JDK, if present
grep -r "java-version" .github/workflows/ | head
cat gradle/wrapper/gradle-wrapper.properties | grep distributionUrl
grep -E "^\s*(agp|kotlin) " gradle/libs.versions.toml
grep -rn "COMPILE_SDK\|MIN_SDK\|TARGET_SDK\|BUILD_TOOLS\|JavaVersion\|JvmTarget" buildSrc/ app/build.gradle.kts 2>/dev/null | head -n 20
```

Typical mapping (examples, not pins — past projects used Gradle 9.7.1 with AGP 9.4.0):

- JDK provides the host toolchain. The bytecode target (e.g. Java 11 / JVM 11) is separate and older. One past project needed JDK 21 to run Gradle while targeting Java 11 bytecode.
- Gradle wrapper is pinned per project (`gradle-wrapper.properties`). AGP is declared in the version catalog. AGP 9 refuses Gradle below 9.6.
- Kotlin comes through the Compose plugin (`org.jetbrains.kotlin.plugin.compose`). Do not add the legacy `kotlin-android` plugin. AGP 9 provides Kotlin; the old plugin breaks the build.
- `compileSdk`, `targetSdk`, `minSdk`, and `BUILD_TOOLS` live in the project's config (e.g. `buildSrc/.../AndroidConfig.kt`). Install exactly those API levels.
- Repos are `google()` plus `mavenCentral()` in `settings.gradle.kts`. Extra repos (e.g. `jitpack`, `gradlePluginPortal`) are fine when the project declares them.

## PC Toolchain (WSL Ubuntu, No Studio)

Install the JDK the project needs (example: 21; older projects used 17):

```bash
java -version   # must match the project's .java-version / CI image
```

No `JAVA_HOME` is necessary if `java` is on PATH. This machine sets neither `JAVA_HOME` nor `ANDROID_HOME`.

Install the SDK command line tools:

```bash
mkdir -p ~/Android/Sdk/cmdline-tools && cd ~/Android/Sdk/cmdline-tools
curl -sO https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip -q commandlinetools-linux-13114758_latest.zip
mkdir -p latest && mv cmdline-tools/* latest/ && rmdir cmdline-tools
```

If that URL 404s, fetch the current `commandlinetools-linux-*_latest.zip` from the Android developer site. `sdkmanager` needs the `latest/` nesting. It fails without it. Persist the `bin` dir on PATH in `~/.bashrc`.

Install the platform, build tools, and licenses the project declares (examples below — substitute the project's own levels):

```bash
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-37" "build-tools;37.0.0"
```

Add other API levels the same way when you work on multiple projects.

Point Gradle at the SDK. This file is machine-specific. Never commit it. It also carries per-dev secrets (e.g. `breezy.*.key` API keys in one project — empty builds, but those sources fail at runtime):

```properties
# local.properties (git-ignored)
sdk.dir=/home/<you>/Android/Sdk
```

Version-code strategies (pick the project's own; tradeoffs):

- Hardcoded `versionCode` plus a commit-count suffix for debug (reproducible, needs git history).
- Commit-count `versionCode` (`git rev-list --count HEAD`): unique per commit, but collides on rebuilds of the same commit — the device then reuses the stale install.
- Timestamp `versionCode` (`currentTimeMillis/1000`): unique per build, best for fast dev loops.

Traps from past setups:

- AGP 9 refuses Gradle below 9.6.
- A missing `local.properties` shows a cryptic SDK-location error, not a missing-file error.

Check the whole chain (discover the project's own tasks first — see [dev loop](dev-loop.md); the line below is one project's shape, not universal):

```bash
./gradlew spotlessCheck testBasicDebugUnitTest assembleBasicDebug lintDebug
adb push app/build/outputs/apk/basic/debug/app-basic-universal-debug.apk /data/local/tmp/app.apk
adb shell "pm install -r /data/local/tmp/app.apk"
```

## ADB Bridge (WSL to Phone)

Open Windows PowerShell once ever (admin shell):

```powershell
usbipd bind --busid <BUSID>   # persistent
```

A hidden logon task re-attaches on every logon (it needs a WSL terminal open at plug time). Use this pattern. One scheduled task runs `usbipd attach --wsl --hardware-id <VID:PID> --auto-attach` hidden. If attach lapses:

```powershell
usbipd attach --wsl --busid <BUSID>
```

You need no Windows terminal. WSL reaches `usbipd` through interop. Run the same re-attach from the dev shell. Real case: you plugged in the phone, but `adb devices` was empty. The attach below restored it:

```bash
powershell.exe -NoProfile -Command "usbipd attach --wsl --busid <BUSID>"
```

Make the WSL side persistent with udev (one rule per observed vendor ID — the phone can re-enumerate, observed: an `18d1` "Google" descriptor instead of the vendor's `2717`):

```bash
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="<VID>", MODE="0666", GROUP="plugdev"' \
  | sudo tee /etc/udev/rules.d/51-<vendor>.rules
sudo udevadm control --reload-rules
adb kill-server; adb devices   # expect: <id>  device
```

`platform-tools` lives in `~/` and on PATH. The RSA key lives in WSL `~/.android/adbkey`, so the phone trust survives reboots.

Traps from bridge setup:

- `no permissions` means the udev rule or server restart is missing. Keep one udev rule per observed `idVendor`.
- WSL-to-Windows interop itself can die (`UtilAcceptVsock: accept4
  failed 110` from any `powershell.exe` call). It looks exactly like the
  phone disappearing, but it sits below USB: no `usbipd` command can run.
  Triage bottom-up and stop at the first failure: `powershell.exe` echo
  (interop alive?) then `usbipd list` (phone visible to Windows?) then
  attach then `adb devices`. It cannot self-heal from inside WSL.
  Non-destructive attempts: kill stale `powershell.exe` via Task Manager,
  pause VPN (known vsock interferer), wait 10-30 min. The real fix is
  `wsl --shutdown` from Windows when sessions can die. Until then, WiFi
  adb covers the whole loop at ~7s per push.
- `unauthorized` means you have not answered the on-phone RSA prompt.
- The RSA key lives in `~/.android/adbkey`. Copying it to another machine
  moves the trust with it.

## Phone Grants (Per Phone, Up Front)

Enable developer options first (tap the OS version 7 times). Always:

- USB debugging.
- USB debugging (Security settings) for input and screenshots.
- Install via USB.
- On the prompt that allows USB debugging, tick Always allow from this computer.

Only if the app does background work (FGS, alarms, accessibility, usage tracking):

- Autostart allowed.
- Battery unrestricted.
- Pinned in Recents.
- High screen timeout during dev (`settings put system screen_off_timeout 600000`). Note: some skins (e.g. HyperOS) ignore it — use `svc power stayon true` while USB-plugged instead, revert with `false` after.
- Wake with `adb shell input keyevent 26` (or `224` for a dozing phone).

Skin note: HyperOS may switch Security settings off after a reboot. Re-check it when screenshots or input stop working while `adb devices` still shows `device`.

In steady state, replugs and reboots need no action. Check with `adb devices` plus one `screencap`.
