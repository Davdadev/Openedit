# OpenEdit bridge for Adobe Premiere Pro

A small CEP panel that lets the OpenEdit MCP server (and Claude Code through it)
drive Premiere Pro: read the active timeline, build cut sequences, place clips,
add markers, captions and zooms, and export.

```
Claude Code --MCP--> OpenEdit server --HTTP 127.0.0.1:47821--> CEP panel (Node) --evalScript--> ExtendScript ($.OpenEdit) --> Premiere DOM / QE DOM
```

The wire protocol is in [`docs/PROTOCOL.md`](../docs/PROTOCOL.md) and the
argument/result types in [`src/hosts/types.ts`](../src/hosts/types.ts).

## Requirements

- Premiere Pro **23.0 (2023) or newer**, macOS or Windows.
  Premiere 23.x/24.x ship CEP 11 and 25.x+ ship CEP 12, so the manifest asks for
  CSXS runtime 11.0. The panel needs Node.js inside the page
  (`--enable-nodejs --mixed-context`), available since CEP 7.
- No npm install: the panel uses only Node built-ins.

## Install

macOS:

```sh
cd premiere
./install.sh          # symlinks this folder into ~/Library/Application Support/Adobe/CEP/extensions/com.openedit.premiere
./install.sh --copy   # or copy it instead
```

Windows (PowerShell, no admin needed):

```powershell
cd premiere
powershell -ExecutionPolicy Bypass -File install.ps1         # junction into %APPDATA%\Adobe\CEP\extensions
powershell -ExecutionPolicy Bypass -File install.ps1 -Copy   # or copy
```

Both installers:

1. put the panel at `.../CEP/extensions/com.openedit.premiere`;
2. enable `PlayerDebugMode` for CSXS 9-13 (the panel is not signed, and CEP
   refuses unsigned panels otherwise). macOS: `defaults write com.adobe.CSXS.N PlayerDebugMode 1`.
   Windows: `HKCU\Software\Adobe\CSXS.N\PlayerDebugMode = "1"`;
3. create `~/.openedit/token` (32 random hex chars, mode 600) if it is missing.

Then **quit and restart Premiere**, open a project and choose
**Window > Extensions > OpenEdit**. The panel must stay open (it can be docked
and small) while OpenEdit is in use.

Check it:

```sh
curl -s http://127.0.0.1:47821/health
# {"ok":true,"host":"premiere"}
curl -s -H "X-OpenEdit-Token: $(cat ~/.openedit/token)" \
     -d '{"id":"1","cmd":"status","args":{}}' http://127.0.0.1:47821/rpc
```

Uninstall: `./uninstall.sh` (add `--debug-off` to also remove PlayerDebugMode),
or `install.ps1 -Uninstall` on Windows. The token file is left in place
because the MCP server uses it too.

## How it works

| File | Role |
|------|------|
| `CSXS/manifest.xml` | Bundle `com.openedit.premiere`, panel "OpenEdit", host `PPRO [23.0,99.9]`, CEF flags `--enable-nodejs --mixed-context --allow-file-access`. |
| `index.html`, `panel.js` | Status UI (listening state, port, token path, Premiere version, project, active sequence, recent commands). Loads the host scripts and starts the server. |
| `lib/server.js` | The HTTP server, as a plain CommonJS module with an injected `evalScript`, so it is testable without CEP. |
| `lib/CSInterface.js` | OpenEdit's own minimal CEP interface (MIT): `evalScript`, `getSystemPath` and a few helpers on top of the host's native `window.__adobe_cep__`. |
| `host/openedit.jsx` | ExtendScript entry: `$.OpenEdit` namespace, JSON writer/parser, helpers, `dispatch()`, loads the other parts with `$.evalFile`. |
| `host/oe-read.jsx` | `status`, `getTimeline`, `getSourceMedia` |
| `host/oe-cut.jsx` | `applyCutPlan` |
| `host/oe-edit.jsx` | `addMarkers`, `importMedia`, `placeClips`, `addCaptions`, `addZooms` |
| `host/oe-render.jsx` | `render` |
| `.debug` | Enables Chrome remote debugging of the panel at `http://localhost:8099`. |

### Server

- Listens on `127.0.0.1:47821` only, and rejects requests whose `Host` header is
  not a loopback name (DNS-rebinding guard).
- `GET /health` -> `{"ok":true,"host":"premiere"}` (no token needed).
- `POST /rpc` needs `X-OpenEdit-Token` equal to `~/.openedit/token`
  (constant-time compare; the file is re-read on every request, so a token
  rewritten by the MCP server is picked up). Missing/wrong token -> HTTP 401.
