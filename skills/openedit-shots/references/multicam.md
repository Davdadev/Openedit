# Multicam

Sync: audio onset envelopes are cross-correlated (FFT, +/- maxOffset), refined to the sample.
Offsets are the reference time at which an angle's t=0 happens. Confidence < 0.3 = check by eye
(clap, door slam, plosive). Drift is reported in ppm when the overlap is over two minutes.

Speaker detection: isolated mics (one lav per person) are detected from level differences and
win; otherwise faces + mouth movement per angle (Vision landmarks). Angles whose mouth activity
correlates frame the same person. Roles: wide (two or more faces, or small faces), medium, close.

Rules (multicam_edit rules object):
- minShot 1.8 s, cutDelay 0.3 s (a beat after they start when there is no pause),
- maxCloseRun 20 s before a reaction (reactionHold 2 s) or wide reset (wideHold 3 s),
- pingPong 2.5 s: shorter alternating turns stay wide,
- varietyAfter 12 s: change size on the same speaker at a sentence end,
- openWide 3 s.

Grammar to keep when adjusting: cut on who speaks, not on every sentence; reactions show the
listener's response, so place them after a point lands; a wide resets geography after long
close-up stretches; never cut between two framings of nearly the same size (it reads as a jump cut).

Outputs: edit JSON, FCP7 XML (Premiere File > Import; Resolve File > Import > Timeline), FCPXML
(Final Cut Pro), rendered mp4 with an SRT remapped to the edit.
