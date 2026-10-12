/**
 * What a saved plan contains, and how it is written and read (pure, no platform imports; the envelope around it is
 * in shared/plan-sync.ts).
 *
 * A plan is two things the app keeps in two places on the iPhone:
 *  - the plan part of the app state (classes, tasks, the schedule, the semester, syllabi, study material, settings
 *    the plan is built from);
 *  - from the course feeds (lib/lms-feed-store.ts): which feed item became which task, and how many feeds there
 *    were. Never a feed's link: it is private and stays on the iPhone it was pasted on.
 *
 * What never goes in: the events read from the iPhone's calendars (a promise the app and the privacy policy make),
 * the cache of a Google Calendar connection, this iPhone's notification settings ("your reminders" stay on the
 * iPhone, and a switch that is on means nothing without that iPhone's own permission), Undo copies, and everything
 * kept outside these two places (AI memory, the AI consent, device flags, a syllabus reading in progress).
 *
 * Version 1 of the plan, as JSON with the keys of every object in alphabetical order:
 *
 *   {
 *     "courseFeeds": { "count": 1, "links": { "<feed item uid>": "<task id>" | "__dismissed__" } },
 *     "state":       { "classes", "examPreps", "grades", "healthPrefs", "onboardingComplete", "planAlerts",
 *                      "practiceExams", "recommendations", "recurringEvents", "scheduleBlocks", "semester",
 *                      "studyGuides", "syllabusImports", "tasks", "user", "userPrefs" }
 *   }
 *
 * That JSON is gzip-compressed and base64-encoded into the envelope the server stores. Any other key at the top
 * level is ignored when a plan is read (for one, the "gradeBook" that builds wrote while the app had a Grades screen).
 */
import { Gzip, gunzipSync, gzipSync } from "fflate";

import {
  MAX_PLAN_SNAPSHOT_CHARS,
  PLAN_ENCODING_GZIP_BASE64,
  PLAN_SNAPSHOT_FORMAT,
  PLAN_SNAPSHOT_VERSION,
  parsePlanEnvelope,
  type PlanSnapshotEnvelope,
} from "../shared/plan-sync";
import type { FeedLinks } from "./lms-feed";
import { createInitialState, restorePersistedState, toLocalPersistedState } from "../engine/state-persistence";
import type { AppState } from "../engine/types";

// ── What is in a plan ─────────────────────────────────────────

/** A plan as the app holds it: the state plus what the course feeds' store holds of it. */
export interface PlanContents {
  state: AppState;
  /** Feed item uid -> task id, or "__dismissed__" (lib/lms-feed.ts). */
  feedLinks: FeedLinks;
  /** How many course feeds the iPhone that holds (or saved) this plan has. Their links are never part of a plan. */
  feedCount: number;
}

/** The fields of the app state that are the plan. */
const PLAN_STATE_KEYS = [
  "onboardingComplete",
  "user",
  "semester",
  "planAlerts",
  "classes",
  "recurringEvents",
  "tasks",
  "scheduleBlocks",
  "healthPrefs",
  "userPrefs",
  "grades",
  "recommendations",
  "examPreps",
  "studyGuides",
  "practiceExams",
  "syllabusImports",
] as const satisfies readonly (keyof AppState)[];

/**
 * The fields that are this iPhone's own, or only exist while the app is open. They are never written into a plan,
 * and loading a plan leaves them as they are on this iPhone (stateForLoadedPlan).
 */
const DEVICE_STATE_KEYS = [
  "deviceCalendarEvents",
  "googleCalendarEvents",
  "googleCalendarConnected",
  "googleCalendarLastSync",
  "notificationSettings",
  "undoSnapshots",
  "replanNotice",
  "inputsBeforeEdit",
] as const satisfies readonly (keyof AppState)[];

type PlanStateKey = (typeof PLAN_STATE_KEYS)[number];
type DeviceStateKey = (typeof DEVICE_STATE_KEYS)[number];

