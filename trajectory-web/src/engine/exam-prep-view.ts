/**
 * What the Exam prep screens say and save, as pure functions (app/exam-prep.tsx, components/study/exam-prep-*.tsx,
 * flashcards-viewer.tsx and quiz-viewer.tsx): the tool's own list, the sheet that starts a prep (what is still
 * missing, and the ExamPrep it builds), one prep (its numbers, the study time line, what planning it would do), and
 * the quiz's steps and result. The screens only draw what these return.
 *
 * Which exams exist and how close they are comes from lib/study-hub.ts and lib/study-view.ts, so this list, the Study
 * tab and an exam's own screen always agree. Unit-tested in tests/exam-prep-view.test.ts.
 */
import { buildNotesOutline, examDateAdvice, parseTopicLines, type ExamDateAdvice } from "./exam-input";
import { matchExamTask, runwayTaskId } from "./exam-prep-link";
import { normalizeTopics } from "./exam-prep-plan";
import { formatMinutes, runwayOutcomeMessage, type RunwayPlan, type RunwayPreview, type RunwaySummary } from "./exam-runway";
import { prettyExamDate } from "./study-free-view";
import { buildStudyHub, type HubExam, type HubSyllabusExam } from "./study-hub";
import { examBadge } from "./study-view";
import type { BadgeTone } from "./task-list";
import type { ExamPrep, ExamStudyGuide, ExamTopic, MasteryLevel, ScheduleBlock, Task } from "./types";
import { dateKeyOf, formatTime } from "./utils";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]?\d|2[0-3]):[0-5]\d$/;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Names, dates, numbers ────────────────────────────────────────────────────

/** The words at the top of the tool's list and on its buttons. */
export const PREP_COPY = {
  eyebrow: "Study tools",
  title: "Exam prep",
  sub: "Topics, flashcards and a practice quiz for one exam.",
  yours: "Your exam preps",
  without: "Exams without one yet",
  newPrep: "New exam prep",
  build: "Build exam prep",
  emptyTitle: "No exams yet",
  emptySub: "Add an upcoming exam to get a study guide, flashcards and study sessions planned around your classes.",
  writing: "Writing your study material",
} as const;

/**
 * A prep's name and the class it is said with: "Exam 2" of "Principles of Finance". A prep with no subject of its own
 * is named by its class (the same rule as the Study tab, lib/study-free-view.ts freeExamFromPrep). `spoken` is the
 * one-line form, "Principles of Finance · Exam 2", so two exams of one class never read the same.
 */
export function prepName(exam: Pick<ExamPrep, "className" | "subject">): { name: string; courseName: string; spoken: string } {
  const subject = exam.subject && exam.subject !== exam.className ? exam.subject : "";
  return { name: subject || exam.className, courseName: subject ? exam.className : "", spoken: subject ? `${exam.className} · ${subject}` : exam.className };
}

/** "Wed, Oct 14", or "Wed, Oct 14 at 9:00 AM" when the exam has a start time. */
export function examWhen(date: string, time?: string | null): string {
  const clock = typeof time === "string" && CLOCK.test(time.trim()) && !/^0?0:00$/.test(time.trim()) ? ` at ${formatTime(time.trim())}` : "";
  return `${prettyExamDate(date)}${clock}`;
}

export interface TopicCounts {
  total: number;
  mastered: number;
  needsReview: number;
  /** 0..1 of the bar: mastered topics out of all topics. */
  fraction: number;
  /** "1 of 4 topics mastered" */
  line: string;
  /** "2 need review", or "" when none does. */
  reviewLine: string;
}

