/**
 * The Study tab and the screen of one exam, as pure functions (app/(tabs)/study.tsx, app/(tabs)/exam.tsx).
 *
 * The list of exams is lib/study-free-view.ts for every student, with Pro or without: an exam or quiz task (from a
 * syllabus, or added with the + button) is "task:<id>", an exam prep is "prep:<id>". What Pro adds are the study
 * tools; the exams, their countdowns and the study time the planner placed for each are the same for everyone.
 */
import { runwayTaskId } from "./exam-prep-link";
import { formatMinutes, type ExamTiming } from "./exam-runway";
import type { FreeExam, FreeStudyView } from "./study-free-view";
import type { BadgeTone } from "./task-list";
import type { ExamPrep, ScheduleBlock } from "./types";
import { formatTime, getDurationMinutes, parseLocalDate } from "./utils";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The one badge that says how close an exam is, by the app's rule for every date: red for today and tomorrow, gold
 * inside a week, quiet beyond that and for what is over or has no known date.
 */
export function examBadge(timing: ExamTiming): { label: string; tone: BadgeTone } {
  if (timing.status === "invalid") return { label: "No date", tone: "neutral" };
  if (timing.status === "past") return { label: "Over", tone: "neutral" };
  if (timing.status === "today" || timing.daysLeft <= 0) return { label: "Today", tone: "red" };
  if (timing.daysLeft === 1) return { label: "Tomorrow", tone: "red" };
  return { label: `${timing.daysLeft} days`, tone: timing.daysLeft <= 6 ? "gold" : "neutral" };
}

/** The line over "Study": what is ahead, counted. */
export function studyEyebrow(view: Pick<FreeStudyView, "exams" | "quizzes">): string {
  const exams = view.exams.length;
  const quizzes = view.quizzes.length;
  if (exams === 0 && quizzes === 0) return "Nothing ahead yet";
  if (exams === 0) return `${count(quizzes, "quiz", "quizzes")} ahead`;
  return quizzes > 0 ? `${count(exams, "exam")} · ${count(quizzes, "quiz", "quizzes")} ahead` : `${count(exams, "exam")} ahead`;
}

export interface ExamProgress {
  /** Sessions the plan holds for it: still to do plus already done (one that was skipped or missed is neither). */
  total: number;
  done: number;
  /** 0..1 of the bar (a sliver when nothing is done yet, so the bar reads as a bar). */
  fraction: number;
  /** "3 study sessions · 4 h to go", "3 study sessions, all done", or "No study time planned yet". */
  line: string;
  /** "0 of 3 done", or "" when nothing is planned. */
  doneLine: string;
}

/**
 * An exam's progress, counted from the same sessions its screen lists (`examSessions`), so the card on Study and
 * the exam's own screen always agree. A session still to do counts whatever its day; a skipped or missed one is
 * shown in the list with that word and counts as neither.
 */
export function examProgress(sessions: readonly Pick<ExamSession, "minutes" | "status">[]): ExamProgress {
  const counted = sessions.filter((session) => session.status === "pending" || session.status === "done");
  const total = counted.length;
  if (total === 0) return { total: 0, done: 0, fraction: 0, line: "No study time planned yet", doneLine: "" };
  const done = counted.filter((session) => session.status === "done").length;
  const minutesLeft = counted.reduce((sum, session) => (session.status === "done" ? sum : sum + session.minutes), 0);
  const line = done < total ? `${count(total, "study session")} · ${formatMinutes(minutesLeft)} to go` : `${count(total, "study session")}, all done`;
  return { total, done, fraction: Math.max(0.03, done / total), line, doneLine: `${done} of ${total} done` };
}

/** How many exams "Coming up" lists before "Show all". */
export const COMING_UP_LIMIT = 5;

/** The rows "Coming up" shows while folded: five, or all of them when "Show all" would only bring one more. */
export function comingUpShown(total: number): number {
  return total <= COMING_UP_LIMIT + 1 ? Math.max(0, total) : COMING_UP_LIMIT;
}

/** Every exam and quiz of the view, the ones over included. */
export function allStudyExams(view: Pick<FreeStudyView, "exams" | "quizzes" | "past">): FreeExam[] {
  return [...view.exams, ...view.quizzes, ...view.past];
}

export function findStudyExam(view: Pick<FreeStudyView, "exams" | "quizzes" | "past">, key: string | undefined | null): FreeExam | null {
  return key ? allStudyExams(view).find((exam) => exam.key === key) ?? null : null;
}

export type ExamRef = { kind: "task"; taskId: string } | { kind: "prep"; prepId: string };

/** "task:<id>" / "prep:<id>" taken apart; null for anything else. */
export function parseExamKey(key: string | undefined | null): ExamRef | null {
  if (!key) return null;
  if (key.startsWith("task:") && key.length > 5) return { kind: "task", taskId: key.slice(5) };
  if (key.startsWith("prep:") && key.length > 5) return { kind: "prep", prepId: key.slice(5) };
  return null;
}

