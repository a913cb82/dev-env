# Calibration notes (when serial scoring is not enough)

Default is serial scoring: one candidate at a time needs no measurement.
Revisit this only if scoring is fast (<60s) and count-based, and generation
stalls behind evaluation.

## How to measure one exam (piggyback the 3 baselines, no extra runs)

- Wall: slowest elapsed across the 3 runs. Timeout = 5× that (current skill rule).
- RAM: sample `MemAvailable` from /proc/meminfo during each run, take the min,
  compare against idle. Collect samples to a file — a background subshell's
  variables never reach the parent. Add ~50% margin for inter-sample spikes.
  `MemAvailable` already excludes reclaimable cache, so file-heavy evals don't
  inflate it. Works under fork/docker because it samples the machine, not a PID.
- CPU: `/proc/stat` deltas around each run, average cores =
  N × (1 − Δidle/Δtotal). Count iowait as idle (IO-blocked needs no core);
  include steal in the total (stolen time is unavailable); exclude guest
  (already inside user). Guard div-by-zero on sub-second runs. Take the max
  across runs — background noise should over-serialize, never corrupt scores.
- Abort parallel plans if: the box swapped during baseline, free fell below
  ~1GB, or the score derives from wall time (throttling lies about those;
  force serial).

## Limits

- Containers report host memory/CPU; set any override manually there.
- Parallel exams must tolerate each other (unique tmpdirs/ports), or no
  measurement makes them sound.
- Residual noise (non-pi load) is handled by scoring serially by default;
  parallelism is an optimization, never a correctness requirement.
