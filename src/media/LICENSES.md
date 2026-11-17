# Stock media sources: API terms and licenses

Checked against each provider's current API documentation (November 2026). OpenEdit records
every download in `CREDITS.md` + `credits.json` in the media folder, with the attribution line
to use. NonCommercial (NC) and NoDerivatives (ND) material is excluded by default
(`allowNonCommercial: true` opts in) because a cut is a derivative and most videos are published
on monetized channels.

All requests send `User-Agent: OpenEdit/0.1 (+https://github.com/Davdadev/openedit)`.

| Provider | Kinds | Key | Content license | API rules we follow |
|---|---|---|---|---|
| Pexels | video, image | `PEXELS_API_KEY` (Authorization header) | Pexels License: free commercial use and modification, attribution not required but appreciated; no selling unaltered copies, no replicating Pexels | 200 req/h, 20k/month by default; link back to Pexels and credit the photographer where possible (our attribution line does both) |
| Pixabay | video, image | `PIXABAY_API_KEY` (`key` param) | Pixabay Content License: free commercial use and modification, no attribution required; no standalone redistribution or resale | 100 req/60 s; **responses must be cached 24 h** (our on-disk cache TTL for Pixabay is 24 h); no permanent hotlinking, so files are downloaded; show the source when showing results. `largeImageURL` is max 1280 px (full-res needs approved full API access). Pixabay documents **no audio/music API**, so Pixabay music/SFX are not used. |
| Unsplash | image | `UNSPLASH_ACCESS_KEY` (`Authorization: Client-ID`) | Unsplash License: free commercial use and modification, no attribution required by the license; no selling unaltered copies, no competing service | Demo 50 req/h, production 1000 req/h. **Download tracking**: `download()` calls `links.download_location` before fetching the file. Credit photographer + Unsplash with `utm_source=openedit&utm_medium=referral` links (in the attribution line). Use the returned `urls.*` (we download `urls.full`, which keeps `ixid`). |
| Openverse | image, audio, music, sfx | none | Per item: CC0, PDM, CC BY, CC BY-SA, ... We send `license_type=commercial,modification` unless NC is allowed | Anonymous: 20 req/min burst, 200 req/day; `page_size` ≤ 20. Uses the `attribution` string Openverse returns. Files are downloaded from the original host (Flickr, Freesound CDN, Jamendo, ...). |
| Wikimedia Commons | image, video, audio | none | Only free licenses: PD, CC0, CC BY, CC BY-SA, GFDL. License/author parsed from `extmetadata` (LicenseShortName, LicenseUrl, Artist, AttributionRequired) | MediaWiki API etiquette: descriptive User-Agent, modest rate. Very large video originals (> 400 MB) are replaced by a ~1080p transcode from `videoinfo.derivatives`. |
| NASA Image and Video Library | image, video, audio | none | Generally not copyrighted (US Government work); credit NASA; must not imply NASA endorsement; some items contain third-party material (check the description) | `images-api.nasa.gov/search`; the asset is resolved from each item's `collection.json` (prefers `~large.mp4` / `~orig.jpg`). |
| Freesound | sfx, audio | `FREESOUND_API_KEY` (`Authorization: Token`) | Per sound: CC0, CC BY (3.0/4.0), CC BY-NC (excluded by default) | Token auth covers search and previews. **Original-file download requires OAuth2**, so OpenEdit downloads `previews.preview-hq-mp3` (~128 kbps MP3) and notes this in the credits. |
| Jamendo | music, audio | `JAMENDO_CLIENT_ID` (`client_id` param) | Per track Creative Commons (`license_ccurl`); many tracks are NC and/or ND, which we filter (`ccnc=false&ccnd=false` + client-side) | Jamendo API terms: the API is free for **non-commercial** use; commercial apps need a deal with Jamendo Licensing. Only tracks with `audiodownload_allowed` are downloaded. |

Not used: Mixkit, Uppbeat, YouTube Audio Library and similar (no official public API; we do not scrape).
Internet Archive was considered but its per-item licensing metadata is too inconsistent to filter safely.

## Ranking license preference

CC0 / Public Domain / Pexels / Pixabay / Unsplash (1.0) > CC BY (0.8) > CC BY-SA (0.6) > GFDL (0.45) >
unknown (0.3) > NC/ND (0.1, excluded unless allowed).

## Sources

- https://www.pexels.com/api/documentation/ · https://www.pexels.com/license/
- https://pixabay.com/api/docs/ · https://pixabay.com/service/license-summary/
- https://unsplash.com/documentation · https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines · https://unsplash.com/license
- https://api.openverse.org/v1/
- https://www.mediawiki.org/wiki/API:Imageinfo · https://commons.wikimedia.org/wiki/Commons:Licensing
- https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf · https://www.nasa.gov/nasa-brand-center/images-and-media/
- https://freesound.org/docs/api/ · https://freesound.org/docs/api/authentication.html
- https://developer.jamendo.com/v3.0/tracks · https://devportal.jamendo.com/api_terms_of_use