// Every field of the app state is in one of the two lists. A field added later does not compile until someone has
// decided whether it is saved to the account: nothing reaches the server just because it was added to the state.
const everyStateFieldIsListed: Record<Exclude<keyof AppState, PlanStateKey | DeviceStateKey>, never> = {};
void everyStateFieldIsListed;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The plan part of a state, in the form this app would load it back in (through the tolerant loader, so the same
 * plan always gives the same text whichever iPhone writes it). `planAlerts` are kept without their `computedAt`:
 * the alerts themselves are only rewritten by the next re-plan, which a loaded plan does not always trigger, but
 * the timestamp changes on every plan run, is read by nothing, and would make every launch look like a change.
 */
function planStateOf(state: AppState): Record<string, unknown> {
  const loaded = restorePersistedState({ ...state, deviceCalendarEvents: undefined, googleCalendarEvents: undefined });
  const persisted = toLocalPersistedState({ ...loaded, deviceCalendarEvents: undefined });
  const plan: Record<string, unknown> = {};
  for (const key of PLAN_STATE_KEYS) plan[key] = persisted[key];
  if (persisted.planAlerts) {
    plan.planAlerts = { shortfalls: persisted.planAlerts.shortfalls, overdueTasks: persisted.planAlerts.overdueTasks };
  }
  return plan;
}

function cleanFeedLinks(value: unknown): FeedLinks {
  const links: FeedLinks = {};
  if (!isRecord(value)) return links;
  for (const [uid, taskId] of Object.entries(value)) {
    if (typeof taskId === "string") links[uid] = taskId;
  }
  return links;
}

function cleanFeedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 999) : 0;
}

// ── One text for one plan ─────────────────────────────────────

const SURROGATE = /[\ud800-\udfff]/;

/** A JSON string literal. Half a surrogate pair (text cut in the middle of an emoji) is written as an escape. */
function quote(text: string): string {
  const quoted = JSON.stringify(text);
  if (!SURROGATE.test(quoted)) return quoted;
  // Older JavaScript engines leave a lone surrogate as it is, and it would not survive being turned into UTF-8.
  let out = "";
  let from = 0;
  for (let i = 0; i < quoted.length; i++) {
    const code = quoted.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code <= 0xdbff) {
      const next = quoted.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    }
    out += `${quoted.slice(from, i)}\\u${code.toString(16)}`;
    from = i + 1;
  }
  return from === 0 ? quoted : out + quoted.slice(from);
}

function writeCanonical(value: unknown, out: string[]): void {
  if (value === null || value === undefined) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "string":
      out.push(quote(value));
      return;
    case "number":
      out.push(Number.isFinite(value) ? String(value) : "null");
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "object":
      break;
    default:
      out.push("null");
      return;
  }
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    writeCanonical(withToJson.toJSON(), out);
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(",");
      writeCanonical(value[i], out);
    }
    out.push("]");
    return;
  }
  const record = value as Record<string, unknown>;
  out.push("{");
  let first = true;
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
    if (!first) out.push(",");
    first = false;
    out.push(quote(key), ":");
    writeCanonical(item, out);
  }
  out.push("}");
}

/**
 * JSON with the keys of every object in alphabetical order, otherwise exactly what JSON.stringify writes. The same
 * plan gives the same text whatever order its objects were built in, so two plans can be compared by their text.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  writeCanonical(value, out);
  return out.join("");
}

/**
 * A fingerprint of a text (64 bits and the length): two different plans having the same one does not happen in
 * practice. Only used to notice "nothing changed" and "this is the plan I already had", never for security.
 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${text.length.toString(36)}-${hex(h2)}${hex(h1)}`;
}

/** A plan ready to be compared and sent. */
export interface PreparedPlan {
  /** The plan as JSON (version 1 of the layout at the top of this file). */
  json: string;
  /**
   * Fingerprint of the plan's content: everything except the feed count, which says something about the iPhone
   * that saved the plan, not about the plan, and differs between two iPhones holding the same plan.
   */
  hash: string;
}

