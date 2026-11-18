# Music editing

- Find the edit with `detect_beats`: bar lines (downbeats), sections, the final downbeat.
- Remove whole phrases (4/8 bars) from the middle; jump between sections of the same kind
  (chorus to chorus) so harmony and instrumentation match.
- Crossfade 20-50 ms just before the downbeat so the new bar's attack is clean (`fit_music` does
  30 ms, 20 ms early).
- Keep the intro when there is time; start on a later phrase only for very short pieces.
- Ending: the song's own ending; trimming the ring-out with a short fade is fine, fading a phrase
  out is not. A "button" (final hit + quick fade) when no ending fits.
- Longer than the song: repeat a phrase-length block (not into the intro).
- Levels: -14 LUFS delivery; music bed under speech -16 to -22 dB, ducked; music-only montage
  carries the mix.
- Licence: check credit requirements of stock music (media_credits).
