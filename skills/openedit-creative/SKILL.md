---
name: openedit-creative
description: Direct a creative edit (ad, commercial, promo, product film, brand spot, trailer, teaser, sizzle reel, travel or event film, social spot) from raw footage with OpenEdit, the way a commercial editor works - concept first, a shot list from analyze_footage, a structure with a hook, build and payoff, varied pacing, a grade, sound design, typography that earns its place, then build_sequence and review_edit. Use whenever the user wants footage turned into an ad or promo, asks for a video with a vibe, style, energy or brand feel, or says an edit looks cheap, boring, amateur, like a slideshow or terrible.
---

# Creative editing: ads, promos and anything with a vibe

A talking-head trim is judged on clarity. A creative edit is judged on **feeling**: does it
have an idea, a shape, a look and a sound? Nobody remembers a montage where every shot is the
same length, the colour is flat, the music is a placeholder and the title sits on black. That
is the default failure. This skill exists to avoid it.

## The workflow (do not skip steps)

1. **Log the footage**: `analyze_footage {folder}`. LOOK at the contact sheets. Write a shot
   list: hero shots (the best images you have), coverage, motion, and every shot that is
   unusable (blank, blown, black, rig or crew visible, lighting gear, the ground, hands fixing
   things, focus hunting). The ✗ REJECT and ⚠ tags help; your eye decides.
2. **Find the idea** in one line before touching the timeline: what is this piece *about*,
   and what is the single moment it builds to? ("Candy floats through ordinary worlds, then
   lands in a mouth: Say ahh.") The best moment in the footage is usually the payoff: build
   toward it, don't spend it in the first second.
3. **Structure**: pick a shape from [references/structures.md](references/structures.md)
   (hook / build / payoff / end card for most spots). Assign shots to sections.
4. **Pace**: shot lengths must VARY. Hero shots 1.5–3 s; the build quickens (0.4–0.8 s); the
   payoff gets room and often a ramp or a hold; the end card 2–3 s. Same-length cuts are a
   slideshow, beat-synced or not.
5. **Choose the look** (`look.preset`): candy/punchy for food, toys and products; warm-film
   for lifestyle and nostalgia; cool-clean for tech; moody for drama; bright-airy for beauty
   and wellness. One look for the whole piece; match exposure shot to shot with `exposure`.
6. **Music and sound**: music sets the vibe more than any picture choice. Pick a track whose
   energy matches the idea (`get_media {kind:"music"}`; audition 2–3). Sound-design the key
   moments: a whoosh on whips, a pop or crunch on the payoff, a riser into the end card
   (`get_media {kind:"sfx"}` → `sfx`). Silence before the payoff hits harder than more music.
7. **Typography**: few words, big, on picture, never on black. One idea per card. Check
   `graphics_catalog`; brand fonts and colours from Figma if the user has them.
8. **Build**: `build_sequence` with the full spec. Read its contact sheet and warnings.
9. **Review**: `review_edit {path}` (it analyses the render's own shots: unusable frames,
   metronome pacing, duplicate shots, a dark opening, loudness). Fix every warning, re-render.
   Then ask: would I stop scrolling for the first second? Is there one moment I'd remember?

Recipes for `build_sequence` (transitions, ramps, moves, sound): [references/sequence-recipes.md](references/sequence-recipes.md).

## Craft rules

- **Open on your best image**, in motion, in the first frame. No logo first, no black, no slow
  fade. A title can sit over the opening shot, small, after the image has landed.
- **Every cut needs a reason**: a new colour, a new world, a match in shape or motion, an
  action completing. Cut *on* movement; a whip into a whip, a push-in into a push-in.
- **Give the payoff room**: slow into it (`ramp {from:1,to:0.35,curve:"ease-out"}`), hold the
  frame (`holdEnd`), drop the music for half a second, land a sound.
- **Transitions are punctuation**, not decoration: mostly cuts; one or two whips or flashes
  where the energy jumps; a dip to white or black only between acts. Never a different
  transition on every cut.
- **Post moves**: a slow push-in (0.04–0.08) adds life to a static hero shot. Not on every
  shot, never on shots that already move.
- **Colour consistency beats colour boldness**: a strong look on mismatched shots looks
  worse than no look.
- **Rig and crew**: if a stick, wire, stand or hand is visible, the shot is unusable unless
  it is removed properly or cropped out (`move` with a larger `amount` to reframe). OpenEdit
  does not do object removal; tell the user it needs DaVinci Resolve Studio (Magic Mask /
  Object Removal), After Effects (Content-Aware Fill) or a dedicated tool, and never ship a
  "removed" rig that still shows as a ghost line.
- **Length**: 6 s bumper, 15 s spot, 30 s spot. Shorter is almost always better; cut the
  weakest shot, not the end card.

## Anti-slop (each of these makes an edit look cheap)

Metronome cutting (every shot the same length) · opening on black or a logo · a title card
on a black scrim hiding your best shot · unusable frames (blank, blown, gear, ground) left in
· the same shot twice · placeholder or mismatched music, or music too quiet · no sound
design at all · a different transition on every cut · zooms or ramps on every shot · five
fonts, rainbow text, text on every shot · ending on a fade-out mid-phrase · no idea, just
"nice shots in a row".

## Reporting to the user

Say the idea in one line, the structure (what happens when), the look and sound choices and
why, the length, where the file is, what review_edit checked, and anything you could not fix
(e.g. rig visible in footage, no suitable music found). Offer the next iteration concretely.
