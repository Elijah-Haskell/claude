/**
 * Data behind the Study tab and Exam Prep's hub tabs (pure). Everything date-related takes the student's
 * LOCAL date key. An exam prep linked to its exam task shows that task's current date (lib/exam-prep-link.ts).
 */
import type { AppState, ExamPrep, SyllabusPracticeExam, SyllabusStudyGuide, Task } from "./types";
import { classifyTaskKind } from "./task-kind";
import { examTiming, runwayScheduleSummary, type ExamTiming, type RunwaySummary } from "./exam-runway";
import { isExamTask, withLinkedExam } from "./exam-prep-link";
import { listStudySources } from "./study-source";
import { finishedByStudying } from "./task-progress";
import { dateKeyOf, timeToMinutes } from "./utils";

export interface HubExam {
  /** The prep with its exam task's current date and time (withLinkedExam). */
  exam: ExamPrep;
  timing: ExamTiming;
  totalTopics: number;
  masteredTopics: number;
  /** Every session on the calendar for this exam: its prep plan's and its exam task's own. */
  runway: RunwaySummary;
}

/** An exam or quiz that came from the syllabus import and has no exam prep yet. */
export interface HubSyllabusExam {
  taskId: string;
  name: string;
  courseId: string;
  courseName: string;
  dueDate: string;
  dueTime?: string;
  /** "exam" (exam, midterm, final, test) or "quiz": quizzes are listed apart so they don't crowd out the exams. */
  kind: "exam" | "quiz";
  timing: ExamTiming;
  /** Study sessions the plan already has for it from today on (the same count as Today's "N prep blocks planned"). */
  planned: { sessions: number; minutes: number };
}

export interface HubGuide {
  guide: SyllabusStudyGuide;
  hasPracticeExam: boolean;
}

export type HubEmptyState = "none" | "no_syllabus" | "no_exams";

export interface StudyHub {
  upcoming: HubExam[];
  past: HubExam[];
  syllabusExams: HubSyllabusExam[];
  guides: HubGuide[];
  stats: { exams: number; studiedTodayMinutes: number; masteredTopics: number; totalTopics: number };
  /**
   * "none": there is an upcoming exam (prepared or from the syllabus) to show.
   * "no_syllabus": no upcoming exam and no syllabus imported -> point at the one syllabus import.
   * "no_exams": a syllabus is imported but no upcoming exam is known -> offer to add one by hand.
   */
  emptyState: HubEmptyState;
  hasSyllabus: boolean;
}

type HubState = Pick<AppState, "examPreps" | "tasks" | "scheduleBlocks" | "studyGuides" | "practiceExams" | "syllabusImports">;

function safeArray<T>(value: readonly T[] | undefined | null): T[] {
  return Array.isArray(value) ? [...value] : [];
}

