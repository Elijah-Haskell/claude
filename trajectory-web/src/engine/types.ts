// ============================================================
// Trajectory Student Planner — Core Types
// ============================================================

export type DayOfWeek = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export type BlockType =
  | "class"
  | "study"
  | "sleep"
  | "buffer"
  | "work"
  | "recurring"
  | "free";

export type StudyStyle = "short_bursts" | "deep_blocks";
export type EnergyProfile = "morning" | "afternoon" | "night";

// ── Class / Hard Constraints ──────────────────────────────────

export interface ClassBlock {
  id: string;
  name: string;
  /** The short tag on chips and narrow blocks ("FINC"). Made from the name when the student has not set one (lib/week-layout.ts classShortName). */
  shortName?: string;
  days: DayOfWeek[];
  startTime: string; // "HH:MM" 24h
  endTime: string;   // "HH:MM" 24h
  location?: string;
  isAsynchronous?: boolean; // true only when the course has no recurring meeting time
  color: string;     // hex color for this course
}

// ── Recurring Events ──────────────────────────────────────────

export interface RecurringEvent {
  id: string;
  title: string;           // e.g., "Mass", "Club Meeting"
  description?: string;    // optional details
  days: DayOfWeek[];       // which days it repeats
  startTime: string;       // "HH:MM" 24h
  endTime: string;         // "HH:MM" 24h
  color: string;           // hex color
  locked: boolean;         // user cannot move/delete from schedule
  doNotSchedule?: boolean; // if true, scheduler will never place any blocks during this window
}

// ── Tasks (Homework) ──────────────────────────────────────────

export type TaskStatus = "pending" | "scheduled" | "done" | "skipped";

export type StudySessionPurpose = "preview" | "learn" | "practice" | "draft" | "review" | "submit";

/** AI may describe the academic work, but never owns a calendar timestamp. */
export interface PlannedStudySession {
  label: string;
  purpose: StudySessionPurpose;
  minutes: number;
  /** Preferred time before the deadline for this session, expressed in days. */
  targetDaysBeforeDue: number;
  /** Earliest useful lead time requested by the strategist, in days. */
  earliestDaysBeforeDue: number;
}

export interface TaskPlanningStrategy {
  rationale: string;
  priority: 1 | 2 | 3 | 4 | 5;
  sessions: PlannedStudySession[];
}

export interface Task {
  id: string;
  name: string;
  courseId: string;   // links to ClassBlock.id
  courseName: string;
  dueDate: string;    // ISO date string "YYYY-MM-DD"
  dueTime?: string;   // "HH:MM" optional
  notBeforeDate?: string; // earliest date the user has asked the planner to revisit this work
  estimatedMinutes: number;
  difficulty: 1 | 2 | 3 | 4 | 5;
  requiresOnCampus: boolean;
  status: TaskStatus;
  scheduledBlockId?: string;
  createdAt: string;
  priorityScore?: number;  // 0-100, computed by AI priority engine
  importance?: 1 | 2 | 3; // 1=low, 2=medium, 3=high (user-set)
  planningStrategy?: TaskPlanningStrategy;
  /** Minutes of planned study already completed (see lib/task-progress.ts). Unset = 0. */
  completedMinutes?: number;
  /** Explicit task kind (e.g. from the syllabus). When unset the planner infers it from the name (lib/task-kind.ts). */
  kind?: TaskKind;
  /** Share of the course grade this deliverable is worth (0-100), when the syllabus says so. Scoring uses it modestly. */
  weightPercent?: number;
  /** How the due date was established: read from the document, inferred from it (year / week number), or typed by the student. */
  dateConfidence?: "explicit" | "inferred" | "user";
  /** Short quote from the syllabus that the due date was taken from. */
  dateEvidence?: string;
  /** What the syllabus says an exam / quiz / project covers ("Topics 1-4"), so sessions can be scoped to it. */
  coversTopics?: string[];
  /** The syllabus import that created this task (see SyllabusImport.createdTaskIds). */
  syllabusImportId?: string;
  /**
   * Exam prep study time only (lib/exam-runway.ts): the exam / quiz task it prepares for. Every plan takes this
   * task's due date and time from that task, so moving the exam moves the prep (lib/exam-prep-link.ts).
   */
  examTaskId?: string;
}

