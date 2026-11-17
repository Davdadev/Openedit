import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadResult, fileBase, readCredits } from "../src/media/download.js";
import { USER_AGENT } from "../src/media/http.js";
import { getKey, keyStatus, maskKey, parseEnv, readEnvFile, writeEnvFile } from "../src/media/keys.js";
import { isRestricted, normalizeLicense } from "../src/media/license.js";
import { freesound, jamendo, nasa, openverse, pexels, pixabay, unsplash, wikimedia } from "../src/media/providers/index.js";
import { clearSearchCache, findMedia, lookupResult, rank, relevance, stem } from "../src/media/search.js";
import type { MediaResult, SearchQuery } from "../src/media/types.js";

// ------------------------------------------------------------------------------------------
// Realistic API fixtures (trimmed copies of real response shapes)

const PEXELS_VIDEOS = {
  page: 1,
  per_page: 2,
  total_results: 2,
  videos: [
    {
      id: 3129671,
      width: 3840,
      height: 2160,
      url: "https://www.pexels.com/video/aerial-view-of-city-at-night-3129671/",
      image: "https://images.pexels.com/videos/3129671/free-video-3129671.jpg",
      duration: 15,
      user: { id: 1583460, name: "Pressmaster", url: "https://www.pexels.com/@pressmaster" },
      video_files: [
        { id: 1, quality: "sd", file_type: "video/mp4", width: 640, height: 360, fps: 25, link: "https://videos.pexels.com/video-files/3129671/sd_640_360_25fps.mp4" },
        { id: 2, quality: "hd", file_type: "video/mp4", width: 1920, height: 1080, fps: 25, link: "https://videos.pexels.com/video-files/3129671/hd_1920_1080_25fps.mp4" },
        { id: 3, quality: "uhd", file_type: "video/mp4", width: 3840, height: 2160, fps: 25, link: "https://videos.pexels.com/video-files/3129671/uhd_3840_2160_25fps.mp4" },
      ],
      video_pictures: [{ id: 1, picture: "https://images.pexels.com/videos/3129671/pictures/preview-0.jpg", nr: 0 }],
    },
    {
      id: 857195,
      width: 1280,
      height: 720,
      url: "https://www.pexels.com/video/people-walking-on-a-beach-857195/",
      image: "https://images.pexels.com/videos/857195/free-video-857195.jpg",
      duration: 40,
      user: { id: 2, name: "Joe", url: "https://www.pexels.com/@joe" },
      video_files: [{ id: 4, quality: "hd", file_type: "video/mp4", width: 1280, height: 720, link: "https://videos.pexels.com/video-files/857195/hd.mp4" }],
      video_pictures: [],
    },
  ],
};

const PEXELS_PHOTOS = {
  photos: [
    {
      id: 2014422,
      width: 3024,
      height: 3024,
      url: "https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/",
      photographer: "Joey Farina",
      photographer_url: "https://www.pexels.com/@joey",
      alt: "Brown Rocks During Golden Hour",
      src: { original: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg", medium: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?h=350" },
    },
  ],
};

const PIXABAY_VIDEOS = {
  total: 1,
  totalHits: 1,
  hits: [
    {
      id: 125,
      pageURL: "https://pixabay.com/videos/id-125/",
      type: "film",
      tags: "city, night, traffic",
      duration: 12,
      videos: {
        large: { url: "https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.mp4", width: 1920, height: 1080, size: 6615235, thumbnail: "https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.jpg" },
        small: { url: "https://cdn.pixabay.com/video/2015/08/08/125-135736646_small.mp4", width: 640, height: 360, size: 1000000, thumbnail: "" },
      },
      user_id: 1281706,
      user: "Coverr-Free-Footage",
    },
  ],
};

const PIXABAY_IMAGES = {
  hits: [
    {
      id: 195893,
      pageURL: "https://pixabay.com/en/blossom-bloom-flower-195893/",
      tags: "blossom, bloom, flower",
      previewURL: "https://cdn.pixabay.com/photo/2013/10/15/09/12/flower-195893_150.jpg",
      webformatURL: "https://pixabay.com/get/35bbf209e13e39d2_640.jpg",
      largeImageURL: "https://pixabay.com/get/ed6a99fd0a76647_1280.jpg",
      imageWidth: 4000,
      imageHeight: 2250,
      user_id: 48777,
      user: "Josch13",
    },
  ],
};

