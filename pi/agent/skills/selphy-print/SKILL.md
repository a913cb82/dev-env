---
name: selphy-print
description: Print photos on Canon SELPHY CP510 from WSL with CUPS and Gutenprint. Use when the user asks to print a photo, check the print queue, or fix a held Selphy job.
---

# Selphy Print

## When To Use

Use this skill when the user asks to print a photo. Use this skill when the user asks about the Selphy queue. Use this skill when a Selphy job stops.

## Terms

- WSL means Windows Subsystem for Linux.
- Queue means the CUPS print queue.
- Job means one print task in the queue.

## Printer Facts

- The printer is a Canon SELPHY CP510.
- The printer uses dye sublimation. It has no nozzles.
- The USB ID is `04A9:3128`.
- The queue name is `selphy-cp510`.
- The queue is the system default.
- The default media is Postcard 4x6 inch.
- The driver is Gutenprint `canon-cp510`.
- Each print uses one paper sheet and one ribbon panel.

## Procedure

Do these steps for each print. You run inside WSL already. Do not open a new terminal.

1. Start the printer.
2. Wait ten seconds.
3. Run `lsusb | grep -i canon` with the bash tool.
4. Run `lpstat -p -d -v` with the bash tool.
5. Confirm the image path with the read tool.
6. Run `lp FILE` with the bash tool to print.
7. Run `lpstat -o` with the bash tool to monitor jobs.
8. An empty result means the print finished.

### Photo Shape

- Phone photos use 4:3 shape. The paper uses 3:2 shape.
- For full image prints, run `lp -o fit-to-page FILE` with the bash tool.
- For borderless prints, crop to 3:2 first. See [photo workflow](references/photo-workflow.md).

### Held Jobs

- A held job stays in the queue. The data is safe.
- Fix the cause first. Then resume the job.
- Run `lp -i JOB -H resume` with the bash tool to resume.
- See [debugging](references/debugging.md) for causes.

## References

- See [install detail](references/setup.md) for one time install and repair.
- See [photo workflow](references/photo-workflow.md) for crop steps.
- See [debugging](references/debugging.md) for faults.
