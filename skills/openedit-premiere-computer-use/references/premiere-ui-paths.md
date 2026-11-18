# Premiere Pro: UI recipes with sources

Sources: Adobe Help Center pages listed per section (accessed Nov 2026), Adobe's UXP developer
docs, and this repository's `premiere/README.md`. Adobe moved Premiere help to
`helpx.adobe.com/premiere/desktop/...`; older `premiere-pro/using/...` URLs still exist.
Menus vary by version (23.x-27.x): verify each path with `app_menu {list:"<Menu>"}` first and
use the titles it returns.

## Contents

1. The OpenEdit panel (CEP)
2. Importing OpenEdit's timeline
3. Captions: import, edit, style
4. Keyframes and eased zooms
5. Audio: ducking and loudness
6. Export mode
7. Safety and recovery

## 1. The OpenEdit panel (CEP)

- Install: `premiere/install.sh` (macOS) / `install.ps1` (Windows) puts the panel in the CEP
  extensions folder and sets `PlayerDebugMode` for CSXS 9-13 because the panel is unsigned
  (`premiere/README.md`). Restart Premiere.
- Open: **Window > Extensions > OpenEdit** (`premiere/README.md`). CEP panels appear under
  Window > Extensions when the manifest asks for it (Adobe CEP-to-UXP migration guide,
  https://developer.adobe.com/uxp/migration-center/uxp-for-cep-devs/technical-migration-guide/).
  UXP plugins are a different system under **Window > UXP Plugins** (Premiere 25.6+,
  https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/install/). If the
  Extensions submenu has no OpenEdit, the install or PlayerDebugMode step did not take
  (`defaults read com.adobe.CSXS.12 PlayerDebugMode` must print 1).
- CEP lifetime: CEP keeps working in app versions released before December 2029
  (https://helpx.adobe.com/creative-cloud/apps/integration-with-other-apps/manage-plugins/cep-uxp-plugin-transition.html).
- The panel must stay open (it can be docked small). Health check:
  `curl -s http://127.0.0.1:47821/health`.

## 2. Importing OpenEdit's timeline

1. `export_timeline {planId, format:"fcp7"}`.
2. **File > Import...** (Command-I), choose the .xml (system Open panel: background tools may
   be refused there; ask for full-screen control with `reason_kind:"file_dialog"` or ask the
   user to pick the file).
3. A bin with the sequence appears in the Project panel; double-click to open it. Compare
   duration with `show_plan`. Scale keyframes for zooms come through (Basic Motion).
4. Relink if media is offline (Premiere prompts with Link Media).

## 3. Captions: import, edit, style

Sources:
https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/import-caption-file-from-third-party-service.html ·
https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/about-captions.html ·
https://helpx.adobe.com/premiere/desktop/add-text-images/stylize-text/create-linked-and-track-styles.html ·
https://helpx.adobe.com/premiere/desktop/add-text-images/stylize-text/apply-linked-and-track-styles.html ·
https://helpx.adobe.com/premiere-pro/using/working-with-captions.html

- Import the .srt like any media (File > Import), then drag it into the sequence: Premiere
  creates a caption track. Edit text in the **Text** panel (Captions tab).
- OpenEdit's panel already tries `createCaptionTrack`; if captions arrived as yellow markers
  instead, import the .srt manually as above.
- Style: select the caption track (or a caption in the Program Monitor), open the
  **Properties** panel **Edit** tab, set Text (font, size, weight) and Appearance (fill,
  stroke, background box, shadow) and position.
- Make it apply to all captions: save it as a **track style** (Save to Project links captions
  to the style; Local Styles reuses it in other projects), then pick it from the **Linked
  style** dropdown. When changing a style later, the Redefine Style dialog asks whether to
  update all captions on the track.
- Long-form style: clean sans (e.g. Inter/Helvetica semibold), white, subtle stroke or
  translucent box, max 2 lines, bottom-centre inside title-safe. No per-word colour.

## 4. Keyframes and eased zooms

Sources:
https://helpx.adobe.com/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/add-keyframes.html ·
https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/about-effect-controls-panel.html ·
https://helpx.adobe.com/premiere-pro/using/motion-position-scale-rotate-clip.html

1. Select the clip; **Window > Effect Controls**; expand **Motion**.
2. Move the playhead to the zoom start. Click the **stopwatch** (Toggle animation) next to
   **Scale** (creates a keyframe), or **Add/Remove Keyframe** if animation is already on.
3. Move ~0.2-0.4 s later and change Scale (e.g. 100 -> 110): a keyframe is created
   automatically.
4. Hold, then return to the base value at the end of the emphasis.
5. Right-click a keyframe > **Ease In** / **Ease Out** (or Bezier) for a natural move.
6. OpenEdit's `add_zooms` writes these keyframes itself (relative to the clip's current
   scale, Bezier). Use the UI only to adjust or to remove ones that should not be there.

## 5. Audio: ducking and loudness

Sources:
https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/automatically-duck-audio.html ·
https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/about-loudness-meter.html ·
https://helpx.adobe.com/premiere/desktop/whats-new/release-notes.html

- **Auto ducking**: **Window > Essential Sound**. Tag the voice clips **Dialogue** and the
  music **Music** (only Music or Ambience clips can be ducked). On the music: enable
  **Ducking**, **Duck against** the Dialogue icon, set **Sensitivity**, **Duck Amount**
  (start around -18 to -24 dB under speech, then listen) and **Fade Duration**, then
  **Generate Keyframes**. Keyframes go on an Amplify effect's gain. Recent versions (27.0
  release notes) update ducking keyframes automatically after edits; older versions need
  Generate Keyframes again, which overwrites manual changes.
