import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { crc32 } from "../../src/documents/zip.ts";
import { decodePng, encodePng, isBlank, PngError } from "../../src/esign/png.ts";
import { PdfBuilder, pdfString, wrap, textWidth } from "../../src/esign/pdf.ts";

function rgba(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(f(x, y), (y * w + x) * 4);
  return b;
}

test("png: round trip of RGBA pixels, split into colour and transparency", () => {
  const px = rgba(7, 5, (x, y) => [x * 30, y * 40, 200, x === y ? 255 : 0]);
  const p = decodePng(encodePng(7, 5, px));
  assert.equal(p.width, 7);
  assert.equal(p.height, 5);
  for (let i = 0; i < 35; i++) {
    assert.deepEqual([...p.rgb.subarray(i * 3, i * 3 + 3)], [...px.subarray(i * 4, i * 4 + 3)]);
    assert.equal(p.alpha![i], px[i * 4 + 3]);
  }
  assert.equal(isBlank(p), false);
  assert.equal(isBlank(decodePng(encodePng(4, 4, rgba(4, 4, () => [0, 0, 0, 0])))), true);
});

test("png: every row filter type decodes (Sub, Up, Average, Paeth)", () => {
  // Build a 3x5 RGB image with one row per filter type, encoded by hand.
  const w = 3;
  const h = 5;
  const img = Buffer.from(Array.from({ length: w * h * 3 }, (_, i) => (i * 37) % 256));
  const bpp = 3;
  const stride = w * bpp;
  const out: number[] = [];
  const at = (x: number, y: number) => (x < 0 || y < 0 ? 0 : img[y * stride + x]);
  for (let y = 0; y < h; y++) {
    const f = y; // 0..4
    out.push(f);
    for (let x = 0; x < stride; x++) {
      const a = at(x - bpp, y), b = at(x, y - 1), c = at(x - bpp, y - 1), v = img[y * stride + x];
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out.push((v - pred + 256) & 0xff);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(out))), chunk("IEND", Buffer.alloc(0))]);
  const p = decodePng(png);
  assert.equal(p.alpha, null);
  assert.deepEqual([...p.rgb], [...img]);
});

test("png: rejects non-PNG, damaged and oversized input", () => {
  const good = encodePng(2, 2, rgba(2, 2, () => [0, 0, 0, 255]));
  assert.throws(() => decodePng(Buffer.from("not a png at all, just some text here....................")), PngError);
  const bad = Buffer.from(good);
  bad[bad.length - 20] ^= 0xff;
  assert.throws(() => decodePng(bad), /damaged|read/);
  assert.throws(() => decodePng(good.subarray(0, good.length - 12)), /incomplete|cut off/);
  assert.throws(() => decodePng(encodePng(3000, 1, Buffer.alloc(12000))), /unusual size/);
});

test("pdf: strings are escaped and mapped to WinAnsi", () => {
  assert.equal(pdfString("a(b)c\\d"), "(a\\(b\\)c\\\\d)");
  assert.equal(pdfString("café — “ok”"), "(caf\\351 \\227 \\223ok\\224)");
  assert.equal(pdfString("日本"), "(??)");
  assert.equal(pdfString("x\ny"), "(x?y)");
});

test("pdf: wrapping keeps every line inside the width and splits long tokens", () => {
  const long = "word ".repeat(80) + "a".repeat(200);
  for (const l of wrap(long, "Helvetica", 10, 300)) assert.ok(textWidth(l, "Helvetica", 10) <= 300, l);
  assert.deepEqual(wrap("one\n\ntwo", "Helvetica", 10, 300), ["one", "", "two"]);
});

test("pdf: the file is well formed (header, xref offsets point at objects, trailer)", () => {
  const pdf = new PdfBuilder({ title: "Test (1)" });
  pdf.heading("Heading");
  for (let i = 0; i < 80; i++) pdf.para(`Line ${i} with some words to fill the page`);
  pdf.image(decodePng(encodePng(10, 4, rgba(10, 4, (x) => [0, 0, 0, x % 2 ? 255 : 0]))), 100, 40);
  const buf = pdf.build(new Date("2026-11-18T12:00:00Z"));
  const s = buf.toString("latin1");
  assert.ok(s.startsWith("%PDF-1.4\n"));
  assert.ok(s.trimEnd().endsWith("%%EOF"));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
  assert.ok(s.slice(startxref).startsWith("xref\n"));
  const [, count] = /xref\n0 (\d+)\n/.exec(s)!;
  const offsets = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, Number(count) - 1);
  offsets.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1}`));
  assert.match(s, /\/Count 3 /); // 80 lines run onto a third page
  assert.match(s, /\/SMask \d+ 0 R/);
  assert.match(s, /\/CreationDate \(D:20261118120000Z\)/);
});
