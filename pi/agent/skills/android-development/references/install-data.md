# Install Transport Log — Method plus Worked Example

Use this method while the install path is unsettled on a given PC/phone/ROM.
Once the path is settled (see confidence bar), stop logging per install and
promote the winner to [dev loop](dev-loop.md). Until then, this log outranks
any prose about installs elsewhere in the skill.

## Method (generic)

After every phone install, append one row. Use this shape:

`date | build | usb push attempts (ok/hang/corrupt + MB/s) | recovery used |
md5 match? | device-side seconds | notes`

Then update the aggregates. Rules change only when the aggregates move.
Always check md5 (local instant, remote ~2s) — byte counts and exit-0 lie.

Confidence bar (generic): call the approach settled when all three hold —
at least 30 logged installs span 4 weeks, the wedge rate stays stable
within ±10pts across weeks, and measured average seconds-per-install
decides WiFi-first against USB-reactive, not theory.

## Worked example log (one project, Xiaomi 15 Ultra, ~80 MB APK, 2026-09/10)

Kept so the next project inherits the triage, not the verdict. Your ROM,
cable, and hub will differ — collect your own aggregates.

### Aggregate counters (example, not normative)

- USB push attempts: 16 (6 clean ~1s at 64-82 MB/s, 1 phantom exit-0,
  9 wedged past cap, 2 corrupt-but-present)
- Recovery record: retry-after-wedge 1/3, kill-server 0/2, usbipd rebind 2/3
- WiFi adb pushes: 1/1 (7s at 11 MB/s, md5 clean)
- pm install after checked push: 7/7 Success

### Log (example)

#### 2026-10-04 (WiFi adb, ~80 MB APK)

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

#### 2026-09-30 (usbipd NAT attach, 83 MB APK)

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
   pushes past cap that left wrong-md5 files. Switched to WiFi adb
   (`tcpip 5555` plus connect 192.168.0.5). Push 7s. md5 MATCH. pm ok.
   Lessons: byte counts and exit-0 lie, so check md5 on every push.
   Rebind is not a certain fix (now 2/3). Episodes look time-bound.

### Open hypotheses from the example (unconfirmed — gather for/against)

- Attach-age decay: wedges cluster ~1hr after a fresh attach. Still needed: log the attach age at each wedge.
- Rebind placebo: one case cleared minutes after a FAILED rebind with no
  further action. Still needed: on the next wedge, retry every ~60s WITHOUT rebinding.
  See if it self-clears.
- WiFi reliability: 1/1 in the example. Still needed: use WiFi-first for the next 10
  installs. Log every push time plus md5.