export function topicCounts(topics: readonly Pick<ExamTopic, "mastery">[] | undefined | null): TopicCounts {
  const list = Array.isArray(topics) ? topics : [];
  const total = list.length;
  const mastered = list.filter((topic) => topic.mastery === "mastered").length;
  const needsReview = list.filter((topic) => topic.mastery === "needs_review").length;
  return {
    total,
    mastered,
    needsReview,
    fraction: total > 0 ? mastered / total : 0,
    line: total === 0 ? "No topics yet" : `${mastered} of ${plural(total, "topic")} mastered`,
    reviewLine: needsReview === 0 ? "" : needsReview === 1 ? "1 needs review" : `${needsReview} need review`,
  };
}

/** The three answers to "How well do you know it?", weakest first (the order of the control). */
export const MASTERY_LEVELS: readonly MasteryLevel[] = ["needs_review", "mostly_understood", "mastered"];

/** A topic's state as its tag and as the control's option: the word and the tone it is drawn in. */
export function masteryTag(level: MasteryLevel): { label: string; tone: "green" | "gold" | "red" } {
  if (level === "mastered") return { label: "Mastered", tone: "green" };
  if (level === "mostly_understood") return { label: "Mostly", tone: "gold" };
  return { label: "Needs review", tone: "red" };
}

