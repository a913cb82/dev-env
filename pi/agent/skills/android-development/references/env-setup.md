# Environment Setup

Do once per PC. Then do once per phone. Then never again unless the machine is rebuilt.

## PC Toolchain (WSL Ubuntu, No Studio)

Java first:

```bash
java -version   # want: openjdk 17
```

No `JAVA_HOME` is necessary if `java` is on PATH. This machine sets neither `JAVA_HOME` nor `ANDROID_HOME`.

SDK command line tools:

```bash
mkdir -p ~/Android/Sdk/cmdline-tools && cd ~/Android/Sdk/cmdline-tools
curl -sO https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip -q commandlinetools-linux-13114758_latest.zip
mkdir -p latest && mv cmdline-tools/* latest/ && rmdir cmdline-tools
```

The `latest/` nesting is required. `sdkmanager` errors out without it. Persist the `bin` dir on PATH in `~/.bashrc`.

Platform, build tools, licenses:

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

Project skeleton that works with the above:

- Gradle wrapper pinned per project (example: 9.7.1).
- AGP via version catalog (example: 9.4.0). Kotlin via the Compose plugin.
- No `kotlin-android` plugin. AGP 9 provides Kotlin. The old plugin breaks the build.
- Repos `google()` plus `mavenCentral()` in `settings.gradle.kts`.
- `versionCode` tracks `git rev-list --count HEAD`. This needs a git checkout with history.

Traps hit during setup:

- Gradle below 9.6 is refused by AGP 9.
- A missing `local.properties` shows a cryptic SDK-location error, not a missing-file error.

Verify the whole chain:

```bash
./gradlew ktlintFormat testDebugUnitTest assembleDebug lintDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## ADB Bridge (WSL to Phone)

Windows PowerShell, once ever (admin shell):

```powershell
usbipd bind --busid <BUSID>   # persistent
```

Hidden logon task re-attaches on every logon (needs a WSL terminal open at plug time). Pattern: one scheduled task runs `usbipd attach --wsl --hardware-id <VID:PID> --auto-attach` hidden. If attach lapses:

```powershell
usbipd attach --wsl --busid <BUSID>
```

WSL side (persistent via udev):

```bash
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="<VID>", MODE="0666", GROUP="plugdev"' \
  | sudo tee /etc/udev/rules.d/51-<vendor>.rules
sudo udevadm control --reload-rules
adb kill-server; adb devices   # expect: <id>  device
```

`platform-tools` lives in `~/` and on PATH. The RSA key lives in WSL `~/.android/adbkey`, so the phone trust survives reboots.

Traps hit during bridge setup:

- `no permissions` means the udev rule or server restart is missing.
- `unauthorized` means the on-phone RSA prompt is unanswered.

## Phone Grants (Per Phone, Up Front)

Developer options first (tap the OS version 7 times). Then enable:

- USB debugging.
- USB debugging (Security settings). Needed for input and screenshots. HyperOS may switch this off after a reboot. Re-check it when screenshots or input stop working while `adb devices` still shows `device`.
- Install via USB.
- On the Allow USB debugging prompt, tick Always allow from this computer.

App exemptions before any feature judgment:

- Autostart allowed.
- Battery unrestricted.
- Pinned in Recents.
- High screen timeout during dev (`settings put system screen_off_timeout 600000`).
- Wake with `adb shell input keyevent 26`.

Steady state: replugs and reboots need no action. Verify with `adb devices` plus one `screencap`.
