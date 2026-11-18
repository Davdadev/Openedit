---
name: openedit-premiere-computer-use
description: Drive Adobe Premiere Pro's interface with computer use (request_access, app_screenshot, app_menu, app_click, app_key) for what OpenEdit's CEP panel and ExtendScript cannot do or when the panel is not running - opening the OpenEdit panel from the Window menu (Extensions submenu), importing an exported XML timeline, styling captions and track styles in the Properties panel, eased keyframes in Effect Controls, auto-ducking music in Essential Sound, transitions, and Export mode settings (format, captions burn-in or sidecar, loudness normalisation). Use when the user edits in Premiere and editor_status shows it is not connected, when a Premiere bridge call returns "unsupported" or a fallback, or when the user asks Claude to do something in Premiere's UI.
---

# Adobe Premiere Pro via computer use

OpenEdit talks to Premiere through a CEP panel that runs ExtendScript: it can build cut
sequences, place clips, add markers, a caption track and Scale keyframes, and export with a
preset. It cannot style captions, set Essential Sound ducking, apply transitions reliably,
change most export settings, or do anything when the panel is closed. For those steps, you
operate Premiere's UI carefully, one verified step at a time.

UI paths below are grounded in Adobe's help pages (cited in
[references/premiere-ui-paths.md](references/premiere-ui-paths.md)). Premiere's menus change
between yearly versions and the app was renamed "Adobe Premiere" in recent releases: when a
path does not match, list the menu with `app_menu {list:"Window"}` and use the title verbatim.

## Decide the route first

1. **Panel connected?** `editor_status`. If Premiere is running but not connected, the panel
   is probably closed: open **Window > Extensions > OpenEdit** (route below), then
   `select_host {host:"premiere"}`.
2. **Panel not installed?** `./premiere/install.sh` installs it and sets CEP `PlayerDebugMode`
   (needed because the panel is unsigned). That changes Adobe's CEP security preference:
   tell the user what it does and let them run it (or run it only after their explicit yes).
   Then Premiere must be restarted (ask before quitting it: unsaved work).
3. **No panel at all / user prefers files?** `export_timeline {planId, format:"fcp7"}` and
   **File > Import** the .xml; captions come as an .srt sidecar (import and drag onto the
   sequence).
4. **Only the UI can do it?** Use computer use with the protocol below.

## Computer-use protocol for Premiere

1. **Access.** Load the computer-use tools. Find the exact app name with
   `list_apps {query:"Premiere"}` (e.g. "Adobe Premiere Pro 2025" or "Adobe Premiere"), then
   `request_access {apps:[<that name>], reason:"..."}` and use the returned bundle id.
2. **Background first.** `app_menu` for anything in the menu bar (most reliable), `app_key`
   for shortcuts, `app_screenshot` + `app_click` for panels. Premiere's panels are partly
   custom-drawn: if clicks report `unsupported(canvas)` or do nothing twice, use
   `element_index` from the AX summary or ask `request_full_control
   {reason_kind:"click_no_effect"}` naming the step.
3. **Screenshot before every click and after every action**; coordinates only from the latest
   screenshot. `app_zoom` to read small values in Effect Controls.
4. **Save first**: **File > Save** (Command-S) before multi-step changes. Duplicate the
   sequence (OpenEdit already builds a new one; work there, never on the user's original).
5. **Confirm with the user** before: Ripple Delete, Clear, Replace, overwriting an export file,
   quitting/restarting Premiere, "Send to Media Encoder" batches that overwrite, anything that
   publishes (Quick Export or Export mode destinations that upload to social platforms).
6. **Stay in scope.** No Creative Cloud sign-in, no account or sync settings, no installing
   plugins or fonts, no downloading, no changing Preferences except what the user agreed to.
   Do not click links in panels.
7. **Verify** with `get_timeline` (when the panel is up), a screenshot of the timeline and
   Program Monitor, and openedit-review on any exported file.
8. **Recover** with **Edit > Undo** (Command-Z) and **Window > History**.

## What computer use is for (quick map)

| Task | Where | Notes |
|---|---|---|
| Open OpenEdit panel | Window > Extensions > OpenEdit | CEP panel; UXP plugins live under Window > UXP Plugins instead |
| Import OpenEdit XML | File > Import (Command-I) > the .xml | creates a sequence with cuts, markers, Scale keyframes |
| Import / place captions | File > Import the .srt, drag into the sequence | creates a caption track |
| Style captions | select caption track > Properties panel (Edit tab) > Text / Appearance; save as track style | style every caption at once via the track style |
| Eased zoom | Window > Effect Controls > Motion > Scale: stopwatch, Add/Remove Keyframe, right-click keyframe > Ease In / Ease Out | panel already adds keyframes; this is for adjusting |
| Music ducking | Window > Essential Sound: tag voice Dialogue, music Music > Ducking > Duck against Dialogue > Generate Keyframes | Sensitivity, Duck Amount, Fade Duration |
| Export with loudness / captions | File > Export > Media (Command-M) > Export mode | Captions: Create Sidecar File or Burn Captions Into Video; Effects: Loudness Normalization |
| Long or multiple exports | Export mode > Send to Media Encoder | Media Encoder must be installed |

Detailed recipes, settings and source URLs:
[references/premiere-ui-paths.md](references/premiere-ui-paths.md).

Keep openedit-editing's craft standards: Scale 105-115% for punch-ins with short eases,
captions <= 2 lines and never over faces, music well under the voice, -14 LUFS / <= -1 dBTP
for online delivery.
