# ffmpeg review commands (fallback when review_edit is unavailable)

Write outputs to a scratch directory, never next to the user's media unless they asked.
Quote paths; they often contain spaces. `$IN` is the rendered file.

## Contact sheet

24 tiles (6x4), evenly spaced. Set `STEP` to duration / 24 (from `probe_media`), minimum 1:

```bash
ffmpeg -hide_banner -loglevel error -i "$IN" \
  -vf "fps=1/$STEP,scale=480:-2,tile=6x4:padding=4:margin=4" -frames:v 1 -y sheet.jpg
```

For 9:16 use `scale=270:-2,tile=8x3`. Then Read `sheet.jpg` and look at every tile.

## Single frames at exact times

```bash
ffmpeg -hide_banner -loglevel error -ss 63.40 -i "$IN" -frames:v 1 -y f_63.40.jpg
```

Check every zoom start, a few cuts (0.1 s before and after), and frames with captions.

## Loudness (EBU R128 / ITU BS.1770)

```bash
ffmpeg -hide_banner -nostats -i "$IN" -af ebur128=peak=true -f null - 2>&1 | tail -n 14
```

Read `I:` (integrated LUFS), `LRA:` and `Peak:` (true peak, dBFS ~ dBTP). Targets: -14 LUFS
(YouTube/social), -16 (podcast), -23 (broadcast); true peak <= -1.

Speech vs music balance: measure a speech-only stretch and a music-only stretch:

```bash
ffmpeg -hide_banner -nostats -ss 30 -t 10 -i "$IN" -af ebur128 -f null - 2>&1 | grep " I:"
```

## Black, frozen and silent stretches

```bash
ffmpeg -hide_banner -nostats -i "$IN" -vf "blackdetect=d=0.1:pix_th=0.10" -an -f null - 2>&1 | grep blackdetect
ffmpeg -hide_banner -nostats -i "$IN" -vf "freezedetect=n=0.003:d=0.5" -an -f null - 2>&1 | grep freeze
ffmpeg -hide_banner -nostats -i "$IN" -af "silencedetect=n=-45dB:d=0.6" -vn -f null - 2>&1 | grep silence_
```

A freeze on a talking head can be a still speaker; check the frame before calling it a bug.
Long silences in a tightly cut edit usually mean a cut was not applied.

## Duration and streams

```bash
ffprobe -v error -show_entries format=duration:stream=codec_type,width,height,r_frame_rate,sample_rate \
  -of default=nw=1 "$IN"
```

Compare `duration` with the plan's `editedDuration` from `show_plan`.

## Burned-in captions vs transcript

Pick 3 cue times from the .srt, grab frames 0.2 s into each cue, and compare the visible text
with the cue text. Mismatch means a timing offset (often the cut plan was not passed to
`make_captions`).