/** Only "exam" and "quiz" tasks get retrieval-practice ("Practice Test") sessions. */
export type TaskKind = "exam" | "quiz" | "assignment" | "reading" | "project" | "other";

// ── Schedule Blocks ───────────────────────────────────────────

export interface ScheduleBlock {
  id: string;
  type: BlockType;
  title: string;
  date: string;       // "YYYY-MM-DD"
  startTime: string;  // "HH:MM" 24h
  endTime: string;    // "HH:MM" 24h
  locked: boolean;    // true = user cannot move/delete
  accepted: boolean;  // false = suggested (ghosted)
  taskId?: string;    // links to Task if type === "study"
  courseId?: string;  // links to ClassBlock if type === "class"
  color: string;
  completionStatus: "pending" | "done" | "skipped" | "missed";
  startRitual?: string;
  whatCountsAsDone?: string;
  ifThenPlan?: IfThenPlan;
  notificationId?: string; // expo-notifications identifier for the study reminder
  schedulingReason?: string; // brief 1-line explanation of why this slot was chosen
  /** True once the user has moved/edited this block; re-planning must not overwrite it. */
  userEdited?: boolean;
  /** ISO instant the user started this block (in progress); re-planning must not move it. */
  startedAt?: string;
  /** The named strategist session this block plays (e.g. "Learn: Topic"); lets a re-plan keep the other named sessions. */
  strategyLabel?: string;
  /**
   * Set on the sessions "Move to tomorrow" / "Defer this day" skipped: the student said "not this day", so every later
   * re-plan keeps new study off that date (lib/week-planner.ts planWindow). Undo restores the blocks without it.
   */
  deferredDay?: boolean;
  /**
   * Set when the AUTOMATIC re-plan recorded this session as missed (it ended unticked): it still counts as "behind"
   * (lib/replan.ts detectDrift) until the student re-plans or ticks it done. A re-plan the student runs clears it.
   */
  autoMissed?: boolean;
}

export interface IfThenPlan {
  obstacle: "phone" | "fatigue" | "social" | "too_hard" | "anxious" | "other";
  copingAction: string;
}

// ── Sleep window (stored as `healthPrefs` for backward compatibility) ──
// Only sleepTargetHours / bedtime / wakeTime are user-facing settings.
// Saves from older versions also carry meal* / workout* preferences and meal / workout blocks; the loader
// (lib/state-persistence.ts) drops them, so neither exists in the type any more.

export interface HealthPreferences {
  sleepTargetHours: number;
  bedtime: string;   // "HH:MM"
  wakeTime: string;  // "HH:MM"
}

// ── User Preferences ──────────────────────────────────────────

export interface UserPreferences {
  studyStyle: StudyStyle;
  energyProfile: EnergyProfile;
  noGoZones: Array<{ startTime: string; endTime: string }>;
  scheduleIntensity: number; // 0–100 (balanced=50, aggressive=100)
  /** Most study minutes the planner puts on one day (unset: derived from scheduleIntensity, see lib/workload-analysis.ts studyLoadCaps). */
  dailyStudyCapMinutes?: number;
  /** Most study minutes the planner puts in one Monday-Sunday week (unset: derived from scheduleIntensity). */
  weeklyStudyCapMinutes?: number;
}

// ── Semester ──────────────────────────────────────────────────

/** A break inside the semester (spring break, reading week, ...). Class meetings are not generated on its days. */
export interface SemesterBreak {
  name: string;
  startDate: string; // "YYYY-MM-DD" local date key, inclusive
  endDate: string;   // "YYYY-MM-DD" local date key, inclusive
}

/**
 * The term the student is planning. All dates are LOCAL calendar date keys ("YYYY-MM-DD"), inclusive.
 * Class meetings are only generated between startDate and endDate and never on a break day.
 */
