# DaVinci Resolve 21: UI recipes with sources

Sources (all checked for this file):

- **Manual**: *DaVinci Resolve 21 Reference Manual*, installed at
  `/Applications/DaVinci Resolve/DaVinci Resolve Manual.pdf` (4351 pages; printed page numbers
  equal PDF page numbers). Cited as "p. N".
- **Scripting README**: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.md`
  (macOS install of Resolve 21).
- **OpenEdit**: `resolve/README.md` in this repository (bridge commands and limits).

Shortcuts are written macOS-style; on Windows/Linux, Command = Control and Option = Alt (p. 68).
Labels can shift between point releases: when a path does not match, `app_menu {list:"File"}`
(or the relevant menu) and use the listed title verbatim.

## Contents

1. Bridge setup and limits
2. Importing OpenEdit's timeline (free Resolve)
3. Subtitles from OpenEdit
4. Keyframed and eased zooms
5. Dynamic Zoom (pan and scan)
6. Transitions and fades
7. Audio: normalise, clean up, duck
8. Colour consistency
9. Deliver: render, loudness, subtitles
10. Exporting for another NLE
11. Navigation, undo, safety
12. Menu reference

## 1. Bridge setup and limits

- **External scripting** lives in **DaVinci Resolve > Preferences... > System > General >
  External Scripting Using: None / Local / Network**, marked "(Resolve Studio only)" (p. 106).
  The scripting README says the same: "In DaVinci Resolve Studio, Preferences > System >
  General, you can configure ... External scripting". OpenEdit needs **Local** plus a restart.
  The free version only runs scripts from Workspace > Scripts or Workspace > Console.
- The same panel has "Automatic scripted actions"; the README recommends leaving it on
  "Allow safe". Do not change it.
- Studio-only API calls return False on the free version (README "Studio and AI Scripting APIs").
- API limits that push work to the UI (OpenEdit `resolve/README.md`): no keyframes (zooms are
  static ZoomX/ZoomY per clip), no blade/split, no overwrite/insert edits, captions may fall
  back to markers.
- Resolve 21 also ships a built-in MCP server for AI assistants (Studio): **File > Setup AI
  Assistants** (p. 4318). If the user has it connected, prefer it over UI clicking for
  project/render tasks it covers.

## 2. Importing OpenEdit's timeline (free Resolve, or bridge fallback)

1. OpenEdit: `export_timeline {planId, format:"fcp7"}` (FCPXML also works: `"fcpxml"`).
   Note the output path.
2. Resolve: **File > Import > Timeline...** (menu, p. 4338 -> p. 379) or Shift-Command-I
   (p. 506). Alternative: Edit page, right-click the Media Pool > Timelines > Import >
   AAF/EDL/XML/DRT/ADL/OTIO (p. 506).
3. A file dialog opens (this is a system Open panel: background tools may be refused there;
   if so ask for full-screen control with `reason_kind:"file_dialog"`, or ask the user to pick
   the file). Choose the exported file.
4. In the Load XML window (p. 507) keep **Automatically import source clips into media pool**
   on; keep **Use sizing information** on (carries OpenEdit's zoom keyframes); leave
   **Automatically set project settings** on for a new empty project, off if the project
   already has a timeline at another frame rate (ask the user).
5. OK. A new timeline appears in the Media Pool. Screenshot and compare clip count and
   duration with `show_plan`.
6. If clips come in offline, Resolve prompts for a folder: point it at the source media folder.

## 3. Subtitles from OpenEdit

- Import: **File > Import > Subtitle** (menu p. 4338), or Media Pool right-click >
  **Import Subtitle** (p. 1230). Supported: .srt, .srtx, .vtt, .xml, .ttml (p. 1230).
- Place: right-click the subtitle clip > **Insert Selected Subtitles to Timeline Using
  Timecode**, or drag it onto the timeline, which creates a subtitle track (p. 1230-1231).
  OpenEdit's SRT is timed from 0: if the timeline starts at 01:00:00:00, use the drag method
  at the timeline start, then check sync on a few cues.
- Style the whole track: click the subtitle **track header**, open the **Track** panel of the
  Inspector, set font, size, outline/background, position (p. 1231). Long-form: clean sans,
  white with soft outline or a translucent box, two lines max, bottom-centre.
- Studio alternative: **Timeline > AI Tools > Create Subtitles from Audio** (p. 1234). Prefer
  OpenEdit's captions when the edit was cut by OpenEdit (same transcript, same timing).
- Delivery: subtitle options are at the bottom of the **Video** panel of the Render Settings
  on the Deliver page (burn in, embed, or separate file) (p. 1247). Export only:
  **File > Export > Subtitle** (.srt/.vtt) (p. 1247).

## 4. Keyframed and eased zooms (what the API cannot do)

Per clip on V1, at each zoom OpenEdit planned (`auto_zooms` output gives edited times):

1. Edit page. Select the clip; open the Inspector > **Video** tab > **Transform**.
2. Park the playhead at the zoom start (type the timecode into the timeline viewer timecode
   field, or use arrow keys from a marker).
3. Click the keyframe diamond next to **Zoom** (sets a keyframe at the current value)
   (p. 1251).
4. Move ~0.2-0.4 s later; set Zoom X/Y (linked) to e.g. 1.10. A keyframe is added
   automatically once the parameter has one (p. 1251).
5. Near the zoom end, add a keyframe at the zoomed value, then at the end return to 1.0.
6. Ease: park on each keyframe (keyframe arrows or the bracket keys move between keyframes),
   right-click the orange diamond > **Ease In**, **Ease Out**, or **Ease In and Out**
   (p. 1251).
7. Delete: click the orange diamond on a keyframe; reset button removes all keyframes of that
   parameter (p. 1251).

Keep zooms 105-115%. A static punch-in that holds for the whole clip needs no keyframes (the
bridge already does that).

## 5. Dynamic Zoom (pan and scan in one control)

Inspector > Video > **Dynamic Zoom** group: turn it on; set **Dynamic Zoom Ease** (Linear,
Ease In, Ease Out, Ease In and Out); **Swap** reverses start/end (p. 1209). Adjust the start
and end boxes with the onscreen controls: the Transform/Crop/Dynamic Zoom button at the
bottom left of the Timeline Viewer (p. 1212). Good for slow push-ins on stills and b-roll; too
slow-moving for emphasis punch-ins.

## 6. Transitions and fades

- Select the edit point (click it, or move the playhead near it and press V), then
  **Timeline > Add Transition** (Command-T); video only Option-T, audio only Shift-T (p. 1160).
- The standard transition defaults to 1 second (Editing panel of User Preferences) (p. 1160).
  That is long for most edits: change per transition with right-click > Change Transition
  Duration or Command-D (p. 1160). 0.25-0.5 s dissolves for time passing; straight cuts
  elsewhere.
- Audio crossfades at a cut that clicks: Shift-T with a short duration (2-6 frames).
- Video fades: drag the fader handles at the clip's top corners (p. 1204), or park the playhead
  and use **Trim > Fade In to Playhead / Fade Out to Playhead** (p. 1205).

## 7. Audio

- **Normalise clips**: select clips, right-click > **Normalize Audio Levels**; choose a
  loudness standard or Sample/True Peak and a target (p. 1110). It is a volume change only.
- **Dialogue Leveler** (Inspector > Audio) rides loud parts down and soft parts up (p. 774,
  p. 1116). **Voice Isolation** removes background noise (Studio only) (p. 774, p. 1115).
  Use moderate amounts; listen for artefacts.
- **Ripple Delete Silence** exists (Clip > Audio Operations > Ripple Delete Silence, p. 773)
  but cuts on level only. Prefer OpenEdit's transcript-aware `plan_cuts`.
- **Music under speech**: lower the music clip in Inspector > Audio > Volume, or keyframe its
  volume overlay around speech; aim ~20-24 dB under the voice during speech.
- **Meters**: Fairlight page loudness meter target can be set to -14 LUFS for YouTube
  (default -23) (p. 4060).

## 8. Colour consistency (not grading)

Goal: shots that match, not a look. Color page (Shift-6).

- Neutral starting point per clip: **Color > Auto Color** (Option-Shift-C) or the **A** button
  in the Primaries palette (p. 3129).
- Match clips to a reference: after Auto Color on all of them, select the clips in the
  thumbnail timeline, right-click the reference > **Shot Match** (p. 3130).
- Check on the scopes, then show the user before/after frames. Creative grading is the user's
  decision: ask before going further.

## 9. Deliver: render, loudness, subtitles

1. Deliver page (Shift-8). **Render Settings** top: choose a preset (H.264 Master, YouTube
   1080p ...) or Custom (p. 4098, p. 4103-4105).
2. **Location**: Browse... to the output folder; filename in the File panel / name field
   (p. 4098, p. 4125). A file dialog may need full-screen control or the user.
3. Audio panel: **Audio Normalization** > **Normalize to Standard** or **Optimize to
   Standard**, pick the **Standard**, set **Target Level** (p. 4124-4125). The YouTube preset
   also has a **Normalize Audio** checkbox (p. 4105). Do NOT tick **Upload directly to
   YouTube** (publishing needs the user's explicit permission and their account).
4. Video panel bottom: subtitle export options (p. 1247).
5. **Add to Render Queue** (p. 4130), then **Start Render** under the viewer (p. 4131). Ask
   before overwriting an existing file.
6. Verify the file: `probe_media`, then openedit-review (loudness, frames).

Simple alternative: **File > Quick Export** with a preset (p. 4095). OpenEdit's bridge
`render` also queues an H.264 render with a preset name; use the UI only for settings the API
does not expose (normalisation, subtitles burn-in, specific codecs).

## 10. Exporting for another NLE

**File > Export > Timeline...** (Shift-Command-O): .otio/.otioz preferred where supported,
else XML/AAF/EDL; .drt between Resolve systems (p. 4160).

## 11. Navigation, undo, safety

- Pages: Shift-2 ... Shift-8; Project Manager Shift-1; Project Settings Shift-9 (p. 21), or
  Workspace > Switch to Page.
- Undo Command-Z, Redo Shift-Command-Z, **Edit > History** for multiple steps; Media, Cut, Edit
  and Fairlight share one undo stack; each Color and Fusion clip has its own (p. 69).
- Save: **File > Save Project** (Command-S); **File > Revert to Last Save Version** (p. 4338).
- Keyframe navigation and markers: **Mark > Add Keyframe**, **Mark > Add Marker** (p. 4343).

## 12. Menu reference (Resolve 21, "Menu Descriptions", p. 4336-4350)

| Menu | Items you will use |
|---|---|
| DaVinci Resolve | Preferences (p. 95), Keyboard Customization |
| File | Save Project, Import > Timeline / Subtitles / Media, Export > Timeline / Subtitles, Quick Export, Project Settings, Setup AI Assistants |
| Edit | Undo, Redo, History, Ripple Delete, Delete Gaps, Overwrite, Place on Top |
| Trim | Blade Edit Mode, Fade In to Playhead, Fade Out to Playhead |
| Timeline | Add Transition, Add Video/Audio Only Transition, Split Clips, AI Tools > Create Subtitles from Audio, Snapping, Linked Selection |
| Clip | Audio Operations > Ripple Delete Silence / Trim Audio Levels, Auto Align Clips |
| Mark | Mark In/Out, Add Keyframe, Add Marker, Delete All Markers |
| View | Safe Area, Show Subtitle Regions, Show Markers |
| Workspace | Switch to Page, Console, Scripts, Workflow Integrations, Reset UI Layout |
