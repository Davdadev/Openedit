---
name: openedit-editing
description: Edit video like a skilled human editor with the OpenEdit MCP tools (transcribe, plan_cuts, apply_cuts, make_captions, auto_zooms, place_clips, render). Use whenever the user asks to edit, cut, trim, tighten, clean up, remove silences or ums, add captions, subtitles, zooms, punch-ins, b-roll, music or sound effects, or render/export a video, a talking head, vlog, tutorial, podcast or interview, in Premiere Pro, DaVinci Resolve or standalone, even if they never say "OpenEdit". Encodes editorial craft, pacing by platform, loudness targets and an explicit anti-"AI slop" standard.
---

# Editing with OpenEdit

OpenEdit gives you precise tools; the taste is yours. A competent edit is one the viewer never
notices: it is clear, it keeps the speaker's rhythm, and every effect has a reason. Your job is
to make the cut a good editor would make, not to use every tool.

## The process (do not skip steps)

1. **Look before you cut.** `editor_status` (which host), `probe_media` (duration, fps, size,
   audio), `transcribe` (read the WHOLE transcript, not a skim). For anything over ~2 min, also
   look at a few frames (see openedit-review) so you know the framing, lighting and whether there
   is screen content.
2. **Decide the story.** In 2-4 sentences, write for yourself: who it is for, the one thing they
   should take away, the target length and platform. If the user did not say, infer from the
   footage and ask only if the platform changes the edit a lot (long-form vs short).
3. **Plan the cut from meaning, then mechanics.** Choose `manualCuts` from the transcript first
   (tangents, repeated points, dead intros like "ok so, um, is this recording?", outros that
   trail off), then let `plan_cuts` handle silences, fillers and retakes. Pick `tightness` by
   platform (table below).
4. **Show the plan.** `show_plan`, then tell the user in plain words: what goes, quoted, and the
   new length. Get an OK before `apply_cuts` on anything non-trivial, and always before cuts
   that remove content (not just air) or exceed ~20% of runtime.
5. **Apply, then dress, in this order:** `apply_cuts` -> captions -> zooms -> b-roll / graphics
   -> music / SFX -> `render`. Times after `apply_cuts` are EDITED-timeline seconds.
6. **Review before you report.** Run the openedit-review loop on the render (frames, duration vs
   plan, loudness, captions). Fix what you find, re-render, then report. Never say "done" about
   a file you have not inspected.

## Cutting rules

- **Cut on meaning, not on silence alone.** A pause after a punchline, before a key number, or
  while the speaker thinks on camera is content. Silence detection only finds candidates.
- **Keep a breath.** Leave ~0.15-0.35 s of air at most cuts; ~0.4-0.8 s after a punchline,
  question or emotional beat. Restore over-tight cuts with `revise_plan {restore:[i]}`.
- **Never cut mid-word or on a plosive.** If a cut lands inside a word in the transcript, move
  the boundary to the word edge. Words like "so", "and", "but" that start a thought stay.
- **False starts go, rhythm stays.** Remove the abandoned attempt and keep the clean take
  (`removeRetakes` lists candidates: check each one against the transcript before trusting it).
  Do not remove every "so" or "like": fillers that carry tone or timing stay.
- **J/L thinking.** When a cut feels abrupt, the fix is often letting audio lead (J) or trail
  (L) the picture, or covering the jump with b-roll under continuous audio, not deleting more.
- **Jump cuts are fine on talking heads** if the framing changes or the cut is clean. A zoom to
  hide a jump cut is a tool, not a style (see zoom budget).
- **Do not "fix" what the user did on purpose** (deliberate pauses, music beds, a cold open).

Full rules, with examples and the J/L recipe: [references/craft-rules.md](references/craft-rules.md).

## Pacing by platform

| Format | `tightness` | Air kept at cuts | Zooms | Captions |
|---|---|---|---|---|
| YouTube talking head (long-form) | normal | 0.15-0.3 s | <= 1 per 15-20 s, 105-112% | optional, `clean`/`minimal`, 1-2 lines |
| Tutorial / screen recording | loose | keep pauses while the UI acts | only to make UI readable, held | `clean` |
| Interview / podcast video | loose | keep reaction beats | almost none | `minimal` or none |
| Shorts / Reels / TikTok (9:16) | tight | 0.05-0.15 s | 1 per 3-6 s ok | `bold-pop`, 3-4 words |
| Story / documentary | loose | let it breathe | none unless motivated | `clean` |

