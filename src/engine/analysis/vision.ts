/**
 * macOS Vision helper for shot analysis (same pattern as reframe.ts' face helper):
 * a small Swift program compiled once to OPENEDIT_HOME/bin and cached by source version.
 *
 * Modes (all print JSON lines on stdout):
 *   analyze <list.txt>        per image: labels (VNClassifyImageRequest), feature print
 *                             (VNGenerateImageFeaturePrintRequest), faces, attention saliency
 *                             (8x8 grid + box), Laplacian sharpness, 8x8 edge-energy grid.
 *   mouths <dir>              per JPEG: faces with mouth openness (face landmarks).
 *   sheet <spec.json> <out>   compose a labelled contact sheet (CoreGraphics + CoreText).
 *
 * Images are processed concurrently (Vision requests are per-handler, thread safe).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, runWithSignal } from "../exec.js";
import { paths } from "../paths.js";

const SWIFT_SOURCE = String.raw`// openedit-vision: shot-analysis helper for OpenEdit (macOS Vision). Prints JSON lines.
import Foundation
import Vision
import ImageIO
import CoreGraphics
import CoreText
import UniformTypeIdentifiers

func emit(_ obj: [String: Any]) -> String {
  if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) { return s }
  return "{}"
}
func r3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
func r2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

func loadImage(_ path: String) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// Grayscale pixels (w x h, 0..255) of an image scaled to at most maxW wide.
func grayPixels(_ img: CGImage, maxW: Int) -> ([Float], Int, Int) {
  let scale = min(1.0, Double(maxW) / Double(img.width))
  let w = max(8, Int(Double(img.width) * scale)), h = max(8, Int(Double(img.height) * scale))
  var buf = [UInt8](repeating: 0, count: w * h)
  let cs = CGColorSpaceCreateDeviceGray()
  buf.withUnsafeMutableBytes { raw in
    if let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: cs, bitmapInfo: CGImageAlphaInfo.none.rawValue) {
      ctx.interpolationQuality = .medium
      ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
  }
  return (buf.map { Float($0) }, w, h)
}

/// Variance of the 4-neighbour Laplacian (focus measure) and an 8x8 Sobel edge-energy grid.
func sharpnessAndEdges(_ img: CGImage) -> (Double, [Double]) {
  let (g, w, h) = grayPixels(img, maxW: 320)
  var sum = 0.0, sum2 = 0.0, n = 0.0
  var grid = [Double](repeating: 0, count: 64)
  for y in 1..<(h - 1) {
    for x in 1..<(w - 1) {
      let i = y * w + x
      let lap = Double(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w])
      sum += lap; sum2 += lap * lap; n += 1
      let gx = Double(g[i + 1] - g[i - 1]), gy = Double(g[i + w] - g[i - w])
      let gy8 = min(7, y * 8 / h), gx8 = min(7, x * 8 / w)
      grid[gy8 * 8 + gx8] += (gx * gx + gy * gy).squareRoot()
    }
  }
  let mean = sum / max(1, n)
  let variance = sum2 / max(1, n) - mean * mean
  let cell = Double(w * h) / 64.0
  return (variance, grid.map { r2($0 / cell) })
}

func analyze(_ path: String) -> String {
  var row: [String: Any] = ["file": path]
  guard let img = loadImage(path) else { row["error"] = "unreadable"; return emit(row) }
  let handler = VNImageRequestHandler(cgImage: img, options: [:])
  let classify = VNClassifyImageRequest()
  let print = VNGenerateImageFeaturePrintRequest()
  let faces = VNDetectFaceRectanglesRequest()
  let saliency = VNGenerateAttentionBasedSaliencyImageRequest()
  try? handler.perform([classify, print, faces, saliency])
  if let res = classify.results {
    let top = res.filter { $0.confidence >= 0.08 }.sorted { $0.confidence > $1.confidence }.prefix(10)
    row["labels"] = top.map { [$0.identifier, r3(Double($0.confidence))] }
  }
  if let fp = print.results?.first {
    var v: [Double] = []
    let n = fp.elementCount
    fp.data.withUnsafeBytes { raw in
      if fp.elementType == .float {
        let p = raw.bindMemory(to: Float.self)
        for i in 0..<n { v.append(Double(p[i])) }
      } else if fp.elementType == .double {
        let p = raw.bindMemory(to: Double.self)
        for i in 0..<n { v.append(p[i]) }
      }
    }
    // L2-normalise and quantise (keeps caches small; cosine similarity is all we need).
    let norm = max(1e-9, v.reduce(0) { $0 + $1 * $1 }.squareRoot())
    row["fp"] = v.map { r3($0 / norm * 16) }
  }
  row["faces"] = (faces.results ?? []).map { o -> [Double] in
    let b = o.boundingBox
    return [r3(Double(b.origin.x)), r3(Double(1 - b.origin.y - b.size.height)), r3(Double(b.size.width)), r3(Double(b.size.height)), r3(Double(o.confidence))]
  }
  if let s = saliency.results?.first {
    let pb = s.pixelBuffer
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), stride = CVPixelBufferGetBytesPerRow(pb) / 4
    var grid = [Double](repeating: 0, count: 64)
    if let base = CVPixelBufferGetBaseAddress(pb) {
      let p = base.assumingMemoryBound(to: Float.self)
      for y in 0..<h { for x in 0..<w { grid[min(7, y * 8 / h) * 8 + min(7, x * 8 / w)] += Double(p[y * stride + x]) } }
    }
    CVPixelBufferUnlockBaseAddress(pb, .readOnly)
    let cell = Double(w * h) / 64.0
    row["sal"] = grid.map { r3($0 / cell) }
    if let obj = s.salientObjects?.first {
      let b = obj.boundingBox
      row["salBox"] = [r3(Double(b.origin.x)), r3(Double(1 - b.origin.y - b.size.height)), r3(Double(b.size.width)), r3(Double(b.size.height))]
    }
  }
  let (sharp, edges) = sharpnessAndEdges(img)
  row["sharp"] = r2(sharp)
  row["edges"] = edges
  return emit(row)
}

func mouths(_ path: String) -> String {
  var row: [String: Any] = ["file": (path as NSString).lastPathComponent]
  guard let img = loadImage(path) else { row["faces"] = []; return emit(row) }
  let handler = VNImageRequestHandler(cgImage: img, options: [:])
  let req = VNDetectFaceLandmarksRequest()
  try? handler.perform([req])
  row["faces"] = (req.results ?? []).map { o -> [Double] in
    let b = o.boundingBox
    var open = -1.0
    if let lips = o.landmarks?.innerLips?.normalizedPoints, lips.count >= 4 {
      let ys = lips.map { Double($0.y) }, xs = lips.map { Double($0.x) }
      let hgt = (ys.max()! - ys.min()!), wid = max(1e-3, xs.max()! - xs.min()!)
      open = hgt / wid
    }
    return [r3(Double(b.origin.x)), r3(Double(1 - b.origin.y - b.size.height)), r3(Double(b.size.width)), r3(Double(b.size.height)), r3(open)]
  }
  return emit(row)
}

func runConcurrent(_ files: [String], _ fn: @escaping (String) -> String) {
  var out = [String](repeating: "", count: files.count)
  let lock = NSLock()
  DispatchQueue.concurrentPerform(iterations: files.count) { i in
    autoreleasepool {
      let s = fn(files[i])
      lock.lock(); out[i] = s; lock.unlock()
    }
  }
  for s in out { Swift.print(s) }
}

/// spec: {"cols":6, "tileW":320, "tileH":180, "bg":"#111", "tiles":[{"file":..., "label":..., "sub":..., "color":"#ff8800"}], "title":"..."}
func sheet(_ specPath: String, _ outPath: String) {
  guard let data = FileManager.default.contents(atPath: specPath),
        let spec = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let tiles = spec["tiles"] as? [[String: Any]] else { FileHandle.standardError.write("bad spec\n".data(using: .utf8)!); exit(3) }
  let cols = max(1, spec["cols"] as? Int ?? 6)
  let tw = spec["tileW"] as? Int ?? 320, th = spec["tileH"] as? Int ?? 180
  let labelH = 34, pad = 6
  let titleH = (spec["title"] as? String) != nil ? 30 : 0
  let rows = max(1, (tiles.count + cols - 1) / cols)
  let W = cols * (tw + pad) + pad, H = titleH + rows * (th + labelH + pad) + pad
  let cs = CGColorSpaceCreateDeviceRGB()
  guard let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(4) }
  ctx.setFillColor(CGColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
  func hex(_ s: String?) -> CGColor {
    guard var h = s, h.hasPrefix("#") else { return CGColor(red: 1, green: 1, blue: 1, alpha: 1) }
    h.removeFirst()
    let v = Int(h, radix: 16) ?? 0xffffff
    return CGColor(red: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
  }
  func text(_ s: String, _ x: Int, _ yTop: Int, _ size: CGFloat, _ color: CGColor, maxW: Int) {
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
    let attrs: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color]
    var str = s
    var line = CTLineCreateWithAttributedString(NSAttributedString(string: str, attributes: attrs))
    while CTLineGetTypographicBounds(line, nil, nil, nil) > Double(maxW) && str.count > 4 {
      str = String(str.dropLast(2)) + "…"
      line = CTLineCreateWithAttributedString(NSAttributedString(string: str, attributes: attrs))
    }
    ctx.textPosition = CGPoint(x: x, y: H - yTop - Int(size))
    CTLineDraw(line, ctx)
  }
  if let title = spec["title"] as? String { text(title, pad, 6, 18, CGColor(red: 1, green: 1, blue: 1, alpha: 1), maxW: W - 2 * pad) }
  for (i, t) in tiles.enumerated() {
    let c = i % cols, r = i / cols
    let x = pad + c * (tw + pad), yTop = titleH + pad + r * (th + labelH + pad)
    if let f = t["file"] as? String, let img = loadImage(f) {
      // Aspect-fit inside the tile.
      let s = min(Double(tw) / Double(img.width), Double(th) / Double(img.height))
      let dw = Double(img.width) * s, dh = Double(img.height) * s
      let dx = Double(x) + (Double(tw) - dw) / 2, dyTop = Double(yTop) + (Double(th) - dh) / 2
      ctx.draw(img, in: CGRect(x: dx, y: Double(H) - dyTop - dh, width: dw, height: dh))
    }
    if let col = t["color"] as? String {
      ctx.setFillColor(hex(col))
      ctx.fill(CGRect(x: x, y: H - yTop - th - 4, width: tw, height: 4))
    }
    if let l = t["label"] as? String { text(l, x + 2, yTop + th + 5, 13, CGColor(red: 1, green: 1, blue: 1, alpha: 1), maxW: tw - 4) }
    if let s2 = t["sub"] as? String { text(s2, x + 2, yTop + th + 20, 11, CGColor(red: 0.75, green: 0.75, blue: 0.75, alpha: 1), maxW: tw - 4) }
  }
  guard let out = ctx.makeImage(), let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { exit(5) }
  CGImageDestinationAddImage(dest, out, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
  if !CGImageDestinationFinalize(dest) { exit(6) }
  Swift.print(emit(["ok": true, "file": outPath, "width": W, "height": H]))
}

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write("usage: openedit-vision analyze <list>|mouths <dir>|sheet <spec> <out>\n".data(using: .utf8)!); exit(2) }
switch args[1] {
case "analyze":
  let list = (try? String(contentsOfFile: args[2], encoding: .utf8)) ?? ""
  runConcurrent(list.split(separator: "\n").map(String.init).filter { !$0.isEmpty }, analyze)
case "mouths":
  let dir = URL(fileURLWithPath: args[2])
  let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".jpg") }.sorted().map { dir.appendingPathComponent($0).path }
  runConcurrent(files, mouths)
case "sheet":
  guard args.count >= 4 else { exit(2) }
  sheet(args[2], args[3])
default:
  exit(2)
}
`;

const VERSION = "3";

export interface VisionFrame {
  file: string;
  labels?: [string, number][];
  /** L2-normalised feature print scaled by 16, 3 decimals. */
  fp?: number[];
  /** [x, y, w, h, conf] normalised, origin top-left. */
  faces?: number[][];
  /** 8x8 attention saliency grid (row-major, top row first). */
  sal?: number[];
  salBox?: number[];
  sharp?: number;
  /** 8x8 Sobel edge-energy grid. */
  edges?: number[];
  error?: string;
}

