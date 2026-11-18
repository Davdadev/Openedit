/**
 * Minimal ZIP reader/writer (no dependencies). Reads the central directory of
 * .zip / .mbr (Motion Bro) / .mogrt / .aegraphic archives without loading the
 * whole file, and inflates single entries on demand. Writes small archives
 * (tests, synthetic .mogrt). Not supported: ZIP64, encryption, multi-disk.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  offset: number;
  dir: boolean;
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, b, got, len - got, pos + got);
    if (!n) break;
    got += n;
  }
  return got === len ? b : b.subarray(0, got);
}

/** List the entries of a ZIP archive (central directory only). */
export function listZip(path: string): ZipEntry[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${path} is not a ZIP archive (no end of central directory)`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) throw new Error(`${path}: ZIP64 archives are not supported`);
    const cd = readAt(fd, cdOffset, cdSize);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const sizeU = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const raw = cd.subarray(p + 46, p + 46 + nameLen);
      // Bit 11 = UTF-8 names; most tools write UTF-8 (or plain ASCII) anyway.
      const name = (flags & 0x800 ? raw.toString("utf8") : raw.toString("utf8")).replace(/\\/g, "/");
      out.push({ name, size: sizeU, compressedSize, method, offset, dir: name.endsWith("/") });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/** Read and inflate one entry. `maxBytes` guards against zip bombs. */
export function readZipEntry(path: string, entry: ZipEntry | string, maxBytes = 256 * 1024 * 1024): Buffer {
  const e = typeof entry === "string" ? listZip(path).find((x) => x.name === entry) : entry;
  if (!e) throw new Error(`${path}: no entry ${String(entry)}`);
  if (e.size > maxBytes) throw new Error(`${path}: entry ${e.name} is too large (${e.size} bytes)`);
  const fd = openSync(path, "r");
  try {
    const lh = readAt(fd, e.offset, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`${path}: bad local header for ${e.name}`);
    const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const data = readAt(fd, start, e.compressedSize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(maxBytes, 1) });
    throw new Error(`${path}: unsupported compression method ${e.method} for ${e.name}`);
  } finally {
    closeSync(fd);
  }
}

/** Read an entry of a ZIP held in memory (e.g. a .mogrt inside a .mbr). */
export function listZipBuffer(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    out.push({
      name,
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
      dir: name.endsWith("/"),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

export function readZipBufferEntry(buf: Buffer, name: string, maxBytes = 64 * 1024 * 1024): Buffer | undefined {
  const e = listZipBuffer(buf).find((x) => x.name === name);
  if (!e) return undefined;
  if (e.size > maxBytes) throw new Error(`entry ${name} is too large`);
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  return e.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: Math.max(maxBytes, 1) });
}

/** Build a ZIP archive in memory (deflate, UTF-8 names). */
export function writeZip(files: { name: string; data: Buffer | string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const comp = deflateRawSync(data);
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
