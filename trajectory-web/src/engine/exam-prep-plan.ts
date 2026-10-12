// ============================================================
// Exam prep runway: WHEN the sessions go and WHAT each one covers (pure)
// ============================================================
// Cramming and "everything two weeks early" both lose to spaced retrieval: the material has to be met several
// times, with gaps that tighten as the exam approaches, and the last look must come the day or two BEFORE the
// exam (never the morning of it unless nothing else fits).

import type { TaskKind } from "./types";

/** Reference runway the tables below are written for. */
export const EXAM_RUNWAY_DAYS = 14;

/**
 * How many days before its deadline a task's work may START, by kind. Exams and projects use the whole 14-day
 * prep window; a weekly quiz is looked at 2-4 days out and homework within the week before it is due. Seen on a
 * real semester (2026-09-24): with no per-kind runway, every quiz and homework of the next two weeks landed on the
 * first free day - the student's Thursday held sessions for quizzes due 15 days later.
 *
 * Bigger jobs get more room: a task with many sessions widens its runway to ~1.5 days per session (never past 14),
 * so a long paper classified as an "assignment" is still spread out.
 */
export function runwayDaysFor(kind: TaskKind, sessionCount = 1): number {
  const base = kind === "exam" || kind === "project" ? EXAM_RUNWAY_DAYS : kind === "quiz" ? 4 : kind === "reading" ? 3 : 7;
  const bySize = Math.ceil(Math.max(1, sessionCount) * 1.5);
  return Math.max(1, Math.min(EXAM_RUNWAY_DAYS, Math.max(base, bySize)));
}

/**
 * Days-before-the-exam for each session of a runway with the default 14 days available, oldest session first.
 * Gaps shrink toward the exam and the final review lands 1-2 days out.
 */
const REFERENCE_LEADS: Record<number, number[]> = {
  1: [2],
  2: [7, 2],
  3: [10, 5, 2],
  4: [13, 8, 4, 2],
  5: [14, 9, 5, 2, 1],
  6: [14, 10, 7, 4, 2, 1],
};

/**
 * Target lead time (days before the exam) for each of `sessionCount` sessions, oldest first, when the prep window
 * holds `runwayDays` days (2..14; a truncated window, e.g. an exam in 4 days, gives a smaller number).
 *
 * The last one or two lead times (<= 2 days) never move: the final review stays 1-2 days before the exam. Earlier
 * ones are compressed into the days that exist and then pushed apart so they land on distinct days whenever the
 * window is long enough. Every lead is between 1 and `runwayDays`, so a session is never earlier than the window
 * and never on the exam day itself.
 */
export function examPrepLeads(sessionCount: number, runwayDays: number): number[] {
  const n = Math.max(0, Math.floor(sessionCount));
  if (n === 0) return [];
  const runway = Math.max(1, Math.min(EXAM_RUNWAY_DAYS, Math.floor(runwayDays)));

  let reference = REFERENCE_LEADS[n];
  if (!reference) {
    // Seven or more sessions: spread the first n-2 convexly from the far edge down to 3 days, then 2 and 1.
    const head = n - 2;
    reference = Array.from({ length: head }, (_, i) => Math.round(3 + (EXAM_RUNWAY_DAYS - 3) * Math.pow(1 - i / Math.max(1, head - 1), 1.4)));
    reference.push(2, 1);
  }

  const leads = reference.map((lead) => {
    if (lead <= 2) return Math.min(lead, runway);
    if (runway <= 2) return runway;
    return 2 + Math.round(((lead - 2) * (runway - 2)) / (EXAM_RUNWAY_DAYS - 2));
  });
  // Distinct days, working back from the final review, as far as the window allows...
  for (let i = n - 2; i >= 0; i -= 1) {
    if (leads[i]! <= leads[i + 1]!) leads[i] = Math.min(runway, leads[i + 1]! + 1);
  }
  // ...and if the far edge of a short window got in the way, pull the later sessions in (the final review may
  // slip from 2 days out to 1, never to the exam day).
  for (let i = 0; i < n - 1; i += 1) {
    if (leads[i + 1]! >= leads[i]!) leads[i + 1] = Math.max(1, leads[i]! - 1);
  }
  return leads.map((lead) => Math.max(1, Math.min(runway, lead)));
}

