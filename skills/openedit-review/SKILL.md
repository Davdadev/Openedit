---
name: openedit-review
description: Quality-check a finished or draft video edit before telling the user it is done - extract frames or a contact sheet, verify duration against the cut plan, loudness (LUFS / true peak), caption placement and timing, framing after reframe, black or frozen frames, audio gaps and cut stutters, then fix and re-render. Use after every OpenEdit render, when the user asks to "check", "review", "QA" or "watch" an edit, or before delivering any video file. Uses the review_edit MCP tool when available, otherwise probe_media plus ffmpeg.
---

# Reviewing an edit

You cannot watch video in real time, but you can look at many frames, measure audio, and read
the timeline. Do that every time. An unreviewed render is a draft.

## 1. Gather evidence

**Preferred:** `review_edit {path: <rendered file>}` returns a contact-sheet image, loudness
(integrated LUFS, true peak, LRA) and cut statistics. Pass the planId too if the tool accepts
it, so it can compare against the plan. Look at the image: actually inspect every tile.

**If `review_edit` is not available** (older OpenEdit), use `probe_media` and ffmpeg through the
shell. Commands: [references/ffmpeg-checks.md](references/ffmpeg-checks.md). Minimum set:

1. `probe_media {path}`: duration, resolution, fps, audio present.
2. Contact sheet: one frame every N seconds (N = duration / 24, at least 1 s), tiled; Read it.
3. Frames at every caption-dense or zoomed moment and at 3-5 random cuts, full size.
4. Loudness: `ebur128` integrated and true peak.
5. `blackdetect`, `freezedetect`, `silencedetect` for gaps.

## 2. Judge it (checklist)

**Structure and timing**
- [ ] Duration matches the plan's `editedDuration` within ~0.1 s (standalone) or one frame per
      cut (NLE export). A big mismatch means cuts were not applied or media was offline.
- [ ] Starts on content (no dead frames, no "um"), ends on a complete sentence plus decay.
- [ ] No unintended black, frozen or flash frames (`blackdetect` / `freezedetect` hits that are
      not deliberate fades).
- [ ] No stutter cuts (two cuts < 0.5 s apart) or one-word islands.

**Picture**
- [ ] Faces in frame on every tile after reframe; headroom sensible; no subject cut in half.
- [ ] Zooms are where intended and not more frequent than the format allows (count them).
- [ ] B-roll matches aspect, resolution, light and colour; no watermarks; held 2-5 s.
- [ ] Graphics not cropped at the edges; lower thirds do not collide with captions.
- [ ] Exposure and white balance consistent between shots.

**Captions**
- [ ] Present when expected, correct style for the format (no `bold-pop` on long-form).
- [ ] <= 2 lines, readable size, inside safe areas, never over faces or on-screen text.
- [ ] In sync: pick 3 caption frames and compare the text with the transcript at that time.
- [ ] Spelling of names and product terms (whisper often mishears them: fix the SRT).

**Audio**
- [ ] Integrated loudness at target (-14 LUFS YouTube/social, -16 podcast, -23 broadcast),
      true peak <= -1 dBTP.
- [ ] Voice clearly above music: during speech, music ~20-24 dB under the voice.
- [ ] No clicks at cuts (very short `silencedetect` hits mid-sentence can indicate gaps), no
      doubled audio from b-roll, no SFX on every cut.

**Taste** (openedit-editing slop list)
- [ ] Every effect has a reason. Nothing on the slop list unless the user asked for it.

## 3. Fix, re-render, re-check

Map problems to tools:

| Problem | Fix |
|---|---|
| Cut too tight / clipped word | `revise_plan {restore:[i]}` -> re-apply -> re-caption -> re-render |
| Missed filler / retake | `revise_plan {addCuts:[...]}` |
| Too many zooms | re-plan zooms with larger `minGap`, or place fewer with `add_zooms` |
| Captions over face | shorter `maxWords`/`maxChars`, or different style; in NLE move the track style |
| Misheard word | edit the .srt (path from `make_captions`) and re-import / re-render |
| Loudness off | `render {loudnorm:true}` (standalone) or normalise in the NLE export |
| Bad b-roll | replace via `find_media` with a more literal query, or remove |
| Subject off-centre in 9:16 | `reframe:{aspect:"9:16", mode:"manual", focusX:...}` |

Use `quality:"draft"` while iterating; render `final` once it passes. Limit yourself to
two fix passes, then report remaining issues honestly instead of looping.

## 4. Report

Tell the user: file path, duration, loudness numbers, what you checked, what you fixed, and
anything left for their judgement (with timestamps). Attach or mention the contact sheet path
if useful. Do not claim checks you did not run.