Details, typical cut rates and what "too tight" sounds like: [references/platform-pacing.md](references/platform-pacing.md).

## Dressing the edit

- **Captions:** 1-2 lines, <= ~32 characters per line (`maxChars` default 32), on screen long
  enough to read (>= ~0.8 s). Highlight-word (`bold-pop`) only for short-form; long-form gets
  `clean` or `minimal`. Never cover a face or on-screen text: check frames.
- **Zooms:** only to hide a jump cut or land emphasis on a specific line. Long-form: at most
  ~1 per 15-20 s (pass `minGap: 15` or more to `auto_zooms`, or place by hand with
  `add_zooms`). Never one per sentence. 105-112% for reframes, 115-120% for real emphasis.
- **B-roll:** must show the specific thing said in that sentence, held 2-5 s, cut on action or
  on the phrase, under continuous dialogue. If nothing literal fits, skip it (openedit-stock-media).
- **Music:** under speech, sit it ~20-24 dB below the voice; let it rise in gaps and intros.
  Start with `place_clips` `gainDb: -20, duckDb: 8, fadeOut: 2` and verify by ear and meter.
- **SFX:** only when they mean something (a UI click on a screen recording, a real impact).
  No whoosh-on-every-cut, no meme sounds unless the user asks for that style.
- **Motion graphics:** a lower third the first time a person appears, a title card if the video
  needs one. `render_motion` at the final aspect. No "subscribe" animation unless asked.
- **Look:** keep exposure and colour consistent across clips; a mismatched b-roll clip reads as
  stock. Fix in the editor (computer-use skills) or choose better footage.

## Loudness and delivery

| Destination | Integrated | True peak |
|---|---|---|
| YouTube / social / streaming | -14 LUFS | <= -1 dBTP |
| Podcast (audio-first) | -16 LUFS | <= -1 dBTP |
| Broadcast (EBU R128) | -23 LUFS | <= -1 dBTP |

`render {loudnorm:true}` targets -14 LUFS / -1.5 dBTP (standalone). For other targets, render
without it and normalise in the editor (Resolve Deliver > Audio, Premiere Export > Effects >
Loudness Normalization), then measure. Use `quality:"draft"` for previews, `"final"` to deliver.

## The anti-slop standard

AI edits are recognisable because they apply every effect everywhere. Before rendering, check
the edit against [references/slop-list.md](references/slop-list.md). The short version:
no zoom on every line, no whoosh on every cut, no rainbow/karaoke captions on long-form, no emoji
captions, no stock clip that only shares a keyword, no generic subscribe animation, no cuts so
tight the speaker never breathes, no captions over faces, no mismatched stock quality or aspect.
If an effect has no reason you could say out loud, remove it.

## Hosts and fallbacks

- **Standalone (ffmpeg):** everything works, including keyframed zooms, ducking and burn-in.
- **Premiere (panel):** cuts, markers, captions track, keyframed zooms, clip placement, export.
- **Resolve Studio (bridge):** cuts, markers, subtitles, static zooms only (no keyframes in the
  API), placement, render.
- **No bridge** (free Resolve, Final Cut, others): `export_timeline` (`fcp7` or `fcpxml`) and
  tell the user the import path. When the scripting API cannot do a step, use
  openedit-resolve-computer-use or openedit-premiere-computer-use.

Tool-by-tool recipes and argument choices: [references/tool-recipes.md](references/tool-recipes.md).

## Beyond the clean cut

A clean cut is the floor, not the goal. When the piece calls for more, use the specialist skill
first, and only where it serves the story:

- **Rhythm** (music, montage, pacing, J/L cuts, speed ramps, cutting to the beat):
  openedit-rhythm.
- **Footage** (what is in the shots, b-roll that fits the line, match cuts, multicam):
  openedit-shots. Run `analyze_footage` before choosing any b-roll.
- **Graphics** (titles, lower thirds, the user's template packs, Figma designs):
  openedit-motion-design. Check `graphics_catalog` before inventing a new graphic.

## Reporting to the user

Say what you changed and why in editor language ("cut the 40 s setup before the first point,
kept the pause after the joke, 3 punch-ins on the numbers"), the new duration, where the file
is, what you checked, and anything you were unsure of. Credit stock media that needs
attribution (`media_credits`).
