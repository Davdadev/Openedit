# OpenEdit – DaVinci Resolve bridge

`openedit_bridge.py` lets the OpenEdit MCP server (and therefore Claude Code) drive a
running DaVinci Resolve through Resolve's **external Python scripting API**
(`DaVinciResolveScript` / `fusionscript`). It needs no plugin and no Workflow Integration,
and it never downloads code.

> **Resolve Studio is required for the live bridge.** Resolve's own scripting README (installed at
> `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.md`,
> checked against Resolve 21.2) says the **External scripting** preference (None / Local / Network)
> is configured "In DaVinci Resolve Studio". The free version only runs scripts *inside* Resolve
> (Workspace > Scripts, the Console), so an external process such as this bridge cannot connect.
>
> **Free DaVinci Resolve:** ask Claude to `export_timeline` with `format: "fcp7"` (or `"fcpxml"`), then
> in Resolve use **File > Import > Timeline…** and pick the file. Cuts, linked audio, markers and
> zooms come across; captions come as an `.srt` sidecar (File > Import > Subtitle).

```
Claude Code ──MCP──> OpenEdit server (Node) ──spawn──> python3 resolve/openedit_bridge.py --serve ──fusionscript──> DaVinci Resolve
                                         one long-lived process, JSON lines matched by id
```

## Setup

1. Install DaVinci Resolve **Studio** 18.5 or newer. Resolve 21.x is the version this bridge was written
   against. (Free Resolve: use `export_timeline`, see above.)
2. In Resolve Studio, set **Preferences > System > General > External scripting using** to **Local**, then
   restart Resolve. This step is required. Without it the bridge can't connect.
3. Run the installer. It checks the install, finds a Python that can load `fusionscript`, tests the
   connection and offers to install a Resolve menu script:

   ```sh
   resolve/install.sh                  # macOS / Linux
   resolve/install.sh --menu-script    # also install Workspace > Scripts > OpenEdit Status
   ```
   ```powershell
   powershell -ExecutionPolicy Bypass -File resolve\install.ps1 -MenuScript   # Windows
   ```
4. Open a project and a timeline, then check the connection:

   ```sh
   python3 resolve/openedit_bridge.py --doctor
   echo '{"id":"1","cmd":"status","args":{}}' | python3 resolve/openedit_bridge.py
   ```

### Python and environment

| Variable | Purpose |
|---|---|
| `OPENEDIT_RESOLVE_PYTHON` | Interpreter the Node server should spawn instead of `python3`. The bridge also uses it as a fallback (see below). |
| `RESOLVE_SCRIPT_API` | Resolve `Developer/Scripting` folder. `Modules/` inside it is added to the import path. |
| `RESOLVE_SCRIPT_LIB` | Full path to `fusionscript.so` / `fusionscript.dll`. |
| `OPENEDIT_RESOLVE_FAKE=1` | Use the in-memory fake Resolve (`test/fake_resolve.py`) for development and tests. |
| `OPENEDIT_RESOLVE_END_EXCLUSIVE=1` | Treat `AppendToTimeline` `endFrame` as exclusive. The default is inclusive, which matches Resolve. |
| `OPENEDIT_RESOLVE_ONESHOT=1` | Spawn one bridge process per command instead of the persistent `--serve` process. |

Default locations, which are used when the variables are unset:

| OS | Scripting API | fusionscript | Bundled Python (Resolve 21.1+) |
|---|---|---|---|
| macOS | `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting` | `/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so` | `…/DaVinci Resolve.app/Contents/Applications/ResolvePython` |
| Windows | `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting` | `C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll` | `C:\Program Files\Blackmagic Design\DaVinci Resolve\ResolvePython\ResolvePython.exe` |
| Linux | `/opt/resolve/Developer/Scripting` | `/opt/resolve/libs/Fusion/fusionscript.so` | `/opt/resolve/bin/ResolvePython` |

