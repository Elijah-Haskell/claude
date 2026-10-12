/**
 * Realistic synthetic model answers (what the LLM would return for two very different syllabi) and helpers to
 * push them through the same pipeline the app uses: parse -> resolve term and dates -> review drafts -> import.
 * No network, no clock: everything takes `now` / `today` explicitly.
 */
import {
  buildDraftItems,
  buildSyllabusImport,
  applySyllabusImport,
  assessTerm,
  decideSemester,
  prefillBasics,
  type DraftItem,
  type BuiltImport,
} from "../../src/engine/syllabus-import";
import {
  parseSyllabusExtractionResponse,
  resolveCourseTerm,
  resolveExtractedItems,
  type ResolvedSyllabusItem,
  type SyllabusExtraction,
} from "../../src/engine/syllabus-extraction-utils";
import {
  AppState,
  DEFAULT_HEALTH_PREFS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_USER_PREFS,
  Semester,
} from "../../src/engine/types";

const item = (overrides: Record<string, unknown>) => ({
  type: "assignment",
  dueDate: null,
  weekNumber: null,
  weekday: null,
  dateEvidence: "",
  dateConfidence: "missing",
  estimatedMinutes: 60,
  difficulty: 2,
  weightPercent: null,
  coversTopics: [],
  notes: "",
  ...overrides,
});

/** Syllabus 1: every date printed in full ("explicit"), uploaded mid-semester (today = 2026-09-20, a Sunday). */
export const EXPLICIT_TODAY = "2026-09-20";
export const EXPLICIT_NOW = new Date(2026, 8, 20, 10, 0, 0);
export const EXPLICIT_FIXTURE = JSON.stringify({
  course: {
    name: "Organic Chemistry",
    code: "CHEM 201",
    instructor: "Dr. Rosalind Franklin",
    isAsynchronous: false,
    meetingPattern: { days: ["Tue", "Thu"], startTime: "09:30", endTime: "10:45", location: "Science Hall 12" },
    termStart: "2026-08-24",
    termEnd: "2026-12-11",
    gradeWeights: [
      { name: "Exams", weightPercent: 45 },
      { name: "Homework", weightPercent: 25 },
      { name: "Research paper", weightPercent: 20 },
      { name: "Quizzes", weightPercent: 10 },
    ],
    breaks: [
      { name: "Fall Break", startDate: "2026-10-12", endDate: "2026-10-13" },
      { name: "Thanksgiving", startDate: "2026-11-25", endDate: "2026-11-29" },
    ],
  },
  items: [
    item({ name: "Homework 1", dueDate: "2026-09-04", dateEvidence: "HW1 due Fri Sep 4, 2026", dateConfidence: "explicit", estimatedMinutes: 60 }),
    item({ name: "Homework 2", dueDate: "2026-09-25", dateEvidence: "HW2 due Fri Sep 25, 2026", dateConfidence: "explicit", estimatedMinutes: 75, difficulty: 3 }),
    item({ name: "Quiz 1", type: "quiz", dueDate: "2026-10-02", dateEvidence: "Quiz 1: October 2, 2026", dateConfidence: "explicit", estimatedMinutes: 45, difficulty: 3, weightPercent: 2.5 }),
    item({ name: "Lab Report 1", dueDate: "10-09", dateEvidence: "Lab report 1 due Oct 9", dateConfidence: "inferred", estimatedMinutes: 120, difficulty: 3 }),
    item({ name: "Midterm Exam", type: "exam", dueDate: "2026-10-22", dateEvidence: "Midterm exam Thursday October 22, 2026", dateConfidence: "explicit", estimatedMinutes: 240, difficulty: 5, weightPercent: 25, coversTopics: ["Alkanes", "Alkenes", "Stereochemistry"] }),
    item({ name: "Research Paper", type: "project", dueDate: "2026-11-13", dateEvidence: "Paper due November 13, 2026", dateConfidence: "explicit", estimatedMinutes: 300, difficulty: 4, weightPercent: 20 }),
    item({ name: "Problem Set 5", dueDate: "2026-11-20", dateEvidence: "PS5 due Nov 20, 2026", dateConfidence: "explicit", estimatedMinutes: 90, difficulty: 4 }),
    item({ name: "Final Exam", type: "exam", dueDate: null, dateEvidence: "Final exam date set by the registrar", dateConfidence: "missing", estimatedMinutes: 300, difficulty: 5, weightPercent: 20 }),
    item({ name: "Bonus Assignment", dueDate: "2027-02-30", dateEvidence: "Bonus due Feb 30", dateConfidence: "explicit" }),
  ],
});

