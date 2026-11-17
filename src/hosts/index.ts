import { PremiereHost } from "./premiere.js";
import { ResolveHost } from "./resolve.js";
import { StandaloneHost } from "./standalone.js";
import type { EditorHost, HostName } from "./types.js";

export { PremiereHost, ResolveHost, StandaloneHost };
export * from "./types.js";

const instances = new Map<HostName, EditorHost>();
let active: EditorHost | null = null;

/** Get (and memoise) the adapter for a host. */
export function getHost(name: HostName): EditorHost {
  let h = instances.get(name);
  if (!h) {
    if (name === "premiere") h = new PremiereHost();
    else if (name === "resolve") h = new ResolveHost();
    else if (name === "standalone") h = new StandaloneHost();
    else throw new Error(`Unknown host "${name as string}" (expected premiere, resolve or standalone)`);
    instances.set(name, h);
  }
  return h;
}

export interface DetectResult {
  host: EditorHost;
  tried: { host: HostName; connected: boolean; detail?: string }[];
}

/**
 * Pick the editor to drive: Premiere if its panel answers /health, else
 * Resolve if the bridge reports connected, else standalone ffmpeg.
 * OPENEDIT_HOST forces a host.
 */
export async function autoDetect(): Promise<DetectResult> {
  const forced = process.env.OPENEDIT_HOST as HostName | undefined;
  if (forced) return { host: getHost(forced), tried: [{ host: forced, connected: true, detail: "forced by OPENEDIT_HOST" }] };
  const tried: DetectResult["tried"] = [];

  const premiere = getHost("premiere") as PremiereHost;
  const pOk = await premiere.health();
  tried.push({ host: "premiere", connected: pOk, detail: pOk ? undefined : "panel not answering" });
  if (pOk) return { host: premiere, tried };

  if (process.env.OPENEDIT_SKIP_RESOLVE !== "1") {
    const resolve = getHost("resolve") as ResolveHost;
    const st = await resolve.status(15_000);
    tried.push({ host: "resolve", connected: st.connected, detail: st.detail });
    if (st.connected) return { host: resolve, tried };
  }

  tried.push({ host: "standalone", connected: true });
  return { host: getHost("standalone"), tried };
}

/** The host tools act on: the one selected with setActiveHost, or auto-detected on first use. */
export async function activeHost(): Promise<EditorHost> {
  if (!active) active = (await autoDetect()).host;
  return active;
}

export function setActiveHost(name: HostName): EditorHost {
  active = getHost(name);
  return active;
}

export function currentHostName(): HostName | null {
  return active?.name ?? null;
}
