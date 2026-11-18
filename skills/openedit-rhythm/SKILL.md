---
name: openedit-rhythm
description: Cut video to music and give an edit rhythm the way a professional editor does, with the OpenEdit tools detect_beats, fit_music, snap_to_beats, build_montage, add_jl_cuts and speed_ramp. Use whenever the user wants a montage, hype edit, travel or sports reel, music video, trailer, b-roll sequence cut to a song, cuts on the beat, a song edited to length or ending properly, J or L cuts, split edits, sound bridges, speed ramps, slow motion, freeze frames or reverse, or says an edit feels flat, choppy or off the beat. Encodes when to cut on the beat and when not to, beat vs downbeat vs phrase cutting by genre, split-edit grammar, ramp taste and music editing on bar lines.
---

# Rhythm: cutting to music, split edits and speed

Rhythm is what makes an edit feel intentional. The rules below are taste; the tools only make
them precise. The goal is never "more cuts on more beats", it is cuts that land where the music
and the story both want them.

## The tools

| Tool | What it does |
|---|---|
| `detect_beats {path}` | Tempo, beats, downbeats (bar lines), meter, sections (intro / build / drop / breakdown / outro, energy 0..1), the final downbeat and ring-out. Read it before every music edit. |
| `fit_music {music, duration?}` | Edits the song to length on bar lines (whole phrases removed/repeated, crossfade just before the downbeat) so it ends on its own ending. Writes an exact-length .m4a; `place` lays it under the timeline, ducked. |
| `snap_to_beats {planId, music?}` | Moves dialogue cuts onto beats only inside pauses, by <= 0.15 s, never into a word. `slideMusic` first slides the song (within a beat) to line up the most cuts. |
| `build_montage {clips, music, style, duration?, output?}` | Fits the song, cuts on a grid (on-beat / every-2-beats / downbeats / phrase), adapts to the song's energy, picks shot windows by motion when the shot analysis exists, renders. |
| `add_jl_cuts {planId, joins?, auto?}` | J (sound leads picture) and L (sound lags picture) at joins. `auto` is conservative. |
| `speed_ramp {planId, ramps?, freezes?}` | Constant or eased speed, slow motion (frames / blend / optical), freeze frames, reverse; later captions/markers follow the picture. |

Every plan tool returns a NEW planId; the standalone timeline is re-timed in place when it held
the old plan. Premiere/Resolve bridges build straight cuts: deliver split edits and ramps there
with `export_timeline {format: "fcp7"}` (Premiere/Resolve) or `"fcpxml"` (Final Cut/Resolve).
EDL carries speed (M2) but not split edits.

## Process

1. `detect_beats` on the track. Note tempo, where the energy changes (build, drop, breakdown) and
   where it resolves. If confidence < 0.5 (rubato, ambient), do not beat-cut: cut on phrases and
   on the picture's own rhythm.
2. Decide the cutting rate from genre and energy (table below), not from the tool default.
3. Fit the music FIRST (`fit_music` / `build_montage` does it), then cut picture to the fitted
   track. Picture cuts can hide music edits, so cut picture on every music edit point.
4. Review: `review_edit` reports beat alignment (% of cuts within ±40 ms / 1 frame), late cuts,
   J/L counts and ramp sanity. Look at the frames on the cut points. Fix, re-render.

## When to cut on the beat, and when not to

- **Cut on the beat** when the music is the spine: montages, hype, travel, sports, music videos,
  trailers. Land big picture changes (new location, new action) on downbeats; land the most
  important shot on the drop.
- **Cut against / off the beat** deliberately for tension, comedy, or when a cut on the beat
  would chop an action. A cut that completes an action (a jump landing, a door closing) beats a
  cut that hits the beat but breaks the action. Action first, beat second.
- **Do not beat-cut dialogue.** A talking head cut to every beat is the clearest sign of a
  machine edit. Under speech, the words decide the cuts; `snap_to_beats` only nudges cuts that
  are already in pauses, and only when the music is prominent. Leave the rest.