The bridge itself only needs the standard library and runs on Python 3.8 or newer. The binding
problem is `fusionscript`. It is a native extension, so it loads only into a 64-bit Python whose
version and CPU architecture the installed Resolve supports. On an Apple Silicon Mac, for example,
an x86_64 Python can't load the arm64 library. If it can't load, the bridge returns an error that
names a compatible interpreter. For any command except `ping`, it also re-runs the request through
the first working candidate it finds, in this order: `OPENEDIT_RESOLVE_PYTHON`, Resolve's bundled
`ResolvePython`, then `python3.12` down to `python3.8` on PATH. For the most predictable setup,
point `OPENEDIT_RESOLVE_PYTHON` at `ResolvePython` (Resolve 21.1+) or at a python.org 3.11.

## Protocol

The wire format is described in `docs/PROTOCOL.md`. The Node server keeps **one persistent
`--serve` process** for the session (requests and responses are matched by `id`, so Python start-up
and the fusionscript connection are paid once) and falls back to one process per command if that
process can't start (`OPENEDIT_RESOLVE_ONESHOT=1` forces one-shot). In one-shot mode the bridge reads
one request line from stdin, writes one response line to stdout and sends all logs to stderr. Stray output from Python code or
from `fusionscript`'s C code can't corrupt stdout, because fd 1 is redirected to stderr and responses
are written to a duplicate of the original stdout.

```sh
python3 resolve/openedit_bridge.py                 # one request in, one response out
python3 resolve/openedit_bridge.py --serve         # newline-delimited loop until EOF (what the server uses)
python3 resolve/openedit_bridge.py --cmd getTimeline [--args '{"markers":[...]}']
python3 resolve/openedit_bridge.py --doctor        # human-readable environment check
```

`ping` answers `"pong"` without touching Resolve. `status` never fails. If Resolve is unreachable it
returns `connected: false` with the reason in `detail`.

## Commands

| cmd | What it does in Resolve |
|---|---|
| `status` | Product name and version, current project, current timeline. |
| `getTimeline` | Current timeline: name, fps (`timelineFrameRate`, with exact NTSC rates), resolution, track counts, every video and audio item, and timeline markers. Times are in seconds, relative to the timeline start frame (for example 01:00:00:00). Source in/out comes from `GetSourceStartTime`, with a fallback to source frames ÷ clip FPS. The path comes from the media pool item's `File Path`. |
| `getSourceMedia` | Unique file paths used in the current timeline, video tracks first. |
| `applyCutPlan` | Finds `plan.source` in the media pool, or imports it into the `OpenEdit` bin. It then runs `CreateEmptyTimeline(name)` and `AppendToTimeline([{mediaPoolItem, startFrame, endFrame}, …])`. Frames use the clip's own FPS, and `endFrame` is inclusive. Ranges shorter than one frame are dropped. Name clashes get a ` (2)` suffix. The original timeline is never modified. If `AppendToTimeline` fails, the bridge removes the empty timeline and builds it from `xmlPath` (an FCP7 XML of the same edit that the server writes) with `MediaPool.ImportTimelineFromFile`; the result then has `method: "importTimeline"` and a `warning`. |
| `addMarkers` | `Timeline.AddMarker(frameOffset, color, name, note, durationFrames)`. Colors map red→Red, green→Green, blue→Blue, yellow→Yellow, purple→Purple, orange→**Sand**, white→**Cream** (Resolve has no orange or white marker). If a frame already has a marker, the new one moves forward up to 4 frames. |
| `importMedia` | Imports into the `OpenEdit` media pool bin, which is created if needed. Files already in that bin aren't imported twice but still count toward the returned number. |
| `placeClips` | `AppendToTimeline` with `recordFrame`, `trackIndex` and `mediaType` (video files are placed video-only, audio files audio-only). Missing tracks are added with `AddTrack`. `sourceIn`/`sourceOut` become start and end frames. `gainDb` sets `AudioVolume`. |
| `addCaptions` | Imports the SRT into the `OpenEdit` bin, adds a subtitle track if none exists, and appends the SRT at the timeline start. If Resolve refuses, it falls back to one Cream marker per cue, with the text in the name and note. The result includes `method: "subtitleTrack" \| "markers"`. |
| `addZooms` | A static punch-in. See the limitations below. |
| `render` | Selects MP4 (or MOV) with H.264 through `SetCurrentRenderFormatAndCodec`, falling back to the "H.264 Master" preset. `preset` loads a named render preset instead. It then sets `TargetDir`/`CustomName`, runs `AddRenderJob` and `StartRendering([jobId])`, and polls `IsRenderingInProgress`. It checks `GetRenderJobStatus`, deletes the job and returns the actual output path. `timeoutSec` is optional (default 6 h). |