/** The plan in `contents` as the text that is saved, with its fingerprint. The heavy step of every save and load. */
export function preparePlan(contents: PlanContents): PreparedPlan {
  const state = planStateOf(contents.state);
  const content = `"links":${canonicalJson(cleanFeedLinks(contents.feedLinks))}},"state":${canonicalJson(state)}}`;
  return { json: `{"courseFeeds":{"count":${cleanFeedCount(contents.feedCount)},${content}`, hash: hashText(content) };
}

// ── Is there a plan? ──────────────────────────────────────────

/** Blocks the planner makes by itself even when there is nothing to plan. */
const STRUCTURAL_BLOCK_TYPES = new Set<string>(["sleep", "buffer"]);

/**
 * "There is no plan on this iPhone": no classes, tasks, recurring events, semester, syllabus imports, exam preps,
 * study guides, practice exams or grades, and no event the student put on the calendar.
 * Whether onboarding was finished, the settings and the events read from the iPhone's calendars say nothing about it.
 */
export function isBlankPlan(contents: Pick<PlanContents, "state">): boolean {
  const { state } = contents;
  const empty = (list: readonly unknown[] | undefined) => !Array.isArray(list) || list.length === 0;
  if (!empty(state.classes) || !empty(state.tasks) || !empty(state.recurringEvents) || state.semester) return false;
  if (!empty(state.syllabusImports) || !empty(state.examPreps) || !empty(state.studyGuides) || !empty(state.practiceExams)) return false;
  if (!empty(state.grades)) return false;
  return !(state.scheduleBlocks ?? []).some((block) => !STRUCTURAL_BLOCK_TYPES.has(block.type));
}

let pristinePlanJson: string | null = null;

/**
 * True for the state a fresh install starts from, which is also what signing out and deleting the account leave
 * behind. It is never saved: an emptied iPhone must not empty the account's plan.
 */
export function isPristineState(state: AppState): boolean {
  if (state.onboardingComplete || state.user || state.semester || state.planAlerts) return false;
  const lists = [state.classes, state.tasks, state.recurringEvents, state.scheduleBlocks, state.grades, state.recommendations, state.examPreps, state.studyGuides, state.practiceExams, state.syllabusImports];
  if (lists.some((list) => Array.isArray(list) && list.length > 0)) return false;
  pristinePlanJson ??= canonicalJson(planStateOf(createInitialState()));
  return canonicalJson(planStateOf(state)) === pristinePlanJson;
}

/**
 * Whether anything that belongs to the plan was replaced between two states (compared by reference, so it costs
 * nothing): a new set of iPhone calendar events or a notification setting is not a change of the plan.
 */
export function planStateChanged(before: AppState, after: AppState): boolean {
  return before !== after && PLAN_STATE_KEYS.some((key) => before[key] !== after[key]);
}

/**
 * The state after `plan` was loaded onto this iPhone: the plan's own fields, and this iPhone's own for everything a
 * plan never contains (the events read from its calendars, its Google cache, its notification settings). Undo copies
 * belong to the plan that is being replaced and are dropped.
 */
export function stateForLoadedPlan(current: AppState, plan: Pick<PlanContents, "state">): AppState {
  const next: AppState = { ...plan.state };
  const device = current as unknown as Record<string, unknown>;
  for (const key of DEVICE_STATE_KEYS) (next as unknown as Record<string, unknown>)[key] = device[key];
  next.undoSnapshots = undefined;
  next.replanNotice = undefined;
  next.inputsBeforeEdit = undefined;
  return next;
}

// ── Bytes ─────────────────────────────────────────────────────

