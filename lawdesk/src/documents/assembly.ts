// Document assembly: fill {{merge.fields}} in .docx, .txt and .html templates.
//
// Template language
//   {{client.name}}                    a value (missing values render empty and are reported)
//   {{matter.dates.closing_date|long}} a value through a filter: long (date as "November 18, 2026"),
//                                      upper, lower
//   {{#if field}} ... {{else}} ... {{/if}}   kept when the field has a non-empty value;
//   {{#if not field}} ... {{/if}}            nesting is allowed
// A block tag that is alone on its line (or alone in its Word paragraph) takes the line with it,
// so templates do not leave blank lines behind.

import { EngineError } from "../engine.ts";
import { escapeHtml, escapeXml, decodeEntities, stripXmlInvalid } from "./text.ts";
import { readZip, writeZip } from "./zip.ts";

export type MergeValue = string | number | null | undefined | MergeData;
export interface MergeData {
  [key: string]: MergeValue;
}

export interface FillResult<T> {
  output: T;
  /** Fields the template uses that do not exist at all (usually a typo in the template). */
  unknown: string[];
  /** Fields that exist but have no value for this matter. */
  empty: string[];
}

export class TemplateError extends EngineError {
  constructor(message: string) {
    super(`Template problem: ${message}`, 400);
  }
}

const TOKEN_RE = /\{\{([^{}]*)\}\}/g;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const FILTERS = new Set(["long", "upper", "lower"]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Span = [number, number];

interface Tag {
  kind: "var" | "if" | "else" | "endif";
  raw: string;
  path: string;
  negate: boolean;
  filter: string | null;
  /** Just the {{...}} characters. */
  inline: Span;
  /** The whole line/paragraph, when the tag is alone on it (block tags only). */
  block: Span | null;
}

type Node = { type: "var"; tag: Tag } | { type: "if"; open: Tag; elseTag: Tag | null; close: Tag; yes: Node[]; no: Node[] };

function parseTag(inner: string, raw: string, inline: Span): Tag {
  const s = decodeEntities(inner).trim();
  const base = { raw, inline, block: null, negate: false, filter: null as string | null, path: "" };
  if (s === "else") return { ...base, kind: "else" };
  if (s === "/if") return { ...base, kind: "endif" };
  if (s.startsWith("#if")) {
    let rest = s.slice(3).trim();
    let negate = false;
    if (rest.startsWith("!")) {
      negate = true;
      rest = rest.slice(1).trim();
    } else if (/^not\s/.test(rest)) {
      negate = true;
      rest = rest.slice(4).trim();
    }
    if (!PATH_RE.test(rest)) throw new TemplateError(`${raw} needs a field name, like {{#if client.email}}`);
    return { ...base, kind: "if", path: rest, negate };
  }
  if (s.startsWith("#") || s.startsWith("/")) throw new TemplateError(`${raw} is not supported (only #if, else and /if)`);
  const [path, filter, ...more] = s.split("|").map((x) => x.trim());
  if (more.length) throw new TemplateError(`${raw} can have at most one filter`);
  if (!PATH_RE.test(path)) throw new TemplateError(`${raw} is not a valid field name`);
  if (filter !== undefined && !FILTERS.has(filter)) throw new TemplateError(`${raw} uses unknown filter "${filter}" (use long, upper or lower)`);
  return { ...base, kind: "var", path, filter: filter ?? null };
}

function buildTree(tags: Tag[]): Node[] {
  let i = 0;
  function parse(depth: number): { nodes: Node[]; stop: Tag | null } {
    const nodes: Node[] = [];
    while (i < tags.length) {
      const t = tags[i++];
      if (t.kind === "var") nodes.push({ type: "var", tag: t });
      else if (t.kind === "if") {
        const yes = parse(depth + 1);
        let elseTag: Tag | null = null;
        let no: Node[] = [];
        let close = yes.stop;
        if (close?.kind === "else") {
          elseTag = close;
          const rest = parse(depth + 1);
          if (rest.stop?.kind === "else") throw new TemplateError(`${t.raw} has two {{else}} tags`);
          no = rest.nodes;
          close = rest.stop;
        }
        if (!close) throw new TemplateError(`${t.raw} is never closed with {{/if}}`);
        nodes.push({ type: "if", open: t, elseTag, close, yes: yes.nodes, no });
      } else {
        if (depth === 0) throw new TemplateError(`${t.raw} has no matching {{#if}}`);
        return { nodes, stop: t };
      }
    }
    return { nodes, stop: null };
  }
  return parse(0).nodes;
}

function lookup(data: MergeData, path: string): { found: boolean; value: string } {
  let cur: MergeValue = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object" || !Object.hasOwn(cur, part)) return { found: false, value: "" };
    cur = (cur as MergeData)[part];
  }
  if (cur !== null && typeof cur === "object") return { found: true, value: "" };
  return { found: true, value: cur === null || cur === undefined ? "" : String(cur) };
}

