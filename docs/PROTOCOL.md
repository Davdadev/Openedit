# OpenEdit bridge protocol

OpenEdit is an MCP server (Node/TypeScript) that Claude Code talks to. It edits video
through one of three hosts:

| Host        | How the MCP server reaches it                                             |
|-------------|----------------------------------------------------------------------------|
| standalone  | In-process. ffmpeg renders the edit straight to a file. No editor needed. |
| premiere    | HTTP `POST http://127.0.0.1:47821/rpc` to the OpenEdit CEP panel, which runs ExtendScript via `CSInterface.evalScript`. |
| resolve     | Spawns `python3 resolve/openedit_bridge.py`, writes ONE JSON request line to stdin, reads ONE JSON response line from stdout. Uses Resolve's `DaVinciResolveScript` API. |

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
| `applyCutPlan`   | `{ plan: CutPlan, sequenceName?: string }`   | `{ sequence: string }` — builds a NEW sequence containing only `plan.keep` ranges of `plan.source`, back to back, video + audio linked. Never modifies the original. |
| `addMarkers`     | `{ markers: Marker[] }`                      | number added (sequence markers)          |
| `importMedia`    | `{ paths: string[] }`                        | number imported into the project bin "OpenEdit" |
| `placeClips`     | `{ clips: ClipPlacement[] }`                 | number placed (overwrite edit; create tracks on top if `track` exceeds count) |
| `addCaptions`    | `{ cues: CaptionCue[], srtPath: string }`    | `{ added, file }` — SRT already written by the server; host imports it as captions/subtitles track |
| `addZooms`       | `{ zooms: Zoom[] }`                          | number applied (scale keyframes on V1 clips over each range, quick ease in/out) |
| `render`         | `{ output: string, preset?: string }`        | `{ output }`                             |

Unsupported commands return `ok:false` with error starting `unsupported:`.
