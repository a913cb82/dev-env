# Install Detail

This file describes one time install. The install is complete. Use this file for repair only.

## WSL Packages

1. Run `sudo apt install -y cups printer-driver-gutenprint usbutils` with the bash tool.
2. Run `sudo lpinfo -m | grep -iE selphy` with the bash tool.
3. Select the `canon-cp510` line. Do not select the `canon-cp400` line.
4. Run `sudo lpadmin -p selphy-cp510 -E -v "gutenprint53+usb://canon-cp510/NONE_UNKNOWN" -m "gutenprint.5.3://canon-cp510/expert" -o printer-is-shared=false` with the bash tool.
5. Run `sudo lpadmin -d selphy-cp510` with the bash tool.
6. Run `lpstat -p -d -v` with the bash tool to confirm.
7. Confirm the queue is idle.
8. Confirm the queue is enabled.
9. Confirm the queue is the default.

## Windows USB Path

The printer has USB only. WSL owns the printer. Windows has no print queue.

1. Install `usbipd-win` on Windows.
2. Run `wsl --update` on Windows.
3. Connect the printer. Start the printer.
4. Run `usbipd list` on Windows to find the device.
5. Run `usbipd bind --busid BUSID` on Windows as admin. Replace BUSID with the bus ID.
6. Keep a WSL terminal open.
7. Run `usbipd attach --wsl --busid BUSID --auto-attach` on Windows for the first test.
8. Close the first window. The attach remains active.
9. Run `usbipd attach --wsl --hardware-id 04a9:3128 --auto-attach` on Windows for port independent matching.
10. Create a logon task on Windows to repeat the attach after reboot.
11. Run `usbipd list` on Windows to confirm Attached state.

The attach command runs as a foreground loop by design. Closing the window stops future auto reattach only. The live attach remains active.

A WSL terminal must remain open at plug time. The attach needs a live WSL instance.

## Logon Task Commands

Run each line separately in Admin PowerShell. Do not paste all lines as one block.
Set no time limit plus restart. The default limit kills the loop 72 hours after logon.
The wrapper retries every 30 seconds. The loop exits when started with the printer absent.
A single try wrapper stops future auto reattach silently. Start the task with the printer on.

```powershell
$Action = New-ScheduledTaskAction -Execute "C:\Program Files\usbipd-win\usbipd.exe" -Argument "attach --wsl --hardware-id 04a9:3128 --auto-attach"
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "usbipd Selphy CP510 auto-attach" -Action $Action -Trigger $Trigger -Settings $Settings
Start-ScheduledTask -TaskName "usbipd Selphy CP510 auto-attach"
```

To hide the task window, change the task action to `wscript.exe` with a retrying wrapper script. Keep the task name. Keep the trigger. Keep the settings. The wrapper content is:

```vb
Set sh = CreateObject("Wscript.Shell")
Do
  sh.Run """C:\Program Files\usbipd-win\usbipd.exe"" attach --wsl --hardware-id 04a9:3128 --auto-attach", 0, True
  WScript.Sleep 30000
Loop
```

Write it with `Set-Content` in Admin PowerShell. Then point the task at `wscript.exe`. Start the task with the printer on. Steady state is task `Running` plus two `usbipd.exe` processes.
