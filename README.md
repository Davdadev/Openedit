# OpenEdit

**Edit video by talking to Claude.** OpenEdit is a free, open-source, fully local AI editing
toolkit. Claude Code drives it through MCP, and it edits in **Adobe Premiere Pro**,
**DaVinci Resolve**, or **with no editor at all** (straight to a finished file with ffmpeg).

No subscription, no account, no upload. Your footage never leaves your machine.

```
you:     "cut the silences and ums, add bold captions, punch in on key moments, make it 9:16"
claude:  transcribe -> plan_cuts -> (shows you the plan) -> apply_cuts -> make_captions -> auto_zooms -> render
```

## What it does

| Feature | How |
|---|---|
| Jump cuts / silence removal | ffmpeg `silencedetect` + padding and merge rules |
| Filler-word removal ("um", "uh", "you know"...) | word-level transcript from local whisper.cpp |
| Retake detection | finds restarted sentences and keeps the last attempt |
| Captions | word-timed SRT / VTT / ASS, imported as a caption track, or burned in with animated styles (`bold-pop`, `karaoke`, `clean`, `minimal`) |
| Zooms / punch-ins | scale keyframes (Premiere), static zoom (Resolve), zoompan (standalone); `auto_zooms` places them for you |
| B-roll, music, SFX | `place_clips` on new tracks, gain in dB, music ducking under speech (standalone) |
| Motion graphics | 7 animated templates rendered with transparent backgrounds via [HyperFrames](https://github.com/heygen-com/hyperframes): title card, lower third, callout, subscribe, counter, quote, chapter |
| Reframe | 9:16, 1:1, 16:9 |
| Loudness | EBU R128 `loudnorm` |
| Markers | coloured sequence markers for review |

Edits are **non-destructive**: cut plans always build a *new* sequence/timeline next to your original.

## Why it's different

Most "AI editor" plugins are a thin panel that loads a remote web app and sends your work
through a paid server. OpenEdit is the opposite:

- **Claude is the brain.** The tools are small and precise; Claude reads the transcript,
  decides what to cut, and shows you the plan before touching your timeline.
- **Local.** Transcription runs on whisper.cpp on your machine. Nothing is uploaded.
- **Three hosts, one workflow.** The same tools work in Premiere, Resolve, or standalone.
- **Open.** MIT licensed. Read it, fork it, add tools.

## Install

Requirements: Node 22+, ffmpeg, whisper.cpp (`whisper-cli`).

```bash
brew install ffmpeg whisper-cpp
```

```bash
git clone https://github.com/davthedev/openedit.git && cd openedit
```

```bash
npm install && npm run build
```

```bash
claude mcp add openedit -- node "$PWD/dist/cli.js"
```

```bash
node dist/cli.js doctor
```

The first transcription downloads the whisper model (`base`, ~140 MB) to `~/.openedit/models`.
The first motion-graphics render fetches HyperFrames and a headless Chrome.

### Premiere Pro (optional)

```bash
./premiere/install.sh
```

Restart Premiere, then open **Window > Extensions > OpenEdit**. The panel listens on
`127.0.0.1:47821` with a token in `~/.openedit/token`. See [premiere/README.md](premiere/README.md).

### DaVinci Resolve (optional)

```bash
./resolve/install.sh
```

In Resolve: **Preferences > System > General > External scripting using: Local**, then restart.
See [resolve/README.md](resolve/README.md).

With neither editor open, OpenEdit uses the standalone ffmpeg host automatically.
Force one with `OPENEDIT_HOST=premiere|resolve|standalone`.

## Use

In Claude Code, just ask:

- "Clean up `~/Videos/talk.mp4`: remove silences and filler words, show me the plan first."
- "Add bold-pop captions and auto zooms, then render a 9:16 version for Shorts."
- "Make a lower third for 'Dana Lee — Product Lead' at 0:04 and put it on V3."
- "Drop `~/sfx/whoosh.wav` at every chapter marker at -6 dB."

The `auto_edit` MCP prompt walks Claude through the standard workflow.

### Tools

`editor_status` · `select_host` · `get_timeline` · `probe_media` · `transcribe` ·
`find_silences` · `plan_cuts` · `show_plan` · `apply_cuts` · `make_captions` ·
`add_markers` · `add_zooms` · `auto_zooms` · `import_media` · `place_clips` · `render` ·
`motion_templates` · `render_motion` · `render_caption_overlay`

## Architecture

```
Claude Code ──MCP stdio──> openedit (Node/TS)
                             ├─ engine/   ffprobe, whisper.cpp, silencedetect, cut plans, captions, ffmpeg render
                             ├─ motion/   HyperFrames templates -> ProRes 4444 / VP9 alpha overlays
                             └─ hosts/
                                 ├─ standalone  (ffmpeg, in-process)
                                 ├─ premiere ──HTTP 127.0.0.1:47821──> CEP panel ──evalScript──> ExtendScript
                                 └─ resolve  ──JSON over stdio──> python bridge ──> DaVinciResolveScript
```

The bridge protocol is in [docs/PROTOCOL.md](docs/PROTOCOL.md); shared types are in
[src/hosts/types.ts](src/hosts/types.ts).

## Development

```bash
npm test
```

```bash
node premiere/test/mock-test.mjs
```

```bash
python3 -m unittest discover -s resolve/test
```

```bash
npm run test:motion
```

## Status

v0.1. The engine, standalone host and motion graphics are tested end to end. The Premiere and
Resolve bridges are tested against simulated hosts but **not yet against the real apps**:
please open an issue with what you see.

Known limits: Resolve's scripting API has no keyframes, so zooms there are static; captions
fall back to markers if a host refuses the SRT import; burn-in captions without HyperFrames need
an ffmpeg built with libass.

## License

MIT. HyperFrames is Apache-2.0 (used as an optional dependency, not vendored).