/** Syllabus 2: everything is "Week N <weekday>", with a spring break, uploaded before the term (today = 2027-01-05, a Tuesday). */
export const WEEKLY_TODAY = "2027-01-05";
export const WEEKLY_NOW = new Date(2027, 0, 5, 9, 0, 0);
export const WEEKLY_FIXTURE = JSON.stringify({
  course: {
    name: "World History",
    code: "HIST 110",
    instructor: "Prof. Ibn Khaldun",
    isAsynchronous: false,
    meetingPattern: { days: ["Mon", "Wed", "Fri"], startTime: "13:00", endTime: "13:50", location: "Old Main 204" },
    termStart: "01-11",
    termEnd: "05-07",
    gradeWeights: [
      { name: "Midterm", weightPercent: 25 },
      { name: "Final exam", weightPercent: 30 },
      { name: "Essays", weightPercent: 30 },
      { name: "Reading responses", weightPercent: 15 },
    ],
    breaks: [{ name: "Spring Break", startDate: "03-08", endDate: "03-12" }],
  },
  items: [
    item({ name: "Reading Response 1", type: "reading", weekNumber: 3, weekday: "Fri", dateEvidence: "Week 3 Fri: reading response 1", dateConfidence: "inferred", estimatedMinutes: 45, difficulty: 2 }),
    item({ name: "Essay 1", weekNumber: 5, weekday: "Fri", dateEvidence: "Week 5 - Friday: Essay 1 due", dateConfidence: "inferred", estimatedMinutes: 180, difficulty: 3, weightPercent: 15 }),
    item({ name: "Midterm Exam", type: "exam", weekNumber: 7, weekday: "Wed", dateEvidence: "Week 7 Wednesday: In-class midterm", dateConfidence: "inferred", estimatedMinutes: 240, difficulty: 4, weightPercent: 25, coversTopics: ["Ancient empires", "Trade routes"] }),
    item({ name: "Essay 2", weekNumber: 12, weekday: "Fri", dateEvidence: "Week 12 Fri: Essay 2 due", dateConfidence: "inferred", estimatedMinutes: 180, difficulty: 3, weightPercent: 15 }),
    item({ name: "Group Presentation", type: "project", weekNumber: 14, weekday: null, dateEvidence: "Week 14: group presentations", dateConfidence: "inferred", estimatedMinutes: 150, difficulty: 3 }),
    item({ name: "Final Exam", type: "exam", dueDate: null, dateEvidence: "Final exam: TBA", dateConfidence: "missing", estimatedMinutes: 300, difficulty: 5, weightPercent: 30 }),
  ],
});

export function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    onboardingComplete: true,
    classes: [],
    recurringEvents: [],
    tasks: [],
    scheduleBlocks: [],
    healthPrefs: DEFAULT_HEALTH_PREFS,
    userPrefs: DEFAULT_USER_PREFS,
    grades: [],
    recommendations: [],
    examPreps: [],
    studyGuides: [],
    practiceExams: [],
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    syllabusImports: [],
    googleCalendarEvents: [],
    googleCalendarConnected: false,
    ...overrides,
  };
}

export interface Pipeline {
  extraction: SyllabusExtraction;
  items: ResolvedSyllabusItem[];
  term: ReturnType<typeof resolveCourseTerm>;
  drafts: DraftItem[];
}

/** Exactly what the server does with a model answer (see extractSyllabus in server/routers.ts). */
export function extractLikeServer(fixture: string, today: string, hints: { semesterStart?: string; semesterEnd?: string; idPrefix?: string } = {}): Pipeline {
  const extraction = parseSyllabusExtractionResponse(fixture);
  if (!extraction) throw new Error("fixture did not parse");
  const term = resolveCourseTerm(extraction.course, today);
  const items = resolveExtractedItems(extraction.items, {
    today,
    termStart: term.termStart ?? hints.semesterStart ?? null,
    termEnd: term.termEnd ?? hints.semesterEnd ?? null,
    breaks: term.breaks,
  });
  return { extraction, items, term, drafts: buildDraftItems(items, { today, idPrefix: hints.idPrefix ?? "run1" }) };
}

/** The whole client-side confirm step for a fresh install: new class, new semester from the syllabus, breaks included. */
export function importFresh(
  state: AppState,
  pipeline: Pipeline,
  opts: { now: Date; today: string; importId?: string; semesterId?: string; drafts?: DraftItem[] },
): { built: BuiltImport; after: AppState; semester: Semester } {
  const { extraction, term } = pipeline;
  const assessment = assessTerm({ existing: state.semester, start: term.termStart, end: term.termEnd, breaks: term.breaks });
  const outcome = decideSemester(
    assessment,
    assessment.existing ? { action: "keep" } : { action: "create", start: term.termStart!, end: term.termEnd! },
    { includeBreaks: true, newId: opts.semesterId ?? "semester-test" },
  );
  if (!outcome.ok || !outcome.semester) throw new Error(outcome.ok ? "no semester" : outcome.error);
  const basics = prefillBasics(extraction.course);
  const built = buildSyllabusImport({
    now: opts.now,
    today: opts.today,
    importId: opts.importId ?? "import-1",
    drafts: opts.drafts ?? pipeline.drafts,
    course: basics,
    target: { kind: "new" },
    existing: { classes: state.classes, tasks: state.tasks },
    semester: outcome.changed ? outcome.semester : undefined,
    source: "paste",
    newClassId: "class-test",
  });
  return { built, after: applySyllabusImport(state, built.payload), semester: outcome.semester };
}
