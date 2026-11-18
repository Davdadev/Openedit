# build_sequence recipes

Every shot: `{shot | path+in, duration, transition?, speed? | ramp?, holdEnd?, move?, exposure?}`.
`shot` ids come from `analyze_footage` (pass the same folder as `footage`); the window is
centred inside that shot unless you give `in` (seconds from the shot's start).

## A 15 s product spot (skeleton)

```json
{
  "output": "~/Videos/spot.mp4",
  "footage": "~/Footage/shoot",
  "look": { "preset": "candy" },
  "shots": [
    { "shot": "A#2", "duration": 1.8, "move": { "type": "push-in", "amount": 0.06 }, "note": "hook: hero" },
    { "shot": "B#1", "duration": 1.2, "transition": { "type": "whip-left" } },
    { "shot": "C#3", "duration": 1.0 },
    { "shot": "D#1", "duration": 0.7 },
    { "shot": "E#2", "duration": 0.5 },
    { "shot": "F#1", "duration": 0.5, "transition": { "type": "flash" } },
    { "shot": "G#1", "duration": 2.0, "speed": 0.6, "move": { "type": "push-in", "amount": 0.05 }, "note": "product hero" },
    { "shot": "H#5", "duration": 2.4, "ramp": { "from": 1, "to": 0.35, "curve": "ease-out" }, "holdEnd": 0.4, "note": "payoff" },
    { "shot": "I#1", "duration": 2.6, "speed": 0.5, "transition": { "type": "dip-white", "duration": 0.3 }, "note": "end card bg" }
  ],
  "music": { "path": "~/Music/track.mp3" },
  "sfx": [
    { "path": "~/sfx/whoosh.wav", "at": 1.7 },
    { "path": "~/sfx/crunch.wav", "at": 10.6, "gainDb": 2 }
  ],
  "graphics": [{ "template": "title-card", "at": 12.8, "duration": 2.4, "params": { "title": "Say ahh." } }],
  "fadeOut": 0.3
}
```

## Transitions (how a shot ENTERS)

| Type | Default | Use for |
|---|---|---|
| cut | – | 90% of joins |
| whip-left/right/up/down | 0.22 s | an energy jump; match the camera's direction; add a whoosh |
| flash | 0.16 s | a beat hit, a reveal, act change in a fast piece |
| dissolve | 0.5 s | time passing, dreamy pieces; never in a fast build |
| dip-black / dip-white | 0.6 / 0.5 s | between acts, into the end card (white = light, black = drama) |
| slide / wipe / zoom / circle-open | 0.35–0.5 s | playful social pieces, sparingly |

On the first shot, `dip-black`, `dissolve` or `dip-white` fade the picture up.

## Speed

- `speed 0.5–0.7`: hero product shots and end-card backgrounds; reads as luxurious.
- `ramp {from:1,to:0.3,curve:"ease-out"}`: slow INTO the moment (the bite, the splash).
- `ramp {from:0.3,to:1.6,curve:"ease-in"}`: launch OUT of a held moment into the next act.
- `holdEnd 0.3–0.6`: freeze the payoff frame under a sound or a title.
- `slowmo:"optical"` only when the source is 50/60 fps or very slow motion is essential;
  it is slow to render. Footage at 25 fps below 0.5x stutters.
- Never ramp more than 8x within a shot.

## Moves

`push-in` / `pull-out` (amount 0.04–0.08 for life, 0.12–0.2 to reframe and crop out an edge),
`drift-left/right/up/down` (parallax-like slide). One move per shot, mostly on static shots.

## Sound

- Music: `fit` (default) edits it to length on bar lines and keeps its real ending.
- `gainDb` on music −2 to −6 when there is dialogue or natural sound over it.
- `natSoundDb` −6 to 0 on a shot whose own sound matters (a laugh, a crunch, waves).
- SFX land a few frames BEFORE the visual hit (0.03–0.08 s) to feel in sync.

## Iterate

The spec is saved next to the render (`*.sequence.json`). Change durations, swap shots, and
call `build_sequence` again; use `quality:"draft"` while iterating and `final` at the end.
Then `review_edit {path}` and fix every warning.
