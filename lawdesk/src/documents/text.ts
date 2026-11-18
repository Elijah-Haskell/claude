// Plain-text extraction for search, plus small XML helpers shared with assembly.

import { MIME } from "./files.ts";
import { readZip } from "./zip.ts";

/** Searchable text is capped so one huge file cannot bloat the index. */
export const MAX_INDEXED_CHARS = 1_000_000;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Characters XML 1.0 does not allow at all (they would make Word refuse the file). */
export function stripXmlInvalid(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "");
}

/** Text of a WordprocessingML part: paragraphs become lines, tabs and breaks are kept. */
export function wordXmlToText(xml: string): string {
  const out = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, "") // field codes are not visible text
    .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, "") // tracked deletions
    .replace(/<[^>]*>/g, "");
  return decodeEntities(out).replace(/\n{3,}/g, "\n\n").trim();
}

export function docxToText(data: Buffer): string {
  const parts = readZip(data, {
    only: (n) => n === "word/document.xml" || /^word\/(header|footer)\d*\.xml$/.test(n) || n === "word/footnotes.xml",
  });
  const order = (n: string) => (n === "word/document.xml" ? 0 : 1);
  parts.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
  return parts.map((p) => wordXmlToText(p.data.toString("utf8"))).filter(Boolean).join("\n\n");
}

export function htmlToText(html: string): string {
  const out = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(out)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text to index for a file, or null when we cannot read this type. Never throws. */
export function extractText(data: Buffer, mime: string): string | null {
  try {
    let text: string | null = null;
    if (mime === MIME.txt || mime === MIME.md || mime === MIME.csv || mime === MIME.eml) text = data.toString("utf8");
    else if (mime === MIME.html) text = htmlToText(data.toString("utf8"));
    else if (mime === MIME.docx) text = docxToText(data);
    if (text === null) return null;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text.length > MAX_INDEXED_CHARS ? text.slice(0, MAX_INDEXED_CHARS) : text;
  } catch {
    return null;
  }
}
