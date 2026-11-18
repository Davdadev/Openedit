---
name: openedit-stock-media
description: Choose and place b-roll, stock footage, images, music and sound effects well with OpenEdit's get_media / find_media / download_media / media_credits tools - literal vs metaphorical coverage, matching motion, light, aspect and resolution, avoiding cheesy or watermarked stock, and meeting licence and credit obligations (CC BY, Jamendo non-commercial terms). Use whenever an edit needs footage, cutaways, b-roll, background music, a music bed, SFX or images the user did not supply, or the user asks to "add b-roll", "find a clip of", "add music" or "make it more visual".
---

# Stock media that does not look like stock

B-roll exists to show the viewer what the speaker is talking about, or to hide a cut. If a clip
does neither, it is decoration, and decoration made from stock reads as cheap. When in doubt,
leave the speaker on screen.

## When to add b-roll

- The sentence names something **concrete and visible** ("we soldered the board", "Tokyo at
  night", "the old CRT monitor"). Show it.
- A jump cut needs covering and there is a relevant visual for the words under it.
- A list or process: one shot per step, each on its phrase.

Do not add b-roll to emotional or persuasive moments where the face is the point, to abstract
statements ("success", "growth", "innovation"), or every N seconds by quota.

## Choosing what to search for

1. Take the exact sentence. Name the **subject + action + setting + mood + shot type**:
   "barista pouring latte art, close-up, warm cafe light" beats "coffee".
2. Prefer **literal** coverage. Use a **metaphor** only when it is specific and fresh, and the
   user's tone allows it. "Plant growing" for "growth" is a cliché: skip it.
3. Match the edit:
   - `orientation`: `landscape` for 16:9, `portrait` for 9:16 (do not crop landscape stock to
     vertical unless the subject is centred).
   - `minWidth`: at least the delivery width (1920 for 1080p, 3840 for 4K).
   - Duration: `minDuration` >= the hold you need + 1-2 s of handles.
   - Light and colour: daylight interview -> daylight b-roll; moody night talk -> low-key shots.
   - Motion: slow, steady shots under calm speech; handheld energy only for energetic content.
4. Compare before downloading when it matters: `find_media {query, kind, count:8}`, read the
   listing (resolution, duration, licence, reason), then `download_media {ids:[...]}`. For
   quick, low-stakes needs, `get_media` downloads the top match.

## Rejecting candidates

Reject: visible watermarks or logos, recognisable brands or faces in a way the user might not
want, staged "business people high-fiving", fake screens with nonsense UI, AI-looking
artefacts, mismatched era/region (US police car in a UK story), resolution below delivery,
interlacing or heavy compression, people looking into the lens (breaks the illusion).

## Placing it

```
place_clips {clips:[{path, at:<edited time of the phrase - 0.2>, sourceIn:<best part>,
              sourceOut:<sourceIn + 2..5>, track:2}]}
```

- Hold 2-5 s. Under 1.5 s is a flash; over 6 s the viewer starts wondering where the speaker
  went (unless it is a montage or the clip has its own action).
- Start on the phrase that names it (slightly before is better than after); cut out on a
  natural action point or the end of the sentence.
- Use the best part of the clip (`sourceIn`): skip the first second of stock (often a slow
  start or a camera move settling).
- Dialogue continues underneath (b-roll is placed video-only). Do not add the stock clip's own
  audio.
- Space them out: on talking-head long-form, rarely more than one b-roll per 15-20 s.

## Music and SFX

- Music: `get_media {query:"calm piano minimal", kind:"music", minDuration:<video length>}`.
  Describe mood and instrumentation, not genre hype words. Avoid vocals under speech.
  Place with `gainDb:-20, duckDb:8, loop:true, fadeOut:2` and listen. End the track on a
  musical phrase where possible.
- SFX: only for real on-screen events, short (`maxDuration:3`), at a level that sits under the
  voice. No whoosh-on-every-cut, no meme sounds unless the user asks.

## Licences and credits (do not skip)

- OpenEdit excludes NonCommercial / NoDerivatives media by default. Only pass
  `allowNonCommercial:true` when the user confirms the video is personal and not monetised.
- **CC BY / CC BY-SA** require attribution; BY-SA can also impose share-alike on adaptations.
- **Jamendo's API is free for non-commercial use**; commercial use needs a Jamendo licensing
  deal. Tell the user if any Jamendo track ends up in a monetised edit.
- **Freesound** downloads are ~128 kbps MP3 previews: fine for SFX, not for music beds.
- **NASA** material: credit NASA, do not imply endorsement, some items contain third-party
  material.
- Before finishing: `media_credits {}` and give the user the attribution lines that are
  required, ready to paste into a description.

Licence details per provider: [references/licences.md](references/licences.md).
