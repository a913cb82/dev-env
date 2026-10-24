# Compose Gestures

Scope: only if the UI stacks overlapping gesture detectors (e.g. freeze plus
tap plus transform on one node). Prefer one merged `awaitEachGesture` loop
over stacked detectors when behaviors interact. Non-consuming observers coexist.
Competing consumers do not. Examples below are from one board-game project —
the rules generalize to any stacked-detector UI.

## Restart Amputation

A `pointerInput` block restarts whenever its keys change. Keying a detector
on state the gesture itself writes restarts detection mid-gesture, so each
pinch or drag applies exactly one step and dies. Example: detectors keyed
on the viewport turned pinch-zoom into one-step nudges.

- Key detectors on stable inputs only (mode flags, pixel constants).
- Read gesture-written state through `rememberUpdatedState` refs, never keys.
- Symptom check: gesture works for one step then stops while fingers stay
  down. That is a restart, not a math bug.

## The Consumed Down

`detectTapGestures` consumes the initial down. Any sibling
`awaitFirstDown()` with the default `requireUnconsumed = true` then waits
forever: the down it wants is already eaten. The tap detector works, the
transform detector works (it grabbed the down first), the observer starves
silently. Example: a press-tracking loop never froze anything, no crash,
no log, while every sibling detector behaved.

- Pure observers pass `awaitFirstDown(requireUnconsumed = false)`.
- Symptom check: one detector dead while siblings on the same node live.
  Suspect consumption before suspecting logic.

## Double-Tap Holds Every Tap

Supplying `onDoubleTap` delays every `onTap` by the double-tap timeout
(~300ms): the framework cannot fire the tap until the tap stops being a
possible double-tap. A toggle on that detector feels laggy by construction.

- Toggles that must feel instant need hand-rolled tap detection in your own
  loop: down plus up inside slop inside the tap timeout, fired on finger-up.
- Double-tap reset survives as two instant toggles (net mode unchanged)
  plus a view reset on the second tap-up inside the double-tap window.
- Guard taps against drags: reject multi-pointer streams and movement past
  touch slop, or scrolling starts toggling.

## 1:1 Finger Tracking

Pan distance must scale by the current span, not the full range. Applying a
drag as a fraction of the full range tracks 1:1 only at full zoom; zoomed
in, every drag overshoots by the zoom factor. Example: scrolling ran
"much too fast" after zooming, from one missing span factor. The zoom
focus point stays put by construction (anchor the focus fraction through
the span change), so fingers stay over the same data values throughout.

## Y-Freeze Ownership

Freezing an axis during gestures needs press truth, not timers. A
quiescence timer leaks on held-still pinches (no events arrive, the timer
releases mid-gesture). Own it exactly: freeze on first finger down, release
on last finger up, in a loop that observes without consuming. Taps also
pass through the loop (down plus up, view unchanged), so freeze plus
release on a tap is a harmless no-op.