export interface ExamLinks {
  /** The tasks whose study sessions are this exam's. */
  sessionTaskIds: string[];
  /** The exam's own task (its date, time needed and difficulty are edited in the task's sheet); null for a prep with no exam task. */
  taskId: string | null;
  /** The exam prep made for it (a Pro tool), when there is one. */
  prepId: string | null;
}

/**
 * What an exam is made of. A prep's sessions come from its own study task and, when it is linked, the exam task's;
 * an exam task that has a prep counts the prep's study task too.
 */
export function examLinks(key: string | undefined | null, examPreps: readonly Pick<ExamPrep, "id" | "examTaskId">[]): ExamLinks | null {
  const ref = parseExamKey(key);
  if (!ref) return null;
  if (ref.kind === "prep") {
    const prep = examPreps.find((candidate) => candidate.id === ref.prepId);
    const taskId = prep?.examTaskId ?? null;
    return { sessionTaskIds: [runwayTaskId(ref.prepId), ...(taskId ? [taskId] : [])], taskId, prepId: ref.prepId };
  }
  const prep = examPreps.find((candidate) => candidate.examTaskId === ref.taskId);
  return { sessionTaskIds: [ref.taskId, ...(prep ? [runwayTaskId(prep.id)] : [])], taskId: ref.taskId, prepId: prep?.id ?? null };
}

/**
 * The exam a screen was opened for, even after its key changed under it. Building an exam prep for an exam's task
 * turns "task:<id>" into "prep:<id>" in the list, and deleting that prep turns it back; `lastTaskId` is the task
 * the screen last knew the exam by (a deleted prep no longer says which task it was for).
 */
export function resolveStudyExam(
  view: Pick<FreeStudyView, "exams" | "quizzes" | "past">,
  key: string | undefined | null,
  examPreps: readonly Pick<ExamPrep, "id" | "examTaskId">[],
  lastTaskId?: string | null,
): FreeExam | null {
  const direct = findStudyExam(view, key);
  if (direct) return direct;
  const links = examLinks(key, examPreps);
  if (!links) return null;
  const taskId = links.taskId ?? lastTaskId ?? null;
  const prepOfTask = taskId ? examPreps.find((candidate) => candidate.examTaskId === taskId) : undefined;
  const candidates = [links.prepId ? `prep:${links.prepId}` : null, prepOfTask ? `prep:${prepOfTask.id}` : null, taskId ? `task:${taskId}` : null];
  for (const candidate of candidates) {
    const found = candidate && candidate !== key ? findStudyExam(view, candidate) : null;
    if (found) return found;
  }
  return null;
}

export interface ExamSession {
  /** The block's id. */
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  minutes: number;
  status: ScheduleBlock["completionStatus"];
  title: string;
}

/** Every study session of these tasks in time order, whatever its state (the exam's screen ticks them off). */
export function examSessions(blocks: readonly ScheduleBlock[], taskIds: readonly string[]): ExamSession[] {
  const ids = new Set(taskIds);
  return blocks
    .filter((block) => block.type === "study" && block.taskId !== undefined && ids.has(block.taskId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
    .map((block) => ({
      id: block.id,
      date: block.date,
      startTime: block.startTime,
      endTime: block.endTime,
      minutes: Math.max(0, getDurationMinutes(block.startTime, block.endTime)),
      status: block.completionStatus,
      title: block.title,
    }));
}

/** "10:00 – 10:50 AM", "11:30 AM – 12:50 PM": AM or PM said once when both ends share it. */
export function timeRangeLabel(startTime: string, endTime: string): string {
  const start = formatTime(startTime);
  const end = formatTime(endTime);
  const period = (text: string) => / (AM|PM)$/i.exec(text)?.[1]?.toUpperCase() ?? "";
  return period(start) && period(start) === period(end) ? `${start.replace(/ (AM|PM)$/i, "")} – ${end}` : `${start} – ${end}`;
}

/** "Sat, Oct 3 · 9:00 – 10:20 AM" */
export function sessionWhen(session: Pick<ExamSession, "date" | "startTime" | "endTime">): string {
  const day = parseLocalDate(session.date);
  const date = Number.isNaN(day.getTime()) ? session.date : day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${date} · ${timeRangeLabel(session.startTime, session.endTime)}`;
}

/** The study tools that are part of Trajectory Pro, in the order the Study tab lists them. What each really does. */
export const STUDY_TOOLS = [
  { key: "prep", icon: "layers", title: "Exam prep", sub: "Topics, flashcards and a practice quiz for one exam" },
  { key: "guide", icon: "file", title: "Study guide", sub: "Made from your syllabus or from notes you paste" },
  { key: "practice", icon: "test", title: "Practice exam", sub: "Built from a study guide, to test yourself first" },
  { key: "review", icon: "refresh", title: "Test review", sub: "Photos of a graded test, with the mistakes explained" },
] as const;

export type StudyToolKey = (typeof STUDY_TOOLS)[number]["key"];
