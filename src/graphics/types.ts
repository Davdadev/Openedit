// Shared types for the OpenEdit graphics library (template packs, own HyperFrames
// templates, user / Figma templates) — one uniform schema for every source.

export type ParamType = "text" | "color" | "slider" | "checkbox" | "point" | "dropdown" | "angle" | "number" | "image" | "group";

export interface TemplateParam {
  /** Stable id used in place_graphic params (slug of the display name, unique per template). */
  id: string;
  /** Display name (for .mogrt: the Essential Graphics control name Premiere matches on). */
  name: string;
  type: ParamType;
  default?: unknown;
  min?: number;
  max?: number;
  options?: string[];
  /** Essential Graphics group the control sits in. */
  group?: string;
  /** Text controls: the font the template uses (PostScript name) and its size. */
  font?: string;
  fontSize?: number;
  description?: string;
}

/** Where a template comes from. */
export type TemplateKind =
  | "mogrt" // Premiere Motion Graphics template (After Effects or Premiere authored)
  | "aep" // After Effects project (needs AE; style reference only)
  | "demo" // locked placeholder of a commercial pack (preview only)
  | "hyperframes" // OpenEdit's own HTML templates (templates/)
  | "user"; // made with create_motion_template (Figma / hand-written)

export type GraphicsApp = "premiere" | "resolve" | "standalone" | "aftereffects";

/** A file on disk, or an entry inside an archive (`archive` = the .zip/.mbr path). */
export interface FileRef {
  path: string;
  archive?: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  kind: TemplateKind;
  /** Pack id (imported packs), "openedit" (own templates) or "user". */
  pack: string;
  packName: string;
  category: string;
  /** Hosts it can be placed in natively or after rendering. */
  apps: GraphicsApp[];
  usable: boolean;
  locked?: boolean;
  /** Why it is (not) usable / how it is used. */
  note?: string;
  source?: FileRef;
  preview?: FileRef;
  image?: FileRef;
  /** Cached small thumbnail (<= 320 px wide, jpg) under OPENEDIT_HOME/graphics/thumbs. */
  thumb?: string;
  params: TemplateParam[];
  groups?: { name: string; params: string[] }[];
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  fonts?: string[];
  missingFonts?: string[];
  description?: string;
  tags?: string[];
  /** Own/user templates: folder holding template.json + composition.html. */
  dir?: string;
}

export interface PackRecord {
  id: string;
  name: string;
  author?: string;
  apps?: string;
  source: string;
  type: "folder" | "archive" | "file";
  importedAt: string;
  counts: Record<string, number>;
}

export interface LibraryFile {
  version: 1;
  packs: PackRecord[];
  items: CatalogItem[];
}
