// ============================================================
// Assistant replies: what the student may see, what may touch the calendar (pure)
// ============================================================
// The chat model answers in JSON. Two things must never happen: raw or half-written JSON shown as the
// assistant's words (seen on the phone 2026-09-24 when a 3k-token answer was cut off), and a proposed
// block edit that names a block the student never listed or gives it a malformed time.

export interface ProposedBlockEdit {
  id: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  title?: string;
}

/** A proposed new due date for an existing task ("my midterm moved to Tuesday"). */
export interface ProposedDeadlineChange {
  taskId: string;
  /** YYYY-MM-DD, a real calendar date. */
  dueDate: string;
  /** HH:MM, only when the student gave a time. */
  dueTime?: string;
}

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "9:05" -> "09:05"; anything that is not a valid HH:MM -> undefined. */
export function normalizeClock(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!TIME.test(trimmed)) return undefined;
  const [h, m] = trimmed.split(":");
  return `${h!.padStart(2, "0")}:${m}`;
}

/** True when the text is (or starts as) a JSON object rather than prose, e.g. a model answer that was not parsed. */
export function looksLikeJsonReply(text: string): boolean {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "");
  return trimmed.startsWith("{") && /"(reply|type|tasks|events|editBlocks)"\s*:/.test(trimmed);
}

/**
 * The "reply" string out of a JSON answer that could not be parsed (typically cut off by the output budget), with
 * JSON escapes resolved. null when there is no usable reply in it.
 */
export function salvageJsonReply(text: string): string | null {
  if (!text) return null;
  const match = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)("|$)/m.exec(text);
  if (!match || !match[1]) return null;
  let reply: string;
  try {
    reply = JSON.parse(`"${match[1]}"`) as string;
  } catch {
    reply = match[1].replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  reply = reply.trim();
  if (!reply) return null;
  // A reply that was itself cut off ends mid-sentence: say so instead of trailing into nothing.
  return match[2] === "" ? `${reply.replace(/[\s,;:-]+$/, "")}…` : reply;
}

/** What the student should read for an assistant message: the salvaged reply when the text is raw JSON, else the text. */
export function displayableReply(text: string): string {
  if (!looksLikeJsonReply(text)) return text;
  return salvageJsonReply(text) ?? "I lost my train of thought there. Could you say that again in one sentence?";
}

/**
 * Proposed block edits from a model answer, restricted to blocks in `knownIds` and to well-formed fields. An edit
 * without any change (no date, times or title) is dropped; a start without an end (or the reverse) keeps only what
 * was given, the app preserves the other side.
 */
export function sanitizeEditBlocks(value: unknown, knownIds: ReadonlySet<string>, max = 20): ProposedBlockEdit[] {
  if (!Array.isArray(value)) return [];
  const out: ProposedBlockEdit[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id || !knownIds.has(id) || seen.has(id)) continue;
    const date = typeof r.date === "string" && DATE.test(r.date.trim()) ? r.date.trim() : undefined;
    const startTime = normalizeClock(r.startTime);
    const endTime = normalizeClock(r.endTime);
    if (startTime && endTime && startTime >= endTime) continue;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 120) : undefined;
    if (!date && !startTime && !endTime && !title) continue;
    seen.add(id);
    out.push({ id, ...(date ? { date } : {}), ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}), ...(title ? { title } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

/** "2026-02-30" is not a date. */
export function isRealIsoDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const WEEKDAY = /\b(mon|tues?|wed|weds|wednes|thu|thur|thurs|fri|sat|satur|sun)(day)?s?\b/;
const RELATIVE_DAY = /\b(today|tonight|tomorrow|tmrw|yesterday|next week|this week|next month|week \d{1,2}|in (a|one|two|three|\d{1,2}) (days?|weeks?))\b/;
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}(st|nd|rd|th)?\s+(of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/;
const NUMERIC_DATE = /\b\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\bthe \d{1,2}(st|nd|rd|th)\b/;

/**
 * Does the student's text name a day or date at all? A deadline proposal is only accepted when it does: the model
 * may resolve "Tuesday" to a date, but it may never come up with a date nobody said.
 */
export function statesADate(text: string): boolean {
  const lower = text.toLowerCase();
  return WEEKDAY.test(lower) || RELATIVE_DAY.test(lower) || MONTH_DAY.test(lower) || NUMERIC_DATE.test(lower);
}

/**
 * Proposed due-date changes from a model answer, restricted to:
 *  - tasks in `knownTasks` (unknown or repeated ids are dropped),
 *  - real YYYY-MM-DD dates no earlier than `today` and at most a year ahead, with an optional valid HH:MM,
 *  - an actual change (same date and time as now is dropped),
 *  - and only when `statedText` (the student's recent messages) names a day or date at all; otherwise every
 *    change is dropped, because the date could only have been invented.
 */
export function sanitizeDeadlineChanges(
  value: unknown,
  knownTasks: ReadonlyMap<string, { dueDate: string; dueTime?: string }>,
  options: { today: string; statedText: string; max?: number },
): ProposedDeadlineChange[] {
  if (!Array.isArray(value) || !statesADate(options.statedText)) return [];
  const max = options.max ?? 10;
  const todayOk = isRealIsoDate(options.today);
  const latest = todayOk ? new Date(`${options.today}T12:00:00Z`) : null;
  latest?.setUTCFullYear(latest.getUTCFullYear() + 1);
  const latestIso = latest ? latest.toISOString().slice(0, 10) : null;
  const out: ProposedDeadlineChange[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const rawId = typeof r.taskId === "string" ? r.taskId : typeof r.id === "string" ? r.id : "";
    const taskId = rawId.trim();
    const current = taskId ? knownTasks.get(taskId) : undefined;
    if (!current || seen.has(taskId)) continue;
    const dueDate = typeof r.dueDate === "string" ? r.dueDate.trim() : "";
    if (!isRealIsoDate(dueDate)) continue;
    if (todayOk && dueDate < options.today) continue;
    if (latestIso && dueDate > latestIso) continue;
    const dueTime = normalizeClock(r.dueTime);
    if (dueDate === current.dueDate && (!dueTime || dueTime === current.dueTime)) continue;
    seen.add(taskId);
    out.push({ taskId, dueDate, ...(dueTime ? { dueTime } : {}) });
    if (out.length >= max) break;
  }
  return out;
}