- Bad JSON -> 400, unknown path -> 404, body over 32 MB -> 413. Every
  well-formed RPC gets HTTP 200 with `{id, ok, result}` or `{id, ok:false, error}`.
- Unknown commands are answered `unsupported: <cmd>` without touching Premiere.
- **Commands run strictly one at a time** (a promise queue), because
  ExtendScript is single-threaded and Premiere does not like overlapping edits.
- Arguments are passed to ExtendScript as a JSON *string literal* with every
  non-ASCII character `\uXXXX`-escaped, and the host's JSON writer escapes
  everything outside printable ASCII, so neither direction depends on the
  system code page.
- Timeouts: 15 s for `ping`, 30 s for `status`, 30 min for `applyCutPlan`,
  4 h for `render`, 10 min otherwise. A timed-out command returns
  `timeout: ...` but cannot be cancelled inside Premiere.
- If the ExtendScript side is not loaded (for example after another panel reset
  the engine), the server re-evaluates `host/openedit.jsx` once and retries.

### Commands (ExtendScript side)

All times are seconds; Premiere's internal unit is ticks
(254016000000 per second). Positions are snapped to the sequence frame grid.

- **status** - Premiere version, project name, active sequence name, plus any
  host load errors in `detail`.
- **getTimeline** - active sequence name, duration, fps (from `timebase`),
  frame size, track counts, every clip (`track` is 1-based, `kind`
  video/audio, timeline start/end, source in/out, media path) and sequence
  markers (with color when the build exposes `getColorByIndex`).
- **getSourceMedia** - unique media paths in the active sequence, video tracks first.
- **applyCutPlan** - never edits the original sequence:
  1. The source file is found in the project (or imported into the
     `OpenEdit` bin).
  2. An empty sequence with the active sequence's settings is made by
     `clone()` of the active sequence (it returns a boolean, so the copy is
     found by diffing sequence IDs), renaming it, and removing its clips and
     markers. With no active sequence, `createNewSequenceFromClips` is used
     (sequence matches the source), then emptied.
  3. For each keep range, in/out marks are set on the source item (each write
     is read back; both the `Time` and the seconds argument form are tried)
     and `overwriteClip` drops it on V1 at the running cursor. An A/V source
     brings its linked audio onto A1. The cursor is re-read from the track
     after every placement so rounding never accumulates. The source item's
     original marks are restored afterwards.
  4. Fallback when marks cannot be set: put the whole source at 0, razor all
     tracks at every boundary with the QE DOM (`track.razor(timecode)`, the
     timecode formatted with the sequence's own frame rate and display
     format), then ripple-delete the removed pieces from last to first. This
     path sorts and merges the keep ranges.
  The result also reports `sequenceId`, `clips`, `skipped`, `duration`, and
  `method` (`inout` or `razor (...)`). The new sequence becomes active.
- **addMarkers** - `markers.createMarker(t)`, name, comment, duration (via
  `marker.end`), color via `setColorByIndex` (green 0, red 1, purple 2,
  orange 3, yellow 4, white 5, blue 6).
- **importMedia** - imports missing files into the `OpenEdit` bin in one
  `importFiles` call; files already in the project are not imported twice.
  Returns how many of the requested files are now available in the project.
- **placeClips** - overwrite edits on the active sequence. Video files are
  placed as **video-only subclips** (`createSubClip(..., takeVideo=1,
  takeAudio=0)`) so B-roll can never overwrite dialogue on the audio tracks;
  audio files go on the requested audio track (with in/out marks, falling
  back to an audio-only subclip). Missing tracks are appended through QE
  `addTracks` (4th argument is the audio track *type*, 5th the insert index;
  the track count is always re-read because the return value is unreliable).
  `gainDb` changes the clip's Volume Level relative to its current value
  (`level * 10^(dB/20)`, read back; existing keyframed levels are left alone).
- **addCaptions** - imports the SRT and calls
  `sequence.createCaptionTrack(item, 0, Sequence.CAPTION_FORMAT_SUBTITLE)`
  (Premiere 2021+). When that is unavailable or fails, each cue becomes a
  yellow sequence marker spanning the cue (`mode:"markers"` plus `note` with
  the reason).