The Resolve 21 API renamed several calls. The bridge tries the new form first and falls back to the
old one: `GetSettings`/`GetSetting`, `GetClipProperty()`/`GetClipProperty(key)`,
`SetProperties`/`SetProperty`, and `StartRendering([ids])`/`StartRendering(id)`.

## Limitations

- **Zoom keyframes.** Resolve's scripting API can't create or edit keyframes, and it can't blade or
  split clips. `addZooms` therefore sets a static `ZoomX`/`ZoomY` (scale ÷ 100) on each V1 clip that
  lies *entirely* inside a zoom range, and skips clips that only partly overlap it. It returns how
  many zoom ranges affected at least one clip. This works well on jump-cut timelines made by
  `applyCutPlan`, where clips are short. For eased punch-ins, add the keyframes by hand or render in
  standalone mode.
- **Captions.** Importing an SRT through the media pool and appending it to a subtitle track works in
  current Resolve versions, but this path isn't formally documented. When it fails, captions arrive
  as markers. Burned-in or styled captions aren't created. Use Resolve's subtitle styling, or
  `CreateSubtitlesFromAudio` in Studio.
- **Overwrite edits.** The API has no overwrite or insert edit. `placeClips` places clips at
  `recordFrame` on the requested track. If that spot is occupied, Resolve may refuse the placement,
  so put B-roll on a free track above V1.
- **endFrame semantics.** The bridge treats `AppendToTimeline`'s `endFrame` as the last included
  frame. `applyCutPlan` compares what Resolve built against the expected length and adds a `warning`
  to the result if they differ. If your Resolve version behaves differently, set
  `OPENEDIT_RESOLVE_END_EXCLUSIVE=1`.
- **Mixed frame rates.** Source frames use each clip's FPS, and timeline positions use the timeline
  FPS. A new timeline from `applyCutPlan` uses the project's frame rate.
- **Network scripting** (Studio only) isn't used. The bridge only connects locally.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not connect to DaVinci Resolve` | Resolve isn't running, is still starting up, or External scripting isn't set to **Local**. Change it and restart Resolve. On the free version there is no such setting: use `export_timeline` and File > Import > Timeline. |
| `fusionscript could not be loaded into this Python` | Your python is the wrong version or architecture. Set `OPENEDIT_RESOLVE_PYTHON` to `ResolvePython` or a 64-bit python.org 3.11 that matches your CPU. |
| `DaVinci Resolve scripting library not found` | Resolve is installed in a non-default location. Set `RESOLVE_SCRIPT_LIB` and `RESOLVE_SCRIPT_API`. |
| `No project is open` / `No active timeline` | Open a project and double-click a timeline in the media pool. |
| Captions arrived as markers | Your Resolve rejected the SRT append. Import the `.srt` (path in the result) by hand with File > Import > Subtitle. |
| Everything else | Run `python3 resolve/openedit_bridge.py --doctor`, and check stderr. Every exception is also returned as `{"ok":false,"error":…}`. |

The **Workspace > Scripts > OpenEdit Status** menu script, installed with `--menu-script`, runs the
bridge from *outside* Resolve, the same way Claude Code does. It shows whether the external
connection works.

## Tests

```sh
python3 -m unittest discover -s resolve/test -v
```

The tests run against `test/fake_resolve.py` and need no Resolve install. They cover:

- frame and second conversion, including NTSC
- inclusive `endFrame` mapping and the clip infos built by `applyCutPlan`
- marker color mapping
- fallbacks for the older API calls
- every command
- the one-line JSON protocol and `--serve` mode, run as a subprocess
- the `ImportTimelineFromFile` fallback when `AppendToTimeline` fails
- stdout protection