export function buildStudyHub(state: HubState, todayKey: string): StudyHub {
  const tasks = safeArray<Task>(state.tasks);
  const examPreps = safeArray<ExamPrep>(state.examPreps).map((exam) => withLinkedExam(exam, tasks));
  const blocks = safeArray(state.scheduleBlocks);
  const guidesRaw = safeArray<SyllabusStudyGuide>(state.studyGuides);
  const practice = safeArray<SyllabusPracticeExam>(state.practiceExams);

  const hubExams: HubExam[] = examPreps.map((exam) => {
    const topics = safeArray(exam.topics);
    return {
      exam,
      timing: examTiming(exam.examDate, todayKey),
      totalTopics: topics.length,
      masteredTopics: topics.filter((t) => t.mastery === "mastered").length,
      runway: runwayScheduleSummary(blocks, exam.id, todayKey, exam.examTaskId),
    };
  });
  const upcoming = hubExams
    .filter((e) => e.timing.status === "upcoming" || e.timing.status === "today" || e.timing.status === "invalid")
    .sort((a, b) => a.exam.examDate.localeCompare(b.exam.examDate));
  const past = hubExams
    .filter((e) => e.timing.status === "past")
    .sort((a, b) => b.exam.examDate.localeCompare(a.exam.examDate));

  // Exams and quizzes from the syllabus import that the student has not started preparing for.
  const coveredTasks = new Set(examPreps.flatMap((e) => (e.examTaskId ? [e.examTaskId] : [])));
  const covered = new Set(examPreps.map((e) => `${e.classId}|${e.examDate}`));
  const plannedFor = (taskId: string) => {
    const upcoming = blocks.filter((b) => b.type === "study" && b.taskId === taskId && b.date >= todayKey && b.completionStatus !== "done" && b.completionStatus !== "skipped");
    return { sessions: upcoming.length, minutes: upcoming.reduce((sum, b) => sum + Math.max(0, timeToMinutes(b.endTime) - timeToMinutes(b.startTime)), 0) };
  };
  const syllabusExams: HubSyllabusExam[] = tasks
    // An exam whose study sessions are all ticked off is "done" as a task, but the exam is still ahead: it stays.
    .filter((t) => t.status !== "skipped" && (t.status !== "done" || finishedByStudying(t, blocks)) && isExamTask(t))
    .map((t) => ({ task: t, dueDate: dateKeyOf(t.dueDate), timing: examTiming(dateKeyOf(t.dueDate), todayKey) }))
    .filter(({ task, dueDate, timing }) => (timing.status === "upcoming" || timing.status === "today") && !coveredTasks.has(task.id) && !covered.has(`${task.courseId}|${dueDate}`))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map(({ task, dueDate, timing }) => ({
      taskId: task.id,
      name: task.name,
      courseId: task.courseId,
      courseName: task.courseName,
      dueDate,
      ...(task.dueTime ? { dueTime: task.dueTime } : {}),
      kind: classifyTaskKind(task) === "quiz" ? ("quiz" as const) : ("exam" as const),
      timing,
      planned: plannedFor(task.id),
    }));

  const practiceGuideIds = new Set(practice.map((p) => p.studyGuideId));
  const guides: HubGuide[] = guidesRaw
    .filter((g) => g && typeof g.id === "string")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((guide) => ({ guide, hasPracticeExam: practiceGuideIds.has(guide.id) }));

  const studiedTodayMinutes = blocks
    .filter((b) => b.type === "study" && b.date === todayKey && b.completionStatus === "done")
    .reduce((sum, b) => sum + Math.max(0, timeToMinutes(b.endTime) - timeToMinutes(b.startTime)), 0);
  const totalTopics = hubExams.reduce((sum, e) => sum + e.totalTopics, 0);
  const masteredTopics = hubExams.reduce((sum, e) => sum + e.masteredTopics, 0);

  const hasSyllabus = listStudySources(state.syllabusImports).length > 0;
  const emptyState: HubEmptyState = upcoming.length > 0 || syllabusExams.length > 0 ? "none" : hasSyllabus ? "no_exams" : "no_syllabus";

  return {
    upcoming,
    past,
    syllabusExams,
    guides,
    stats: { exams: examPreps.length, studiedTodayMinutes, masteredTopics, totalTopics },
    emptyState,
    hasSyllabus,
  };
}

/**
 * Everything the student can practise with, for Exam Prep's "Practice" tab: practice exams built from a
 * syllabus study guide (app/practice-exam.tsx) and the practice quizzes inside an exam's AI study guide.
 */
export type PracticeEntry =
  | { kind: "practice_exam"; key: string; guideId: string; title: string; questionCount: number; estimatedMinutes: number; createdAt: string }
  | { kind: "exam_quiz"; key: string; examId: string; title: string; questionCount: number; examDate: string };

type PracticeState = Pick<AppState, "practiceExams" | "examPreps">;

export function buildPracticeList(state: PracticeState): PracticeEntry[] {
  // app/practice-exam.tsx opens the FIRST practice exam saved for a guide, so list one per guide.
  const seenGuides = new Set<string>();
  const saved: PracticeEntry[] = safeArray<SyllabusPracticeExam>(state.practiceExams)
    .filter((p) => p && typeof p.studyGuideId === "string" && Array.isArray(p.questions) && p.questions.length > 0)
    .filter((p) => (seenGuides.has(p.studyGuideId) ? false : (seenGuides.add(p.studyGuideId), true)))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((p) => ({
      kind: "practice_exam",
      key: `pe-${p.id}`,
      guideId: p.studyGuideId,
      title: p.courseTitle,
      questionCount: p.questions.length,
      estimatedMinutes: p.estimatedMinutes,
      createdAt: p.createdAt,
    }));
  const quizzes: PracticeEntry[] = safeArray<ExamPrep>(state.examPreps)
    .filter((e) => e && (e.studyGuide?.practiceQuestions?.length ?? 0) > 0)
    .sort((a, b) => a.examDate.localeCompare(b.examDate))
    .map((e) => ({
      kind: "exam_quiz",
      key: `eq-${e.id}`,
      examId: e.id,
      title: e.subject && e.subject !== e.className ? `${e.className} · ${e.subject}` : e.className,
      questionCount: e.studyGuide!.practiceQuestions.length,
      examDate: e.examDate,
    }));
  return [...saved, ...quizzes];
}
