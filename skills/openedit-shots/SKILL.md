---
name: openedit-shots
description: Look at footage like an editor with OpenEdit's analyze_footage, suggest_broll, find_match_cuts, multicam_sync and multicam_edit tools - log shots from contact sheets, pick literal b-roll from the user's own library (no slop), find match cuts, and cut multicam interviews with editorial grammar. Use when the user hands over a folder of rushes or b-roll, asks to "add b-roll from my footage", "find a match cut", "sync my cameras", "cut the multicam" or "switch between angles", or whenever an edit has more than one camera or clip.
---

# Shots and scenes: see the footage before you cut it

Never choose a shot you have not looked at. Every tool here returns a contact sheet image:
read it. The numbers (confidence, scores) rank candidates; your eye decides.

## 1. Log the footage first

1. `analyze_footage {folder}` (or `{paths}`) on every new folder. It is cached, so call it freely.
2. Read the sheet. Build a mental shot list: what each file is (A-roll interview, b-roll, graphics,
   junk), the good shots (sharp, well exposed, steady or with a motivated move), the setups
   (wide / medium / close-up), the palette of each scene.
3. Note the bad ones and never use them: soft, crushed or clipped, shaky without purpose,
   title cards, slates, black. Accent bars on the sheet: red ECU, orange close-up, yellow medium,
   green wide, blue no faces.

Details: `references/logging.md`.

## 2. B-roll: literal to the line

`suggest_broll {planId, library}` ranks library shots per phrase; then you place the keepers with
`place_clips` (the payload is in the result). Rules:

- **Literal to the line.** Show what is being said, as it is said: "my computer reads it aloud"
  gets hands on a keyboard or a screen, cut a beat before the word. A shot that is only vaguely
  related is worse than staying on the speaker.
- **Confidence floor.** Phrases below the minimum get nothing, on purpose. Do not lower
  `minConfidence` to fill gaps; fill gaps with a better shot or with the speaker.
- **Hold 2-5 s.** Under 2 s nobody reads it; over 5 s it becomes a different film.
- **Motion matched to energy.** Calm explanation: steady or slow moves. Fast talk: movement.
- **Cut on action** when the shot has one (hand lands on a key, page turns).
- **No strangers' faces talking.** A new face moving its lips reads as a new speaker.
- **Consistent colour.** Black-and-white archive next to colour interview needs a reason;
  group cutaways from the same source and look.
- **Do not cover the first line** (the speaker introduces themselves) and keep total coverage
  under ~40 %.
- Stock (`useStock`) is a last resort: it returns unverified ideas. Download, run
  `analyze_footage` on them, look, then decide. Credit them (`media_credits`).

Details and anti-slop checklist: `references/broll.md`.

## 3. Match cuts: rare and earned

`find_match_cuts` proposes A-out / B-in pairs that rhyme by shape and position, motion
direction, colour or subject, with side-by-side frames. Use one or two in a piece, only where the
ideas connect too (circle of a planet -> round logo works when the story goes from mission to
agency). Sell it with sound: let B's audio start under A (J-cut). See `references/match-cuts.md`.

## 4. Multicam grammar

1. `multicam_sync {angles}`: check every confidence; anything under 0.3 must be checked by eye.
   Drift over ~40 ppm on long takes needs conforming.
2. `multicam_edit {angles, audioSource, output}`: builds the switch, renders, writes FCP7 XML /
   FCPXML, imports into Resolve when Resolve is active. Read the shot list it prints.
3. Grammar it follows (and you should keep when adjusting `rules`):
   - Open wide, then go to whoever talks.
   - Cut to the speaker in the pause before they speak, or a beat after they start when they
     overlap. Never on every sentence: hold a shot while the thought continues.
   - Minimum shot ~1.8 s; quick back-and-forth stays on the wide instead of ping-ponging.
   - In long answers: a listener reaction or a wide reset every ~20 s, and size changes on the
     same speaker only at sentence ends.
4. Render, then `review_edit` the result and look at the frames around the switches.

Details: `references/multicam.md`.