// ── Topics ────────────────────────────────────────────────────

export interface ExamSessionTopics {
  /** Short scope of the session, e.g. "Topics 1-2"; null for the final review and for exams without topics. */
  label: string | null;
  /** The last session of the runway: it revisits everything. */
  isFinalReview: boolean;
}

/** `coversTopics` arrives as a list from the syllabus import; a single string ("Topics 1-4") is accepted too. */
export function normalizeTopics(value: string[] | string | undefined | null): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : value.split(/[;\n]/);
  return list.map((topic) => String(topic).trim()).filter(Boolean);
}

const NUMBERED = /^\s*(topic|chapter|ch\.?|unit|module|week|lecture|section)s?\s*#?\s*(\d+)\b/i;

/** "Topics 1-2", "Topics 1, 3-4", "Topic 9"; falls back to the topic names for unnumbered topics. */
export function describeTopics(group: string[]): string {
  if (group.length === 0) return "";
  const parsed = group.map((topic) => NUMBERED.exec(topic));
  if (parsed.every((match) => match !== null)) {
    const noun = parsed[0]![1]!.replace(/\.$/, "").toLowerCase().replace(/^ch$/, "chapter");
    const label = noun[0]!.toUpperCase() + noun.slice(1);
    if (parsed.every((match) => match![1]!.toLowerCase().replace(/\.$/, "") === parsed[0]![1]!.toLowerCase().replace(/\.$/, ""))) {
      const numbers = [...new Set(parsed.map((match) => Number(match![2])))].sort((a, b) => a - b);
      const ranges: string[] = [];
      for (let i = 0; i < numbers.length; ) {
        let j = i;
        while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j += 1;
        ranges.push(j > i ? `${numbers[i]}-${numbers[j]}` : `${numbers[i]}`);
        i = j + 1;
      }
      return `${label}${numbers.length > 1 ? "s" : ""} ${ranges.join(", ")}`;
    }
  }
  const names = group.map((topic) => topic.replace(NUMBERED, "").replace(/^[\s:.\-–]+/, "").trim() || topic);
  const joined = names.join(", ");
  return joined.length > 60 ? `${joined.slice(0, 57).trimEnd()}...` : joined;
}

/**
 * Assign the exam's topics to its `sessionCount` sessions, in order. Earlier sessions each take a contiguous share
 * of the topics; the last session is the final review of everything. With more sessions than topics, each topic
 * gets its own session and the spare ones are mixed practice over all topics.
 */
export function planExamTopics(topics: string[], sessionCount: number): ExamSessionTopics[] {
  if (sessionCount <= 0) return [];
  const finalReview: ExamSessionTopics = { label: null, isFinalReview: true };
  if (topics.length === 0) return Array.from({ length: sessionCount }, (_, i) => (i === sessionCount - 1 ? finalReview : { label: null, isFinalReview: false }));

  const prepSessions = sessionCount - 1;
  const plan: ExamSessionTopics[] = [];
  for (let j = 0; j < prepSessions; j += 1) {
    if (topics.length <= prepSessions) {
      plan.push({ label: j < topics.length ? describeTopics([topics[j]!]) : "mixed practice, all topics", isFinalReview: false });
    } else {
      const from = Math.floor((j * topics.length) / prepSessions);
      const to = Math.floor(((j + 1) * topics.length) / prepSessions);
      plan.push({ label: describeTopics(topics.slice(from, to)), isFinalReview: false });
    }
  }
  plan.push(finalReview);
  return plan;
}
