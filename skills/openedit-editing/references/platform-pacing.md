# Pacing and settings by platform

Numbers are starting points used by working editors, not laws. Watch the result.

## YouTube talking head (8-30 min)

- `plan_cuts {tightness:"normal", removeFillers:true, removeRetakes:true}`; review retakes.
- Expect 10-25% saved. Average shot 3-8 s.
- Zooms: 0-4 per minute is the full range; aim for 1 per 15-20 s at most. `auto_zooms
  {planId, style:"smooth", minGap:15, baseScale:106, scale:112}` or hand-placed `add_zooms`
  on lines that matter. Re-check: count zooms / edited minutes.
- Captions optional. If used: `make_captions {style:"clean", maxWords:7, maxChars:32}`.
- B-roll: on concrete nouns and examples, 1 every 20-60 s is plenty.
- Music: optional; quiet bed in intro and section breaks, ducked under speech, or none.
- Loudness: -14 LUFS, true peak <= -1 dBTP.

## Tutorial / screen recording

- `tightness:"loose"`. Never cut while the cursor is moving towards or acting on a UI element:
  the viewer loses the causal link. Cut dead time while a progress bar runs, but show its start
  and end.
- Zooms: to make small UI text readable, held for the whole action, eased in and out
  (`style:"smooth"`), not punched in and out every sentence.
- Captions `clean`; never over the area being demonstrated.
- SFX: none, or a subtle click on real clicks if the user wants it.

## Interview / podcast video

- `tightness:"loose"`; keep listening and reaction moments: they sell the conversation.
- Remove crosstalk false starts only if they confuse meaning.
- Zooms: essentially none; use camera switches if there are two angles.
- Loudness: -16 LUFS if it is primarily a podcast, -14 LUFS for YouTube.
- Captions `minimal` or none.

## Short-form (Shorts, Reels, TikTok)

See the openedit-shorts skill. In summary: hook in the first 1-2 s, 20-60 s, `tightness:"tight"`,
`bold-pop` captions with 3-4 words, reframe 9:16, end on a beat, no dead air at the start.

## Corporate / explainer with voice-over

- Cuts follow the VO sentences; picture changes on phrase boundaries.
- Graphics (lower thirds, callouts) carry names, numbers and steps.
- Music bed at a constant ducked level, ending on a cadence, not a fade into silence mid-phrase.

## What "too tight" sounds like

Speaker never inhales; sentences start on the first consonant with no attack; laughter is
clipped; every pause is identical length. Fix with `revise_plan` restores or re-plan at the
next looser `tightness` with explicit `padding: 0.12`.

## What "too loose" sounds like

Audible "um" or thinking pauses over ~0.8 s that carry no meaning; long gaps between sections.
Re-plan tighter or add `manualCuts`.