const UNSPLASH_SEARCH = {
  total: 1,
  total_pages: 1,
  results: [
    {
      id: "eOLpJytrbsQ",
      width: 4000,
      height: 3000,
      description: "A man drinking a coffee.",
      alt_description: "man holding mug",
      urls: {
        raw: "https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?ixid=abc",
        full: "https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?ixid=abc&fm=jpg&q=85",
        regular: "https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?w=1080",
        small: "https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?w=400",
        thumb: "https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?w=200",
      },
      links: {
        html: "https://unsplash.com/photos/eOLpJytrbsQ",
        download: "https://unsplash.com/photos/eOLpJytrbsQ/download",
        download_location: "https://api.unsplash.com/photos/eOLpJytrbsQ/download?ixid=abc",
      },
      user: { name: "Jeff Sheldon", username: "ugmonk", links: { html: "https://unsplash.com/@ugmonk" } },
    },
  ],
};

const OPENVERSE_IMAGES = {
  result_count: 2,
  results: [
    {
      id: "81fff0fb-f37f-455e-810b-dadd78962ef1",
      title: "Seattle city night",
      foreign_landing_url: "https://www.flickr.com/photos/14616167@N00/8059791323",
      url: "https://live.staticflickr.com/8456/8059791323_b0f90c02dd_b.jpg",
      creator: "Still Vision",
      creator_url: "https://www.flickr.com/photos/14616167@N00",
      license: "by",
      license_version: "2.0",
      license_url: "https://creativecommons.org/licenses/by/2.0/",
      provider: "flickr",
      source: "flickr",
      filetype: null,
      tags: [{ name: "city" }, { name: "night" }],
      attribution: '"Seattle city night" by Still Vision is licensed under CC BY 2.0.',
      width: 1024,
      height: 686,
      thumbnail: "https://api.openverse.org/v1/images/81fff0fb/thumb/",
    },
    {
      id: "nc-item",
      title: "City night NC",
      foreign_landing_url: "https://www.flickr.com/photos/x/1",
      url: "https://live.staticflickr.com/1/1.jpg",
      creator: "X",
      creator_url: null,
      license: "by-nc",
      license_version: "2.0",
      license_url: "https://creativecommons.org/licenses/by-nc/2.0/",
      provider: "flickr",
      source: "flickr",
      tags: [],
      attribution: null,
      width: 2000,
      height: 1000,
      thumbnail: null,
    },
  ],
};

const OPENVERSE_AUDIO = {
  results: [
    {
      id: "6b072076-066b-45b6-9695-367a6260c96d",
      title: "Rain, Moderate, C.wav",
      foreign_landing_url: "https://freesound.org/people/InspectorJ/sounds/401275",
      url: "https://cdn.freesound.org/previews/401/401275_5121236-hq.mp3",
      creator: "InspectorJ",
      creator_url: "https://freesound.org/people/InspectorJ",
      license: "by",
      license_version: "4.0",
      license_url: "https://creativecommons.org/licenses/by/4.0/",
      provider: "freesound",
      source: "freesound",
      filetype: "mp3",
      tags: [{ name: "rain" }, { name: "weather" }],
      attribution: '"Rain, Moderate, C.wav" by InspectorJ is licensed under CC BY 4.0.',
      duration: 60116,
      thumbnail: null,
    },
  ],
};

