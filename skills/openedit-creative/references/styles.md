# Style directions

Pick ONE direction before the first cut and keep every choice inside it: look, pace,
transitions, type, sound. Mixing directions is what makes an edit feel cheap.

| Direction | Look | Pace | Transitions | Type (OpenEdit templates) | Sound |
|---|---|---|---|---|---|
| **Playful pop** (candy, toys, snacks, kids, social) | `candy` | quick build (0.5-0.9 s), hero 1.5-2 s, bouncy | cuts, whips on energy jumps, one flash | `pop-lines` hook, one `stamp-badge`, `speech-bubble` for a reaction, `end-card` | upbeat funky / chiptune; pop, boing, crunch, whoosh |
| **Premium** (beauty, fashion, spirits, cars, jewellery) | `moody` or `warm-film`, grain 4-7 | slow (2-4 s), long holds, speed 0.5-0.7 | cuts and dissolves, dip-black between acts | `title-card` (thin, `align:left`), minimal `end-card` without sparkles | sparse piano / ambient; silence before the reveal |
| **Tech clean** (apps, SaaS, gadgets) | `cool-clean` | crisp 1-1.5 s, consistent | cuts, slides, wipes | `chip-label` for features, `kinetic-stack` for the claim, `callout` on UI | minimal electronic; soft clicks, swipes |
| **Hype / sport** (launch, events, sport) | `punchy` | fast (0.3-0.6 s) into a held peak | cuts, flashes, whips, ramps into hits | `kinetic-stack`, `tilt-tag` | driving beat; impacts, risers, a drop |
| **Warm lifestyle** (food, travel, family, local business) | `warm-film` or `bright-airy` | relaxed 1.5-3 s, natural sound breaks | cuts, gentle dissolves | `pop-lines` with soft colours, `lower-third` | acoustic / folk; natural sound at 2-3 moments |
| **Documentary / brand film** | `natural` or `mono` | follows the voice; picture holds | cuts, L/J cuts (openedit-rhythm) | `lower-third`, `quote`, `chapter` | score under voice, room tone |

## Colour for graphics

Sample the footage first: `analyze_footage` lists each shot's palette. Use the brand
colour (or the most saturated colour of the hero shot) as `accent`, a complementary one as
`accent2`, and dark `ink` on light shapes. Two or three colours, never a rainbow.

## Typography

One family per piece (two at most: a display face for titles, Inter for small text).
Bundled display faces: Archivo Black (bold, friendly), League Gothic / Oswald (condensed,
hype), Playfair Display (premium serif), Montserrat / Outfit / Poppins (clean). Text at
least ~5% of frame height for a phone; keep it inside the inner 90% of the frame.

## Getting more style

- `graphics_catalog` shows OpenEdit's library and the user's packs (MOGRTs in Premiere).
- The HyperFrames plugin's `hyperframes:hyperframes-registry` skill has ~450 editable blocks
  (glitch, film grain, kinetic type, 3D, charts, camera moves) to adapt into a template.
- The Design plugin's `design-critique` reviews a frame strip; `ux-copy` writes the words.
- The user's Figma frames become their own templates (openedit-motion-design).
