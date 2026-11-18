---
name: openedit-motion-design
description: Design and place motion graphics with OpenEdit - lower thirds, titles, callouts, kinetic type, stat counters - from the user's own template packs (MOGRT, Motion Bro), OpenEdit's templates, or custom brand graphics built from Figma frames with create_motion_template. Covers graphics_catalog, preview_template, place_graphic in Premiere Pro, DaVinci Resolve and standalone, motion craft (timing, easing, hierarchy, legibility, safe areas) and pack licensing. Use when the user asks for titles, a lower third, name tags, on-screen text, animated callouts, "make it look branded", "use my Figma design" or "use my template pack".
---

# Motion design with OpenEdit

Graphics exist to inform (who is speaking, what the number is, where to look). If a graphic
does not inform or reinforce the brand, leave it out. One clean lower third beats five
animated stickers.

## Tools

| Tool | Use |
|------|-----|
| `import_template_pack {path}` | Index the user's pack (.mbr, .zip, folder, .mogrt, .aep) in place. |
| `graphics_catalog {query?, category?, app?}` | Numbered contact sheet + list. LOOK at the image before choosing. Pass `app` = the active host. |
| `preview_template {id, params?}` | Frame strip (entrance, settled, hold, exit) + editable fields. |
| `create_motion_template {figmaCode or html/svg/css, fields, motion}` | Custom/brand template; returns a preview strip. |
| `place_graphic {id, at, params, duration?, editable?}` | Places on the timeline (see host table). |

What works where:

| Template | Premiere | Resolve | Standalone |
|----------|----------|---------|------------|
| `.mogrt` (packs) | native, editable in Essential Graphics | no (needs Premiere) | no |
| OpenEdit / user (Figma) | alpha ProRes overlay on V3 | alpha overlay, or `editable: true` = Fusion Text+ title | burned into the render |
| `.aep` | style reference only (needs After Effects) | same | same |
| locked `.demo` | preview only | - | - |

If the user picks a MOGRT in Resolve, say so plainly and offer the alternatives the error
lists, or recreate the *idea* (not a 1:1 copy) with `create_motion_template`.

## Workflow

1. `editor_status`, then `graphics_catalog {app: <host>}`. Read the contact sheet.
2. Choose by purpose (below), then `preview_template` and check the fields.
3. Fill fields from the transcript (exact name spelling, real title). Keep colours to the
   brand: Figma variables or the colours already in the video.
4. `place_graphic` at the right moment: a lower third ~1-2 s after the person starts
   speaking, never over a cut; a title on a beat or a pause.
5. After rendering, `review_edit`: check the graphic does not cover faces or captions.

## Which graphic when

- **Lower third**: first appearance of a speaker; 4-6 s; once per person per video.
- **Title / chapter card**: section changes; 2.5-4 s; same style for every chapter.
- **Callout / highlight**: point at UI or a detail; arrives with the words that name it.
- **Kinetic type**: the hook or one key line of a short; never whole paragraphs.
- **Counter / stat**: a number the speaker says; count-up lands as the number is spoken.

## Motion craft (the rules that make it look designed)

- Entrances 0.3-0.6 s (up to 0.9 s for big titles) with an ease-out: `outExpo`, `outQuart`.
  Never linear. Exits faster (about 60%) with an ease-in; `autoExit` does this for you.
- Hold at least the reading time: 1.5 s + ~0.3 s per word.
- Stagger: chars 0.015-0.04 s, words 0.04-0.12 s, lines 0.08-0.15 s. Lead with the
  structure (bar, plate), then the primary text, then the secondary.
- One motion language per video: 2-3 presets, same easing, same direction.
- Hierarchy: one primary line, one secondary at ~40-50% size; max 2 type families.
- Legibility over footage: a plate, a shadow or a scrim; contrast at least 4.5:1.
- Safe areas: keep text inside the inner 90% (title safe); for 9:16 keep clear of the
  bottom 20% and the right edge (platform UI). Make a 9:16 variant rather than squeezing 16:9.
- Less is more: no graphic on every sentence, no motion on every word.

Details and preset choices: `references/craft.md`.

## Figma → motion template

Full step-by-step with the Figma MCP tool names, layer naming and the motion spec:
`references/figma-workflow.md`. In short: `get_metadata` → `get_design_context` on the frame
→ `get_variable_defs` for brand colours → `get_screenshot` to compare → `create_motion_template
{figmaCode, motion}` → look at the strip, fix, call again with the same name → `place_graphic`.

## Template packs and licences

Commercial packs (Motion Bro, Envato, Motion Array…) are licensed to the user for their own
projects. Use them only in the user's edits. Never copy pack files, previews or frames
elsewhere, never redistribute them, never recreate a pack design 1:1 as a new template.
Missing fonts (shown in the catalog) make MOGRTs look wrong: tell the user which to install.

## Anti-slop

Do not produce: generic "subscribe" bell animations, emoji spam, rainbow gradients, more than
two fonts, bounce/elastic on serious content, motion on every word, graphics over faces,
drop shadows plus glows plus outlines together, text smaller than ~3% of frame height,
lower thirds that sit on screen for the whole clip. See `references/craft.md`.
