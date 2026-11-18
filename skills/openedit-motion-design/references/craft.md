# Motion craft reference

## Timing table

| Element | Entrance | Hold | Exit |
|---------|----------|------|------|
| Lower third | 0.5-0.7 s total (bar 0.4, plate 0.6, text staggered after) | 3-5 s | 0.3-0.4 s |
| Title card | 0.6-1.0 s | >= reading time | 0.4 s |
| Callout | 0.3-0.5 s | while the thing is discussed | 0.25 s |
| Counter | 1.0-1.6 s count-up (`outQuart`) | 1.5 s after it lands | fade 0.3 s |
| Kinetic hook (shorts) | 0.25-0.4 s per word | on the beat | cut, or 0.2 s |

## Preset choices (create_motion_template `motion`)

- Plates and bars: `wipe-right`, `grow-x` (horizontal bars), `grow-y` (vertical accent bars).
- Primary text: `mask-up` with `split: "words"` (confident), `split: "chars"` for short titles.
- Secondary text: `fade` or `rise` with a small `distance` (1.5-2 rem), or `tracking-in` for
  uppercase labels.
- Lines, arrows, outlines: `line-draw` (SVG strokes).
- Numbers: `count-up` (keeps prefix/suffix and separators).
- Key word: `highlight` or `underline`, once.
- Logos, avatars: `iris`, `scale-in`; `pop`/`spring-in` only for playful brands.
- Depth: `drift` with different `x` on background and foreground layers (parallax).
- Easing names: outExpo (default), outQuart, outBack (sparingly), spring, inOutQuart (wipes),
  or `cubic-bezier(x1,y1,x2,y2)` copied from the design tool.

## Type

- Two families max (one is often enough: weights carry the hierarchy).
- Name 54-64 px, role 22-28 px at 1080p; uppercase labels need 0.12-0.2 em tracking.
- Line length under ~40 characters on screen.

## Colour and legibility

- Brand accent for small areas only (bars, dashes, highlights); text white or near-black.
- Plates at 80-90% opacity of a near-black/near-white, or a soft shadow for text without a plate.
- Check over the actual footage frame: the preview backdrop is neutral grey; `review_edit`
  shows the real result.

## Anti-slop checklist

- Generic subscribe/like animations, bells, cursor clicks: no.
- Emoji or stickers as decoration: no (only if the brand is genuinely playful and the user asked).
- Rainbow or multi-stop neon gradients: no.
- More than 2 fonts, or a display font for body text: no.
- Motion on every word, every sentence a graphic: no.
- Graphics covering faces, captions or on-screen UI being discussed: no.
- Elastic/bounce on serious or corporate content: no.
- Lower thirds that never leave: no; exit after the read.