let helper: Promise<{ cmd: string; args: string[] } | null> | null = null;

/** The Vision helper command (compiled on first use), or null when unavailable (non-macOS, no Swift). */
export function visionHelper(): Promise<{ cmd: string; args: string[] } | null> {
  if (!helper) helper = runWithSignal(undefined, () => build());
  return helper;
}

async function build(): Promise<{ cmd: string; args: string[] } | null> {
  if (process.platform !== "darwin" || process.env.OPENEDIT_NO_VISION === "1") return null;
  const binDir = join(paths.home(), "bin");
  mkdirSync(binDir, { recursive: true });
  const src = join(binDir, `openedit-vision-v${VERSION}.swift`);
  const bin = join(binDir, `openedit-vision-v${VERSION}`);
  if (!existsSync(src) || readFileSync(src, "utf8") !== SWIFT_SOURCE) writeFileSync(src, SWIFT_SOURCE);
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return { cmd: bin, args: [] };
  try {
    await run("swiftc", ["-O", "-o", bin, src], { timeoutMs: 300_000 });
    if (existsSync(bin)) return { cmd: bin, args: [] };
  } catch (e) {
    process.stderr.write(`openedit: could not compile the Vision helper: ${(e as Error).message.split("\n").slice(0, 6).join(" ")}\n`);
  }
  return null;
}

