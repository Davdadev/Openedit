# Cutting craft, in detail

Load this when you are choosing `manualCuts`, judging a `plan_cuts` result, or fixing a cut
that "feels wrong".

## 1. Read the transcript like an editor

Mark these as you read (keep a short list with source timestamps):

| Mark | What it looks like in the transcript | Usual action |
|---|---|---|
| Dead intro | "ok, is this on", "so yeah, hi guys, um" before the real first sentence | cut to the first sentence that says something |
| False start | a sentence that stops mid-way and restarts within ~10 s | cut the abandoned attempt, keep the last full one |
| Retake | the same point said twice, both complete | keep the better delivery (usually the later, check energy) |
| Tangent | a story that does not serve the stated goal | propose cutting, quote it to the user |
| Repetition | the same idea made twice in different words | keep the clearer one |
| Beat | a joke, a reveal, a number, a question to the audience | protect the pause after it |
| Trail-off outro | "so yeah... I guess that's it... um" | end on the last strong sentence |

Whisper often drops fillers at `base`. If the speaker clearly hesitates and `plan_cuts` finds
none, re-run with `model: "small"` (slower, better).

## 2. Where a cut goes

- Cut at word boundaries from the word-level JSON (path printed by `transcribe`). Prefer the gap
  just before an inhale, not after it, so the next sentence starts clean.
- A cut that removes a breath entirely makes speech sound machine-gunned. Over a whole video,
  the speaker should still audibly breathe every few sentences.
- Keep ~0.15-0.35 s of air at ordinary cuts. Keep ~0.4-0.8 s after: a punchline, a rhetorical
  question, a number the viewer needs to absorb, an emotional statement, a topic change.
- Do not cut inside a laugh, a sigh, or a smile that resolves a line: those are performances.
- Two cuts closer than ~0.5 s apart produce a visible stutter. Merge them or keep the middle.
- `minKeep` drops kept pieces shorter than 0.25 s by default; a 1-word piece left between two
  cuts is almost always wrong: remove it or restore the cut around it.

Restore cuts with `revise_plan {planId, restore:[indices]}` (indices from `show_plan`), add
cuts with `addCuts`. It returns a NEW planId: use that one from then on.

## 3. Jump cuts, J-cuts and L-cuts

- A jump cut inside one continuous shot is accepted on YouTube. It is jarring when the head
  position jumps a lot. Options, best first: (1) cut elsewhere so positions match, (2) cover it
  with b-roll that starts slightly before the cut and ends after it, (3) a framing change
  (zoom 100 -> 108%) exactly on the cut, (4) leave it.
- **J-cut**: next shot's audio starts before its picture. Use when moving to a new speaker or
  scene: the viewer hears it, then sees it.
- **L-cut**: picture changes, previous audio continues. Use for b-roll under narration and for
  reaction shots in interviews.
- In OpenEdit, b-roll on V2 over continuous A1 dialogue is already an L/J structure. In
  Premiere/Resolve you can also extend audio edits by hand (computer-use skills).

## 4. Rhythm checks

- Read the edited transcript aloud in your head at speaking pace. If two sentences now collide
  ("...and that's why. So the second thing..."), there is not enough air or a connective word
  was removed.
- Average shot length for a talking head after jump cuts is commonly 3-8 s. Many cuts under
  1.5 s means you are cutting on silence, not meaning.
- Time saved is not the goal. 10-25% is typical for a clean talking head; 40%+ usually means
  content was cut or breaths removed: check before applying.

## 5. Things the user owns

Do not remove: deliberate silences, sponsor reads (unless asked), legal disclaimers, music
cues, cold opens, a callback to an earlier joke. When unsure whether something is intentional,
keep it and mention it.

## 6. Multi-camera and multiple files

`plan_cuts` covers one source. With several files on a timeline, plan each one and say how
they are assembled. For two-camera interviews, prefer switching angles at speaker changes and
reactions over zooming.
