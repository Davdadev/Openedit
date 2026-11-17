import type { CaptionCue } from "./hosts/types.js";

/** API of src/motion (HyperFrames motion graphics), typed locally so the core builds without it. */
export interface MotionModule {
  listTemplates(): { id: string; description: string; params: Record<string, string> }[];
  renderTemplate(o: {
    template: string;
    params: Record<string, unknown>;
    output: string;
    width?: number;
    height?: number;
    fps?: number;
    duration?: number;
  }): Promise<{ output: string }>;
  renderCaptionOverlay(o: {
    cues: CaptionCue[];
    style?: string;
    output: string;
    width: number;
    height: number;
    fps: number;
  }): Promise<{ output: string }>;
}

let cached: MotionModule | null = null;

/** Load the motion module lazily; throws a clear error if it is not installed/built. */
export async function loadMotion(): Promise<MotionModule> {
  if (cached) return cached;
  const specifier = "./motion/index.js";
  try {
    cached = (await import(specifier)) as MotionModule;
    return cached;
  } catch (e) {
    throw new Error(`Motion graphics module unavailable (${(e as Error).message}).`);
  }
}
