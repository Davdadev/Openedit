# OpenEdit bridge protocol

OpenEdit is an MCP server (Node/TypeScript) that Claude Code talks to. It edits video
through one of three hosts:

| Host        | How the MCP server reaches it                                             |
|-------------|----------------------------------------------------------------------------|
| standalone  | In-process. ffmpeg renders the edit straight to a file. No editor needed. |
| premiere    | HTTP `POST http://127.0.0.1:47821/rpc` to the OpenEdit CEP panel, which runs ExtendScript via `CSInterface.evalScript`. |
| resolve     | Keeps one `python3 resolve/openedit_bridge.py --serve` process: newline-delimited JSON requests on stdin, responses on stdout matched by `id`. Falls back to one process per command (ONE request line in, ONE response line out). Uses Resolve Studio's `DaVinciResolveScript` API. |

## Wire format (both bridges)

Request:

```json
{ "id": "abc", "cmd": "applyCutPlan", "args": { "plan": { ... }, "sequenceName": "Edit - jump cuts" } }
```

Response:

```json
{ "id": "abc", "ok": true, "result": { "sequence": "Edit - jump cuts" } }
{ "id": "abc", "ok": false, "error": "No active sequence" }
```

Premiere: the panel also answers `GET /health` with `{"ok":true,"host":"premiere"}`.
Requests must carry header `X-OpenEdit-Token` equal to the contents of `~/.openedit/token`
(created by whichever side starts first, 32 random hex chars, file mode 600). Bind to 127.0.0.1 only.

## Commands and args

All times are seconds (float). Types are in `src/hosts/types.ts`.

| cmd              | args                                         | result                                   |
|------------------|----------------------------------------------|------------------------------------------|
| `ping`           | `{}`                                         | `"pong"`                                 |
| `status`         | `{}`                                         | `HostStatus`                             |
| `getTimeline`    | `{}`                                         | `TimelineInfo` (active sequence)         |
| `getSourceMedia` | `{}`                                         | `string[]` absolute media paths used in the active sequence, video first |
| `applyCutPlan`   | `{ plan: CutPlan, sequenceName?: string, xmlPath?: string }` | `{ sequence: string }` — builds a NEW sequence containing only `plan.keep` ranges of `plan.source`, back to back, video + audio linked. Never modifies the original. Resolve: `xmlPath` is an FCP7 XML of the same edit, imported with `ImportTimelineFromFile` if `AppendToTimeline` fails. |
| `addMarkers`     | `{ markers: Marker[] }`                      | number added (sequence markers)          |
| `importMedia`    | `{ paths: string[] }`                        | number imported into the project bin "OpenEdit" |
| `placeClips`     | `{ clips: ClipPlacement[] }`                 | number placed (overwrite edit; create tracks on top if `track` exceeds count) |
| `addCaptions`    | `{ cues: CaptionCue[], srtPath: string }`    | `{ added, file }` — SRT already written by the server; host imports it as captions/subtitles track |
| `addZooms`       | `{ zooms: Zoom[] }`                          | number applied (scale keyframes on V1 clips over each range, quick ease in/out) |
| `render`         | `{ output: string, preset?: string }`        | `{ output }`                             |
| `importTimeline` | `{ xmlPath: string, name?: string }`          | `{ sequence, file }` — Resolve only: builds a NEW timeline from an interchange file (multicam switch from `multicam_edit`) with `MediaPool.ImportTimelineFromFile`. |
| `applyMogrt`     | `{ path, at, duration?, track?, params?: {name, type, value}[] }` | Premiere only. `{ placed, track, at, set, missing[], errors[], duration? }` — `sequence.importMGT(path, ticks, track-1, 0)`, then each param via `getMGTComponent().properties.getParamForDisplayName(name)`: text (AE text JSON `textEditValue` kept with its font info), color `[r,g,b,a]` 0..255 via `setColorValue(a,r,g,b,true)`, point `[x,y]` frame fractions, slider/angle/number, checkbox, dropdown index. `duration` trims the clip end. |
| `addFusionTitle` | `{ at, track?, duration?, spec: {inputs, keys}, settingPath?, name? }` | Resolve only. Moves the playhead (`SetCurrentTimecode`), `Timeline.InsertFusionTitleIntoTimeline("Text+")`, `SetPosition({trackIndex, startFrame})`, then sets the Text+ tool's inputs (`SetInput`) and keyframes (`AddModifier(id, "BezierSpline")` + `SetInput(id, v, frame)`). Returns `{ inserted, timecode, inputs, duration, notes[] }`. The same title is written as a Fusion `.setting` macro (`settingPath`) for manual reuse. |

Unsupported commands return `ok:false` with error starting `unsupported:`.

## Without a bridge

`export_timeline {planId, format}` writes the edit as FCP7 XML (`xmeml` v5), FCPXML 1.10, CMX 3600 EDL
or SRT (`src/engine/interchange.ts`). Edit points are snapped to source frames, NTSC rates use the
ntsc flag / rational frame durations / drop-frame timecode, and audio is linked to video.

## Split edits and retiming in `applyCutPlan`

A `CutPlan` may carry `splits` (J/L cuts: `{index, type: "J"|"L", seconds, roll?}`), `ramps`
(speed changes on source ranges) and `freezes` (`{at, duration}`); see `src/hosts/types.ts`. They are
additive: bridges that ignore them build straight cuts at full speed (the current Premiere and
Resolve bridges do). Fallback: `export_timeline` writes them for the NLE to import: FCP7 XML has
linked clips with different audio/video in/out and a "Time Remap" speed effect per constant-speed
step; FCPXML uses `audioStart`/`audioDuration`, `srcEnable="video"` for muted ramps and a `timeMap`;
CMX 3600 EDL carries speed as M2 lines but no split edits. The standalone host renders all of them.
