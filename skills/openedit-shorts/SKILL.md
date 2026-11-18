---
name: openedit-shorts
description: Turn long-form video into vertical 9:16 short-form clips (YouTube Shorts, Instagram Reels, TikTok) with OpenEdit - find the self-contained 20-60 s moment in the transcript, build a hook in the first 1-2 seconds, reframe on the speaker's face, add bold word-by-word captions inside the platform safe zones, and end on a beat. Use whenever the user asks for shorts, reels, TikToks, clips, highlights, vertical or 9:16 versions, "make this viral", or social cut-downs of a longer video or podcast.
---

# Shorts from long-form

A good short is one idea, told completely, that earns the next second at every second. You are
not shrinking the long video: you are finding the part that stands alone.

Use with openedit-editing (cutting craft) and openedit-review (QA). Everything below assumes the
OpenEdit MCP tools.

## 1. Find the moment (from the transcript, not from silence)

`transcribe {path}` and read all of it. Shortlist 3-5 candidates. A candidate must:

- **Stand alone.** No "as I said earlier", no unexplained "he"/"this", no setup that lives
  10 minutes earlier. If it needs one line of context, you may splice that line in.
- **Have a hook line** that works in 1-2 s: a surprising claim, a number, a question, a
  conflict, a strong opinion. Often it is in the middle of the passage: move it to the front
  (a "cold open" of the best line, then the build-up) when the logic survives.
- **Pay off.** End on the answer, the punchline, or the strongest sentence. Never on "so yeah".
- **Fit 20-60 s** after tightening. 30-45 s is the sweet spot for talking content.

Present the shortlist to the user with timestamps, the hook line quoted, and the planned
length, then build the ones they pick (or the best one if they asked you to choose).

## 2. Cut it

Build one plan per short. Remove everything outside the moment with `manualCuts` (source
times), and tighten inside it:

```
plan_cuts {path, tightness:"tight", removeFillers:true, removeRetakes:true,
           manualCuts:[{start:0, end:<moment start>}, {start:<moment end>, end:<duration>}, ...]}
show_plan {planId}
apply_cuts {planId}
```

- First frame = first word of the hook. No breath, no "so", no lead-in. Zero dead air at start.
- Inside: keep 0.05-0.15 s at cuts, but still keep the pause after the punchline (~0.3-0.5 s).
- Moving the hook to the front means two passes: plan the body, and place the hook line ahead
  of it (standalone: render the hook and body as separate plans and join, or describe the
  re-order to the user for the NLE). Check the joined audio does not jump in level or room tone.
- Ending: cut right after the last word plus its natural decay (~0.3 s). Loopable endings
  (last line flows into the first) are a bonus, not a requirement.

## 3. Reframe

`render {output, reframe:"9:16", loudnorm:true}` follows the speaker's face (macOS Vision,
smoothed). Check frames: if the subject is off-centre or two people talk, use
`reframe:{aspect:"9:16", mode:"manual", focusX:0.3}` per speaker, or split into shots.
Source already vertical: no reframe. Screen recordings rarely survive a 9:16 crop: prefer a
stacked layout made in the NLE, or skip them.

## 4. Captions (the one place `bold-pop` belongs)

```
make_captions {planId, style:"bold-pop", maxWords:3, maxChars:20}
```

- 1 line, 2-4 words, highlight on the spoken word. Large, high contrast, outlined.
- Keep them inside the safe zone (below): OpenEdit's vertical captions sit ~22% above the
  bottom edge; confirm on frames that nothing falls under the platform caption/handle area or
  behind the right-hand button column, and that they never cover the mouth or eyes.
- Verbatim words. No emoji, no hype rewrites, no colours changing per word.

Safe-zone numbers and platform notes: [references/safe-zones.md](references/safe-zones.md).

## 5. Motion and sound

- Punch-ins are acceptable more often here (one per 3-6 s) to reset attention on jump cuts:
  `auto_zooms {planId, style:"punch", minGap:4}`. Still not every sentence.
- Music: optional, low and ducked (`gainDb:-22, duckDb:8`), never louder than the voice.
  Trend audio is the user's call (licensing is platform-specific).
- No whoosh on every cut, no meme SFX, no subscribe animation unless asked.
- Text on screen (a title in the first second) only if the hook is not clear from audio alone;
  keep it inside the top safe zone, <= 6 words.

## 6. Review (mandatory)

Run openedit-review on each render. Short-specific checks:

- [ ] First 1 s: speech starts in the first ~0.3 s; first frame is not a blink or mid-gesture.
- [ ] Duration 20-60 s (or what the user asked), within ~1 s of the plan.
- [ ] Face stays in frame for the whole short (contact sheet at 1 fps).
- [ ] Captions inside the safe zone in every sampled frame; none over the face.
- [ ] -14 LUFS integrated, true peak <= -1 dBTP.
- [ ] Ends on a complete sentence; no trailing "um" or breath.

Report each short with its hook line, duration, file path and what you checked.
