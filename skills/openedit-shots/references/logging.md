# Logging footage with analyze_footage

Each shot line reads: `id start-end duration [transition] camera, motion, exposure, faces (size), palette | labels`.

- **transition**: cut, dissolve or fade into this shot. Soft "morph" dissolves between takes of the
  same talking head are usually logged as one shot (the picture barely changes).
- **camera**: static, pan-left/right, tilt-up/down, zoom-in/out, handheld (shake without
  direction), moving (subject motion only). Pans name the camera direction.
- **motion**: mean frame-to-frame change (0.001 locked-off talking head, 0.02 lively, 0.05+ busy).
- **exposure**: ok, dark, bright, clipped (large blown areas), crushed (large black areas).
  "soft" is appended when the frame is out of focus.
- **faces / shot size**: from the largest face: wide, medium, close-up, extreme-close-up, no-faces.
- **labels**: macOS Vision classifier labels of the representative frames (best guess, not truth).
  "document/screenshot" often means a graphic or title card.

Working method:
1. Read the sheet top to bottom once without deciding anything.
2. Mark the A-roll setups and the coverage you have for each topic.
3. Mark unusable shots (soft, crushed, slates, flashes) and never propose them.
4. Write the shot ids you plan to use in your reply to the user, so they can veto.
