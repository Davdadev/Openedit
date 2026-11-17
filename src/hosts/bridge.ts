import { randomBytes } from "node:crypto";
import type { BridgeCommand, BridgeResponse } from "./types.js";

export function newRequestId(): string {
  return randomBytes(6).toString("hex");
}

/** Unwrap a bridge response, turning ok:false into a thrown Error (message kept verbatim). */
export function unwrap<T>(res: BridgeResponse, cmd: BridgeCommand): T {
  if (!res || typeof res !== "object" || !("ok" in res)) throw new Error(`Malformed bridge response to ${cmd}`);
  if (res.ok) return res.result as T;
  throw new Error(res.error || `${cmd} failed`);
}