export interface Semester {
  id: string;
  name: string;      // e.g. "Fall 2026"
  startDate: string; // first day of classes
  endDate: string;   // last day of the term (finals included)
  breaks: SemesterBreak[];
}

/**
 * The plan as it was just before a re-plan / AI change was applied, so it can be undone (see lib/replan.ts).
 * `classes`, `recurringEvents` and `healthPrefs` are only present when that change also touched them.
 */
export interface ReplanSnapshot {
  /** Short label shown in the Undo UI, e.g. "Catch up: replan the semester". */
  label: string;
  /** ISO instant the change was applied. */
  at: string;
  scheduleBlocks: ScheduleBlock[];
  tasks: Task[];
  classes?: ClassBlock[];
  recurringEvents?: RecurringEvent[];
  healthPrefs?: HealthPreferences;
  /** Automatic re-plan after an edit of the semester (null: there was none) / study settings: undo puts it back too. */
  semester?: Semester | null;
  userPrefs?: UserPreferences;
  /** The plan alerts before the change (restored by undo so the banners match the restored plan). */
  planAlerts?: PlanAlerts;
  /** What the change did, for the Undo UI ("3 sessions moved · 1 added"). */
  summary?: string;
  /** "auto" = the automatic re-plan after an ordinary edit (shown as "Plan updated"); otherwise a change the student applied. */
  source?: "auto" | "manual";
  /**
   * Automatic re-plan after the task list changed: `tasks` / `scheduleBlocks` are from before that edit, so Undo also
   * removes the task added, brings back the one deleted or puts the edited one back as it was.
   */
  taskEdit?: { kind: "added" | "removed" | "changed"; count: number };
}

/**
 * What the latest whole-semester plan could NOT do: work that does not fit before its deadline and work that is
 * already overdue. Derived data, refreshed by every plan; Week, Today and Tasks read it so they all give the
 * same honest capacity message (lib/plan-alerts.ts).
 */
export interface PlanAlerts {
  shortfalls: Array<{
    taskId: string;
    taskName: string;
    dueDate: string;
    requestedMinutes: number;
    placedMinutes: number;
    missingMinutes: number;
    overdue: boolean;
    reason: string;
  }>;
  /** `missedAssessment`: a quiz / exam that already happened; nothing is planned for it (mark it done or skipped). */
  overdueTasks: Array<{ taskId: string; taskName: string; dueDate: string; daysOverdue: number; missedAssessment?: boolean }>;
  /** ISO instant of the plan these were computed by. */
  computedAt: string;
}

// ── App State ─────────────────────────────────────────────────

export interface AppState {
  onboardingComplete: boolean;
  user?: User;
  /** The term being planned. Optional: saves from older versions have none (the planner then infers a horizon from task due dates). */
  semester?: Semester;
  /** Shortfalls / overdue work reported by the latest whole-semester plan (undefined before the first plan). */
  planAlerts?: PlanAlerts;
  /** The last few applied re-plans, newest first (max 3). UNDO_REPLAN restores the newest. */
  undoSnapshots?: ReplanSnapshot[];
  /**
   * Plan inputs as they were before the edits the next automatic re-plan will absorb (lib/app-context.tsx reducer;
   * never restored at launch). That re-plan's Undo puts them back together with the plan.
   */
  inputsBeforeEdit?: Partial<Pick<ReplanSnapshot, "classes" | "recurringEvents" | "healthPrefs" | "semester" | "userPrefs" | "tasks" | "scheduleBlocks">> & {
    /** Outside calendar events (Google or the iPhone's calendars) changed: they cannot be put back, so that re-plan offers no Undo. */
    calendarChanged?: boolean;
  };
  classes: ClassBlock[];
  recurringEvents: RecurringEvent[];
  tasks: Task[];
  scheduleBlocks: ScheduleBlock[];
  /** Sleep window (bedtime / wake time / sleep target) — a scheduling setting, not a health tracker. */
  healthPrefs: HealthPreferences;
  userPrefs: UserPreferences;
  grades: Grade[];
  recommendations: StudyRecommendation[];
  examPreps: ExamPrep[];
  studyGuides: SyllabusStudyGuide[];
  practiceExams: SyllabusPracticeExam[];
  notificationSettings: NotificationSettings;
  syllabusImports?: SyllabusImport[];
  googleCalendarEvents: GoogleCalendarEventLocal[]; // synced Google Calendar events
  googleCalendarConnected: boolean;  // whether Google Calendar is linked
  googleCalendarLastSync?: string;   // ISO timestamp of last sync
  /**
   * Events read on the phone from the iPhone calendars the student chose ("Plan around my iPhone calendars"). They
   * never leave the device. Busy time reads them together with Google events through busyCalendarEvents().
   */
  deviceCalendarEvents?: GoogleCalendarEventLocal[];
  /** The newest automatic change without Undo (outside calendar events changed). In memory only, never saved. */
  replanNotice?: ReplanNotice;
}

