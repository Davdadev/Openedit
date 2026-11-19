# Figma → OpenEdit motion template

The session's Claude has the official Figma MCP server; OpenEdit cannot call it, so you
orchestrate: read the design with Figma tools, then hand the code to OpenEdit.

## 1. Find the frame

- `get_metadata` on the file or page: frame names, ids, sizes. Pick the graphic's frame
  (designers usually draw lower thirds on a full 1920x1080 frame: keep that, positions stay right).
- `get_screenshot` of that frame: the reference you compare the preview against.

## 2. Read the design

- `get_design_context {nodeId}` returns React + Tailwind code (and asset URLs on
  `http://localhost:3845/assets/...`). Pass it unchanged as `figmaCode`.
- `get_variable_defs`: brand colours and fonts. Use them as field defaults; Figma variables
  that appear in the code as `var(--name, #hex)` become colour fields automatically.
- Images/SVG: download each asset URL the converter lists (Figma `download_assets`, or curl
  for localhost URLs) into a folder, and pass them in `assets` with the listed file names.
  Prefer SVG for vector shapes; keep text as live text (never flatten it to an image).

## 3. Layer naming → fields

Ask the designer (or rename) layers so the right parts are editable:

| Layer name | Becomes |
|------------|---------|
| `#title`, `#name`, `#role` | text field (default = layer text) |
| `#color:accent` | colour field bound to the layer's fill/background |
| `#image:logo` | image field (pass a local path in place_graphic) |
| `#toggle:badge` | checkbox showing/hiding the layer |

Other layers keep their Figma name as `data-name`, so motion selectors are
`[data-name="plate"]`; fields are `[data-oe-field="name"]`. Auto layout becomes flex CSS,
components become plain nested markup (reuse by making one template per component).

## 4. Motion

Add a `motion` array, layer by layer, in reading order. Example lower third:

```json
[
  { "selector": "[data-oe-field=\"accent\"]", "preset": "grow-y", "duration": 0.5 },
  { "selector": "[data-name=\"plate\"]", "preset": "wipe-right", "delay": 0.12, "duration": 0.7 },
  { "selector": "[data-oe-field=\"name\"]", "preset": "mask-up", "split": "words", "delay": 0.3, "stagger": 0.07 },
  { "selector": "[data-oe-field=\"role\"]", "preset": "tracking-in", "delay": 0.6, "from": 0.4, "tracking": 0.16 }
]
```

Exits are mirrored automatically (`autoExit`); set `exit: true` entries only for custom exits.

### When the designer animated it in Figma (use their motion, not presets)

If the frame has keyframe animation in Figma (motion / Smart Animate), use the designer's own
timing and easing:

1. `get_motion_context {fileKey, nodeId, recursive: true}` on the PARENT frame, once.
2. Pass the whole response, untouched, as `figmaMotion` to `create_motion_template` (with the
   same frame's `figmaCode`). OpenEdit extracts the CSS `@keyframes` and animation rules,
   makes loops finite (enough cycles to cover `duration`) and adds `both` fill so HyperFrames
   can seek every frame. The tool's warnings list each keyframe set it found.
3. If the motion CSS targets selectors that are not in the imported HTML (Figma class names
   vs `data-name` layers), map them with `figmaSelectorMap`, e.g.
   `{".title-frame": "[data-name=\"title\"]"}`. A warning names any `@keyframes` that no rule
   applies.
4. Set `autoExit: false` when the Figma motion already animates out; otherwise OpenEdit fades
   the graphic out at the end.
5. Look at the strip: the settled frame must match `get_screenshot`, the motion must match
   the Figma prototype. Tracks that do not translate (shaders, video fills): export them from
   Figma (`get_screenshot` / the person's MP4) and place them as assets.

For deeper Figma work inside HyperFrames itself (storyboards as keyframes, tokens over REST,
motion verification against Figma's own export), the HyperFrames plugin's `hyperframes:figma`
skill covers it; OpenEdit's path above is the quick one for titles and lower thirds.

## 5. Check and iterate

`create_motion_template` returns a 4-frame strip: entrance, settled, hold, exit. Compare the
settled frame with the Figma screenshot (fonts, spacing, colours) and the motion with the
craft rules. Fix and call again with the same `name` (it is overwritten). Then
`preview_template {id, params}` with real content (long names!) and `place_graphic`.

## Fonts

Fonts are loaded by the renderer from installed fonts or Google Fonts (Google Fonts links or
@imports are downloaded into the template). If the result says a font is not installed, ask
the user to install it, or switch to the Google Fonts equivalent.
