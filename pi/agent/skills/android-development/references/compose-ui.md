# Compose UI

Scope: Compose screens, navigation, progress, and theme. Pointer-input
detector problems live in [compose gestures](compose-gestures.md).

## Back Navigation

`BackHandler(enabled = screen != Home)` is not reliable enough. The enabled
flag changes on recomposition, so a back press in the stale frame is still
delivered to the old screen. Symptom: after `< Home`, one back press appears
to stay on Home; the next one exits. A focused search field can also make the
IME consume the first back press.

- Use one always-enabled `BackHandler`. Read the live screen state inside the
  callback; do not gate the handler on a state-derived `enabled` flag.
- At the root, call `finish()`. A root back exits in one press.
- Hide the IME first: `LocalSoftwareKeyboardController.current?.hide()`, both
  in the system-back handler and in the in-app `< Home` link.
- Extract the mapping to a pure function and unit-test it:
  `backTarget(screen): Screen?` (null means finish).
- Example map: Home -> finish; Overlays -> Picker; Picker/Timers/Setup -> Home.

## Smooth Progress

- Never wire a progress bar to a once-per-second state; it steps. Keep the
  label on whole seconds and animate only the geometry.
- `val p = remember(resetKey) { Animatable(0f) }`, then
  `p.animateTo(1f, tween(waitSec * 1000, easing = LinearEasing))`.
  `animateFloatAsState` with a linear tween is the alternative.
- Do not switch to a solid success color at 100%. Keep one gradient for the
  whole fill; a color flip reads as a new state, not completion.
- `fillMaxWidth(fraction)` requires 0..1; coerce.

## One-Click Toggles

- For a setting used nearly every time, make the whole row toggle it. Put the
  rare secondary setting (overlay / look-through / advanced) on its own screen,
  not in a bottom sheet on every tap.
- Nested `clickable`s consume: a pill inside a row toggles once, the row
  toggles once. Test both.
- Freeze list ordering while toggling: snapshot the active set on load/query so
  rows do not jump under the finger. Render the live value from the store, not
  the frozen snapshot.

## Theme and System Bars

- Fixed light theme:
  ```kotlin
  enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.light(TRANSPARENT, TRANSPARENT),
      navigationBarStyle = SystemBarStyle.light(TRANSPARENT, TRANSPARENT),
  )
  ```
  Add `statusBarsPadding()` and `navigationBarsPadding()` once at the root.
- A fixed palette that ignores system dark mode is valid for a kiosk-like app.
  State the choice; do not let half the screens follow dark mode.

## Ktlint Traps

- `@Composable` functions still need lowercase names. The function-naming rule
  does not exempt annotations; PascalCase composables fail `ktlintCheck`.
- A file with one top-level class must match its name (`Screen.kt`, not
  `Nav.kt`).
- `RememberInComposition`: a `MutableInteractionSource()` created in composition
  must be `remember`ed.
- Run the project's format fix (`ktlintFormat`), then the full check. Some rules
  are not auto-correctable and name the file/line.