- **addZooms** - for each V1 clip overlapping a zoom range, keyframes
  Motion > Scale (component by matchName `AE.ADBE Motion`, param by name
  "Scale" or index 1, which works in localized UIs): base, base*scale/100
  after ~0.2 s, hold, back to base over the last ~0.2 s, Bezier
  interpolation. `scale` is relative to the clip's current scale, so a 4K clip
  already scaled to 50% gets 57.5% for `scale:115`. Keyframe times are
  clip-local (`clip.inPoint + (t - clip.start)`).
- **render** - exports the active sequence with
  `sequence.exportAsMediaDirect(output, preset, 0)` (renders inside
  Premiere, blocks until done). If that API is missing the job is queued in
  Adobe Media Encoder (`app.encoder.encodeSequence` + `startBatch`) and the
  result has `queued:true`. Preset lookup, first match wins:
  1. `args.preset` as an `.epr` path;
  2. `args.preset` as a preset name (e.g. `"Match Source - High bitrate"`),
     searched in Premiere's system presets;
  3. env var `OPENEDIT_PREMIERE_PRESET` (an `.epr` path);
  4. Premiere's built-in H.264 "Match Source - Adaptive High Bitrate" (or
     similar) preset in `<install>/MediaIO/systempresets/4E49434B_48323634/`
     (macOS: inside the `.app` bundle's `Contents/`).
  No `.epr` is bundled: export presets have to be saved from Premiere or
  Media Encoder, so the bridge uses the ones Premiere ships with. To use your
  own, export one from Premiere's Export dialog (Save Preset) and pass its path.

### ExtendScript rules

`host/*.jsx` are ES3 and **7-bit ASCII only** (ExtendScript reads script files
in the system code page on Windows; a single accented character can break the
parse). The namespace is created only if missing, so re-loading is safe.
Every command is wrapped by `dispatch()`, which always returns JSON text and
turns any exception into `{"ok":false,"error":...}`.

## Tests

```sh
node premiere/test/mock-test.mjs   # server + host logic, no Premiere needed
node premiere/test/check-host.mjs  # ASCII + syntax + ES3 lint of host/*.jsx
```

`mock-test.mjs` covers token creation and auth, `/health`, 400/401/403/404
handling, request queueing (never more than one ExtendScript call in flight,
submission order kept), error mapping (`EvalScript error.`, empty and
non-JSON replies, evalScript throwing, timeouts), host reload, and Unicode
argument round-trips. It then loads the real `host/*.jsx` into a Node `vm`
with a small fake of the Premiere DOM (`test/fake-premiere.mjs`) and runs
every command through `dispatch()`, including both `applyCutPlan` methods.
The fake is a simplification written from the documented API; passing it does
not prove Premiere behaves the same.

`check-host.mjs` runs a strict ES3 parse when it can resolve the `acorn`
package (`ACORN_PATH=/path/to/node_modules/acorn`).

## Troubleshooting

- **Panel missing from Window > Extensions**: PlayerDebugMode is not set for
  your CSXS version, or Premiere was not restarted. Run
  `defaults read com.adobe.CSXS.12 PlayerDebugMode` (macOS) - it must print 1.
  Premiere older than 23.0 is not supported by the manifest.
- **Panel says "Node.js is not enabled"**: the manifest's CEF parameters were
  changed or the panel was installed from an old copy; reinstall.
- **"port 47821 ... already in use"**: another OpenEdit panel (a second
  Premiere instance) or a stale process holds the port. Close it, then close
  and reopen the panel. `lsof -i :47821` shows the owner.
- **401 unauthorized**: the MCP server and the panel read different token
  files. Both use `~/.openedit/token` (`%USERPROFILE%\.openedit\token`).
- **"ExtendScript host not loaded" / "EvalScript error."**: click
  **Reload host** in the panel. Load errors are shown in the log and in
  `status.detail`. Debug the panel at `http://localhost:8099` in Chrome.
- **render: "no export preset found"**: pass `preset` as a full `.epr` path or
  set `OPENEDIT_PREMIERE_PRESET`. Look for presets under
  `/Applications/Adobe Premiere Pro <year>/Adobe Premiere Pro <year>.app/Contents/MediaIO/systempresets/`
  or `C:\Program Files\Adobe\Adobe Premiere Pro <year>\MediaIO\systempresets\`.
- **Commands time out during long exports**: expected for very long renders
  over 4 h; Premiere keeps working and the file appears when done.
- **Captions came in as markers**: your Premiere build has no
  `createCaptionTrack` scripting API or it rejected the SRT; import the SRT
  manually (File > Import) and drag it onto the timeline.
