# Device Probes and UI Verification

Answer questions with probe scripts, not app rebuilds. One app build plus
install costs minutes; one probe costs seconds.

## run-as Probe Scripts

```bash
cat > /tmp/probe.sh <<'EOF'
F=/data/data/<pkg>/files
export LD_LIBRARY_PATH=$F/katago:/system/lib64
export HOME=$F
cd /data/data
timeout 120 /system/bin/linker64 $F/katago/lib.so <args> < /data/local/tmp/in.txt
echo "EXIT=$?"
EOF
adb push /tmp/probe.sh /data/local/tmp/probe.sh
adb shell "run-as <pkg> sh /data/local/tmp/probe.sh"
```

- `run-as` requires a debuggable build. A release app (like the reference app you
  decompile) refuses it: `package not debuggable`.
- Probes run as the app uid with the app's private paths, so engine gates,
  permissions, and file layouts behave exactly as in-app.
- Read probe output with `run-as <pkg> cat <file>`. A plain `adb shell cat` is
  denied on app data.
- `python3` is absent on device. Dump raw output and parse on the PC.

## FIFO Harness for stdin Protocols

For engines that speak on stdin and stdout:

```bash
mkfifo $F/in
> $F/out
timeout 120 <engine> < $F/in > $F/out 2>$F/err &
exec 8>$F/in
echo "command" >&8
# poll $F/out for the response token, then report elapsed seconds
```

- Poll with a deadline, and print the seconds per step so the harness doubles as
  a benchmark.
- Grep for an exact token (`^play `) because headers, warnings, and results share
  the same stream.
- Keep one command per line, and validate quoting locally before blaming the
  engine. A JSON payload with one extra brace looks identical in a log tail and
  produces a parse error that reads like an engine fault.
- Clear the output file between steps (`> $F/out`) and match on the exact id or
  token; substring matches return stale lines.

## Screenshot and Tap Hygiene

- `adb exec-out screencap -p > shot.png` works on any screen, locked or not.
- Screenshot AFTER EVERY TAP STEP. Sheet layouts shift when sections are added
  or removed. Blind coordinates then hit the wrong control. One blind sequence
  silently changed a saved rank setting and started a second game.
- For text controls, prefer real bounds from `uiautomator dump /dev/stdout` over
  screen-fraction math.
- Do not tap destructive or state-changing controls blind. If a tap only
  verifies a layout, check the screenshot from a prior state instead.
- Some surfaces need a human: permission prompts, verification dialogs, secret
  codes. Send the user one message with exact steps, then resume from a
  screenshot.

## Logcat Discipline

- Dump before clearing: `adb logcat -d > dump.txt`, then clear deliberately.
- Filter by tag plus a phase marker. Keep one tag per subsystem.
- Verify the build marker appears (`build versionCode=...`) so a stale process
  cannot masquerade as the new build.
- Log the assembled command line, the cwd, the environment path, and the file
  sizes for every native launch. That one line answered most startup questions.