export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

function applyFilter(v: string, filter: string | null): string {
  if (filter === "long") return longDate(v);
  if (filter === "upper") return v.toUpperCase();
  if (filter === "lower") return v.toLowerCase();
  return v;
}

interface Target {
  /** Text to put in place of a value tag (already escaped for the format). */
  render(value: string): string;
  /** May the text between these two positions be cut out without breaking the file's structure? */
  canCut(start: number, end: number): boolean;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function evaluate(nodes: Node[], data: MergeData, target: Target) {
  const edits: Edit[] = [];
  const unknown = new Set<string>();
  const empty = new Set<string>();
  const get = (t: Tag) => {
    const r = lookup(data, t.path);
    if (!r.found) unknown.add(t.path);
    else if (r.value === "") empty.add(t.path);
    return r.value;
  };
  const drop = (t: Tag) => {
    const [start, end] = t.block ?? t.inline;
    edits.push({ start, end, text: "" });
  };
  const cut = (a: Tag, b: Tag) => {
    const options: [Span, Span][] = [];
    if (a.block && b.block) options.push([a.block, b.block]);
    options.push([a.inline, b.inline]);
    if (a.block) options.push([a.block, b.inline]);
    if (b.block) options.push([a.inline, b.block]);
    for (const [sa, sb] of options) {
      if (target.canCut(sa[0], sb[1])) {
        edits.push({ start: sa[0], end: sb[1], text: "" });
        return;
      }
    }
    throw new TemplateError(`the text from ${a.raw} to ${b.raw} crosses a table or section boundary; keep each {{#if}} block inside one table cell or outside tables`);
  };
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (n.type === "var") {
        edits.push({ start: n.tag.inline[0], end: n.tag.inline[1], text: target.render(applyFilter(get(n.tag), n.tag.filter)) });
        continue;
      }
      const on = (get(n.open) !== "") !== n.open.negate;
      if (on) {
        drop(n.open);
        walk(n.yes);
        if (n.elseTag) cut(n.elseTag, n.close);
        else drop(n.close);
      } else if (n.elseTag) {
        cut(n.open, n.elseTag);
        walk(n.no);
        drop(n.close);
      } else cut(n.open, n.close);
    }
  };
  walk(nodes);
  return { edits, unknown: [...unknown].sort(), empty: [...empty].sort() };
}

function applyEdits(s: string, edits: Edit[]): string {
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos) throw new TemplateError("overlapping template tags");
    out += s.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + s.slice(pos);
}

// ---------------------------------------------------------------- plain text and HTML

function textTags(src: string): Tag[] {
  const tags: Tag[] = [];
  for (const m of src.matchAll(TOKEN_RE)) {
    const start = m.index!;
    const tag = parseTag(m[1], m[0], [start, start + m[0].length]);
    if (tag.kind !== "var") {
      const lineStart = src.lastIndexOf("\n", start - 1) + 1;
      let lineEnd = src.indexOf("\n", tag.inline[1]);
      lineEnd = lineEnd === -1 ? src.length : lineEnd + 1;
      const line = src.slice(lineStart, lineEnd);
      if (line.trim() === m[0]) tag.block = [lineStart, lineEnd];
    }
    tags.push(tag);
  }
  return tags;
}

export function fillText(src: string, data: MergeData, opts: { html?: boolean } = {}): FillResult<string> {
  const tags = textTags(src);
  const tree = buildTree(tags);
  const esc = opts.html ? (v: string) => escapeHtml(v).replace(/\r?\n/g, "<br>\n") : (v: string) => v;
  const r = evaluate(tree, data, { render: esc, canCut: () => true });
  return { output: applyEdits(src, r.edits), unknown: r.unknown, empty: r.empty };
}

// ---------------------------------------------------------------- Word (.docx)

interface XmlTag {
  start: number;
  end: number;
  name: string;
  close: boolean;
  selfClose: boolean;
}

