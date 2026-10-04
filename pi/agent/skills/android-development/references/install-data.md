# Install Transport Data (WORK IN PROGRESS)

The install path is NOT settled. Log every install here until the approach
has high confidence. Do not promote a hypothesis to a rule without data.

## How to log

After every phone install, append one row to the log below. Use this shape:

`date | build | usb push attempts (ok/hang/corrupt + MB/s) | recovery used |
md5 match? | device-side seconds | notes`

Then update the aggregates. Rules change only when the aggregates move.

## Aggregate counters (update these, not the prose)

- USB push attempts: 16 (6 clean ~1s at 64-82 MB/s, 1 phantom exit-0,
  9 wedged past cap, 2 corrupt-but-present)
- Recovery record: retry-after-wedge 1/3, kill-server 0/2, usbipd rebind 2/3
- WiFi adb pushes: 1/1 (7s at 11 MB/s, md5 clean)
- pm install after checked push: 7/7 Success

## Log

### 2026-10-04 (WiFi adb, Xiaomi 15 Ultra, ~80 MB APK)

1. White-thinking build. `./gradlew installDebug` failed: no devices.
   WiFi adb to 192.168.0.5:5555 refused; neighbors unrouted. Phone-side
   wireless debugging had moved to :32925 (changing port — read it off
   the screen). USB path unavailable: WSL-to-Windows interop down
   (`UtilAcceptVsock`), so no `usbipd` at all. Not a push wedge; no
   recovery attempted on the transport.
2. Same build over `adb connect 192.168.0.5:32925`. Gradle install
   succeeded first try (~1m10s build+install; install portion not
   timed separately). Launch clean. Note: Gradle install path, not the
   push-plus-`pm install` split, so not counted in WiFi push aggregates.
   Lesson: an interop outage blocks ALL usbipd recovery (rebind needs
   interop too) — WiFi is then the only path, which strengthens the
   WiFi-first hypothesis under test.

### 2026-09-30 (usbipd NAT attach, Xiaomi 15 Ultra, 83 MB APK)

1. Ranked-toggle build. `adb install` hung 300s (aborted). Split op.
   Push ok ~1s. `pm install` ok. Lesson: never `adb install`.
2. Stats-fix build. Push hung past cap. Retry ok ~1s. pm ok.
3. New-game build. Push hung. Retry hung. Kill-server, still hung.
   usbipd detach plus attach. Push ok at 82 MB/s. pm ok.
4. Anim build. Push ok at 64 MB/s first try. pm ok.
5. Flicker build. Push ok at 82 MB/s first try. pm ok.
6. Place-120 build. Push hung. Retry hung. Kill-server, still hung.
   Rebind. Push ok at 82 MB/s. pm ok.
7. Place-90 build. Push hung (12s). Rebind. Push hung again. Small
   transfers plus 10/40/80 MB zeros all fine. APK hung again. One
   76 MB/s exit-0 push whose file vanished before `pm install`. Two more
   pushes past cap that left wrong-md5 files (3ed7… and ba1d0c… against
   3f69…). Switched to WiFi adb (`tcpip 5555` plus connect 192.168.0.5).
   Push 7s. md5 MATCH. pm ok. Lessons: byte counts and exit-0 lie, so
   check md5 on every push. Rebind is not a certain fix (now 2/3).
   Episodes look time-bound.

## Open hypotheses (unconfirmed — gather for/against)

- Attach-age decay: wedges cluster ~1hr after a fresh attach (cases 3, 6,
  7 against healthy 4, 5 between). For: 2 episodes. Against: none yet.
  Still needed: log the attach age at each wedge.
- Rebind placebo: case 7 cleared minutes after a FAILED rebind with no
  further action. For: 1. Against: cases 3, 6 cleared right after rebind.
  Still needed: on the next wedge, retry every ~60s WITHOUT rebinding.
  See if it self-clears.
- WiFi reliability: 1/1. Still needed: use WiFi-first for the next 10
  installs. Log every push time plus md5.

## Confidence bar

Call the approach settled when all three hold. At least 30 logged
installs span 4 weeks. The wedge rate stays stable within ±10pts across
weeks. Measured average seconds-per-install decides WiFi-first against
USB-reactive, not theory. Until then, this file outranks any
prose about installs elsewhere in the skill.