/** Run Vision analysis on a list of images. Returns null when Vision is unavailable. */
export async function visionAnalyze(files: string[], listDir: string): Promise<Map<string, VisionFrame> | null> {
  const h = await visionHelper();
  if (!h) return null;
  const out = new Map<string, VisionFrame>();
  if (!files.length) return out;
  const list = join(listDir, `vision-list-${process.pid}-${Date.now()}.txt`);
  writeFileSync(list, files.join("\n"));
  const { stdout } = await run(h.cmd, [...h.args, "analyze", list], { timeoutMs: 60 * 60_000 });
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const row = JSON.parse(line) as VisionFrame;
    out.set(row.file, row);
  }
  return out;
}

/** Faces with mouth openness for every JPEG in `dir` (sorted by name). */
export async function visionMouths(dir: string): Promise<{ file: string; faces: number[][] }[] | null> {
  const h = await visionHelper();
  if (!h) return null;
  const { stdout } = await run(h.cmd, [...h.args, "mouths", dir], { timeoutMs: 60 * 60_000 });
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as { file: string; faces: number[][] });
}

export interface SheetTile {
  file: string;
  label?: string;
  sub?: string;
  /** Accent bar colour "#rrggbb". */
  color?: string;
}

/**
 * Compose a labelled contact sheet JPEG. Uses the Vision helper (CoreText labels) on macOS,
 * else ffmpeg's tile filter (no labels; the caller's text legend carries them).
 */