// Text to UTF-8 and back is written here, like the base64 below, so that it is the same code in the tests and on
// the iPhone. What a JavaScript engine offers for it differs between engines and versions (the app's has had no
// TextDecoder), and the compression library's own stand-in writes every character outside the basic plane, which
// is every emoji, wrongly when there is no TextEncoder. A student's task names must not depend on either.

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** How many bytes `text` takes as UTF-8. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * `text` as UTF-8 bytes (`length`: utf8Length(text), when the caller has it already). Half a surrogate pair becomes
 * U+FFFD, as everywhere else; canonicalJson never lets one get this far.
 */
export function utf8Bytes(text: string, length: number = utf8Length(text)): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      out[at++] = code;
      continue;
    }
    if (code < 0x800) {
      out[at++] = 0xc0 | (code >> 6);
      out[at++] = 0x80 | (code & 0x3f);
      continue;
    }
    if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(i + 1))) {
      code = 0x10000 + ((code - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00);
      out[at++] = 0xf0 | (code >> 18);
      out[at++] = 0x80 | ((code >> 12) & 0x3f);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
      continue;
    }
    if (isHighSurrogate(code) || isLowSurrogate(code)) code = 0xfffd;
    out[at++] = 0xe0 | (code >> 12);
    out[at++] = 0x80 | ((code >> 6) & 0x3f);
    out[at++] = 0x80 | (code & 0x3f);
  }
  return out;
}

const TEXT_CHUNK = 8192; // String.fromCharCode takes the characters as arguments

/**
 * UTF-8 bytes as text. Never throws: bytes that are not UTF-8 (a sequence cut short, an overlong form, an encoded
 * surrogate) become U+FFFD. What a plan is read from has passed its checksum, so that only happens when whoever
 * wrote it got it wrong.
 */
