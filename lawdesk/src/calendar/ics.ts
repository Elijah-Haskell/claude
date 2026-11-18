// iCalendar (RFC 5545, https://www.rfc-editor.org/rfc/rfc5545) reading and writing.
//
// Writing follows:
//   §3.1    content lines end in CRLF and are folded so no line is longer than 75 octets
//           (continuation lines start with one space). We never split a UTF-8 character.
//   §3.3.11 TEXT values escape backslash, semicolon, comma and newline (\\ \; \, \n).
//   §3.2    parameter values containing : ; or , are put in double quotes.
//   §3.6.5  VTIMEZONE: we publish one for each zone we allow (US zones, rules in force
//           since 2007 under 15 U.S.C. §260a(a), https://www.law.cornell.edu/uscode/text/15/260a :
//           DST from 2 a.m. on the second Sunday of March to 2 a.m. on the first Sunday of November).
// Reading unfolds lines (§3.1), unescapes TEXT and understands DATE, UTC, TZID and
// floating DATE-TIME values.

export const CRLF = "\r\n";

// ------------------------------------------------------------------ writing

export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

export function paramValue(s: string): string {
  if (/["\r\n]/.test(s)) s = s.replace(/["\r\n]/g, ""); // DQUOTE and controls are not allowed at all
  return /[:;,]/.test(s) ? `"${s}"` : s;
}

const enc = new TextEncoder();

/** Fold one content line at 75 octets (RFC 5545 §3.1) without splitting a UTF-8 character. */
export function foldLine(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75; // the first line holds 75 octets; continuation lines hold a space + 74
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join(CRLF + " ");
}

export class IcsWriter {
  private lines: string[] = [];

  /** Add a property. `value` must already be in iCalendar form (use escapeText for TEXT). */
  prop(name: string, value: string, params: Record<string, string> = {}): this {
    const p = Object.entries(params)
      .map(([k, v]) => `;${k}=${paramValue(v)}`)
      .join("");
    this.lines.push(foldLine(`${name}${p}:${value}`));
    return this;
  }

  text(name: string, value: string | null | undefined, params: Record<string, string> = {}): this {
    if (value == null || value === "") return this;
    return this.prop(name, escapeText(value), params);
  }

  begin(c: string): this {
    this.lines.push(`BEGIN:${c}`);
    return this;
  }

  end(c: string): this {
    this.lines.push(`END:${c}`);
    return this;
  }

  raw(block: string): this {
    for (const l of block.split(/\r?\n/)) if (l) this.lines.push(foldLine(l));
    return this;
  }

  toString(): string {
    return this.lines.join(CRLF) + CRLF;
  }
}

/** 20260309T140000Z from epoch ms. */
export function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** 20260309 from 2026-03-09. */
export function icsDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

/** 20260309T090000 from a local date and HH:MM:SS. */
export function icsLocal(date: string, time: string): string {
  return icsDate(date) + "T" + time.replace(/:/g, "").padEnd(6, "0");
}

// --- VTIMEZONE definitions for the zones the calendar accepts ---

interface ZoneDef {
  std: number; // minutes east of UTC
  stdName: string;
  dst?: number;
  dstName?: string;
}

/**
 * Zones an event may be entered in. Kansas is Central except four western counties (Sherman, Wallace,
 * Greeley, Hamilton), which are Mountain: see the boundary in 49 CFR § 71.7(d),
 * https://www.law.cornell.edu/cfr/text/49/71.7 .
 */
export const ZONES: Record<string, ZoneDef> = {
  "America/Chicago": { std: -360, stdName: "CST", dst: -300, dstName: "CDT" },
  "America/Denver": { std: -420, stdName: "MST", dst: -360, dstName: "MDT" },
  "America/New_York": { std: -300, stdName: "EST", dst: -240, dstName: "EDT" },
  "America/Los_Angeles": { std: -480, stdName: "PST", dst: -420, dstName: "PDT" },
  "America/Anchorage": { std: -540, stdName: "AKST", dst: -480, dstName: "AKDT" },
  "America/Phoenix": { std: -420, stdName: "MST" },
  "Pacific/Honolulu": { std: -600, stdName: "HST" },
};

