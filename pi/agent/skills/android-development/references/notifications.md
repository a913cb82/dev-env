# Persistent Status Notifications

Scope: a foreground/status notification that reports app state. Tested on
Android 16 / HyperOS; the rules are standard.

## Channel

- A status channel at `IMPORTANCE_MIN` is silent, has no heads-up, and lives in
  the shade. That is the right shape when the user says "no heads-up."
- Create the channel once. Importance cannot be raised later; a change needs a
  new channel id.
- `POST_NOTIFICATIONS` is a runtime permission on API 33+. Check it before
  `notify`; expose it as a setup row with a Fix action.
- Build with `setOngoing(true)`, `setOnlyAlertOnce(true)`, `setShowWhen(false)`.
  A tap opens the main activity through a `PendingIntent` with
  `FLAG_IMMUTABLE`.

## Live Countdown

- Decide the line with a pure function and unit-test it. Keep Android formatting
  (local time, labels) outside the decision.
- Tick only while the screen is interactive (`PowerManager.isInteractive`).
  Cancel on screen off; restart on screen on or user unlock and refresh once.
  Never tick for the full session with the screen off.
- Recompute remaining from a wall-clock deadline; never decrement a counter.
- Prefer `Open · 4:55 left · until 12:37`. Keep the fixed end time as the
  fallback when a live tick is not reliable.
- Collect store/state changes and update on each; a ticker alone misses
  pause/unlock transitions.
- Keep the line short; the shade truncates.

## Verify

- Expand the shade, screenshot, collapse:
  `adb shell cmd statusbar expand-notifications`; `screencap`; `cmd statusbar
  collapse`.
- Log the line and whether the notification is showing. Test at least one live
  countdown and one timeout/end state.
- After a reinstall the process restarts and in-memory state is gone. The
  notification line must still be correct from persisted state.