export function utf8Text(bytes: Uint8Array): string {
  const parts: string[] = [];
  const units = new Uint16Array(TEXT_CHUNK + 1);
  const length = bytes.length;
  const continues = (index: number) => index < length && (bytes[index]! & 0xc0) === 0x80;
  let at = 0;
  let i = 0;
  while (i < length) {
    if (at >= TEXT_CHUNK) {
      parts.push(String.fromCharCode.apply(null, units.subarray(0, at) as unknown as number[]));
      at = 0;
    }
    const lead = bytes[i++]!;
    if (lead < 0x80) {
      units[at++] = lead;
      continue;
    }
    let code = 0xfffd;
    if (lead >= 0xc2 && lead <= 0xdf) {
      if (continues(i)) code = ((lead & 0x1f) << 6) | (bytes[i++]! & 0x3f);
    } else if (lead >= 0xe0 && lead <= 0xef) {
      // The second byte's range rules out overlong forms (E0) and encoded surrogates (ED).
      const second = i < length ? bytes[i]! : 0;
      if (second >= (lead === 0xe0 ? 0xa0 : 0x80) && second <= (lead === 0xed ? 0x9f : 0xbf) && continues(i + 1)) {
        code = ((lead & 0x0f) << 12) | ((second & 0x3f) << 6) | (bytes[i + 1]! & 0x3f);
        i += 2;
      }
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      // …and here overlong forms (F0) and anything beyond U+10FFFF (F4).
      const second = i < length ? bytes[i]! : 0;
      if (second >= (lead === 0xf0 ? 0x90 : 0x80) && second <= (lead === 0xf4 ? 0x8f : 0xbf) && continues(i + 1) && continues(i + 2)) {
        const point = (((lead & 0x07) << 18) | ((second & 0x3f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f)) - 0x10000;
        i += 3;
        units[at++] = 0xd800 | (point >> 10);
        code = 0xdc00 | (point & 0x3ff);
      }
    }
    units[at++] = code;
  }
  parts.push(String.fromCharCode.apply(null, units.subarray(0, at) as unknown as number[]));
  return parts.join("");
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_CODES = new Uint8Array(64);
const BASE64_VALUES = new Uint8Array(128).fill(255);
for (let i = 0; i < 64; i++) {
  BASE64_CODES[i] = BASE64_ALPHABET.charCodeAt(i);
  BASE64_VALUES[BASE64_ALPHABET.charCodeAt(i)] = i;
}
const PAD = 61; // "="

/** Standard base64 with padding. Written here because the app's JavaScript engine has no Buffer, btoa or atob. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const step = 3 * 2048; // 8,192 characters at a time: String.fromCharCode takes them as arguments
  for (let offset = 0; offset < bytes.length; offset += step) {
    const end = Math.min(offset + step, bytes.length);
    const codes = new Array<number>(Math.ceil((end - offset) / 3) * 4);
    let at = 0;
    for (let i = offset; i < end; i += 3) {
      const a = bytes[i]!;
      const b = i + 1 < end ? bytes[i + 1]! : 0;
      const c = i + 2 < end ? bytes[i + 2]! : 0;
      codes[at++] = BASE64_CODES[a >> 2]!;
      codes[at++] = BASE64_CODES[((a & 3) << 4) | (b >> 4)]!;
      codes[at++] = i + 1 < end ? BASE64_CODES[((b & 15) << 2) | (c >> 6)]! : PAD;
      codes[at++] = i + 2 < end ? BASE64_CODES[c & 63]! : PAD;
    }
    parts.push(String.fromCharCode.apply(null, codes));
  }
  return parts.join("");
}

/** The bytes of a base64 text, or null when it is not base64 (a wrong length, a foreign character, misplaced padding). */
export function base64ToBytes(text: string): Uint8Array | null {
  const length = text.length;
  if (length % 4 !== 0) return null;
  let padding = 0;
  if (length > 0 && text.charCodeAt(length - 1) === PAD) padding = text.charCodeAt(length - 2) === PAD ? 2 : 1;
  const bytes = new Uint8Array((length / 4) * 3 - padding);
  const valueAt = (index: number) => {
    const code = text.charCodeAt(index);
    return code < 128 ? BASE64_VALUES[code]! : 255;
  };
  let at = 0;
  for (let i = 0; i < length; i += 4) {
    // Only the last group of four may end in padding; anywhere else "=" is a foreign character.
    const padded = i + 4 === length ? padding : 0;
    const a = valueAt(i);
    const b = valueAt(i + 1);
    const c = padded === 2 ? 0 : valueAt(i + 2);
    const d = padded >= 1 ? 0 : valueAt(i + 3);
    if ((a | b | c | d) > 63) return null;
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    bytes[at++] = (chunk >> 16) & 255;
    if (at < bytes.length) bytes[at++] = (chunk >> 8) & 255;
    if (at < bytes.length) bytes[at++] = chunk & 255;
  }
  return bytes;
}

let crcTable: Uint32Array | null = null;

/** CRC-32 as gzip uses it: every gzip file ends with the checksum and the length of what it holds. */
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function littleEndian32(bytes: Uint8Array, at: number): number {
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

/**
 * The most a plan's JSON may take once decompressed. A real semester is about 200 KB; this only stops a damaged
 * snapshot from asking for all the memory the iPhone has.
 */
export const MAX_PLAN_JSON_BYTES = 32 * 1024 * 1024;

/** What a gzip file holds, or null when it is damaged (wrong length, wrong checksum) or claims to be enormous. */
function gunzipCapped(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) return null;
  const size = littleEndian32(bytes, bytes.length - 4);
  if (size > MAX_PLAN_JSON_BYTES) return null;
  try {
    // A buffer of exactly the announced size: a file that lies about it cannot make the app allocate more.
    const out = gunzipSync(bytes, { out: new Uint8Array(size) });
    return out.length === size && crc32(out) === littleEndian32(bytes, bytes.length - 8) ? out : null;
  } catch {
    return null;
  }
}

// ── Writing a snapshot ────────────────────────────────────────

export type EncodedPlan =
  | { ok: true; snapshot: string }
  /** The envelope would be longer than the server stores (MAX_PLAN_SNAPSHOT_CHARS). */
  | { ok: false; reason: "too-large" };

const GZIP_OPTIONS = { level: 6, mtime: 0 } as const;

function envelopeFor(compressed: Uint8Array): EncodedPlan {
  const envelope: PlanSnapshotEnvelope = {
    format: PLAN_SNAPSHOT_FORMAT,
    v: PLAN_SNAPSHOT_VERSION,
    encoding: PLAN_ENCODING_GZIP_BASE64,
    data: bytesToBase64(compressed),
  };
  const snapshot = JSON.stringify(envelope);
  return snapshot.length > MAX_PLAN_SNAPSHOT_CHARS ? { ok: false, reason: "too-large" } : { ok: true, snapshot };
}

/** A plan's JSON (preparePlan) as the snapshot the server stores. In one go: for when the app is about to be suspended. */
export function encodePlanSnapshot(json: string): EncodedPlan {
  const bytes = planBytes(json);
  return bytes ? envelopeFor(gzipSync(bytes, GZIP_OPTIONS)) : { ok: false, reason: "too-large" };
}

/** A plan's JSON as bytes; null when it is larger than any plan this app would read back (nothing is allocated then). */
function planBytes(json: string): Uint8Array | null {
  if (json.length > MAX_PLAN_JSON_BYTES) return null;
  const length = utf8Length(json);
  return length > MAX_PLAN_JSON_BYTES ? null : utf8Bytes(json, length);
}

const SLICE_BYTES = 64 * 1024;

/**
 * The same, compressing a slice at a time and calling `pause` in between, so a long plan never holds the app up for
 * more than a slice (the app's JavaScript engine compresses far more slowly than a desktop browser).
 */
export async function encodePlanSnapshotInSlices(json: string, pause: () => Promise<void>): Promise<EncodedPlan> {
  const bytes = planBytes(json);
  if (!bytes) return { ok: false, reason: "too-large" };
  const chunks: Uint8Array[] = [];
  const gzip = new Gzip(GZIP_OPTIONS, (chunk) => {
    chunks.push(chunk);
  });
  for (let offset = 0; ; offset += SLICE_BYTES) {
    const final = offset + SLICE_BYTES >= bytes.length;
    gzip.push(bytes.subarray(offset, offset + SLICE_BYTES), final);
    if (final) break;
    await pause();
  }
  const compressed = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, at);
    at += chunk.length;
  }
  return envelopeFor(compressed);
}

