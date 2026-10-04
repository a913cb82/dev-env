# Environment Setup

Do this setup once per PC. Do it once per phone. Never repeat it unless someone rebuilds the machine.

## PC Toolchain (WSL Ubuntu, No Studio)

Install Java first:

```bash
java -version   # want: openjdk 17
```

No `JAVA_HOME` is necessary if `java` is on PATH. This machine sets neither `JAVA_HOME` nor `ANDROID_HOME`.

Install the SDK command line tools:

```bash
mkdir -p ~/Android/Sdk/cmdline-tools && cd ~/Android/Sdk/cmdline-tools
curl -sO https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip -q commandlinetools-linux-13114758_latest.zip
mkdir -p latest && mv cmdline-tools/* latest/ && rmdir cmdline-tools
```

`sdkmanager` needs the `latest/` nesting. It fails without it. Persist the `bin` dir on PATH in `~/.bashrc`.

Install the platform, build tools, and licenses:

```bash
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

Add other API levels the same way.

Point Gradle at the SDK. This file is machine-specific. Never commit it:

```properties
# local.properties (git-ignored)
sdk.dir=/home/<you>/Android/Sdk
```

Use this project skeleton with the setup above:

- Pin the Gradle wrapper per project (example: 9.7.1).
- Declare AGP in the version catalog (example: 9.4.0). Add Kotlin through the Compose plugin.
- Do not add the `kotlin-android` plugin. AGP 9 provides Kotlin. The old plugin breaks the build.
- Declare repos `google()` plus `mavenCentral()` in `settings.gradle.kts`.
- `versionCode` tracks `git rev-list --count HEAD`. This needs a git checkout with history.
- For fast dev loops, a timestamp versionCode (`currentTimeMillis/1000`)
  is unique per build. A commit-count versionCode collides on rebuilds.
  The device then reuses the stale install.

Traps from past setups:

- AGP 9 refuses Gradle below 9.6.
- A missing `local.properties` shows a cryptic SDK-location error, not a missing-file error.

Check the whole chain:

```bash
./gradlew ktlintFormat testDebugUnitTest assembleDebug lintDebug
adb push app/build/outputs/apk/debug/app-debug.apk /data/local/tmp/app.apk
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

Make the WSL side persistent with udev:

```bash
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="<VID>", MODE="0666", GROUP="plugdev"' \
  | sudo tee /etc/udev/rules.d/51-<vendor>.rules
sudo udevadm control --reload-rules
adb kill-server; adb devices   # expect: <id>  device
```

`platform-tools` lives in `~/` and on PATH. The RSA key lives in WSL `~/.android/adbkey`, so the phone trust survives reboots.

Traps from bridge setup:

- `no permissions` means the udev rule or server restart is missing. The
  phone can re-enumerate under a second vendor ID (we observed an 18d1
  "Google" descriptor). Keep one udev rule per observed `idVendor`.
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

Enable developer options first (tap the OS version 7 times). Then enable:

- USB debugging.
- USB debugging (Security settings) for input and screenshots.
- Install via USB.
- On the prompt that allows USB debugging, tick Always allow from this computer.

HyperOS may switch Security settings off after a reboot. Re-check it when screenshots or input stop working while `adb devices` still shows `device`.

Set app exemptions before you judge any feature:

- Autostart allowed.
- Battery unrestricted.
- Pinned in Recents.
- High screen timeout during dev (`settings put system screen_off_timeout 600000`).
- Wake with `adb shell input keyevent 26`.

In steady state, replugs and reboots need no action. Check with `adb devices` plus one `screencap`.
