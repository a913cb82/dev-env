# Install Transport Data (WORK IN PROGRESS)

The install path is NOT settled. Log every install here until the approach
has high confidence. Do not promote a hypothesis to a rule without data.

## How to log

After every phone install, append one row to the log below:

`date | build | usb push attempts (ok/hang/corrupt + MB/s) | recovery used |
md5 match? | device-side seconds | notes`

Then update the aggregates. Rules change only when the aggregates move.

## Aggregate counters (update these, not the prose)

- USB push attempts: 16 (6 clean ~1s @ 64–82 MB/s, 1 phantom exit-0,
  9 wedged past cap, 2 corrupt-but-present)
- Recovery record: retry-after-wedge 1/3, kill-server 0/2, usbipd rebind 2/3
- WiFi adb pushes: 1/1 (7s @ 11 MB/s, md5 clean)
- pm install after verified push: 7/7 Success

## Log

### 2026-09-30 (usbipd NAT attach, Xiaomi 15 Ultra, 83 MB APK)

1. Ranked-toggle build: `adb install` hung 300s (aborted). Split op:
   push ok ~1s, `pm install` ok. Lesson: never `adb install`.
2. Stats-fix build: push hung past cap; retry ok ~1s. pm ok.
3. New-game build: push hung; retry hung; kill-server, hung;
   usbipd detach+attach, push ok @ 82 MB/s. pm ok.
4. Anim build: push ok @ 64 MB/s first try. pm ok.
5. Flicker build: push ok @ 82 MB/s first try. pm ok.
6. Place-120 build: push hung; retry hung; kill-server, hung;
   rebind, push ok @ 82 MB/s. pm ok.
7. Place-90 build: push hung (12s); rebind; push hung again; small
   transfers + 10/40/80 MB zeros all fine; APK hung again; one 76 MB/s
   exit-0 push whose file vanished before `pm install`; two more pushes
   past cap that left wrong-md5 files (3ed7…, ba1d0c… vs 3f69…).
   Switched to WiFi adb (`tcpip 5555` + connect 192.168.0.5): push 7s,
   md5 MATCH, pm ok. Lessons: byte counts and exit-0 lie — md5 every
   push; rebind is not a certain fix (now 2/3); episodes look time-bound.

## Open hypotheses (unconfirmed — gather for/against)

- Attach-age decay: wedges cluster ~1hr after a fresh attach (cases 3, 6, 7
  vs healthy 4, 5 between). For: 2 episodes. Against: none yet. Need:
  log attach age at each wedge.
- Rebind placebo: case 7 cleared minutes after a FAILED rebind with no
  further action. For: 1. Against: cases 3, 6 cleared right after rebind.
  Need: on next wedge, retry every ~60s WITHOUT rebinding; see if it
  self-clears.
- WiFi reliability: 1/1. Need: use WiFi-first for the next 10 installs,
  log every push time + md5.

## Confidence bar

Settled when: ≥30 logged installs spanning ≥4 weeks, wedge rate stable
within ±10pts across weeks, and WiFi-first vs USB-reactive decided by
measured average seconds-per-install (not by theory). Until then, this
file outranks any prose about installs elsewhere in the skill.