// ── Reading a snapshot ────────────────────────────────────────

export type DecodedPlan =
  | { kind: "plan"; plan: PlanContents }
  /**
   * Written by a newer version of Trajectory (a higher version number, or an encoding this app does not know). It
   * must be left alone: not loaded, and never saved over, until the app is updated.
   */
  | { kind: "newer-version" }
  /** Not a plan, or damaged. Treated with the same care: this app might simply be unable to read it. */
  | { kind: "unreadable" };

/**
 * Reads a snapshot defensively: nothing in it is trusted, and the state goes through the same tolerant loader as the
 * copy on the iPhone, so a plan written by an older (or slightly newer) version loads like an old save does.
 */
export function decodePlanSnapshot(snapshot: unknown): DecodedPlan {
  const envelope = parsePlanEnvelope(snapshot);
  if (!envelope) return { kind: "unreadable" };
  if (envelope.v > PLAN_SNAPSHOT_VERSION || envelope.encoding !== PLAN_ENCODING_GZIP_BASE64) return { kind: "newer-version" };
  const compressed = base64ToBytes(envelope.data);
  const bytes = compressed ? gunzipCapped(compressed) : null;
  if (!bytes) return { kind: "unreadable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Text(bytes));
  } catch {
    return { kind: "unreadable" };
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) return { kind: "unreadable" };
  const feeds = isRecord(parsed.courseFeeds) ? parsed.courseFeeds : {};
  return {
    kind: "plan",
    plan: {
      state: restorePersistedState(parsed.state),
      feedLinks: cleanFeedLinks(feeds.links),
      feedCount: cleanFeedCount(feeds.count),
    },
  };
}