- **Late cuts feel sloppy, early cuts feel tight.** A cut 2-6 frames after a beat reads as a
  mistake; on the beat or one frame before reads as deliberate.

## Rate by genre (starting points)

| Edit | Grid | Notes |
|---|---|---|
| Hype / sports / trailer peak | on-beat or every-2-beats in drops, downbeats elsewhere | Never under ~0.45 s (11 frames at 25 fps) except deliberate flash frames |
| Montage / travel | downbeats, phrase in quiet passages | Let landscapes breathe 2-4 bars |
| Documentary / brand | phrase (4 bars) or section changes only | Music supports, does not drive |
| Interview with music bed | no beat cutting; snap a few pause cuts at most | Duck the music under speech |
| Music video / performance | downbeats + lyric phrases | Hold on performance moments |

Let shots breathe: the faster the music, the more you need a few long holds to make the fast
cuts feel fast. Vary the rate with the song's sections (build → tighten, breakdown → open up);
`build_montage` does this with `adaptive` (default on). See
[references/cutting-to-music.md](references/cutting-to-music.md).

## Split edits (J and L cuts)

- **J-cut** (sound leads): the next scene's sound or next speaker's line starts 0.3-1.5 s before
  the picture changes. Use for scene transitions (sound bridge), a new speaker, pulling the
  viewer forward.
- **L-cut** (sound lags): the line carries on over the next picture: reaction shots, b-roll
  entrances while the speaker keeps talking, the end of a scene lingering.
- Conversations: overlap 0.3-0.8 s; scene transitions 0.5-1.5 s; longer than ~2 s is a sound
  bridge, intended or not.
- On a single camera a long split shows the speaker out of sync: keep it under ~0.5 s or cover
  it with b-roll. `add_jl_cuts {auto: true}` only adds safe breath pre-laps and transition leads.
- B-roll over continuous dialogue is a split edit by nature; give b-roll natural sound a 0.3-0.5 s
  lead (J) so it enters with its world, at -18 to -24 dB under speech.
Details: [references/split-edits.md](references/split-edits.md).

## Speed ramps

- A ramp sells an action: ramp DOWN into the peak (the jump, the splash, the hit), hold it, ramp
  back UP out of it. Put the slowest point on a downbeat or the drop.
- Ease every ramp (`curve: "ease-in-out"`); abrupt 8x jumps look like dropped frames.
- Slow motion below 50% needs `quality: "blend"` or `"optical"` unless the source is high frame
  rate; optical can warp fast edges: check frames.
- Audio over a ramp: mute it and let music / a whoosh carry the moment; `pitch` only for short,
  mild changes.
- Freeze frames: a beat, not a gimmick (character intro, punchline). 0.5-1.5 s, on a hit.
Details: [references/speed-ramps.md](references/speed-ramps.md).

## Music editing

- Edit on bar lines, ideally whole phrases (4 or 8 bars), with the crossfade just before the
  downbeat. Never cut mid-phrase or mid-vocal line.
- End on the song's ending (final downbeat + ring-out). If the target is shorter, remove from the
  middle. A fade-out in the middle of a phrase is the most common amateur tell.
- If no natural ending fits, end on a downbeat with a short "button" (hit + quick fade).
- Under speech: -16 to -22 dB with ducking; music edits under words are hidden by the voice, but
  still keep them on bar lines.
See [references/music-editing.md](references/music-editing.md).

## Anti-slop

- Speed ramps on every shot. One or two ramps per minute, each selling a real action.
- Cutting on every beat for the whole piece (and on talking heads). Vary the rate.
- Energy mismatch: frantic cuts on a calm piece, or slow holds over a drop.
- Music that fades out mid-phrase, or ends seconds before / after the picture.
- Beat cuts that chop actions in half, or the same clip reused back to back.
- J/L cuts everywhere "because pros use them": use them where sound should move the story.