- **Loudness Meter** (an audio effect on the mix) measures LUFS/LKFS and true peak for
  checking; it does not change level.

## 6. Export mode

Sources:
https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-video.html ·
https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/overview-of-export-settings.html ·
https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/quickly-export-a-video-file.html ·
https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-directly-to-adobe-media-encoder.html ·
https://helpx.adobe.com/media-encoder/desktop/encoding-and-exporting/automatic-loudness-correction.html

1. Select the sequence; **File > Export > Media** (Command-M) opens **Export** mode.
2. **Preset** and **Format**: H.264 with a "Match Source - Adaptive High Bitrate" preset suits
   online delivery.
3. **File name / Location**: click the blue file name to open Save As. Ask before overwriting.
4. **Captions** section (only shown when the sequence has caption tracks): **Create Sidecar
   File** (e.g. .srt) or **Burn Captions Into Video** (cannot be turned off later). Embedded
   captions only for some formats (QuickTime, MXF OP1a).
5. **Effects** > **Loudness Normalization**: choose the standard (ATSC A/85, EBU R128, ITU
   BS.1770-3); per Adobe's Media Encoder documentation only ITU BS.1770-3 lets you set the
   target loudness (set -14 LUFS for YouTube/social). **Configure True Peak Limiter** controls
   peak overshoot; **Write Loudness Report** saves an XML with measured loudness and true peak.
6. **Export**, or **Send to Media Encoder** for long or multiple deliverables.
7. Quick Export (icon at the top right) only offers presets; use Export mode when captions or
   loudness settings matter.
8. Never enable a publish destination (YouTube, TikTok, etc.) in Export mode without the
   user's explicit permission: that posts content publicly.

After export: `probe_media` and openedit-review (loudness via ebur128, frames for captions).

## 7. Safety and recovery

- Save (Command-S) before changes; **Edit > Undo** and **Window > History** to go back.
- Never modify the user's original sequence; OpenEdit's `apply_cuts` builds a new one.
- Restarting Premiere (after installing the panel) can lose unsaved work: ask the user to
  save and restart it themselves, or confirm before you quit it.