/**
 * A change the automatic re-plan made that cannot be undone: outside calendar events (Google, or the iPhone's
 * calendars) changed and sessions had to move. The Undo bar shows it like "Plan updated", without an Undo button
 * (components/undo-replan-bar.tsx). In memory only (lib/state-persistence.ts leaves it out).
 */
export interface ReplanNotice {
  label: string;
  /** What moved ("2 sessions moved · 0 conflicts"). */
  summary: string;
  /** ISO instant of the re-plan. */
  at: string;
}

// ── Defaults ──────────────────────────────────────────────────

export const DEFAULT_HEALTH_PREFS: HealthPreferences = {
  sleepTargetHours: 8,
  bedtime: "23:00",
  wakeTime: "07:00",
};

export const DEFAULT_USER_PREFS: UserPreferences = {
  studyStyle: "deep_blocks",
  energyProfile: "morning",
  noGoZones: [{ startTime: "22:00", endTime: "07:00" }],
  scheduleIntensity: 50,
};

export const COURSE_COLORS = [
  "#4F6EF7", // indigo
  "#8B5CF6", // purple
  "#EC4899", // pink
  "#F59E0B", // amber
  "#10B981", // emerald
  "#06B6D4", // cyan
  "#EF4444", // red
  "#84CC16", // lime
];

export const BLOCK_COLORS: Record<BlockType, string> = {
  class:     "#4F6EF7",
  study:     "#8B5CF6",
  sleep:     "#64748B",
  buffer:    "#94A3B8",
  work:      "#EC4899",
  recurring: "#06B6D4",
  free:      "#CBD5E1",
};

// User & Authentication

export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  currentSemester: string;
  targetGPA?: number;
  createdAt: string;
}

export interface Grade {
  id: string;
  classId: string;
  letterGrade: "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D+" | "D" | "F";
  numericGrade?: number;
  weight?: number;
  recordedAt: string;
}

export interface StudyRecommendation {
  id: string;
  type: "high_priority" | "at_risk" | "optimization" | "recovery";
  title: string;
  description: string;
  actionItems: string[];
  urgency: "low" | "medium" | "high";
  classId?: string;
  createdAt: string;
}

// ── Exam Prep Engine ─────────────────────────────────────────

export type MasteryLevel = "mastered" | "mostly_understood" | "needs_review";

export interface ExamTopic {
  id: string;
  title: string;
  description?: string;
  mastery: MasteryLevel;
  reviewCount: number;
  lastReviewedAt?: string;
}

export interface ExamStudyGuide {
  keyConcepts: string[];
  importantDefinitions: Array<{ term: string; definition: string }>;
  practiceQuestions: Array<{ question: string; answer: string }>;
  flashcards: Array<{ front: string; back: string }>;
  bigPictureSummary?: string;
  topicExpansions?: Array<{ title: string; explanation: string; keyPoints: string[]; commonMistakes: string }>;
  aiGenerated?: boolean;
  /** True when the pasted material was longer than the AI limit and only its beginning was used. */
  inputTruncated?: boolean;
  /** When the AI content was generated (ISO instant). */
  generatedAt?: string;
}

