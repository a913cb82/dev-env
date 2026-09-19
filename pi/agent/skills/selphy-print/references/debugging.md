# Debugging

## Held Jobs

- A held job means CUPS paused the job. The data is safe.
- Run `lpstat -o` with the bash tool to list jobs.
- Fix the cause first. Then resume the job.
- Run `lp -i JOB -H resume` with the bash tool to resume.

## No Device In WSL

- Symptom: `lsusb | grep -i canon` shows no result.
- Cause: The printer is off. Or WSL was closed at plug time.
- Fix: You run inside WSL already. Start the printer. Wait ten seconds. Run the `lsusb` command again.

## Never Attached

- Symptom: `usbipd list` shows Shared but never Attached.
- Cause: The auto attach loop is not running. The task state is Ready instead of Running.
- Check: The task needs state Running plus two `usbipd.exe` processes. One process means the engine only. No loop means no attach.
- Trap: The default task limit kills the loop 72 hours after logon. Set no limit plus restart. See [install detail](setup.md).
- Trap: The loop exits when started with the printer absent. Use the retrying wrapper. See [install detail](setup.md).
- Fix: Power the printer on. Keep a WSL terminal open. Start the task named `usbipd Selphy CP510 auto-attach` on Windows as admin.

## Ribbon Depleted

- Symptom: The backend reports `Ribbon depleted`. The job holds.
- Cause: The ribbon cassette is empty.
- Fix: Replace the ribbon cassette. Add paper to match the cassette count. Resume the job.

## Out Of Paper

- Symptom: The backend reports out of paper. The job holds.
- Cause: The paper tray is empty.
- Fix: Add paper. Resume the job.

## Wrong Paper

- Symptom: Paper shuttles in and out, then ejects blank. Green light. Ribbon advances. Queue sticks on `Sending init sequence`.
- Cause: Inkjet paper has no thermal coating. Dye sublimation cannot transfer to it. Loose wrong-size paper in the tray misfeeds the sensor too.
- Fix: Stop. Do not cut it. Do not reuse the sheet. Load a matched Canon paper plus ribbon set in the correct size. The sheet must fit the tray with no push.

## Wrong Queue

- Symptom: Jobs target a dead queue. Or the default queue is wrong.
- Cause: A stale per user default names a removed queue.
- Fix: Run `lpstat -p -d -v` with the bash tool. Run `lpoptions -d selphy-cp510` with the bash tool to set the default.

## Wrong Driver

- Symptom: Colors look wrong. Or size looks wrong.
- Cause: The queue uses the wrong PPD.
- Fix: Select the `canon-cp510` line explicitly. Do not use the `canon-cp400` line. Run `lpadmin -p selphy-cp510 -m "gutenprint.5.3://canon-cp510/expert"` with the bash tool.

## Harmless Messages

- `Printer drivers are deprecated` means CUPS 2.4 noise. Ignore it.
- `DOES NOT REPORT A SERIAL NUMBER` is normal for this printer. Ignore it with one printer.
