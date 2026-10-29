# Reverse Gesture Keyboard

A text box where every word is drawn as the swipe a finger would trace on a
phone keyboard to gesture-type it. Each glyph is a tiny keyboard the same
height as the text.

```sh
python3 -m http.server   # ES modules need http://, not file://
# open http://localhost:8000
```

## How the traces are made

`src/gesture.js` uses the **Sigma-Lognormal** model of rapid human movement:

- Each key-to-key hop is a stroke along a circular arc, with a lognormal speed
  profile (quick acceleration, long deceleration).
- The next stroke starts before the previous one ends. Their velocities add up,
  so the finger rounds the corners instead of stopping on each key. **Fluency**
  sets how much the strokes overlap.
- Aim points are scattered around key centers, with an extra offset shared by
  the whole word. Arcs get random curvature, and a small 8–12 Hz tremor is
  layered on top. **Sloppiness** scales all of these.
- Arc lengths are solved so that every chord still ends exactly on its aim
  point. The gesture always finishes where it was aimed.

Traces are seeded per word, per occurrence, so they stay stable as you edit.
The same word appearing twice gets two different but plausible traces.
**New hand** changes the global seed.

## Using the component

```html
<script type="module" src="src/gesture-textbox.js"></script>
<gesture-textbox sloppiness="0.4" fluency="0.5" show-letters></gesture-textbox>
```

`.value` gets or sets the text, and `input` events bubble out. You can theme it
with `--gesture-trace`, `--gesture-key`, `--gesture-h` (glyph height),
`--gesture-selection` and `--gesture-caret`.

A hidden `<textarea>` holds the real text, so typing, paste, undo and IME all
work natively. The component handles rendering, mouse-to-caret mapping and
up/down movement.
