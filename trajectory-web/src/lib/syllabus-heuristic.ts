// The built-in syllabus reader: no AI, no network. It reads pasted syllabus text line by line and keeps every line
// that names a graded deliverable (an exam, a quiz, a problem set, a paper...) together with a date or a week
// number, in the same shape the AI reader produces (src/engine/syllabus-extraction-utils.ts ExtractedItem), so the
// rest of the import (date resolution, the review steps, the plan) is the same either way. It never invents a date:
// a line with a deliverable but no date is kept as an item that "needs a date". Course name, code, meeting pattern
// and term dates are read when a line states them plainly.

import { normalizeMeetingDays, parseTimeRange, type ExtractedCourse, type ExtractedItem, type SyllabusExtraction, type SyllabusItemType } from "../engine/syllabus-extraction-utils";

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** "Sept 14", "September 14, 2026", "14 Sept", "2-Sep", "9/14", "9/14/26", "2026-09-14". */
const DATE_RE = new RegExp(
  `\\b(?:${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?[\\s-]${MONTH}\\.?(?:,?\\s*\\d{4})?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?)\\b`,
  "i",
);
const WEEK_RE = /\b(?:week|wk)\s*#?\s*(\d{1,2})\b/i;
const WEEKDAY_RE = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b\.?/i;
const TIME_RE = /\b(?:due\s+)?(?:by|at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|noon|midnight)?)\b/i;
/** A clock time on its own ("8:00 am", "14:00"), used for the due time when the line has no "by" or "at". */
const BARE_TIME_RE = /\b(\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.)?|\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.))\b/i;
/** "MWF", "TTh", "TR", "Mon/Wed", "Tuesdays and Thursdays": the days a class meets, as one token. */
const DAYS_TOKEN_RE = /\b((?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*(?:\s*(?:,|\/|&|and)\s*(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*)*)\b|\b((?:M|T|W|Th|F|R|Sa|Su)(?:\/?(?:M|T|W|Th|F|R|Sa|Su)){0,5})\b/;
/** "10:00-10:50 am", "9:30 – 10:45", "2 to 3:15 pm". */
const TIME_RANGE_RE = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\b/i;

const KINDS: { re: RegExp; type: SyllabusItemType; minutes: number; difficulty: number }[] = [
  { re: /\b(final\s+exam|final|midterm|exam(?:ination)?|test)\b/i, type: "exam", minutes: 240, difficulty: 4 },
  { re: /\bquiz(?:zes)?\b/i, type: "quiz", minutes: 45, difficulty: 2 },
  { re: /\b(project|presentation|poster|portfolio|capstone|thesis)\b/i, type: "project", minutes: 480, difficulty: 4 },
  { re: /\b(homework|hw|problem\s*set|pset|assignment|essay|paper|lab\s*report|lab|worksheet|case\s*study|memo|report|discussion\s*post|reflection|response)\b/i, type: "assignment", minutes: 120, difficulty: 3 },
  { re: /\b(reading|read\b|chapter|ch\.|chapters|pp\.|pages)\b/i, type: "reading", minutes: 60, difficulty: 2 },
];
/** Lines about these are never deliverables. */
const SKIP_RE = /\b(office\s+hours|no\s+class|holiday|break\b|drop\s+deadline|last\s+day\s+to\s+(?:drop|withdraw|add)|syllabus\s+quiz\s+optional|grading\s+scale)\b/i;
const CODE_RE = /\b([A-Z]{2,5})\s?-?(\d{3,4}[A-Z]?)\b/;

function clean(text: string): string {
  return text.replace(/\s+/g, " ").replace(/^[\s\-–—•*·|:]+|[\s\-–—•*·|:]+$/g, "").trim();
}

function kindOf(line: string): (typeof KINDS)[number] | null {
  for (const kind of KINDS) if (kind.re.test(line)) return kind;
  return null;
}

/** The item's name: the line without its date, week and "due" words, trimmed to something that fits a row. */
function nameOf(line: string, date: string | null): string {
  let name = line;
  if (date) name = name.replace(date, " ");
  name = name
    .replace(WEEK_RE, " ")
    .replace(WEEKDAY_RE, " ")
    .replace(/\b(due|deadline|submit(?:ted)?|turn\s+in|by\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight|in\s+class)\b/gi, " ")
    .replace(BARE_TIME_RE, " ")
    .replace(/\(\s*\)/g, " ");
  name = clean(name);
  return (name || "Untitled item").slice(0, 120);
}

function normalizeTime(raw: string | undefined): string | null {
  if (!raw) return null;
  const text = raw.toLowerCase().replace(/\./g, "").trim();
  if (text === "noon") return "12:00";
  if (text === "midnight") return "23:59";
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  if (match[3] === "pm" && hours < 12) hours += 12;
  if (match[3] === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** A date as the AI reader would report it: "YYYY-MM-DD" with a year, "MM-DD" without. */
function reportDate(raw: string): { value: string; explicit: boolean } | null {
  const text = raw.trim().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/\./g, "");
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) return { value: text, explicit: true };
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(text);
  if (m) {
    const mm = String(Number(m[1])).padStart(2, "0");
    const dd = String(Number(m[2])).padStart(2, "0");
    if (!m[3]) return { value: `${mm}-${dd}`, explicit: false };
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return { value: `${year}-${mm}-${dd}`, explicit: true };
  }
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const lower = text.toLowerCase();
  const monthIndex = months.findIndex((name) => lower.includes(name));
  if (monthIndex < 0) return null;
  const numbers = lower.replace(/[a-z,]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const day = numbers.find((n) => n.length <= 2);
  const year = numbers.find((n) => n.length === 4);
  if (!day) return null;
  const mm = String(monthIndex + 1).padStart(2, "0");
  const dd = String(Number(day)).padStart(2, "0");
  return year ? { value: `${year}-${mm}-${dd}`, explicit: true } : { value: `${mm}-${dd}`, explicit: false };
}

function weekdayOf(line: string): ExtractedItem["weekday"] {
  const match = WEEKDAY_RE.exec(line);
  if (!match) return null;
  const days = normalizeMeetingDays(match[1]);
  return days[0] ?? null;
}

export interface HeuristicOptions {
  /** The class the import was opened for, used as the course name when the text names none. */
  courseHint?: string;
}

/** What the built-in reader makes of pasted syllabus text. Never throws; an empty text gives no items. */
export function extractSyllabusHeuristically(text: string, options: HeuristicOptions = {}): SyllabusExtraction {
  const lines = text.split(/\r?\n/).map(clean).filter((line) => line.length > 0);
  const items: ExtractedItem[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  let name = "";
  let code = "";
  let instructor = "";
  let isAsynchronous = false;
  let meetingPattern: ExtractedCourse["meetingPattern"] = null;
  let termStart: string | null = null;
  let termEnd: string | null = null;

  for (const line of lines.slice(0, 40)) {
    if (!code) {
      const match = CODE_RE.exec(line);
      if (match && line.length < 120) {
        code = `${match[1]} ${match[2]}`;
        if (!name) name = clean(line.replace(/[:\-–—|]+$/, ""));
      }
    }
    if (!instructor) {
      const match = /\b(?:instructor|professor|prof\.?|taught\s+by|dr\.)\s*[:\-–—]?\s*([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})/i.exec(line);
      if (match) instructor = match[1]!.trim();
    }
    if (!meetingPattern && (/\b(?:class(?:es)?\s+)?(?:meets?|meeting|lecture|lectures|schedule|time)\b/i.test(line) || /\b(?:MWF|TTh|TR|MW|WF|M\/W|T\/Th)\b/.test(line))) {
      const range = TIME_RANGE_RE.exec(line);
      const dayToken = DAYS_TOKEN_RE.exec(line);
      const days = dayToken ? normalizeMeetingDays(dayToken[1] ?? dayToken[2] ?? "") : [];
      const times = range ? parseTimeRange(range[0]) : null;
      if (days.length > 0 && times) {
        const room = /\b(?:in|room|rm\.?)\s+([A-Z][\w.-]*(?:\s+\d+[A-Za-z]?)?)/.exec(line.slice(range!.index + range![0].length));
        meetingPattern = { days, startTime: times.startTime, endTime: times.endTime, location: room?.[1]?.trim() ?? "" };
      }
    }
    if (/\b(asynchronous|self-paced|online\s+only|no\s+scheduled\s+meeting)\b/i.test(line)) isAsynchronous = true;
    if (/\b(classes?\s+(?:begin|start)s?|first\s+day\s+of\s+class|semester\s+(?:begins|starts)|term\s+(?:begins|starts))\b/i.test(line)) {
      const date = DATE_RE.exec(line);
      const reported = date ? reportDate(date[0]) : null;
      if (reported && !termStart) termStart = reported.value;
    }
    if (/\b(last\s+day\s+of\s+class|classes?\s+ends?|semester\s+ends|term\s+ends|final\s+exams?\s+(?:week|period)|finals\s+week)\b/i.test(line)) {
      const date = DATE_RE.exec(line);
      const reported = date ? reportDate(date[0]) : null;
      if (reported && !termEnd) termEnd = reported.value;
    }
  }

  for (const line of lines) {
    if (SKIP_RE.test(line)) continue;
    const kind = kindOf(line);
    if (!kind) continue;
    const dateMatch = DATE_RE.exec(line);
    const weekMatch = WEEK_RE.exec(line);
    const reported = dateMatch ? reportDate(dateMatch[0]) : null;
    const weekNumber = weekMatch ? Number(weekMatch[1]) : null;
    // A whole-course line ("Exams: 40% of the grade") is not a deliverable with a date.
    if (!reported && weekNumber === null && /%|percent|points?\b.*\b(total|each)/i.test(line)) continue;
    const itemName = nameOf(line, dateMatch?.[0] ?? null);
    const key = `${itemName.toLowerCase()}|${reported?.value ?? ""}|${weekNumber ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const timeMatch = TIME_RE.exec(line) ?? BARE_TIME_RE.exec(line);
    const weight = /(\d{1,3})\s*%/.exec(line);
    items.push({
      name: itemName,
      type: kind.type,
      dueDate: reported?.value ?? null,
      dueTime: normalizeTime(timeMatch?.[1]),
      weekNumber,
      weekday: weekNumber !== null ? weekdayOf(line) : null,
      dateEvidence: line.slice(0, 40),
      dateConfidence: reported?.explicit ? "explicit" : reported || weekNumber !== null ? "inferred" : "missing",
      estimatedMinutes: kind.minutes,
      difficulty: kind.difficulty,
      weightPercent: weight ? Math.min(100, Number(weight[1])) : null,
      coversTopics: [],
      notes: "",
    });
  }

  if (items.length === 0) warnings.push("The built-in reader found no dated assignments or exams. Each should be on its own line with its date, like “Sept 14 – Problem Set 2”.");
  const undated = items.filter((item) => item.dueDate === null && item.weekNumber === null).length;
  if (undated > 0) warnings.push(`${undated} ${undated === 1 ? "item has" : "items have"} no date in the text: add one in the next step, or leave ${undated === 1 ? "it" : "them"} out.`);

  const course: ExtractedCourse = {
    name: name || options.courseHint?.trim() || "",
    code,
    instructor,
    isAsynchronous,
    meetingPattern,
    termStart,
    termEnd,
    lastClassDate: null,
    gradeWeights: [],
    breaks: [],
  };
  return { course, items, warnings, truncated: false };
}