export interface ExamPrep {
  id: string;
  classId: string;
  className: string;
  subject?: string;           // display name for the exam subject
  examDate: string;           // "YYYY-MM-DD"
  examTime?: string;          // "HH:MM"
  topics: ExamTopic[];
  rawInput: string;           // user's pasted text
  uploadedFileUrl?: string;   // S3 URL of uploaded PDF/image
  uploadedImageUrls?: string[]; // S3 URLs of multiple uploaded images
  studyGuide?: ExamStudyGuide;
  studyBlockIds: string[];    // linked ScheduleBlock IDs
  finalReviewGenerated: boolean;
  createdAt: string;
  /**
   * The exam / quiz task (usually from the syllabus import) this prep is for. When set, that task's date and time are
   * the exam's and `examDate` / `examTime` only follow it (lib/exam-prep-link.ts). Unset for an exam added by hand.
   */
  examTaskId?: string;
}

// ── Schedule Reality Check ───────────────────────────────────

export interface RealityCheck {
  date: string;               // "YYYY-MM-DD"
  totalScheduledMinutes: number;
  availableMinutes: number;
  completionProbability: number; // 0–100
  overloadedBy: number;       // minutes over capacity
  suggestedMoves: Array<{
    blockId: string;
    blockTitle: string;
    suggestedDate: string;
  }>;
}

// ── Syllabus Study Materials ────────────────────────────────

export interface SyllabusTopic {
  title: string;
  week?: string;
  description: string;
  keyTerms: string[];
  importance: "high" | "medium" | "low";
}

export interface SyllabusStudyGuide {
  id: string;
  courseTitle: string;
  courseName?: string;    // links to ClassBlock.name
  examDate?: string;      // "YYYY-MM-DD"
  overview: string;
  topics: SyllabusTopic[];
  studyTips: string[];
  createdAt: string;
  syllabusFileName?: string;
  /** SyllabusImport.id this guide was built from (unset for pasted text). */
  sourceImportId?: string;
  /** What the guide was really built from (see lib/study-source.ts). Unset on guides saved by older versions. */
  sourceKind?: "syllabus_text" | "deadlines_only" | "pasted_text";
  /** True when the source text was longer than the AI limit, so only its beginning was used. */
  sourceTruncated?: boolean;
  /** Characters in the whole source text / characters actually sent to the AI. */
  sourceChars?: number;
  sourceUsedChars?: number;
}

export interface PracticeQuestion {
  type: "multiple_choice" | "short_answer" | "true_false";
  question: string;
  /** Multiple choice: exactly 4 plain option texts (no "A)" prefixes). Older saved exams may carry prefixes. */
  options?: string[];
  /**
   * Multiple choice: zero-based index (0-3) of the single correct option. THE scoring contract
   * (lib/practice-exam-scoring.ts). Older saved exams have none and use `answer` as a letter or the option text.
   */
  answerIndex?: number;
  /** Multiple choice: the correct option's text. True/false: "True" | "False". Short answer: a model answer. */
  answer: string;
  explanation: string;
  topic: string;
  difficulty: "easy" | "medium" | "hard";
}

export interface SyllabusPracticeExam {
  id: string;
  studyGuideId: string;   // links to SyllabusStudyGuide.id
  courseTitle: string;
  totalQuestions: number;
  estimatedMinutes: number;
  questions: PracticeQuestion[];
  createdAt: string;
  /** True when the study guide it was built from only covered part of a long syllabus. */
  sourceTruncated?: boolean;
}

// ── Syllabus Import History ────────────────────────────────

export interface SyllabusImportItem {
  name: string;
  dueDate: string;          // YYYY-MM-DD
  type: string;             // "assignment" | "exam" | "quiz" | "project" | "reading" | "other"
  difficulty?: number;      // 1-5
  estimatedMinutes?: number;
}

