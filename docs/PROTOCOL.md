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

Unsupported commands return `ok:false` with error starting `unsupported:`.

## Without a bridge

`export_timeline {planId, format}` writes the edit as FCP7 XML (`xmeml` v5), FCPXML 1.10, CMX 3600 EDL
or SRT (`src/engine/interchange.ts`). Edit points are snapped to source frames, NTSC rates use the
ntsc flag / rational frame durations / drop-frame timecode, and audio is linked to video.
