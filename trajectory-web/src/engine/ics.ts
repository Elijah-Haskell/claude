/**
 * Small, tolerant iCalendar (RFC 5545) VEVENT reader for calendar feeds (Canvas and other LMS feeds, Google's
 * secret iCal address). Pure: no React Native imports.
 *
 * Handles line folding (CRLF / LF + space or tab), escaped text (\n \, \; \\), quoted parameters,
 * DTSTART;VALUE=DATE (all-day), UTC times ("...Z"), TZID times (converted with Intl), floating local times,
 * CATEGORIES, URL, STATUS and RRULE. Anything it does not understand is ignored rather than fatal.
 */

export interface IcsDateValue {
  /** Local calendar date "YYYY-MM-DD" (in the device's time zone for UTC / TZID values). */
  date: string;
  /** Local "HH:MM", absent for all-day values. */
  time?: string;
  allDay: boolean;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  categories: string[];
  start: IcsDateValue;
  end?: IcsDateValue;
  url?: string;
  status?: string;
  rrule?: string;
  location?: string;
}

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Undo RFC 5545 line folding and split into logical lines. */
export function unfoldIcsLines(text: string): string[] {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((line) => line.length > 0);
}

function parseProperty(line: string): IcsProperty | null {
  // The value starts at the first ":" that is not inside a quoted parameter value.
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let current = "";
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ";" && !inQuotes) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: parts[0]!.toUpperCase(), params, value };
}

/** Unescape an iCalendar TEXT value. */
export function unescapeIcsText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/** Split a TEXT list (CATEGORIES) on unescaped commas. */
function splitTextList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
    } else if (ch === ",") {
      items.push(current);
      current = "";
    } else current += ch;
  }
  items.push(current);
  return items.map((v) => unescapeIcsText(v).trim()).filter(Boolean);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localParts(date: Date): IcsDateValue {
  return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}`, allDay: false };
}

/** Offset (ms) of `timeZone` from UTC at the instant `utcMs`, via Intl; null if the zone is unknown. */
function zoneOffsetMs(utcMs: number, timeZone: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts: Record<string, number> = {};
    for (const part of fmt.formatToParts(new Date(utcMs))) {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
    }
    const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
    return Number.isFinite(asUtc) ? asUtc - utcMs : null;
  } catch {
    return null;
  }
}

/**
 * Parse a DATE or DATE-TIME property into the device's local date/time.
 * `VALUE=DATE` (or an 8-digit value) is all-day; "Z" is UTC; TZID is converted; anything else is floating local.
 */
export function parseIcsDate(value: string, params: Record<string, string> = {}): IcsDateValue | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, z] = m;
  const y = Number(ys), mo = Number(mos), d = Number(ds);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (hs === undefined || params.VALUE === "DATE") {
    return { date: `${ys}-${mos}-${ds}`, allDay: true };
  }
  const h = Number(hs), mi = Number(mis), s = Number(ss ?? "0");
  if (z) return localParts(new Date(Date.UTC(y, mo - 1, d, h, mi, s)));
  const tzid = params.TZID?.replace(/^\//, "");
  if (tzid) {
    // Wall time in `tzid` -> UTC (two passes settle DST edges) -> device local.
    const wall = Date.UTC(y, mo - 1, d, h, mi, s);
    const first = zoneOffsetMs(wall, tzid);
    if (first !== null) {
      const second = zoneOffsetMs(wall - first, tzid) ?? first;
      return localParts(new Date(wall - second));
    }
  }
  return { date: `${ys}-${mos}-${ds}`, time: `${hs}:${mis}`, allDay: false };
}

/** Every VEVENT in an iCalendar document. Events without a start are skipped. */
export function parseIcsEvents(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: IcsProperty[] | null = null;
  let depth = 0; // nested components inside a VEVENT (VALARM) are ignored
  for (const line of unfoldIcsLines(text)) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      current = [];
      depth = 0;
      continue;
    }
    if (!current) continue;
    if (upper.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (upper.startsWith("END:") && depth > 0) {
      depth--;
      continue;
    }
    if (upper === "END:VEVENT") {
      const event = toEvent(current);
      if (event) events.push(event);
      current = null;
      continue;
    }
    if (depth > 0) continue;
    const prop = parseProperty(line);
    if (prop) current.push(prop);
  }
  return events;
}

function toEvent(props: IcsProperty[]): IcsEvent | null {
  const get = (name: string) => props.find((p) => p.name === name);
  const startProp = get("DTSTART");
  const start = startProp ? parseIcsDate(startProp.value, startProp.params) : null;
  if (!start) return null;
  const endProp = get("DTEND");
  const end = endProp ? parseIcsDate(endProp.value, endProp.params) ?? undefined : undefined;
  const summary = unescapeIcsText(get("SUMMARY")?.value ?? "").trim();
  const categories = props.filter((p) => p.name === "CATEGORIES").flatMap((p) => splitTextList(p.value));
  const uid = (get("UID")?.value ?? "").trim() || `${summary}|${start.date}|${start.time ?? ""}`;
  const description = get("DESCRIPTION")?.value;
  return {
    uid,
    summary: summary || "Untitled",
    description: description ? unescapeIcsText(description) : undefined,
    categories,
    start,
    end,
    url: get("URL")?.value?.trim() || undefined,
    status: get("STATUS")?.value?.trim().toUpperCase() || undefined,
    rrule: get("RRULE")?.value || undefined,
    location: get("LOCATION") ? unescapeIcsText(get("LOCATION")!.value) : undefined,
  };
}
