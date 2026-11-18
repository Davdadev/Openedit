# OpenEdit tool recipes

Exact calls for common jobs. All times are seconds. After `apply_cuts`, every time you pass
(markers, zooms, captions, placements, `placeAt`) is on the EDITED timeline.

## Orientation

```
editor_status {}                       # which host; call first
probe_media {path}                     # duration, fps, size, audio
transcribe {path}                      # [mm:ss.s] lines + word-level JSON path
find_silences {path}                   # optional: see the pause map
```

Host choice: `select_host {host:"standalone"}` when the user wants a finished file and no NLE;
`"premiere"` / `"resolve"` when they will keep editing in the app.

## Clean talking-head cut

```
plan_cuts {path, tightness:"normal", removeSilences:true, removeFillers:true,
           removeRetakes:true, manualCuts:[{start:0, end:4.2}, {start:312.0, end:351.5}]}
show_plan {planId}                     # quote the removed text to the user
revise_plan {planId, restore:[3,7]}    # give back a pause or a line the user wants
apply_cuts {planId: <latest>}
```

`manualCuts` are SOURCE-time ranges. Use the transcript timestamps; widen by ~0.05 s on each
side to avoid clipping word edges, then confirm in `show_plan`.

## Captions

```
make_captions {planId, style:"clean", maxWords:7, maxChars:32}     # long-form
make_captions {planId, style:"bold-pop", maxWords:4, maxChars:24}  # short-form
```

Writes .srt/.vtt/.ass next to each other; the host imports SRT (Premiere caption track,
Resolve subtitle track; markers as fallback). For an overlay any NLE can use:
`render_caption_overlay {planId, style}` (transparent .mov).

## Zooms

```
auto_zooms {planId, style:"smooth", minGap:15, baseScale:106, scale:112}   # long-form
auto_zooms {planId, style:"punch", minGap:4}                               # shorts
add_zooms {zooms:[{start:42.3, end:47.9, scale:115, ease:0.2}]}           # by hand
```

Check the returned list: delete or avoid zooms on lines that do not deserve emphasis by
placing them by hand instead. Resolve's API has no keyframes, so zooms there are static per
clip; for eased zooms in Resolve use openedit-resolve-computer-use.

## B-roll, music, SFX

```
get_media {query:"hands typing on laptop keyboard close-up", kind:"video",
           orientation:"landscape", minWidth:1920, maxDuration:20}
place_clips {clips:[{path, at:63.4, sourceIn:2.0, sourceOut:6.0, track:2}]}
place_clips {clips:[{path:"music.mp3", at:0, track:2, gainDb:-20, duckDb:8, loop:true, fadeOut:2}]}
```

B-roll on video track 2+ never replaces dialogue audio. Music and SFX go on audio tracks.
`duckDb`, `loop`, `fadeOut`, `duration` are honoured by the standalone renderer; in Premiere or
Resolve, ducking is done in the app (computer-use skills).

## Motion graphics

```
motion_templates {}
render_motion {template:"lower-third", params:{name:"Dana Lee", role:"Product Lead"},
               placeAt:4.0, aspect:"16:9"}
```

Templates: title-card, lower-third, callout, counter, quote, chapter, subscribe. Render at the
final aspect (`aspect:"9:16"` for shorts) so nothing is cropped. Keep the user's brand colour
if known (`accent`), otherwise a neutral one; do not mix several accent colours.

## Render

```
render {output:"~/Movies/talk-draft.mp4", quality:"draft"}                       # preview
render {output:"~/Movies/talk.mp4", loudnorm:true, quality:"final"}              # delivery
render {output:"~/Movies/talk-short.mp4", reframe:"9:16", loudnorm:true}         # shorts
render {output:..., reframe:{aspect:"9:16", mode:"manual", focusX:0.35}}         # off-centre subject
```

In Premiere/Resolve, `render` queues the editor's own export; reframe, burn-in and loudnorm are
standalone-only.

## Interchange

```
export_timeline {planId, format:"fcp7"}     # Premiere: File > Import; Resolve: File > Import > Timeline
export_timeline {planId, format:"fcpxml"}   # Final Cut Pro, Resolve
export_timeline {planId, format:"edl"}      # anything
export_timeline {planId, format:"srt"}      # captions only
```

Always tell the user the exact import menu path for their editor.

## Markers for the user

`add_markers {markers:[{time, name, comment, color:"yellow"}]}` for things you want the user
to check (a cut you were unsure about, a b-roll suggestion). Red = problem, yellow = check,
green = chapter.