function scanTags(xml: string): XmlTag[] {
  const out: XmlTag[] = [];
  const re = /<[^>]*>/g;
  for (const m of xml.matchAll(re)) {
    const t = m[0];
    if (t.startsWith("<?") || t.startsWith("<!")) continue;
    const name = /^<\/?\s*([^\s/>]+)/.exec(t)?.[1] ?? "";
    out.push({ start: m.index!, end: m.index! + t.length, name, close: t.startsWith("</"), selfClose: t.endsWith("/>") });
  }
  return out;
}

interface WText {
  openStart: number;
  openEnd: number; // where the text starts
  closeStart: number; // where the text ends
  para: number; // index into paragraphs, or -1
}

interface Para {
  start: number;
  end: number;
  parent: string;
  texts: number[];
}

/** Find every <w:t> and which <w:p> it belongs to. */
function wordStructure(xml: string) {
  const tags = scanTags(xml);
  const stack: string[] = [];
  const paraStack: number[] = [];
  const texts: WText[] = [];
  const paras: Para[] = [];
  let openText: { openStart: number; openEnd: number } | null = null;
  for (const t of tags) {
    if (t.selfClose) continue;
    if (!t.close) {
      if (t.name === "w:p") {
        paras.push({ start: t.start, end: -1, parent: stack[stack.length - 1] ?? "", texts: [] });
        paraStack.push(paras.length - 1);
      }
      if (t.name === "w:t") openText = { openStart: t.start, openEnd: t.end };
      stack.push(t.name);
    } else {
      if (stack[stack.length - 1] !== t.name) throw new TemplateError("the Word file's XML is not well formed");
      stack.pop();
      if (t.name === "w:t" && openText) {
        const para = paraStack.length ? paraStack[paraStack.length - 1] : -1;
        texts.push({ ...openText, closeStart: t.start, para });
        if (para >= 0) paras[para].texts.push(texts.length - 1);
        openText = null;
      }
      if (t.name === "w:p") paras[paraStack.pop()!].end = t.end;
    }
  }
  if (stack.length) throw new TemplateError("the Word file's XML is not well formed");
  return { tags, texts, paras };
}

function withPreserve(openTag: string): string {
  return /xml:space=/.test(openTag) ? openTag : openTag.replace(/^<w:t\b/, '<w:t xml:space="preserve"');
}

/**
 * Word often splits "{{client.name}}" across several runs (spell-check marks, formatting,
 * revision ids). Move each tag's characters into the run where it starts, so every tag sits
 * whole inside one <w:t>. The text keeps the formatting of the run the tag starts in.
 */
export function normalizeRuns(xml: string): string {
  const { texts, paras } = wordStructure(xml);
  const edits: Edit[] = [];
  for (const p of paras) {
    if (!p.texts.length) continue;
    const nodes = p.texts.map((i) => texts[i]);
    const cur = nodes.map((n) => decodeEntities(xml.slice(n.openEnd, n.closeStart)));
    const joined = cur.join("");
    if (!joined.includes("{{")) continue;
    const orig = cur.slice();
    // Where each node starts in the joined text.
    const starts: number[] = [];
    let acc = 0;
    for (const s of cur) {
      starts.push(acc);
      acc += s.length;
    }
    const spans = [...joined.matchAll(TOKEN_RE)].map((m) => [m.index!, m.index! + m[0].length, m[0]] as const);
    let changed = false;
    for (let k = spans.length - 1; k >= 0; k--) {
      const [s, e, token] = spans[k];
      const i = locateIn(starts, orig, s);
      const j = locateIn(starts, orig, e - 1);
      if (i === j) continue;
      changed = true;
      cur[i] = cur[i].slice(0, s - starts[i]) + token;
      for (let x = i + 1; x < j; x++) cur[x] = "";
      cur[j] = cur[j].slice(e - starts[j]);
    }
    // Make sure every text node holding a tag keeps its spaces once values go in.
    nodes.forEach((n, x) => {
      const openTag = xml.slice(n.openStart, n.openEnd);
      const needsPreserve = cur[x] !== orig[x] || cur[x].includes("{{");
      if (!changed && !needsPreserve) return;
      const newOpen = needsPreserve ? withPreserve(openTag) : openTag;
      if (newOpen !== openTag) edits.push({ start: n.openStart, end: n.openEnd, text: newOpen });
      if (cur[x] !== orig[x]) edits.push({ start: n.openEnd, end: n.closeStart, text: escapeXml(cur[x]) });
    });
  }
  return applyEdits(xml, edits);
}

