import type { MediaKind, MediaProvider, ProviderId } from "../types.js";
import { freesound } from "./freesound.js";
import { jamendo } from "./jamendo.js";
import { nasa } from "./nasa.js";
import { openverse } from "./openverse.js";
import { pexels } from "./pexels.js";
import { pixabay } from "./pixabay.js";
import { unsplash } from "./unsplash.js";
import { wikimedia } from "./wikimedia.js";

/** All providers, roughly in order of typical quality for their kinds. */
export const PROVIDERS: MediaProvider[] = [pexels, pixabay, unsplash, freesound, jamendo, openverse, wikimedia, nasa];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id) as [ProviderId, ...ProviderId[]];

export function getProvider(id: string): MediaProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function providersFor(kind: MediaKind): MediaProvider[] {
  return PROVIDERS.filter((p) => p.kinds.includes(kind));
}

export { freesound, jamendo, nasa, openverse, pexels, pixabay, unsplash, wikimedia };
