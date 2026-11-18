// A minimal ZIP reader and writer over node:zlib, enough for .docx/.xlsx files.
// Supports stored (0) and deflated (8) entries. No ZIP64, no encryption, no multi-disk.

import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export class ZipError extends Error {}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Total uncompressed bytes we are willing to expand from one archive (zip-bomb guard). */
export const DEFAULT_MAX_UNZIPPED = 200 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** True when the buffer starts like a ZIP archive. */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL;
}

function findEocd(buf: Buffer): number {
  // The EOCD record is 22 bytes plus a comment of up to 65535 bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError("Not a ZIP file (no end-of-central-directory record)");
}

interface CentralRecord {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compSize: number;
  size: number;
  localOffset: number;
}

function centralDirectory(buf: Buffer): CentralRecord[] {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
  if (cdOffset + cdSize > eocd) throw new ZipError("Corrupt ZIP: central directory out of range");
  const out: CentralRecord[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError("Corrupt ZIP: bad central directory entry");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("ZIP64 archives are not supported");
    }
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    out.push({ name, method, flags, crc, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** List entry names without decompressing anything. */
export function zipEntryNames(buf: Buffer): string[] {
  return centralDirectory(buf).map((r) => r.name);
}

/**
 * Read a ZIP archive. `only` limits which entries are decompressed (the rest are skipped).
 * CRCs are checked. Throws ZipError on anything unexpected.
 */
export function readZip(buf: Buffer, opts: { only?: (name: string) => boolean; maxTotal?: number } = {}): ZipEntry[] {
  const maxTotal = opts.maxTotal ?? DEFAULT_MAX_UNZIPPED;
  let total = 0;
  const out: ZipEntry[] = [];
  for (const r of centralDirectory(buf)) {
    if (opts.only && !opts.only(r.name)) continue;
    if (r.flags & 0x1) throw new ZipError("Encrypted ZIP entries are not supported");
    const lp = r.localOffset;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== SIG_LOCAL) throw new ZipError(`Corrupt ZIP: bad local header for ${r.name}`);
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    if (start + r.compSize > buf.length) throw new ZipError(`Corrupt ZIP: ${r.name} runs past the end of the file`);
    const raw = buf.subarray(start, start + r.compSize);
    total += r.size;
    if (total > maxTotal) throw new ZipError("ZIP expands to more data than allowed");
    let data: Buffer;
    if (r.method === 0) data = Buffer.from(raw);
    else if (r.method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(r.size, 1) });
      } catch (e) {
        throw new ZipError(`Corrupt ZIP: cannot inflate ${r.name}`);
      }
    } else throw new ZipError(`Unsupported ZIP compression method ${r.method} for ${r.name}`);
    if (data.length !== r.size) throw new ZipError(`Corrupt ZIP: size mismatch for ${r.name}`);
    if (crc32(data) !== r.crc) throw new ZipError(`Corrupt ZIP: CRC mismatch for ${r.name}`);
    out.push({ name: r.name, data });
  }
  return out;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Write entries (in the given order) to a ZIP archive. Entries are deflated unless that would not help. */
export function writeZip(entries: ZipEntry[], opts: { date?: Date } = {}): Buffer {
  const { time, date } = dosDateTime(opts.date ?? new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const e of entries) {
    if (!e.name || e.name.startsWith("/") || e.name.split("/").includes("..")) throw new ZipError(`Bad ZIP entry name ${e.name}`);
    if (seen.has(e.name)) throw new ZipError(`Duplicate ZIP entry ${e.name}`);
    seen.add(e.name);
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    let method = 8;
    let body = deflateRawSync(e.data);
    if (body.length >= e.data.length) {
      method = 0;
      body = e.data;
    }
    if (offset > 0xffffffff || body.length > 0xffffffff) throw new ZipError("Archive too large (ZIP64 not supported)");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    // extra len, comment len, disk start, internal attrs, external attrs: all 0
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  if (entries.length > 0xfffe) throw new ZipError("Too many entries (ZIP64 not supported)");
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
