# Speed ramps

- Shape: normal -> ease down (0.3-0.6 s) -> slow hold (25-40%) -> ease up -> normal. Example:
  `ramps: [{start: 12.0, end: 12.5, from: 1, to: 0.3, curve: "ease-in-out"}, {start: 12.5, end: 13.2, speed: 0.3, quality: "blend"}, {start: 13.2, end: 13.6, from: 0.3, to: 1, curve: "ease-in-out"}]`
- Ranges are SOURCE seconds and must sit inside kept segments.
- Speed-ups (2-8x) compress travel or setup; ease out of them too.
- Time the slowest frame to the beat: output time = edit time of the ramp start + the ramp's
  output length; check with review_edit's contact sheet.
- `quality`: frames (duplicate; fine at >= 50% or for high-frame-rate sources), blend (soft,
  safe), optical (motion-interpolated; best on simple motion, check for warping).
- Freeze: `freezes: [{at: 14.2, duration: 0.8}]` (source time, edited seconds held).
- Reverse: `{start, end, reverse: true, speed?}`: rewinds, "undo" gags. Use once.
- Review flags: > 8x jumps between neighbours, ramp pieces under 4 frames (stutter), slow
  motion under 50% without blending.