export interface SyllabusImport {
  id: string;
  importedAt: string;       // ISO datetime
  courseName: string;       // extracted course name from AI
  linkedClassId: string;    // ClassBlock.id it was linked to
  linkedClassName: string;  // display name
  itemCount: number;        // number of tasks added
  skippedCount: number;     // duplicates skipped
  isNewClass: boolean;      // true if a new class was auto-created
  /** Extracted items stored for AI context — deadlines, exams, assignments */
  extractedItems?: SyllabusImportItem[];
  /** Brief course description extracted from syllabus */
  courseDescription?: string;
  /** Full raw text of the uploaded syllabus document — used by AI for detailed Q&A */
  rawText?: string;
  /** The normalised extraction (JSON string, see lib/syllabus-extraction-utils.ts) this import was built from. */
  extractionJson?: string;
  /** Where the syllabus came from. */
  source?: "file" | "scan" | "paste";

  // ── Undo bookkeeping (see UNDO_SYLLABUS_IMPORT in lib/syllabus-import.ts) ──
  /** Ids of the tasks this import created. Undo removes exactly these (and their study blocks). */
  createdTaskIds?: string[];
  /** Id of the class this import created, if it had to create one. Undo removes it and its generated blocks. */
  createdClassId?: string;
  /** The class as it was before this import edited its meeting pattern or short name. Undo restores it. */
  previousClass?: ClassBlock;
  /** Tasks as they were before the student chose to overwrite them. Undo restores them. */
  overwrittenTasks?: Task[];
  /** Ids of the schedule blocks that existed for the created tasks/class when the import was applied (informational; undo matches by task/class). */
  createdBlockIds?: string[];
  /** Set when the import set or changed the semester. `semesterBefore` is null when there was none. Undo restores it. */
  semesterSetId?: string;
  semesterBefore?: Semester | null;
  /** The profile as it was when the import set the semester (setting a semester also labels the profile). */
  userBefore?: User | null;
  /** Items the student left out (no date / already past / unchecked), for the history screen. */
  excludedCount?: number;
  /** True when the AI study strategist was unavailable and default session plans were used. */
  strategyUnavailable?: boolean;
}

// ── Notification Settings ──────────────────────────────────

export interface ReminderTime {
  id: string;
  leadTimeHours: 1 | 6 | 12 | 24 | 48; // legacy preset (kept for backward compat)
  leadTimeMinutes?: number; // custom duration in minutes (overrides leadTimeHours when set)
  customHour?: number;   // optional: fire at this hour of day instead (0-23)
  customMinute?: number; // optional: fire at this minute (0-59)
  label?: string;        // user-facing label, e.g. "30 minutes before"
}

export interface NotificationSettings {
  enabled: boolean;
  leadTimeHours: 1 | 6 | 12 | 24 | 48; // legacy single reminder (kept for backward compat)
  reminders?: ReminderTime[];       // multiple reminders (overrides leadTimeHours when set)
  /** Also notify when a planned study session starts (Start / Snooze / Skip). Optional: older saves have none. */
  sessionStart?: boolean;
}

/**
 * Reminders are opt-in: the OS permission prompt is shown only when the user
 * turns the toggle on in Notification Settings, never as a side effect of
 * accepting a block.
 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  leadTimeHours: 24,
  reminders: [{ id: "default", leadTimeHours: 24 }],
};

// ── Google Calendar ─────────────────────────────────────────

export interface GoogleCalendarEventLocal {
  id: string;             // Google event ID
  calendarId: string;
  title: string;
  description?: string;
  startDate: string;      // "YYYY-MM-DD"
  endDate?: string;
  startTime?: string;     // "HH:MM" — undefined for all-day
  endTime?: string;
  isAllDay: boolean;
  isRecurring: boolean;
  status: "active" | "cancelled";
  syncedAt: string;       // ISO timestamp
  /** "device" = read from this iPhone's calendars; absent or "google" = synced from Google Calendar. */
  source?: "google" | "device";
}
