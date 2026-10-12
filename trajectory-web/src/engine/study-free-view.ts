/**
 * The Study tab for a student without Pro (app/(tabs)/study.tsx), pure: the exams and quizzes they have, each with its
 * countdown and the study sessions the planner already placed for it, plus the read-only plan behind a tap
 * (components/study/exam-plan-sheet.tsx). Nothing here plans or changes anything.
 *
 * Built on lib/study-hub.ts (which exams are listed, their dates and timing), so a free student sees the same exams a
 * Pro student does, and the session count matches the Study tab's "N study sessions planned". Unit-tested in
 * tests/study-free-view.test.ts.
 */
import type { ScheduleBlock } from "./types";
import { runwayTaskId } from "./exam-prep-link";
import { formatMinutes, type ExamTiming } from "./exam-runway";
import type { HubExam, HubSyllabusExam, StudyHub } from "./study-hub";
import { parseLocalDate, timeToMinutes } from "./utils";

// ── Wording shared by the Study tab and the exam sheet ─────────────────────────

/** "9 DAYS", "TOMORROW", "TODAY", "3 DAYS AGO", "DATE UNKNOWN". */
export function countdownLabel(timing: ExamTiming): string {
  return (timing.status === "upcoming" && timing.daysLeft > 1 ? `${timing.daysLeft} days` : timing.label).toUpperCase();
}

/** The countdown pill's tone (a components/ui/pill tone): red in the last 2 days, gold within 5, else green. */
export function urgencyTone(timing: ExamTiming): "neutral" | "red" | "gold" | "green" {
  if (timing.status === "past" || timing.status === "invalid") return "neutral";
  if (timing.daysLeft <= 2) return "red";
  if (timing.daysLeft <= 5) return "gold";
  return "green";
}

/** "Tue, Oct 20" from a "YYYY-MM-DD" key (the key itself when it cannot be parsed). */
export function prettyExamDate(key: string): string {
  const d = parseLocalDate(key);
  return Number.isNaN(d.getTime()) ? key : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export interface FreeStudySession {
  id: string;
  /** "YYYY-MM-DD" */
  date: string;
  /** "HH:MM", 24-hour */
  startTime: string;
  endTime: string;
  minutes: number;
  title: string;
}

export interface FreeExam {
  /** "task:<id>" for an exam or quiz task (from the syllabus or added in Tasks), "prep:<id>" for an exam prep. */
  key: string;
  kind: "exam" | "quiz";
  name: string;
  /** "" when there is none. */
  courseName: string;
  /** "YYYY-MM-DD" as stored (`timing` says when it is not a real date). */
  date: string;
  /** "HH:MM" when the exam has a start time. */
  time?: string;
  timing: ExamTiming;
  /** Study sessions still ahead (from today on, not done or skipped), in calendar order. */
  sessions: FreeStudySession[];
  /** Minutes of `sessions`. */
  minutes: number;
  /** Sessions for it the student already marked done. */
  done: number;
}

export interface FreeStudyView {
  /** Upcoming exams, soonest first (one whose date is unknown last). */
  exams: FreeExam[];
  /** Upcoming quizzes, soonest first. */
  quizzes: FreeExam[];
  /** Exam preps whose exam is over, latest first. */
  past: FreeExam[];
  /** Study time ahead for every upcoming exam and quiz. */
  plannedSessions: number;
  plannedMinutes: number;
}

const blockMinutes = (block: Pick<ScheduleBlock, "startTime" | "endTime">) => Math.max(0, timeToMinutes(block.endTime) - timeToMinutes(block.startTime));

/**
 * The study sessions of these tasks: the ones still ahead (dated today or later and neither done nor skipped, the rule
 * behind the Study tab's "N study sessions planned") in calendar order, and how many are already done.
 */
export function sessionsFor(blocks: readonly ScheduleBlock[], taskIds: ReadonlySet<string>, todayKey: string): { ahead: FreeStudySession[]; done: number } {
  const mine = blocks.filter((b) => b.type === "study" && b.taskId !== undefined && taskIds.has(b.taskId));
  const ahead = mine
    .filter((b) => b.date >= todayKey && b.completionStatus !== "done" && b.completionStatus !== "skipped")
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
    .map((b) => ({ id: b.id, date: b.date, startTime: b.startTime, endTime: b.endTime, minutes: blockMinutes(b), title: b.title }));
  return { ahead, done: mine.filter((b) => b.completionStatus === "done").length };
}

function withSessions(base: Omit<FreeExam, "sessions" | "minutes" | "done">, blocks: readonly ScheduleBlock[], taskIds: ReadonlySet<string>, todayKey: string): FreeExam {
  const { ahead, done } = sessionsFor(blocks, taskIds, todayKey);
  return { ...base, sessions: ahead, minutes: ahead.reduce((sum, s) => sum + s.minutes, 0), done };
}

/** An exam or quiz task with no exam prep (the syllabus import's, or one added in Tasks). */
export function freeExamFromTask(item: HubSyllabusExam, blocks: readonly ScheduleBlock[], todayKey: string): FreeExam {
  return withSessions(
    {
      key: `task:${item.taskId}`,
      kind: item.kind,
      name: item.name,
      courseName: item.courseName ?? "",
      date: item.dueDate,
      ...(item.dueTime ? { time: item.dueTime } : {}),
      timing: item.timing,
    },
    blocks,
    new Set([item.taskId]),
    todayKey,
  );
}

/** An exam prep (made while the student had Pro): its plan's sessions and, when linked, its exam task's own. */
export function freeExamFromPrep(item: HubExam, blocks: readonly ScheduleBlock[], todayKey: string): FreeExam {
  const { exam } = item;
  const subject = exam.subject && exam.subject !== exam.className ? exam.subject : "";
  return withSessions(
    {
      key: `prep:${exam.id}`,
      kind: "exam",
      name: subject || exam.className,
      courseName: subject ? exam.className : "",
      date: exam.examDate,
      ...(exam.examTime ? { time: exam.examTime } : {}),
      timing: item.timing,
    },
    blocks,
    new Set([runwayTaskId(exam.id), ...(exam.examTaskId ? [exam.examTaskId] : [])]),
    todayKey,
  );
}

/** Soonest first; an exam whose date is unknown goes last. */
function bySoonest(a: FreeExam, b: FreeExam): number {
  const aUnknown = a.timing.status === "invalid";
  const bUnknown = b.timing.status === "invalid";
  if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
  return a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "");
}

export function buildFreeStudyView(hub: Pick<StudyHub, "upcoming" | "past" | "syllabusExams">, blocks: readonly ScheduleBlock[], todayKey: string): FreeStudyView {
  const upcoming = [
    ...hub.upcoming.map((item) => freeExamFromPrep(item, blocks, todayKey)),
    ...hub.syllabusExams.map((item) => freeExamFromTask(item, blocks, todayKey)),
  ].sort(bySoonest);
  return {
    exams: upcoming.filter((e) => e.kind === "exam"),
    quizzes: upcoming.filter((e) => e.kind === "quiz"),
    past: hub.past.map((item) => freeExamFromPrep(item, blocks, todayKey)),
    plannedSessions: upcoming.reduce((sum, e) => sum + e.sessions.length, 0),
    plannedMinutes: upcoming.reduce((sum, e) => sum + e.minutes, 0),
  };
}

/** "2 study sessions planned · 1 h 15 min", or "" when the plan has none yet. */
export function plannedLine(sessions: number, minutes: number): string {
  return sessions > 0 ? `${sessions} study session${sessions === 1 ? "" : "s"} planned · ${formatMinutes(minutes)}` : "";
}
