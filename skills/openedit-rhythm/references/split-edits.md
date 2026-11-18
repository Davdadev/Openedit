# Split edits (J and L cuts)

| Situation | Edit | Length |
|---|---|---|
| New scene / location | J: next scene's ambience or line first | 0.5-1.5 s |
| Conversation, next speaker | J: hear them before we see them | 0.3-0.8 s |
| Reaction shot | L: the line continues over the listener | 0.5-1.5 s |
| B-roll entering over speech | picture cuts in a pause, voice continues (L) | entry on a phrase start |
| B-roll natural sound | J lead of its ambience under the voice | 0.3-0.5 s at -18 to -24 dB |
| Single-camera jump cut | breath pre-lap J only | <= 0.35 s |

- `roll: "audio"` (default) keeps the picture cut and moves the sound edit (needs source handles);
  `roll: "video"` keeps the sound edit and moves the picture cut.
- Sync never changes: each piece's sound and picture stay locked; the duration is unchanged.
- Never bring back removed speech: a J that would play a cut "um" is wrong. `auto` checks this.
- In standalone, b-roll natural sound is a placement option: `natSound {gainDb, lead, tail}`.
- Export: fcp7 XML writes linked clips with different audio/video in/out; FCPXML uses
  audioStart/audioDuration. The Premiere/Resolve bridges get straight cuts.