/** Index of the text node that holds character `pos` of the joined paragraph text. */
function locateIn(starts: number[], texts: string[], pos: number): number {
  for (let i = starts.length - 1; i >= 0; i--) {
    if (starts[i] <= pos && pos < starts[i] + texts[i].length) return i;
  }
  return 0;
}

function wordTags(xml: string) {
  const { tags: xmlTags, texts, paras } = wordStructure(xml);
  const tags: Tag[] = [];
  for (const t of texts) {
    const content = xml.slice(t.openEnd, t.closeStart);
    for (const m of content.matchAll(TOKEN_RE)) {
      const start = t.openEnd + m.index!;
      const tag = parseTag(m[1], decodeEntities(m[0]), [start, start + m[0].length]);
      if (tag.kind !== "var" && t.para >= 0) {
        const p = paras[t.para];
        const text = p.texts.map((i) => decodeEntities(xml.slice(texts[i].openEnd, texts[i].closeStart))).join("");
        const body = xml.slice(p.start, p.end);
        const hasObjects = /<w:(drawing|pict|object)\b|<mc:AlternateContent\b|<w:p\b[^>]*>[\s\S]*<w:p\b/.test(body);
        // A table cell must keep at least one paragraph, so never remove a whole one there.
        if (text.trim() === tag.raw && !hasObjects && p.parent !== "w:tc") tag.block = [p.start, p.end];
      }
      tags.push(tag);
    }
  }
  // Element path at a position: the open elements around it.
  const pathAt = (pos: number): string => {
    const stack: string[] = [];
    for (const t of xmlTags) {
      if (t.end > pos) break;
      if (t.selfClose) continue;
      if (t.close) stack.pop();
      else stack.push(t.name);
    }
    return stack.join(">");
  };
  return { tags, canCut: (a: number, b: number) => pathAt(a) === pathAt(b) };
}

function renderWord(value: string): string {
  const v = stripXmlInvalid(value).replace(/\r\n?/g, "\n");
  return v
    .split("\n")
    .map((line) => line.split("\t").map(escapeXml).join('</w:t><w:tab/><w:t xml:space="preserve">'))
    .join('</w:t><w:br/><w:t xml:space="preserve">');
}

/** Fill one WordprocessingML part (document, header, footer...). */
export function fillWordXml(xml: string, data: MergeData): FillResult<string> {
  const norm = normalizeRuns(xml);
  const { tags, canCut } = wordTags(norm);
  const tree = buildTree(tags);
  const r = evaluate(tree, data, { render: renderWord, canCut });
  return { output: applyEdits(norm, r.edits), unknown: r.unknown, empty: r.empty };
}

const FILLABLE_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

export function fillDocx(template: Buffer, data: MergeData): FillResult<Buffer> {
  const entries = readZip(template);
  if (!entries.some((e) => e.name === "word/document.xml")) throw new TemplateError("the file is not a Word document (no word/document.xml)");
  const unknown = new Set<string>();
  const empty = new Set<string>();
  const out = entries.map((e) => {
    if (!FILLABLE_PART.test(e.name)) return e;
    const r = fillWordXml(e.data.toString("utf8"), data);
    r.unknown.forEach((f) => unknown.add(f));
    r.empty.forEach((f) => empty.add(f));
    return { name: e.name, data: Buffer.from(r.output, "utf8") };
  });
  return { output: writeZip(out), unknown: [...unknown].sort(), empty: [...empty].sort() };
}

/**
 * Check a template and list the fields it uses. Throws TemplateError when the template
 * would not fill (bad tag, unclosed {{#if}}...).
 */
export function inspectTemplate(kind: "docx" | "txt" | "html", data: Buffer): { fields: string[] } {
  const fields = new Set<string>();
  const collect = (tags: Tag[]) => {
    buildTree(tags);
    for (const t of tags) if (t.path) fields.add(t.path);
  };
  if (kind === "docx") {
    const parts = readZip(data, { only: (n) => FILLABLE_PART.test(n) });
    if (!parts.some((p) => p.name === "word/document.xml")) throw new TemplateError("the file is not a Word document (no word/document.xml)");
    for (const p of parts) collect(wordTags(normalizeRuns(p.data.toString("utf8"))).tags);
  } else collect(textTags(data.toString("utf8")));
  return { fields: [...fields].sort() };
}
