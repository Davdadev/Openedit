# Vertical safe zones (1080 x 1920)

Platform overlays (username, caption text, music ticker, like/comment/share column, progress
bar, top tabs) change often and differ by app, device and ad vs organic placement. These are
conservative working margins, not official specifications: when the user names a platform,
favour their own experience and check a real upload.

| Region | Approx. pixels at 1080x1920 | Share of frame | What lives there |
|---|---|---|---|
| Top band | y 0-~250 | ~13% | status bar, tabs ("Following / For You"), search |
| Bottom band | y ~1500-1920 | ~22% | handle, description, audio ticker, progress bar |
| Right column | x ~900-1080 (lower 2/3) | ~15-17% | like / comment / share / remix buttons |
| Left margin | x 0-~60 | ~5% | edge crop on some devices |

Practical rules:

- Keep captions, titles and faces inside roughly x 60-900, y 250-1500.
- Place spoken captions in the lower-middle (centre of the text block ~62-72% from the top),
  above the bottom band and clear of the chin. OpenEdit's vertical caption margin (~22% of
  height from the bottom) lands here; re-check after any reframe.
- A top title sits just under the top band (~y 280-420), never touching the frame edge.
- Faces: eyes roughly on the upper third line (~y 640) for single-speaker talking heads.
- 4:5 (Instagram feed) is cropped from 9:16 in grid view: keep essentials in the central
  1080x1350.

How to verify: extract frames from the render (see openedit-review) and check caption bounding
boxes against these margins. If you have a platform UI overlay PNG from the user, composite it
over a frame with ffmpeg `overlay` and look.
