---
name: openedit-resolve-computer-use
description: Drive DaVinci Resolve's own interface with computer use (request_access, app_screenshot, app_menu, app_click, app_key) for the editing steps OpenEdit's Resolve bridge and Resolve's scripting API cannot do - free Resolve with no external scripting, importing an exported FCP XML/FCPXML timeline, keyframed or eased zooms, transitions, fades, subtitle styling, Fairlight audio (normalise, voice isolation, ducking), colour matching, Deliver page render settings and loudness normalisation. Use when the user edits in DaVinci Resolve and editor_status shows Resolve is not connected, when a bridge call returns "unsupported" or a limitation, or when the user asks Claude to "do it in Resolve" for something the tools cannot.
---

# DaVinci Resolve via computer use

OpenEdit's Resolve bridge uses Resolve **Studio's** external scripting API. That API cannot
create keyframes, transitions, grades, Fairlight processing or most render options, and the
free version of Resolve cannot be scripted from outside at all. For those steps you operate
Resolve's UI like an assistant editor would: carefully, one verified step at a time.

Menu paths and page numbers below are from the DaVinci Resolve 21 Reference Manual installed at
`/Applications/DaVinci Resolve/DaVinci Resolve Manual.pdf`. Full recipes with citations:
[references/resolve-ui-paths.md](references/resolve-ui-paths.md).

## Decide the route first (cheapest reliable route wins)

1. **OpenEdit tool works?** Use it (`apply_cuts`, `add_markers`, `make_captions`,
   `place_clips`, `render`). Re-check `editor_status` before assuming the bridge is down.
2. **No bridge (free Resolve, or scripting off)?** Do the edit in OpenEdit, then
   `export_timeline {planId, format:"fcp7"}` (or `"fcpxml"`) and import it:
   **File > Import > Timeline...** (Shift-Command-I). Captions: **File > Import > Subtitle**.
   Offer to do the import with computer use, or give the user the path and menu.
3. **Resolve Studio 21 with its built-in MCP** (File > Setup AI Assistants, manual p. 4318)
   connected in this session? Its tools may cover project/render tasks. Use them for what they
   do; keep OpenEdit for transcript-driven cutting.
4. **Only the UI can do it?** Use computer use, following the protocol below.

To enable the bridge on **Studio**: Preferences > System > General > **External scripting
using: Local**, then restart Resolve (manual p. 106; scripting README "Configuration"). This is
a security-relevant preference: ask the user to change it themselves (you may open
**DaVinci Resolve > Preferences...** and point to it). Never choose **Network**. The free
version has no such option: say so plainly and use route 2.

## Computer-use protocol for Resolve

1. **Access.** Load the computer-use tools, then `request_access {apps:["DaVinci Resolve"],
   reason:"..."}`. Use the bundle id the response returns in every `app_*` call. Ask once for
   everything you will need (add Finder only if a file dialog needs it).
2. **Background first.** Prefer `app_screenshot`, `app_menu`, `app_click`, `app_key`,
   `app_type`. Resolve draws most of its UI itself, so the accessibility summary is sparse:
   use `app_menu` for anything in the menu bar (it is native and reliable), and coordinates
   from a fresh `app_screenshot` for panels. If a click reports `unsupported(canvas)` or has no
   effect twice, ask for full-screen control with `request_full_control
   {reason_kind:"click_no_effect"}` and say which step needs it.
3. **Screenshot before every click and after every action.** Coordinates come only from the
   latest screenshot of that window. Use `app_zoom` to read small Inspector values.
4. **Save first.** Before a risky or multi-step change: **File > Save Project** (Command-S).
   Work on a duplicate timeline when changing an edit the user cares about.
5. **Confirm destructive steps with the user**: Delete/Ripple Delete, Replace, Delete All
   Markers/Keyframes, overwriting an existing render file, closing without saving, "Remove" in
   Ripple Delete Silence. Say exactly what will change.
6. **Stay in scope.** Never change Preferences other than the one the user agreed to, never
   sign in to Blackmagic Cloud or YouTube, never enter licence keys, never install Extras or
   download anything without explicit permission, never tick "Upload directly to YouTube".
   Do not click links shown inside Resolve.
7. **Verify.** After the change: re-read the timeline with `get_timeline` if the bridge is up,
   otherwise screenshot the timeline and Inspector; after a render, `probe_media` and
   openedit-review on the output file.
8. **Recover.** Edit > Undo (Command-Z) or Edit > History to step back (manual p. 69). If the
   UI is in an unexpected state, press Escape once, screenshot, and re-orient by page name.

## Orientation

- Pages: Media, Cut, Edit, Fusion, Color, Fairlight, Deliver. Switch with
  **Workspace > Switch to Page** or Shift-2 ... Shift-8 (Shift-1 Project Manager, Shift-9
  Project Settings; manual p. 21). Do UI editing on the **Edit** page.
- Inspector: top-right of the Edit page; tabs Video / Audio / Effects / Transition / Image / File (p. 919).
- Keyframe controls: a diamond button right of each Inspector parameter; it turns orange
  when a keyframe is set (p. 1250-1251).

## What computer use is for (quick map)

| Task | Where (Resolve 21) | Manual |
|---|---|---|
| Import OpenEdit timeline | File > Import > Timeline... | p. 379, 506 |
| Import / style subtitles | File > Import > Subtitle; track header > Inspector > Track | p. 1230-1231 |
| Eased zoom / punch-in | Inspector > Video > Transform > Zoom keyframes; right-click keyframe > Ease In and Out | p. 1250-1251 |
| Ken Burns style move | Inspector > Video > Dynamic Zoom (+ Dynamic Zoom Ease) | p. 1209 |
| Transition at an edit | select edit point, Timeline > Add Transition (Command-T) | p. 1160 |
| Fade in/out | clip fader handles, or Trim > Fade In/Out to Playhead | p. 1204-1205 |
| Normalise clip levels | right-click audio clip > Normalize Audio Levels | p. 1110 |
| Voice Isolation / Dialogue Leveler | Inspector > Audio (Voice Isolation is Studio only) | p. 774, 1115-1116 |
| Neutral colour / match shots | Color page: Color > Auto Color (Option-Shift-C); thumbnail right-click > Shot Match | p. 3129-3130 |
| Render with loudness target | Deliver > Render Settings > Audio > Normalize/Optimize to Standard; Add to Render Queue; Start Render | p. 4098, 4124-4125, 4130-4131 |
| Export timeline for another NLE | File > Export > Timeline... (Shift-Command-O) | p. 4160 |

Keep the craft standards from openedit-editing while working in the UI: eased zooms of
105-115%, transitions only where they mean something (0.5 s or shorter), no effects on every
cut.