const WIKIMEDIA = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 84288035,
        ns: 6,
        title: "File:Ocean Moon Glint and City Night Lights in 4K.webm",
        index: 1,
        videoinfo: [
          {
            size: 9600365,
            width: 1920,
            height: 1080,
            duration: 16.842,
            thumburl: "https://upload.wikimedia.org/thumb/ocean.jpg",
            url: "https://upload.wikimedia.org/wikipedia/commons/b/b9/Ocean_Moon_Glint_and_City_Night_Lights_in_4K.webm",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Ocean_Moon_Glint_and_City_Night_Lights_in_4K.webm",
            mime: "video/webm",
            mediatype: "VIDEO",
            extmetadata: {
              ObjectName: { value: "Ocean Moon Glint and City Night Lights in 4K" },
              ImageDescription: { value: "Time-lapse over the <b>Pacific</b> and city night lights" },
              Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:NASA">NASA</a>' },
              LicenseShortName: { value: "Public domain" },
              AttributionRequired: { value: "false" },
            },
          },
        ],
      },
      {
        pageid: 2,
        ns: 6,
        title: "File:Big_city_night.webm",
        index: 2,
        videoinfo: [
          {
            size: 900 * 1024 * 1024,
            width: 3840,
            height: 2160,
            duration: 30,
            url: "https://upload.wikimedia.org/wikipedia/commons/a/aa/Big_city_night.webm",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Big_city_night.webm",
            mime: "video/webm",
            derivatives: [
              { src: "https://upload.wikimedia.org/transcoded/a/aa/Big.webm.480p.vp9.webm", type: "video/webm", width: 854, height: 480 },
              { src: "https://upload.wikimedia.org/transcoded/a/aa/Big.webm.1080p.vp9.webm", type: "video/webm", width: 1920, height: 1080 },
            ],
            extmetadata: {
              Artist: { value: "Jane Doe" },
              LicenseShortName: { value: "CC BY-SA 4.0" },
              LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
              AttributionRequired: { value: "true" },
            },
          },
        ],
      },
    ],
  },
};

const NASA_SEARCH = {
  collection: {
    items: [
      {
        href: "https://images-assets.nasa.gov/video/GSFC_EarthAtNight/collection.json",
        data: [{ nasa_id: "GSFC_EarthAtNight", title: "Earth at Night", center: "GSFC", keywords: ["Night", "Earth", "City lights"], media_type: "video", description: "Black Marble" }],
        links: [{ href: "https://images-assets.nasa.gov/video/GSFC_EarthAtNight/GSFC_EarthAtNight~thumb.jpg", rel: "preview", render: "image" }],
      },
    ],
  },
};
const NASA_COLLECTION = [
  "http://images-assets.nasa.gov/video/GSFC_EarthAtNight/GSFC_EarthAtNight~orig.mp4",
  "http://images-assets.nasa.gov/video/GSFC_EarthAtNight/GSFC_EarthAtNight~large.mp4",
  "http://images-assets.nasa.gov/video/GSFC_EarthAtNight/metadata.json",
];

const FREESOUND_SEARCH = {
  count: 2,
  results: [
    {
      id: 60013,
      name: "Whoosh.wav",
      tags: ["whoosh", "swoosh", "transition"],
      license: "http://creativecommons.org/publicdomain/zero/1.0/",
      username: "qubodup",
      url: "https://freesound.org/people/qubodup/sounds/60013/",
      duration: 1.2,
      previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/60/60013_hq.mp3", "preview-lq-mp3": "https://cdn.freesound.org/previews/60/60013_lq.mp3" },
    },
    {
      id: 5,
      name: "Whoosh NC",
      tags: ["whoosh"],
      license: "https://creativecommons.org/licenses/by-nc/4.0/",
      username: "nc",
      url: "https://freesound.org/people/nc/sounds/5/",
      duration: 2,
      previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/5_hq.mp3" },
    },
  ],
};

const JAMENDO_TRACKS = {
  headers: { status: "success", code: 0, error_message: "", results_count: 1 },
  results: [
    {
      id: "1532771",
      name: "Calm Piano Morning",
      duration: 154,
      artist_id: "7905",
      artist_name: "Komiku",
      album_name: "Mélodies",
      license_ccurl: "http://creativecommons.org/licenses/by/3.0/",
      shareurl: "https://www.jamendo.com/track/1532771",
      audio: "https://prod-1.storage.jamendo.com/?trackid=1532771&format=mp31",
      audiodownload: "https://prod-1.storage.jamendo.com/download/track/1532771/mp32/",
      audiodownload_allowed: true,
      musicinfo: { tags: { genres: ["classical", "piano"], instruments: ["piano"], vartags: ["calm"] } },
    },
  ],
};

// ------------------------------------------------------------------------------------------
// fetch mock

type Route = [RegExp, (url: URL, init?: RequestInit) => Response | Promise<Response>];
const calls: { url: string; headers: Record<string, string> }[] = [];
let routes: Route[] = [];

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const bytes = (type: string, body = "FAKEMEDIA") => new Response(body, { headers: { "content-type": type } });

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      calls.push({ url: url.toString(), headers });
      for (const [re, fn] of routes) if (re.test(url.toString())) return fn(url, init);
      return new Response("not mocked", { status: 404 });
    }),
  );
}

