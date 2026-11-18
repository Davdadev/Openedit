# Provider licences (as used by OpenEdit)

Summarised from OpenEdit's `src/media/LICENSES.md` (checked against provider docs, Nov 2026).
That file is authoritative; read it when a question goes beyond this table. `media_sources {}`
shows which providers have keys configured.

| Provider | Kinds | Licence | Attribution | Watch out for |
|---|---|---|---|---|
| Pexels | video, image | Pexels License: commercial use and modification allowed | not required, appreciated (OpenEdit writes a line anyway) | no reselling unaltered copies |
| Pixabay | video, image | Pixabay Content License | not required | no standalone redistribution; no Pixabay music via API |
| Unsplash | image | Unsplash License | not required by licence; API guidelines ask for photographer credit | no competing service |
| Openverse | image, audio, music, sfx | per item: CC0, PDM, CC BY, CC BY-SA ... | required for BY / BY-SA | read each item's licence |
| Wikimedia Commons | image, video, audio | PD, CC0, CC BY, CC BY-SA, GFDL | usually required | BY-SA share-alike; GFDL is awkward for video |
| NASA | image, video, audio | generally US Gov public domain | credit NASA | no implied endorsement; third-party content in some items |
| Freesound | sfx, audio | CC0, CC BY (NC excluded by default) | required for CC BY | previews are ~128 kbps MP3 |
| Jamendo | music | per track CC (NC/ND filtered out) | per licence | the API itself is for non-commercial use only; commercial use needs Jamendo Licensing |

## What to tell the user

After using stock media, list:

1. Items that REQUIRE attribution, with the exact line from `media_credits`.
2. Any item with share-alike (BY-SA) terms.
3. Any Jamendo music if the video might be monetised.
4. Where `CREDITS.md` lives (default `~/OpenEdit Media/CREDITS.md`).

Never strip, crop out or blur a watermark or credit burned into a file. Reject that file instead.