function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}${String(a % 60).padStart(2, "0")}`;
}

export function vtimezone(tzid: string): string {
  const z = ZONES[tzid];
  if (!z) throw new Error(`No VTIMEZONE for ${tzid}`);
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
  if (z.dst === undefined) {
    lines.push("BEGIN:STANDARD", `TZOFFSETFROM:${fmtOffset(z.std)}`, `TZOFFSETTO:${fmtOffset(z.std)}`, `TZNAME:${z.stdName}`, "DTSTART:19700101T000000", "END:STANDARD");
  } else {
    lines.push(
      "BEGIN:DAYLIGHT",
      `TZOFFSETFROM:${fmtOffset(z.std)}`,
      `TZOFFSETTO:${fmtOffset(z.dst)}`,
      `TZNAME:${z.dstName}`,
      "DTSTART:20070311T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      `TZOFFSETFROM:${fmtOffset(z.dst)}`,
      `TZOFFSETTO:${fmtOffset(z.std)}`,
      `TZNAME:${z.stdName}`,
      "DTSTART:20071104T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "END:STANDARD",
    );
  }
  lines.push("END:VTIMEZONE");
  return lines.join(CRLF);
}

// ------------------------------------------------------------------ reading

export interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  type: string;
  props: IcsProp[];
  children: IcsComponent[];
}

export function unfold(text: string): string[] {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((l) => l.length > 0);
}

export function parseLine(line: string): IcsProp {
  // name *(";" param) ":" value — colons inside quoted parameter values don't end the name part
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) break;
  }
  if (i >= line.length) throw new Error(`Not an iCalendar line: ${line.slice(0, 60)}`);
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const pieces: string[] = [];
  let cur = "";
  inQuote = false;
  for (const c of head) {
    if (c === '"') inQuote = !inQuote;
    if (c === ";" && !inQuote) {
      pieces.push(cur);
      cur = "";
    } else cur += c;
  }
  pieces.push(cur);
  const params: Record<string, string> = {};
  for (const p of pieces.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"(.*)"$/, "$1");
  }
  return { name: pieces[0].toUpperCase(), params, value };
}

export function parseIcs(text: string): IcsComponent {
  const root: IcsComponent = { type: "ROOT", props: [], children: [] };
  const stack = [root];
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (p.name === "BEGIN") {
      const c: IcsComponent = { type: p.value.toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(c);
      stack.push(c);
    } else if (p.name === "END") {
      if (stack.length < 2 || stack[stack.length - 1].type !== p.value.toUpperCase()) {
        throw new Error(`Unexpected END:${p.value}`);
      }
      stack.pop();
    } else {
      stack[stack.length - 1].props.push(p);
    }
  }
  if (stack.length !== 1) throw new Error(`Missing END:${stack[stack.length - 1].type}`);
  return root;
}

export function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

export function getProp(c: IcsComponent, name: string): IcsProp | undefined {
  return c.props.find((p) => p.name === name);
}

export function getProps(c: IcsComponent, name: string): IcsProp[] {
  return c.props.filter((p) => p.name === name);
}

/** A DATE or DATE-TIME value as found in a file. */
export type IcsTime =
  | { kind: "date"; date: string } // all-day
  | { kind: "utc"; ms: number }
  | { kind: "local"; date: string; time: string; tzid: string | null }; // tzid null = floating

export function parseIcsTime(value: string, params: Record<string, string>): IcsTime {
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return { kind: "date", date: `${m[1]}-${m[2]}-${m[3]}` };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) throw new Error(`Not an iCalendar date or time: ${v}`);
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = `${m[4]}:${m[5]}:${m[6]}`;
  if (m[7]) return { kind: "utc", ms: Date.parse(`${date}T${time}Z`) };
  return { kind: "local", date, time, tzid: params.TZID ?? null };
}

/** RFC 5545 §3.3.6 DURATION, e.g. PT1H30M, P1D, -PT15M. Returns milliseconds. */
export function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m || v.trim() === "P" || /T$/.test(v.trim())) throw new Error(`Not a duration: ${v}`);
  const [, sign, w, d, h, mi, s] = m;
  const ms = (((Number(w ?? 0) * 7 + Number(d ?? 0)) * 24 + Number(h ?? 0)) * 60 + Number(mi ?? 0)) * 60_000 + Number(s ?? 0) * 1000;
  return sign === "-" ? -ms : ms;
}

/**
 * Windows zone names Outlook writes in TZID, mapped to IANA names (from the Unicode CLDR
 * windowsZones table, https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml).
 */
export const WINDOWS_ZONES: Record<string, string> = {
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  UTC: "UTC",
};