/** "Reviewed 3 times · last Oct 6", "Reviewed 1 time", or "Not reviewed yet". */
export function topicReviewLine(topic: Pick<ExamTopic, "reviewCount" | "lastReviewedAt">): string {
  const count = Math.max(0, Math.round(topic.reviewCount ?? 0));
  if (count === 0) return "Not reviewed yet";
  const last = topic.lastReviewedAt ? new Date(topic.lastReviewedAt) : null;
  const when = last && !Number.isNaN(last.getTime()) ? ` · last ${last.toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";
  return `Reviewed ${plural(count, "time")}${when}`;
}

// ── The list ─────────────────────────────────────────────────────────────────

export interface PrepRow {
  id: string;
  name: string;
  /** The class it is said with ("" when the prep is named by its class). */
  courseName: string;
  classId: string;
  /** The class as the prep saved it ("General" for none): how its class is found when the id no longer matches. */
  className: string;
  when: string;
  badge: { label: string; tone: BadgeTone };
  counts: TopicCounts;
  past: boolean;
  /** What a screen reader says for the row. */
  spoken: string;
}

export interface SyllabusRow {
  taskId: string;
  name: string;
  courseId: string;
  courseName: string;
  kind: "exam" | "quiz";
  when: string;
  badge: { label: string; tone: BadgeTone };
  spoken: string;
}

export interface ExamPrepList {
  /** Preps whose exam is still ahead (or has no known date), soonest first. */
  preps: PrepRow[];
  /** Preps whose exam is over, latest first. */
  past: PrepRow[];
  /** Upcoming exams that have no prep yet: tapping one starts a prep filled in from it. */
  exams: SyllabusRow[];
  /** The same for quizzes, listed apart so they do not crowd out the exams. */
  quizzes: SyllabusRow[];
  /** No prep at all and nothing to start one from. */
  empty: boolean;
}

function prepRow(item: HubExam): PrepRow {
  const { exam, timing } = item;
  const named = prepName(exam);
  const badge = examBadge(timing);
  const counts = topicCounts(exam.topics);
  const when = examWhen(exam.examDate, exam.examTime);
  return {
    id: exam.id,
    name: named.name,
    courseName: named.courseName,
    classId: exam.classId,
    className: exam.className,
    when,
    badge,
    counts,
    past: timing.status === "past",
    spoken: `${named.spoken}, ${when}, ${badge.label}. ${counts.line}`,
  };
}

function syllabusRow(item: HubSyllabusExam): SyllabusRow {
  const badge = examBadge(item.timing);
  const when = examWhen(item.dueDate, item.dueTime);
  const title = item.courseName ? `${item.courseName} · ${item.name}` : item.name;
  return {
    taskId: item.taskId,
    name: item.name,
    courseId: item.courseId,
    courseName: item.courseName ?? "",
    kind: item.kind,
    when,
    badge,
    spoken: `${title}, ${when}, ${badge.label}. Start an exam prep for it`,
  };
}

/** Everything the tool's own list shows, from the same hub the Study tab is built on. */
export function buildExamPrepList(state: Parameters<typeof buildStudyHub>[0], todayKey: string): ExamPrepList {
  const hub = buildStudyHub(state, todayKey);
  const syllabus = hub.syllabusExams.map(syllabusRow);
  return {
    preps: hub.upcoming.map(prepRow),
    past: hub.past.map(prepRow),
    exams: syllabus.filter((row) => row.kind === "exam"),
    quizzes: syllabus.filter((row) => row.kind === "quiz"),
    empty: hub.upcoming.length === 0 && hub.past.length === 0 && syllabus.length === 0,
  };
}

/** "Quizzes · 3", "Past · 2": the label of a part of the list that is folded behind a link. */
export function foldTitle(what: string, count: number): string {
  return `${what} · ${count}`;
}

// ── Starting one ─────────────────────────────────────────────────────────────

export interface PrepForm {
  /** "" = no class (saved as "General"). */
  classId: string;
  /** "YYYY-MM-DD", or "" while no date is chosen. */
  dateKey: string;
  /** "HH:MM", or "" for an exam with no start time. */
  time: string;
  /** One topic per line. */
  topics: string;
  /** Pasted notes (and the text taken from a Word or text file). */
  notes: string;
  /** The uploaded PDF. */
  fileUrl: string;
  /** Uploaded photos. */
  imageUrls: string[];
  /** The exam task (from the syllabus) the sheet was opened for. */
  linkedTaskId: string | null;
}

export const EMPTY_PREP_FORM: PrepForm = { classId: "", dateKey: "", time: "", topics: "", notes: "", fileUrl: "", imageUrls: [], linkedTaskId: null };

/**
 * What opening the sheet for an exam fills in: with its task (an exam from the syllabus) the class, date, start time
 * and the topics the syllabus lists; with only a class and a date (an older link), those. Only the fields named in
 * the result change; a class that no longer exists is not chosen.
 */
export function prepPrefill(
  prefill: { classId?: string; date?: string; taskId?: string } | undefined,
  tasks: readonly Task[],
  classes: readonly { id: string }[],
): Partial<PrepForm> {
  if (!prefill) return {};
  const task = prefill.taskId ? tasks.find((candidate) => candidate.id === prefill.taskId) : undefined;
  const classId = task?.courseId ?? prefill.classId;
  const date = task ? dateKeyOf(task.dueDate) : prefill.date;
  const patch: Partial<PrepForm> = {};
  if (classId && classes.some((cls) => cls.id === classId)) patch.classId = classId;
  else if (task) patch.classId = "";
  if (date && DATE_KEY.test(date)) patch.dateKey = date;
  if (!task) return patch;
  patch.linkedTaskId = task.id;
  patch.time = task.dueTime && /^\d{1,2}:\d{2}$/.test(task.dueTime) && task.dueTime !== "00:00" ? task.dueTime.padStart(5, "0") : "";
  patch.topics = normalizeTopics(task.coversTopics).join("\n");
  return patch;
}

/** The exam the sheet is linked to. The link holds only while the date is that exam's: another date is another exam. */
export function linkedExamTask<T extends Task>(form: Pick<PrepForm, "linkedTaskId" | "dateKey">, tasks: readonly T[]): T | undefined {
  return form.linkedTaskId ? tasks.find((task) => task.id === form.linkedTaskId && dateKeyOf(task.dueDate) === form.dateKey) : undefined;
}

/** "Calculus II · Midterm · from your syllabus": the line under the sheet's title for an exam from the syllabus. */
export function linkedExamLine(task: Pick<Task, "name" | "courseName"> | undefined): string {
  return task ? `${task.courseName ? `${task.courseName} · ` : ""}${task.name} · from your syllabus` : "";
}

export interface PrepFormCheck {
  canBuild: boolean;
  /** What is still missing, in words, for the line over the button; null when the prep can be built. */
  reason: string | null;
  /** A note about the chosen date that does not stop the build (the exam is today, or more than two weeks off). */
  advice: ExamDateAdvice | null;
}

/**
 * Whether "Build exam prep" can act: a date that has not passed, plus at least one of topics, notes or an upload.
 * An exam from the syllabus needs nothing more (its name stands in for the topics until some are added).
 */
export function prepFormCheck(form: PrepForm, ctx: { todayKey: string; uploading?: boolean; linked?: boolean }): PrepFormCheck {
  const advice = form.dateKey ? examDateAdvice(form.dateKey, ctx.todayKey) : null;
  const note = advice && advice.level === "info" ? advice : null;
  const stop = (reason: string): PrepFormCheck => ({ canBuild: false, reason, advice: note });
  if (ctx.uploading) return stop("Wait for the upload to finish");
  if (!form.dateKey) return stop("Choose the exam date");
  if (advice?.level === "blocked") return stop(advice.message);
  if (form.time.trim() !== "" && !CLOCK.test(form.time.trim())) return stop("Choose the start time again, or clear it");
  const hasInput = form.topics.trim().length > 0 || form.notes.trim().length > 0 || Boolean(form.fileUrl) || form.imageUrls.length > 0;
  if (!hasInput && !ctx.linked) return stop("Add topics, notes or material to study from");
  return { canBuild: true, reason: null, advice: note };
}

/**
 * The ExamPrep the sheet saves. It is linked to the exam task it is for (the one the sheet was opened for, else the
 * class's one exam on that date), so it follows that exam's date and time wherever the exam moves. With only a file
 * or notes and no typed topics, one placeholder topic lets the AI expand the material; an exam from the syllabus with
 * nothing typed is planned under its own name.
 */
export function newExamPrep(
  form: PrepForm,
  ctx: { classes: readonly { id: string; name: string }[]; tasks: readonly Task[]; id: () => string; now: Date },
): ExamPrep {
  const cls = form.classId ? ctx.classes.find((candidate) => candidate.id === form.classId) : undefined;
  const linked = linkedExamTask(form, ctx.tasks);
  const examTask = linked ?? matchExamTask(ctx.tasks, form.classId, form.dateKey);
  const parsed = parseTopicLines(form.topics);
  const hasMaterial = Boolean(form.fileUrl) || form.imageUrls.length > 0;
  const topicList = parsed.length > 0 ? parsed : linked && !hasMaterial && !form.notes.trim() ? [linked.name] : ["Topics from my material"];
  const topics: ExamTopic[] = topicList.map((title) => ({ id: ctx.id(), title, description: "", mastery: "needs_review", reviewCount: 0 }));
  const time = form.time.trim();
  return {
    id: ctx.id(),
    classId: form.classId || examTask?.courseId || "",
    className: cls?.name || examTask?.courseName || "General",
    subject: examTask?.name || cls?.name || topicList[0] || "Exam",
    examDate: form.dateKey,
    examTime: time ? time.padStart(5, "0") : undefined,
    ...(examTask ? { examTaskId: examTask.id } : {}),
    topics,
    rawInput: form.notes,
    uploadedFileUrl: form.fileUrl || form.imageUrls[0] || undefined,
    uploadedImageUrls: form.imageUrls.length > 0 ? form.imageUrls : undefined,
    // Only what the student wrote themselves; the AI study guide replaces it as soon as it is written.
    studyGuide: buildNotesOutline(form.notes, topics),
    studyBlockIds: [],
    finalReviewGenerated: false,
    createdAt: ctx.now.toISOString(),
  };
}

// ── One exam prep ────────────────────────────────────────────────────────────

/** Whether opening a prep should ask the AI for its material by itself: once, never for an exam that is over. */
export function shouldWriteMaterial(exam: Pick<ExamPrep, "topics" | "rawInput" | "uploadedFileUrl" | "uploadedImageUrls" | "studyGuide">, opts: { past: boolean; alreadyAsked: boolean }): boolean {
  const hasContent = exam.topics.length > 0 || Boolean(exam.rawInput?.trim()) || Boolean(exam.uploadedFileUrl) || (exam.uploadedImageUrls?.length ?? 0) > 0;
  return !exam.studyGuide?.aiGenerated && hasContent && !opts.past && !opts.alreadyAsked;
}

/** What ai.generateExamContent returns (the fields a prep keeps). */
export interface ExamMaterial {
  keyConcepts: string[];
  bigPictureSummary?: string;
  topicExpansions: NonNullable<ExamStudyGuide["topicExpansions"]>;
  importantDefinitions: ExamStudyGuide["importantDefinitions"];
  practiceQuestions: ExamStudyGuide["practiceQuestions"];
  flashcards: ExamStudyGuide["flashcards"];
  inputTruncated?: boolean;
}

/**
 * The prep with freshly written material. It is merged into the prep as it is NOW, so what the student marked on a
 * topic while waiting (and before, when the material is made again) is kept; a topic only gains a description when it
 * had none.
 */
export function withMaterial(latest: ExamPrep, material: ExamMaterial, now: Date): ExamPrep {
  const topics = latest.topics.map((topic) => {
    const expansion = material.topicExpansions.find((candidate) => candidate.title.toLowerCase() === topic.title.toLowerCase());
    return expansion && !topic.description ? { ...topic, description: expansion.explanation } : topic;
  });
  const studyGuide: ExamStudyGuide = {
    keyConcepts: material.keyConcepts,
    bigPictureSummary: material.bigPictureSummary,
    topicExpansions: material.topicExpansions,
    importantDefinitions: material.importantDefinitions,
    practiceQuestions: material.practiceQuestions,
    flashcards: material.flashcards,
    aiGenerated: true,
    inputTruncated: material.inputTruncated || undefined,
    generatedAt: now.toISOString(),
  };
  return { ...latest, topics, studyGuide };
}

export interface StudyTimeLine {
  /** "7 sessions planned · 4 h 45 min", "No study time planned yet", or for an exam that is over what that means. */
  text: string;
  /** "Replan them" / "Plan study time"; null for an exam that is over (nothing more is planned for it). */
  link: string | null;
  /** "Next: Wed, Sep 30 at 11:30 AM": the next session still ahead, when the plan has one. */
  next: string | null;
}

/**
 * The line under the progress bar. `summary` counts every session on the calendar for this exam (its prep's plan and
 * its exam task's own, lib/exam-runway.ts runwayScheduleSummary); `hasPlan` is whether the prep's own study task exists
 * and is still open, which is what makes the link a replan.
 */
export function studyTimeLine(
  summary: Pick<RunwaySummary, "sessions" | "minutes"> & { next?: Pick<ScheduleBlock, "date" | "startTime"> | null },
  opts: { hasPlan: boolean; past: boolean },
): StudyTimeLine {
  if (opts.past) return { text: "This exam is over. Your study materials are still here; no new study time is planned.", link: null, next: null };
  if (summary.sessions > 0) {
    const next = summary.next ? `Next: ${prettyExamDate(summary.next.date)} at ${formatTime(summary.next.startTime)}` : null;
    return { text: `${plural(summary.sessions, "session")} planned · ${formatMinutes(summary.minutes)}`, link: opts.hasPlan ? "Replan them" : "Plan study time", next };
  }
  return { text: "No study time planned yet", link: opts.hasPlan ? "Replan study time" : "Plan study time", next: null };
}

export interface PlanNote {
  tone: "blue" | "gold" | "green";
  /** "" when the sentence under it says everything. */
  title: string;
  body: string;
  /** "Add to my plan" / "Replan"; null when there is nothing to accept. */
  confirm: string | null;
  /** "Cancel" beside a confirm, "Close" on its own. */
  dismiss: string;
}

/**
 * What "Plan study time" / "Replan them" found, to show on the screen before anything changes: how many sessions
 * the planner would place (and what they replace), a warning when not all of it fits before the exam, or why there
 * is nothing to schedule. The sentences are lib/exam-runway.ts runwayOutcomeMessage's.
 */
export function planOfferNote(plan: RunwayPlan, preview: RunwayPreview | null, replanning: boolean): PlanNote {
  const outcome = runwayOutcomeMessage(plan, preview);
  if (plan.status !== "ready" || !plan.task) return { tone: "blue", title: outcome.title, body: outcome.body, confirm: null, dismiss: "Close" };
  const warning = outcome.tone === "warning";
  if (replanning) return { tone: warning ? "gold" : "blue", title: "Replan this exam's study time?", body: outcome.body, confirm: "Replan", dismiss: "Cancel" };
  // "Exam plan added" is said once it is (planDoneNote); until then the sentence itself is the offer.
  return { tone: warning ? "gold" : "blue", title: warning ? outcome.title : "", body: outcome.body, confirm: "Add to my plan", dismiss: "Cancel" };
}

/** Said once the student accepted the offer and the plan was rebuilt with it. */
export function planDoneNote(replanning: boolean): PlanNote {
  return { tone: "green", title: replanning ? "Plan updated" : "Exam plan added", body: "", confirm: null, dismiss: "Close" };
}

/** The facts the student is asked to confirm before a prep is deleted. */
export function deletePrepFacts(exam: Pick<ExamPrep, "examTaskId">): { title: string; body: string } {
  return {
    title: "Delete this exam prep?",
    body: exam.examTaskId
      ? "Its study materials and the study sessions it planned will be removed. Finished sessions and the exam itself stay, and the exam's own study sessions come back in your plan."
      : "Its study materials and any study sessions planned for it will be removed. Finished sessions are kept.",
  };
}

/** The calendar once a prep is deleted: the sessions its own plan placed go, the ones already finished stay. */
export function blocksAfterPrepDelete<T extends Pick<ScheduleBlock, "taskId" | "completionStatus">>(blocks: readonly T[], examId: string): T[] {
  const runwayId = runwayTaskId(examId);
  return blocks.filter((block) => block.taskId !== runwayId || block.completionStatus === "done");
}

export interface PracticeButtons {
  cards: { label: string; count: number };
  quiz: { label: string; count: number };
  /** Why a button is off, in words; null when both can open (or while the material is being written). */
  reason: string | null;
}

/** "Flashcards · 16" and "Quiz · 12": each is off while there is nothing to open, with the reason under them. */
export function practiceButtons(guide: Pick<ExamStudyGuide, "flashcards" | "practiceQuestions"> | undefined | null, opts: { writing?: boolean; hasAiGuide?: boolean } = {}): PracticeButtons {
  const cards = guide?.flashcards?.length ?? 0;
  const questions = guide?.practiceQuestions?.length ?? 0;
  // Where to get some: the Study guide tab has "Generate study guide" until the AI has written one; after that the
  // way is "Make the material again", behind the more button.
  const how = opts.hasAiGuide ? "Make the material again (the more button at the top) to get some." : "Generate the AI study guide (Study guide tab) to get some.";
  const reason = opts.writing
    ? cards + questions > 0 ? "They open again once the new material is written." : null
    : cards > 0 && questions > 0
      ? null
      : cards === 0 && questions === 0
        ? `No flashcards or practice questions yet. ${how}`
        : questions === 0
          ? `No practice questions yet. ${how}`
          : "No flashcards in this study guide.";
  return {
    cards: { label: cards > 0 ? `Flashcards · ${cards}` : "Flashcards", count: cards },
    quiz: { label: questions > 0 ? `Quiz · ${questions}` : "Quiz", count: questions },
    reason,
  };
}

/**
 * A topic's title as its row shows it. The row already says "TOPIC 2" over it, and the AI often writes the number
 * into the title too ("Topic 2: Financial Statement Analysis"): that prefix is left out. A title that is only the
 * prefix stays as it is.
 */
export function topicRowTitle(title: string): string {
  const stripped = title.replace(/^\s*topic\s+\d+\s*[:.\-–]\s*/i, "").trim();
  return stripped || title.trim();
}

export interface GuideIntro {
  title: string;
  body: string;
  /** "Generate study guide", or null while it is being written. */
  action: string | null;
}

/** The card at the top of the Study guide tab while there is no AI guide; null once there is one. */
export function guideIntro(guide: Pick<ExamStudyGuide, "aiGenerated" | "flashcards" | "importantDefinitions"> | undefined | null, writing: boolean): GuideIntro | null {
  if (guide?.aiGenerated) return null;
  if (writing) return { title: "Building your study guide", body: "The AI is expanding your topics, creating flashcards, and writing practice questions.", action: null };
  const fromNotes = Boolean(guide) && ((guide?.flashcards?.length ?? 0) > 0 || (guide?.importantDefinitions?.length ?? 0) > 0);
  return {
    title: "No AI study guide yet",
    body: fromNotes
      ? "Below is only what was pulled from your own notes. Generate the AI guide for explanations, flashcards and practice questions."
      : "Generate an AI study guide from your topics and material: explanations, flashcards and practice questions.",
    action: "Generate study guide",
  };
}

/** Definitions the AI wrote are "Definitions"; those lifted from the student's notes say so. */
export function definitionsTitle(guide: Pick<ExamStudyGuide, "aiGenerated"> | undefined | null): string {
  return guide?.aiGenerated ? "Definitions" : "Definitions from your notes";
}

// ── Flashcards and the quiz ──────────────────────────────────────────────────

/** "Card 3 of 16", "Question 4 of 12" (`index` counts from 0). */
export function stepLabel(what: "Card" | "Question", index: number, total: number): string {
  return `${what} ${Math.min(index + 1, Math.max(total, 1))} of ${total}`;
}

/** 0..1 of the bar under it: how far through the cards or questions this one is. */
export function stepFraction(index: number, total: number): number {
  return total > 0 ? Math.min(1, (index + 1) / total) : 0;
}

/** The card before or after this one; the first and the last stay where they are. */
export function cardStep(index: number, by: 1 | -1, total: number): number {
  return Math.max(0, Math.min(index + by, Math.max(total - 1, 0)));
}

export interface QuizState {
  /** The question on screen (0-based). */
  index: number;
  /** Its answer is showing. */
  revealed: boolean;
  /** Questions the student marked "I knew it". */
  score: number;
  /** Questions marked either way. */
  answered: number;
}

export const QUIZ_START: QuizState = { index: 0, revealed: false, score: 0, answered: 0 };

/** The student marks their own answer: the next question comes up, and the last one ends the quiz. */
export function quizMark(state: QuizState, knew: boolean, total: number): QuizState {
  return {
    index: state.index < total - 1 ? state.index + 1 : state.index,
    revealed: false,
    score: state.score + (knew ? 1 : 0),
    answered: state.answered + 1,
  };
}

export function quizFinished(state: Pick<QuizState, "answered">, total: number): boolean {
  return total > 0 && state.answered >= total;
}

/** The result leads with the count; the sentence under it is the advice the quiz always gave, at the same 80% line. */
export function quizResult(score: number, total: number): { headline: string; sentence: string } {
  return {
    headline: `${score} of ${total} correct`,
    sentence: total > 0 && score >= total * 0.8 ? "You are well prepared." : "Keep reviewing the weak topics.",
  };
}
