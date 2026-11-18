// A small PDF writer: US Letter pages, the standard Type 1 fonts (no embedding needed),
// lines, wrapped text and PNG images with transparency. Enough for a certificate.

import { deflateSync } from "node:zlib";
import type { Png } from "./png.ts";

export type FontName = "Helvetica" | "Helvetica-Bold" | "Times-Roman" | "Times-Bold" | "Times-Italic";
const FONTS: FontName[] = ["Helvetica", "Helvetica-Bold", "Times-Roman", "Times-Bold", "Times-Italic"];

export const PAGE_W = 612;
export const PAGE_H = 792;

// WinAnsi codes for common punctuation outside Latin-1.
const WIN: Record<string, number> = { "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "…": 0x85, "€": 0x80 };

/** Encode text as a PDF literal string in WinAnsi; characters it can't show become "?". */
export function pdfString(s: string): string {
  let out = "(";
  for (const ch of s) {
    let code = WIN[ch] ?? ch.codePointAt(0)!;
    if (code > 0xff || (code < 0x20 && code !== 0x09)) code = 0x3f;
    if (code === 0x09) code = 0x20;
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += "\\" + String.fromCharCode(code);
    else if (code < 0x7f) out += String.fromCharCode(code);
    else out += "\\" + code.toString(8).padStart(3, "0");
  }
  return out + ")";
}

/** Rough text width. Generous so wrapped lines never run past the margin. */
export function textWidth(s: string, font: FontName, size: number): number {
  const avg = font.startsWith("Helvetica") ? (font.endsWith("Bold") ? 0.58 : 0.53) : font === "Times-Bold" ? 0.52 : 0.48;
  let w = 0;
  for (const ch of s) w += ch === " " ? 0.28 : /[ilI.,:;'|!]/.test(ch) ? 0.3 : /[mwMW@]/.test(ch) ? 0.86 : /[A-Z0-9]/.test(ch) ? avg + 0.12 : avg;
  return w * size;
}

export function wrap(text: string, font: FontName, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of String(text).split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      // Break a single over-long token (a hash, a user agent) across lines.
      let w = word;
      while (textWidth(w, font, size) > maxWidth) {
        let n = w.length;
        while (n > 1 && textWidth(w.slice(0, n), font, size) > maxWidth) n--;
        if (line) (lines.push(line), (line = ""));
        lines.push(w.slice(0, n));
        w = w.slice(n);
      }
      const next = line ? `${line} ${w}` : w;
      if (textWidth(next, font, size) > maxWidth && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

interface Image {
  png: Png;
}

export class PdfBuilder {
  private pages: string[][] = [];
  private images: Image[] = [];
  private cur: string[] = [];
  readonly margin = 60;
  y = 0;
  private title: string;
  private footer: (n: number, total: number) => string;

  constructor(opts: { title: string; footer?: (n: number, total: number) => string }) {
    this.title = opts.title;
    this.footer = opts.footer ?? ((n, t) => `Page ${n} of ${t}`);
    this.newPage();
  }

  newPage() {
    this.cur = [];
    this.pages.push(this.cur);
    this.y = PAGE_H - this.margin;
  }

  private ensure(h: number) {
    if (this.y - h < this.margin + 24) this.newPage();
  }

  text(x: number, y: number, s: string, font: FontName = "Helvetica", size = 10, gray = 0) {
    const f = FONTS.indexOf(font) + 1;
    this.cur.push(`BT ${gray} g /F${f} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(s)} Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, gray = 0.7) {
    this.cur.push(`${gray} G ${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
  }

  /** Wrapped paragraph at the cursor; moves the cursor down. */
  para(s: string, opts: { font?: FontName; size?: number; indent?: number; gap?: number; gray?: number; width?: number } = {}) {
    const font = opts.font ?? "Helvetica";
    const size = opts.size ?? 10;
    const x = this.margin + (opts.indent ?? 0);
    const width = opts.width ?? PAGE_W - this.margin - x;
    const lh = size * 1.35;
    for (const l of wrap(s, font, size, width)) {
      this.ensure(lh);
      this.y -= lh;
      this.text(x, this.y, l, font, size, opts.gray ?? 0);
    }
    this.y -= opts.gap ?? 4;
  }

  heading(s: string, size = 13) {
    this.ensure(size * 3);
    this.y -= 10;
    this.para(s, { font: "Times-Bold", size, gap: 2 });
    this.line(this.margin, this.y, PAGE_W - this.margin, this.y, 0.6, 0.55);
    this.y -= 6;
  }

  /** Label / value rows, label in a fixed column. */
  field(label: string, value: string, labelWidth = 150) {
    const size = 9.5;
    const lh = size * 1.35;
    const lines = wrap(value || "—", "Helvetica", size, PAGE_W - this.margin * 2 - labelWidth);
    this.ensure(lh * Math.min(lines.length, 3));
    let first = true;
    for (const l of lines) {
      this.ensure(lh);
      this.y -= lh;
      if (first) this.text(this.margin, this.y, label, "Helvetica-Bold", size, 0.25);
      this.text(this.margin + labelWidth, this.y, l, "Helvetica", size);
      first = false;
    }
    this.y -= 3;
  }

  image(png: Png, maxW: number, maxH: number, x = this.margin) {
    const scale = Math.min(maxW / png.width, maxH / png.height, 1);
    const w = png.width * scale;
    const h = png.height * scale;
    this.ensure(h + 8);
    this.y -= h + 4;
    this.images.push({ png });
    this.cur.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${this.y.toFixed(2)} cm /Im${this.images.length} Do Q`);
    this.y -= 4;
  }

  build(created: Date = new Date()): Buffer {
    const objs: (string | Buffer)[] = [];
    const add = (o: string | Buffer) => (objs.push(o), objs.length);
    const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);

    const catalog = add("");
    const pagesObj = add("");
    const fontIds = FONTS.map((f) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`));
    const imageIds = this.images.map(({ png }) => {
      const smask = png.alpha
        ? add(stream(`/Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(png.alpha)))
        : 0;
      return add(
        stream(
          `/Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask ? ` /SMask ${smask} 0 R` : ""}`,
          deflateSync(png.rgb),
        ),
      );
    });
    const fontDict = FONTS.map((_, i) => `/F${i + 1} ${fontIds[i]} 0 R`).join(" ");
    const xobj = imageIds.length ? `/XObject << ${imageIds.map((id, i) => `/Im${i + 1} ${id} 0 R`).join(" ")} >>` : "";
    const total = this.pages.length;
    const pageIds = this.pages.map((ops, i) => {
      const foot = `BT 0.45 g /F1 8 Tf ${this.margin} 34 Td ${pdfString(this.footer(i + 1, total))} Tj ET`;
      const content = add(stream("/Filter /FlateDecode", deflateSync(Buffer.from([...ops, foot].join("\n"), "latin1"))));
      return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << ${fontDict} >> ${xobj} >> /Contents ${content} 0 R >>`);
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    const d = created.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const info = add(`<< /Title ${pdfString(this.title)} /Producer (Lawdesk) /CreationDate (D:${d}Z) >>`);

    const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let pos = parts[0].length;
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(pos);
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), Buffer.isBuffer(o) ? o : Buffer.from(o, "latin1"), Buffer.from("\nendobj\n", "latin1")]);
      parts.push(b);
      pos += b.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
    return Buffer.concat(parts);
  }
}
