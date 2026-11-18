// Just enough PNG to check a drawn signature and put it in a PDF: 8-bit, non-interlaced,
// RGB or RGBA (what a browser canvas produces). Decoding splits colour and transparency so
// the PDF can use the transparency as a soft mask.

import { deflateSync, inflateSync } from "node:zlib";
import { crc32 } from "../documents/zip.ts";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_PNG_BYTES = 600 * 1024;
export const MAX_PNG_SIDE = 2400;

export class PngError extends Error {
  status = 400;
}

export interface Png {
  width: number;
  height: number;
  rgb: Buffer;
  alpha: Buffer | null;
}

export function decodePng(buf: Buffer): Png {
  if (!Buffer.isBuffer(buf) || buf.length < 45 || !buf.subarray(0, 8).equals(SIG)) throw new PngError("The signature is not a PNG image");
  if (buf.length > MAX_PNG_BYTES) throw new PngError("The signature image is too large");
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  let sawEnd = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (off + 12 + len > buf.length) throw new PngError("The signature image is cut off");
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== crc) throw new PngError("The signature image is damaged");
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new PngError("Unsupported signature image format");
      }
      if (!width || !height || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) throw new PngError("The signature image has an unusual size");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    off += 12 + len;
  }
  if (!width || !idat.length || !sawEnd) throw new PngError("The signature image is incomplete");
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height + 1 });
  } catch {
    throw new PngError("The signature image could not be read");
  }
  if (raw.length !== (stride + 1) * height) throw new PngError("The signature image could not be read");
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y > 0 ? px[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[row - stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new PngError("The signature image could not be read");
      px[row + x] = v & 0xff;
    }
  }
  if (bpp === 3) return { width, height, rgb: px, alpha: null };
  const rgb = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height);
  for (let i = 0, j = 0, k = 0; i < px.length; i += 4, j += 3, k++) {
    rgb[j] = px[i];
    rgb[j + 1] = px[i + 1];
    rgb[j + 2] = px[i + 2];
    alpha[k] = px[i + 3];
  }
  return { width, height, rgb, alpha };
}

/** True when nothing was drawn (every pixel transparent, or every pixel white). */
export function isBlank(p: Png): boolean {
  if (p.alpha) return !p.alpha.some((a) => a > 16);
  for (let i = 0; i < p.rgb.length; i++) if (p.rgb[i] < 240) return false;
  return true;
}

/** Encode RGBA pixels as a PNG (used by tests and for a typed-signature placeholder). */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