let home: string;
let media: string;
const KEY_VARS = ["PEXELS_API_KEY", "PIXABAY_API_KEY", "UNSPLASH_ACCESS_KEY", "FREESOUND_API_KEY", "JAMENDO_CLIENT_ID"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "oe-media-home-"));
  media = mkdtempSync(join(tmpdir(), "oe-media-lib-"));
  for (const k of [...KEY_VARS, "OPENEDIT_HOME", "OPENEDIT_MEDIA_DIR"]) savedEnv[k] = process.env[k];
  process.env.OPENEDIT_HOME = home;
  process.env.OPENEDIT_MEDIA_DIR = media;
  for (const k of KEY_VARS) process.env[k] = `test-${k.toLowerCase()}`;
  calls.length = 0;
  routes = [];
  installFetch();
  clearSearchCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(media, { recursive: true, force: true });
});

const q = (over: Partial<SearchQuery>): SearchQuery => ({ query: "city night", kind: "video", limit: 10, ...over });
const ctx = { key: "KEY123" };

// ------------------------------------------------------------------------------------------

describe("providers: search + download with mocked APIs", () => {
  it("pexels videos: auth header, best rendition, title from slug, download", async () => {
    routes = [
      [/api\.pexels\.com\/v1\/videos\/search/, () => json(PEXELS_VIDEOS)],
      [/videos\.pexels\.com/, () => bytes("video/mp4")],
    ];
    const res = await pexels.search(q({ orientation: "landscape" }), ctx);
    expect(calls[0].headers.Authorization).toBe("KEY123");
    expect(calls[0].headers["User-Agent"]).toBe(USER_AGENT);
    expect(calls[0].url).toContain("orientation=landscape");
    expect(res[0]).toMatchObject({ id: "3129671", provider: "pexels", title: "Aerial view of city at night", width: 1920, height: 1080, duration: 15, licenseCode: "stock", attributionRequired: false, author: "Pressmaster" });
    expect(res[0].downloadUrl).toContain("hd_1920_1080");
    const path = await pexels.download(res[0], media, "x", {});
    expect(basename(path)).toBe("x.mp4");
    expect(readFileSync(path, "utf8")).toBe("FAKEMEDIA");
  });

  it("pexels photos", async () => {
    routes = [[/api\.pexels\.com\/v1\/search/, () => json(PEXELS_PHOTOS)]];
    const [p] = await pexels.search(q({ kind: "image", query: "golden rocks" }), ctx);
    expect(p).toMatchObject({ kind: "image", title: "Brown Rocks During Golden Hour", width: 3024, downloadUrl: PEXELS_PHOTOS.photos[0].src.original });
  });

  it("pixabay videos + images (key param, scaled image size)", async () => {
    routes = [
      [/pixabay\.com\/api\/videos\//, () => json(PIXABAY_VIDEOS)],
      [/pixabay\.com\/api\/\?/, () => json(PIXABAY_IMAGES)],
      [/cdn\.pixabay\.com|pixabay\.com\/get/, () => bytes("image/jpeg")],
    ];
    const [v] = await pixabay.search(q({ orientation: "portrait" }), ctx);
    expect(calls[0].url).toContain("key=KEY123");
    expect(calls[0].url).toContain("orientation=vertical");
    expect(v).toMatchObject({ id: "125", width: 1920, duration: 12, tags: ["city", "night", "traffic"], author: "Coverr-Free-Footage" });
    expect(v.authorUrl).toBe("https://pixabay.com/users/Coverr-Free-Footage-1281706/");
    const [img] = await pixabay.search(q({ kind: "image", query: "flower" }), ctx);
    expect(img).toMatchObject({ width: 1280, height: 720, downloadUrl: PIXABAY_IMAGES.hits[0].largeImageURL });
    expect(basename(await pixabay.download(img, media, "f", {}))).toBe("f.jpg");
  });

  it("unsplash: Client-ID auth, UTM links, triggers download_location before downloading", async () => {
    routes = [
      [/api\.unsplash\.com\/search\/photos/, () => json(UNSPLASH_SEARCH)],
      [/api\.unsplash\.com\/photos\/.*\/download/, () => json({ url: "https://image.unsplash.com/x" })],
      [/images\.unsplash\.com/, () => bytes("image/jpeg")],
    ];
    const [p] = await unsplash.search(q({ kind: "image", query: "coffee", orientation: "square" }), ctx);
    expect(calls[0].headers.Authorization).toBe("Client-ID KEY123");
    expect(calls[0].url).toContain("orientation=squarish");
    expect(p.authorUrl).toBe("https://unsplash.com/@ugmonk?utm_source=openedit&utm_medium=referral");
    expect(p.attributionText).toContain("Jeff Sheldon");
    calls.length = 0;
    const path = await unsplash.download(p, media, "u", ctx);
    expect(calls[0].url).toContain("/photos/eOLpJytrbsQ/download");
    expect(calls[0].headers.Authorization).toBe("Client-ID KEY123");
    expect(calls[1].url).toContain("images.unsplash.com");
    expect(basename(path)).toBe("u.jpg");
  });

  it("openverse images + audio: commercial filter param, license parsing, ms->s", async () => {
    routes = [
      [/api\.openverse\.org\/v1\/images\//, () => json(OPENVERSE_IMAGES)],
      [/api\.openverse\.org\/v1\/audio\//, () => json(OPENVERSE_AUDIO)],
      [/cdn\.freesound\.org/, () => bytes("audio/mpeg")],
    ];
    const imgs = await openverse.search(q({ kind: "image" }), {});
    expect(calls[0].url).toContain("license_type=commercial%2Cmodification");
    expect(imgs[0]).toMatchObject({ licenseCode: "cc-by", license: "CC BY 2.0", attributionRequired: true, author: "Still Vision" });
    expect(imgs[1].licenseCode).toBe("cc-by-nc");
    const [a] = await openverse.search(q({ kind: "sfx", query: "rain" }), {});
    expect(a.duration).toBeCloseTo(60.116);
    expect(a.kind).toBe("sfx");
    expect(basename(await openverse.download(a, media, "rain", {}))).toBe("rain.mp3");
    await openverse.search({ ...q({ kind: "image" }), allowNonCommercial: true }, {});
    expect(calls.at(-1)!.url).not.toContain("license_type");
  });

  it("wikimedia: extmetadata license/artist, transcode for huge originals", async () => {
    routes = [
      [/commons\.wikimedia\.org\/w\/api\.php/, () => json(WIKIMEDIA)],
      [/upload\.wikimedia\.org/, () => bytes("video/webm")],
    ];
    const res = await wikimedia.search(q({}), {});
    expect(calls[0].url).toContain("filetype%3Avideo");
    expect(calls[0].url).toContain("prop=videoinfo");
    expect(res[0]).toMatchObject({ title: "Ocean Moon Glint and City Night Lights in 4K", licenseCode: "pd", attributionRequired: false, author: "NASA", authorUrl: "https://commons.wikimedia.org/wiki/User:NASA" });
    expect(res[0].tags).toContain("Pacific");
    expect(res[1]).toMatchObject({ licenseCode: "cc-by-sa", attributionRequired: true, width: 1920, author: "Jane Doe" });
    expect(res[1].downloadUrl).toContain("1080p");
    expect(basename(await wikimedia.download(res[0], media, "w", {}))).toBe("w.webm");
  });

  it("nasa: resolves collection.json and prefers ~large.mp4 over https", async () => {
    routes = [
      [/images-api\.nasa\.gov\/search/, () => json(NASA_SEARCH)],
      [/collection\.json/, () => json(NASA_COLLECTION)],
      [/~large\.mp4/, () => bytes("video/mp4")],
    ];
    const [r] = await nasa.search(q({ query: "earth night" }), {});
    expect(r).toMatchObject({ id: "GSFC_EarthAtNight", licenseCode: "pd", author: "NASA GSFC", tags: ["Night", "Earth", "City lights"] });
    const path = await nasa.download(r, media, "n", {});
    expect(calls.at(-1)!.url).toBe("https://images-assets.nasa.gov/video/GSFC_EarthAtNight/GSFC_EarthAtNight~large.mp4");
    expect(basename(path)).toBe("n.mp4");
  });

  it("freesound: Token header, duration filter, HQ mp3 preview, license URL parsing", async () => {
    routes = [
      [/freesound\.org\/apiv2\/search\//, () => json(FREESOUND_SEARCH)],
      [/cdn\.freesound\.org/, () => bytes("audio/mpeg")],
    ];
    const res = await freesound.search(q({ kind: "sfx", query: "whoosh", maxDuration: 3 }), ctx);
    expect(calls[0].headers.Authorization).toBe("Token KEY123");
    expect(decodeURIComponent(calls[0].url).replace(/\+/g, " ")).toContain("duration:[0 TO 3]");
    expect(res[0]).toMatchObject({ title: "Whoosh", licenseCode: "cc0", attributionRequired: false, downloadUrl: "https://cdn.freesound.org/previews/60/60013_hq.mp3" });
    expect(res[1].licenseCode).toBe("cc-by-nc");
    expect(basename(await freesound.download(res[0], media, "s", ctx))).toBe("s.mp3");
  });

  it("jamendo: client_id, NC/ND filters, license from ccurl", async () => {
    routes = [
      [/api\.jamendo\.com\/v3\.0\/tracks/, () => json(JAMENDO_TRACKS)],
      [/storage\.jamendo\.com/, () => bytes("audio/mpeg")],
    ];
    const [t] = await jamendo.search(q({ kind: "music", query: "calm piano", minDuration: 60 }), ctx);
    expect(calls[0].url).toContain("client_id=KEY123");
    expect(calls[0].url).toContain("ccnc=false");
    expect(calls[0].url).toContain("durationbetween=60_3600");
    expect(t).toMatchObject({ title: "Calm Piano Morning", licenseCode: "cc-by", license: "CC BY 3.0", author: "Komiku", duration: 154 });
    expect(t.tags).toContain("piano");
    expect(basename(await jamendo.download(t, media, "m", ctx))).toBe("m.mp3");
  });

  it("jamendo error header surfaces as an error", async () => {
    routes = [[/api\.jamendo\.com/, () => json({ headers: { status: "failed", error_message: "Your credential is not authorized." }, results: [] })]];
    await expect(jamendo.search(q({ kind: "music" }), ctx)).rejects.toThrow(/not authorized/);
  });
});

// ------------------------------------------------------------------------------------------

describe("licenses", () => {
  it("normalizes names, codes and URLs", () => {
    expect(normalizeLicense("CC BY-SA 4.0")).toBe("cc-by-sa");
    expect(normalizeLicense("by-nc-nd")).toBe("cc-by-nc-nd");
    expect(normalizeLicense("Creative Commons 0")).toBe("cc0");
    expect(normalizeLicense("Attribution NonCommercial")).toBe("cc-by-nc");
    expect(normalizeLicense("Attribution")).toBe("cc-by");
    expect(normalizeLicense("https://creativecommons.org/licenses/by/4.0/")).toBe("cc-by");
    expect(normalizeLicense("http://creativecommons.org/publicdomain/zero/1.0/")).toBe("cc0");
    expect(normalizeLicense("pdm")).toBe("pd");
    expect(normalizeLicense("Public domain")).toBe("pd");
    expect(normalizeLicense("GFDL")).toBe("gfdl");
    expect(normalizeLicense("Sampling+")).toBe("unknown");
    expect(isRestricted("cc-by-nd")).toBe(true);
    expect(isRestricted("cc-by-sa")).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------

function mk(over: Partial<MediaResult>): MediaResult {
  return {
    id: Math.random().toString(36).slice(2),
    provider: "openverse",
    kind: "video",
    title: "thing",
    url: "https://example.org/p",
    downloadUrl: `https://example.org/${Math.random()}.mp4`,
    tags: [],
    license: "CC0",
    licenseCode: "cc0",
    attributionRequired: false,
    attributionText: "x",
    ...over,
  };
}

describe("ranking", () => {
  it("stems and scores relevance", () => {
    expect(stem("cities")).toBe("city");
    expect(stem("walking")).toBe("walk");
    expect(stem("waves")).toBe("wave");
    expect(stem("running")).toBe("run");
    expect(relevance("city at night", { title: "Cities by night", tags: [] }).score).toBe(1);
    expect(relevance("city at night", { title: "Beach", tags: ["nightlife"] }).score).toBeGreaterThan(0);
    expect(relevance("city at night", { title: "Beach", tags: ["sand"] }).score).toBe(0);
  });

  it("prefers relevant, high-res, permissive results and explains why", () => {
    const o = { query: "city night", kind: "video" as const, count: 3 };
    const good = mk({ id: "good", provider: "pexels", title: "City at night", width: 1920, height: 1080, duration: 12, licenseCode: "stock", license: "Pexels License" });
    const lowres = mk({ id: "lowres", title: "City at night", width: 640, height: 360, duration: 12 });
    const sa = mk({ id: "sa", provider: "wikimedia", title: "City at night", width: 1920, height: 1080, duration: 12, licenseCode: "cc-by-sa", license: "CC BY-SA 4.0" });
    const offtopic = mk({ id: "off", provider: "pixabay", title: "Cat sleeping", width: 3840, height: 2160, duration: 10, licenseCode: "stock" });
    const { results } = rank([offtopic, sa, lowres, good], o);
    expect(results.map((r) => r.id)).toEqual(["good", "sa", "lowres"]);
    expect(results[0].reason).toContain("matches 2/2 terms");
    expect(results[0].reason).toContain("1920x1080");
    expect(results[0].gid).toBe("pexels:good");
  });

  it("excludes NC/ND unless allowNonCommercial", () => {
    const nc = mk({ id: "nc", title: "city night", licenseCode: "cc-by-nc" });
    const ok = mk({ id: "ok", title: "something", licenseCode: "cc-by" });
    expect(rank([nc, ok], { query: "city night", kind: "image" }).results.map((r) => r.id)).toEqual(["ok"]);
    expect(rank([nc, ok], { query: "city night", kind: "image", allowNonCommercial: true }).results[0].id).toBe("nc");
  });

  it("applies duration range hard filter and orientation preference", () => {
    const long = mk({ id: "long", title: "ocean waves", duration: 120 });
    const fit = mk({ id: "fit", title: "ocean waves", duration: 8 });
    expect(rank([long, fit], { query: "ocean waves", kind: "video", maxDuration: 10 }).results.map((r) => r.id)).toEqual(["fit"]);
    const land = mk({ id: "land", title: "ocean", width: 1920, height: 1080 });
    const port = mk({ id: "port", title: "ocean", width: 1080, height: 1920 });
    expect(rank([land, port], { query: "ocean", kind: "image", orientation: "portrait" }).results[0].id).toBe("port");
  });

  it("diversifies providers when scores are close", () => {
    const a = [1, 2, 3].map((i) => mk({ id: `p${i}`, provider: "pexels", title: "forest", width: 1920, height: 1080, licenseCode: "stock" }));
    const b = mk({ id: "w1", provider: "pixabay", title: "forest", width: 1920, height: 1080, licenseCode: "stock" });
    const { results } = rank([...a, b], { query: "forest", kind: "image", count: 2 });
    expect(new Set(results.map((r) => r.provider)).size).toBe(2);
  });
});

// ------------------------------------------------------------------------------------------

describe("aggregator", () => {
  it("queries providers in parallel, skips missing keys, survives errors and timeouts", async () => {
    delete process.env.PIXABAY_API_KEY;
    routes = [
      [/api\.pexels\.com/, () => json(PEXELS_VIDEOS)],
      [/commons\.wikimedia\.org/, () => new Response("boom", { status: 500 })],
      [/images-api\.nasa\.gov/, () => new Promise<Response>(() => {})], // never resolves
    ];
    const res = await findMedia({ query: "city night", kind: "video", count: 3, timeoutMs: 300 });
    const st = Object.fromEntries(res.providers.map((p) => [p.provider, p.status]));
    expect(st).toEqual({ pexels: "ok", pixabay: "skipped", wikimedia: "error", nasa: "timeout" });
    expect(res.providers.find((p) => p.provider === "pixabay")!.detail).toMatch(/no key.*PIXABAY_API_KEY/);
    expect(res.results[0].gid).toBe("pexels:3129671");
    expect(lookupResult("pexels:3129671")?.title).toBe("Aerial view of city at night");
  });

  it("caches provider responses on disk", async () => {
    routes = [[/api\.pexels\.com/, () => json(PEXELS_VIDEOS)]];
    await findMedia({ query: "city night", kind: "video", providers: ["pexels"] });
    const n = calls.length;
    const again = await findMedia({ query: "city night", kind: "video", providers: ["pexels"] });
    expect(calls.length).toBe(n);
    expect(again.providers[0].status).toBe("cached");
  });

  it("reports providers that do not offer a kind", async () => {
    routes = [[/freesound/, () => json(FREESOUND_SEARCH)]];
    const res = await findMedia({ query: "whoosh", kind: "sfx", providers: ["unsplash", "freesound"] });
    expect(res.providers.find((p) => p.provider === "unsplash")!.detail).toMatch(/does not offer sfx/);
    expect(res.results.map((r) => r.gid)).toEqual(["freesound:60013"]); // NC one filtered
  });
});

// ------------------------------------------------------------------------------------------

describe("downloads + credits", () => {
  it("writes clean names under <root>/<kind>/, dedupes, and records credits", async () => {
    routes = [
      [/api\.openverse\.org\/v1\/images/, () => json(OPENVERSE_IMAGES)],
      [/staticflickr/, () => bytes("image/jpeg")],
    ];
    const [r] = await openverse.search(q({ kind: "image" }), {});
    expect(fileBase(r)).toBe("seattle-city-night-openverse-81fff0fb-f37f-455e-810b");
    const first = await downloadResult(r);
    expect(first.existing).toBe(false);
    expect(first.path).toBe(join(media, "image", "seattle-city-night-openverse-81fff0fb-f37f-455e-810b.jpg"));
    expect(existsSync(first.path)).toBe(true);
    const n = calls.length;
    const second = await downloadResult(r);
    expect(second.existing).toBe(true);
    expect(calls.length).toBe(n);
    const credits = readCredits(media);
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ gid: `openverse:${r.id}`, author: "Still Vision", license: "CC BY 2.0", attributionRequired: true, sourceUrl: r.url });
    const md = readFileSync(join(media, "CREDITS.md"), "utf8");
    expect(md).toContain("Seattle city night");
    expect(md).toContain("attribution required");
  });

  it("downloads into an explicit project dir", async () => {
    routes = [[/cdn\.freesound/, () => bytes("audio/mpeg")]];
    const proj = mkdtempSync(join(tmpdir(), "oe-proj-"));
    const r = mk({ provider: "freesound", id: "60013", kind: "sfx", title: "Whoosh!", downloadUrl: "https://cdn.freesound.org/previews/60/60013_hq.mp3" });
    const out = await downloadResult(r, { dir: proj });
    expect(out.path).toBe(join(proj, "sfx", "whoosh-freesound-60013.mp3"));
    expect(out.note).toMatch(/preview/);
    rmSync(proj, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------------------------------

describe("keys", () => {
  it("parses dotenv text", () => {
    expect(parseEnv('# c\nA=1\nexport B="two words"\nC=x # trailing\nD=   # only comment\nbad line')).toEqual({ A: "1", B: "two words", C: "x", D: "" });
  });

  it("writes ~/.openedit/.env with mode 600, merges, and env wins over file", () => {
    delete process.env.PEXELS_API_KEY;
    delete process.env.FREESOUND_API_KEY;
    const file = writeEnvFile({ PEXELS_API_KEY: "abcd1234efgh5678" });
    expect(file).toBe(join(home, ".env"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeEnvFile({ FREESOUND_API_KEY: "fs" });
    expect(readEnvFile()).toEqual({ PEXELS_API_KEY: "abcd1234efgh5678", FREESOUND_API_KEY: "fs" });
    expect(getKey("PEXELS_API_KEY")).toBe("abcd1234efgh5678");
    process.env.PEXELS_API_KEY = "from-env";
    expect(getKey("PEXELS_API_KEY")).toBe("from-env");
    const st = keyStatus().find((k) => k.env === "FREESOUND_API_KEY")!;
    expect(st).toMatchObject({ set: true, source: "file" });
    expect(maskKey("abcd1234efgh5678")).toBe("abcd********5678");
    writeEnvFile({ FREESOUND_API_KEY: "" });
    expect(readEnvFile()).toEqual({ PEXELS_API_KEY: "abcd1234efgh5678" });
  });

  it("a key in the file enables a provider without env", async () => {
    for (const k of KEY_VARS) delete process.env[k];
    writeFileSync(join(home, ".env"), "PEXELS_API_KEY=filekey\n", { mode: 0o600 });
    routes = [[/api\.pexels\.com/, () => json(PEXELS_PHOTOS)]];
    const res = await findMedia({ query: "rocks", kind: "image", providers: ["pexels", "unsplash"] });
    expect(res.providers.map((p) => `${p.provider}:${p.status}`)).toEqual(["pexels:ok", "unsplash:skipped"]);
    expect(calls[0].headers.Authorization).toBe("filekey");
  });
});