export async function composeSheet(tiles: SheetTile[], out: string, o: { cols?: number; tileW?: number; tileH?: number; title?: string } = {}): Promise<string> {
  const cols = o.cols ?? Math.min(6, Math.max(1, tiles.length));
  const tileW = o.tileW ?? 320;
  const tileH = o.tileH ?? 180;
  const h = await visionHelper();
  if (h) {
    const spec = `${out}.spec.json`;
    writeFileSync(spec, JSON.stringify({ cols, tileW, tileH, title: o.title, tiles }));
    try {
      await run(h.cmd, [...h.args, "sheet", spec, out], { timeoutMs: 120_000 });
      return out;
    } finally {
      try {
        (await import("node:fs")).rmSync(spec, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  const rows = Math.ceil(tiles.length / cols);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const t of tiles) args.push("-i", t.file);
  const scaled = tiles.map((_, i) => `[${i}:v]scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2,setsar=1[t${i}]`);
  const pads = rows * cols - tiles.length;
  for (let i = 0; i < pads; i++) scaled.push(`color=c=0x111111:s=${tileW}x${tileH}:d=0.04[p${i}]`);
  const inputs = tiles.map((_, i) => `[t${i}]`).join("") + Array.from({ length: pads }, (_, i) => `[p${i}]`).join("");
  const graph = `${scaled.join(";")};${inputs}concat=n=${rows * cols}:v=1:a=0,tile=${cols}x${rows}:padding=4:margin=4:color=0x111111[o]`;
  await run("ffmpeg", [...args, "-filter_complex", graph, "-map", "[o]", "-frames:v", "1", "-q:v", "4", out], { timeoutMs: 120_000 });
  return out;
}
