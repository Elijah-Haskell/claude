/**
 * AI Memory — Persistent user preferences and tendencies for the AI chatbot.
 *
 * Learns from the user's scheduling patterns, task habits, and explicit feedback
 * to make the AI feel more personalized over time.
 *
 * Stored in this browser's localStorage (lib/storage.ts appStorage) under "@trajectory/aiMemory", the key the
 * iPhone app uses in AsyncStorage.
 *
 * Learning is IDEMPOTENT: every observation (a task, a finished/skipped block) has a key, and a key that was
 * already learned from is ignored. The app replays completed work on every launch (its "what changed" effects
 * start from an empty list), so without this the counts grew on each launch and the memory soon claimed that
 * every student procrastinates. Evidence also decays (recent behaviour counts more) and every list is capped.
 * Memories written by the old replaying learners (no `version`) are rebuilt from scratch once.
 */

import { dateKeyOf, daysBetweenKeys, localDateKey } from "../engine/utils";
import { appStorage } from "./storage";

const STORAGE_KEY = "@trajectory/aiMemory";

/** Current memory schema. Anything older is discarded and relearned (see normalizeAIMemory). */
export const AI_MEMORY_VERSION = 2;
/** Most observation keys remembered (oldest dropped first). */
export const MAX_SEEN_KEYS = 3000;
/** Every new observation scales the existing evidence by this, so roughly the last ~50 observations dominate. */
export const EVIDENCE_DECAY = 0.98;
/** How much (decayed) evidence a conclusion needs before it is stated to the AI: about 3, 2 and 6 observations. */
const MIN_TIME_EVIDENCE = 2.5;
const MIN_LENGTH_EVIDENCE = 1.5;
const MIN_PROCRASTINATION_EVIDENCE = 5.5;
/** Share of tasks added within 2 days of their due date that counts as "tends to add tasks late". */
const PROCRASTINATION_SHARE = 0.6;
const MAX_LIST = 10;
/** Event types from features that were cut (health / meals / workouts); never repeated to the AI. */
const RETIRED_EVENT_TYPES = new Set(["workout", "meal", "health", "exercise", "gym"]);

export type StudyTimeOfDay = "morning" | "afternoon" | "evening" | "night";

/** The (decayed) observations behind the derived fields. */
export interface AIMemoryEvidence {
  timeOfDay: Record<StudyTimeOfDay, number>;
  studyMinutesSum: number;
  studyMinutesWeight: number;
  taskMinutesSum: number;
  taskMinutesWeight: number;
  /** Tasks added with a future due date, and how many of them were due within 2 days. */
  datedTasks: number;
  urgentTasks: number;
}

export interface AIMemory {
  /** How many times the user has used the AI chat (no longer inflated by learners; not sent to the AI). */
  sessionCount: number;

  /** Preferred study session length in minutes (learned from accepted blocks) */
  preferredStudyLengthMinutes: number | null;

  /** Preferred study times: "morning" | "afternoon" | "evening" | "night" */
  preferredStudyTime: StudyTimeOfDay | null;

  /** Whether the user tends to schedule tasks close to their due date */
  tendsToProcrastinate: boolean | null;

  /** Courses the user finds most difficult (based on difficulty ratings given) */
  hardCourses: string[];

  /** Courses the user finds easiest */
  easyCourses: string[];

  /** Average estimated minutes per task (used to calibrate AI estimates) */
  avgTaskMinutes: number | null;

  /** Most common event types the user adds (e.g. "work", "club") */
  commonEventTypes: string[];

  /** Free-form notes the AI has learned about the user */
  notes: string[];

  /** Timestamp of last update */
  lastUpdatedAt: string;

  /** Schema version (AI_MEMORY_VERSION). Missing = written by a pre-1.0.7 build: rebuilt once. */
  version?: number;
  /** Keys of the observations already learned from (bounded FIFO). */
  seen?: string[];
  /** Decayed evidence the derived fields are computed from. */
  evidence?: AIMemoryEvidence;
}

function emptyEvidence(): AIMemoryEvidence {
  return {
    timeOfDay: { morning: 0, afternoon: 0, evening: 0, night: 0 },
    studyMinutesSum: 0,
    studyMinutesWeight: 0,
    taskMinutesSum: 0,
    taskMinutesWeight: 0,
    datedTasks: 0,
    urgentTasks: 0,
  };
}

/** A fresh, empty memory. */
export function createEmptyAIMemory(now: Date = new Date()): AIMemory {
  return {
    sessionCount: 0,
    preferredStudyLengthMinutes: null,
    preferredStudyTime: null,
    tendsToProcrastinate: null,
    hardCourses: [],
    easyCourses: [],
    avgTaskMinutes: null,
    commonEventTypes: [],
    notes: [],
    lastUpdatedAt: now.toISOString(),
    version: AI_MEMORY_VERSION,
    seen: [],
    evidence: emptyEvidence(),
  };
}

// ── Normalisation / one-time repair ─────────────────────────────────────────

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const unique = [...new Set(value.filter((v): v is string => typeof v === "string" && v.trim().length > 0))];
  return unique.slice(-max);
}

function sanitizeEvidence(value: unknown): AIMemoryEvidence {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Partial<AIMemoryEvidence>;
  const tod = (typeof raw.timeOfDay === "object" && raw.timeOfDay !== null ? raw.timeOfDay : {}) as Partial<Record<StudyTimeOfDay, number>>;
  const evidence: AIMemoryEvidence = {
    timeOfDay: {
      morning: finiteNonNegative(tod.morning),
      afternoon: finiteNonNegative(tod.afternoon),
      evening: finiteNonNegative(tod.evening),
      night: finiteNonNegative(tod.night),
    },
    studyMinutesSum: finiteNonNegative(raw.studyMinutesSum),
    studyMinutesWeight: finiteNonNegative(raw.studyMinutesWeight),
    taskMinutesSum: finiteNonNegative(raw.taskMinutesSum),
    taskMinutesWeight: finiteNonNegative(raw.taskMinutesWeight),
    datedTasks: finiteNonNegative(raw.datedTasks),
    urgentTasks: finiteNonNegative(raw.urgentTasks),
  };
  evidence.urgentTasks = Math.min(evidence.urgentTasks, evidence.datedTasks);
  return evidence;
}

/** Recompute every derived field from the evidence (so they can never drift from it). */
function deriveFromEvidence(memory: AIMemory): AIMemory {
  const evidence = memory.evidence ?? emptyEvidence();
  const tod = evidence.timeOfDay;
  const todTotal = tod.morning + tod.afternoon + tod.evening + tod.night;
  const [bestTime] = (Object.entries(tod) as Array<[StudyTimeOfDay, number]>).sort((a, b) => b[1] - a[1])[0]!;
  return {
    ...memory,
    preferredStudyTime: todTotal >= MIN_TIME_EVIDENCE ? bestTime : null,
    preferredStudyLengthMinutes: evidence.studyMinutesWeight >= MIN_LENGTH_EVIDENCE
      ? Math.round(evidence.studyMinutesSum / evidence.studyMinutesWeight)
      : null,
    avgTaskMinutes: evidence.taskMinutesWeight > 0 ? Math.round(evidence.taskMinutesSum / evidence.taskMinutesWeight) : null,
    tendsToProcrastinate: evidence.datedTasks >= MIN_PROCRASTINATION_EVIDENCE
      ? evidence.urgentTasks / evidence.datedTasks >= PROCRASTINATION_SHARE
      : null,
  };
}

/**
 * Turn whatever is stored into a valid current-version memory. A memory without `version` was written by the
 * replaying learners (its counts and flags are inflated), so everything learned is discarded and relearned from
 * the app's history (the app replays completed work on launch; with idempotent learning that replay now counts
 * each item exactly once). Free-form notes are kept.
 */
export function normalizeAIMemory(raw: unknown, now: Date = new Date()): AIMemory {
  const base = createEmptyAIMemory(now);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
  const saved = raw as Partial<AIMemory>;
  const notes = stringList(saved.notes, 20);
  if (saved.version !== AI_MEMORY_VERSION) {
    return { ...base, notes };
  }
  const memory: AIMemory = {
    ...base,
    sessionCount: Math.min(finiteNonNegative(saved.sessionCount), 100_000),
    hardCourses: stringList(saved.hardCourses, MAX_LIST),
    easyCourses: stringList(saved.easyCourses, MAX_LIST),
    commonEventTypes: stringList(saved.commonEventTypes, MAX_LIST).filter((t) => !RETIRED_EVENT_TYPES.has(t.toLowerCase())),
    notes,
    lastUpdatedAt: typeof saved.lastUpdatedAt === "string" ? saved.lastUpdatedAt : base.lastUpdatedAt,
    seen: stringList(saved.seen, MAX_SEEN_KEYS),
    evidence: sanitizeEvidence(saved.evidence),
  };
  return deriveFromEvidence(memory);
}

// ── Pure learners (unit tested) ─────────────────────────────────────────────

function normText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function decay(evidence: AIMemoryEvidence): AIMemoryEvidence {
  const d = EVIDENCE_DECAY;
  return {
    timeOfDay: {
      morning: evidence.timeOfDay.morning * d,
      afternoon: evidence.timeOfDay.afternoon * d,
      evening: evidence.timeOfDay.evening * d,
      night: evidence.timeOfDay.night * d,
    },
    studyMinutesSum: evidence.studyMinutesSum * d,
    studyMinutesWeight: evidence.studyMinutesWeight * d,
    taskMinutesSum: evidence.taskMinutesSum * d,
    taskMinutesWeight: evidence.taskMinutesWeight * d,
    datedTasks: evidence.datedTasks * d,
    urgentTasks: evidence.urgentTasks * d,
  };
}

function remember(seen: string[], key: string): string[] {
  const next = [...seen, key];
  return next.length > MAX_SEEN_KEYS ? next.slice(next.length - MAX_SEEN_KEYS) : next;
}

function addToCappedList(list: string[], value: string): string[] {
  if (!value || list.includes(value)) return list;
  return [...list.slice(-(MAX_LIST - 1)), value];
}

export interface TaskObservation {
  /** Task id when known: the most reliable de-duplication key. */
  id?: string;
  name: string;
  courseName: string;
  estimatedMinutes: number;
  difficulty: number;
  dueDate: string;
}

export interface LearnTaskOptions {
  /**
   * "added": the student just added these tasks (AI chat confirm) — also feeds the "adds work close to its due
   * date" signal. "completed" (the default, the safe reading when a caller does not say): only course difficulty
   * and task length are learned (finishing close to a deadline says nothing about when the work was planned).
   */
  source?: "added" | "completed";
  now?: Date;
}

/** Stable key for a task observation (id when there is one, else its name/course/due date). */
export function taskObservationKey(task: TaskObservation, source: "added" | "completed"): string {
  const identity = task.id ? `id:${task.id}` : `${normText(task.name)}|${normText(task.courseName)}|${task.dueDate ?? ""}`;
  return `t:${source}:${identity}`;
}

/** Learn from tasks. Tasks already learned from (same key) are ignored, so replays change nothing. */
export function applyTaskObservations(memory: AIMemory, tasks: readonly TaskObservation[], options: LearnTaskOptions = {}): AIMemory {
  const source = options.source ?? "completed";
  const todayKey = localDateKey(options.now ?? new Date());
  let seen = memory.seen ?? [];
  let evidence = memory.evidence ?? emptyEvidence();
  let { hardCourses, easyCourses } = memory;
  let changed = false;

  for (const task of tasks) {
    const key = taskObservationKey(task, source);
    if (seen.includes(key)) continue;
    seen = remember(seen, key);
    changed = true;
    evidence = decay(evidence);

    if (Number.isFinite(task.estimatedMinutes) && task.estimatedMinutes > 0 && task.estimatedMinutes <= 24 * 60) {
      evidence.taskMinutesSum += task.estimatedMinutes;
      evidence.taskMinutesWeight += 1;
    }
    const course = task.courseName?.trim();
    if (course) {
      if (task.difficulty >= 4) {
        hardCourses = addToCappedList(hardCourses, course);
        easyCourses = easyCourses.filter((c) => c !== course);
      } else if (task.difficulty <= 2 && !hardCourses.includes(course)) {
        easyCourses = addToCappedList(easyCourses, course);
      }
    }
    // Lead time only means something when the work is being ADDED and its due date is still ahead.
    if (source === "added" && task.dueDate) {
      const days = daysBetweenKeys(todayKey, dateKeyOf(task.dueDate));
      if (Number.isFinite(days) && days >= 0) {
        evidence.datedTasks += 1;
        if (days <= 2) evidence.urgentTasks += 1;
      }
    }
  }
  if (!changed) return memory;
  return deriveFromEvidence({ ...memory, seen, evidence, hardCourses, easyCourses });
}

export interface BlockObservation {
  /** Block id (and date) when known: without them identical time slots on different days count once. */
  id?: string;
  date?: string;
  type: string;
  startTime: string; // "HH:MM" 24h
  endTime: string; // "HH:MM" 24h
  completionStatus: "done" | "skipped";
  courseName?: string;
}

/** Stable key for a block observation. */
export function blockObservationKey(block: BlockObservation): string {
  return block.id
    ? `b:${block.id}:${block.completionStatus}`
    : `b:${block.date ?? ""}|${block.type}|${block.startTime}|${block.endTime}|${block.completionStatus}`;
}

function timeOfDayOf(hour: number): StudyTimeOfDay {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/** Learn from one finished or skipped block. A block already learned from (same key) changes nothing. */
export function applyBlockObservation(memory: AIMemory, block: BlockObservation): AIMemory {
  if (block.type !== "study") return memory; // only learn from study blocks
  const key = blockObservationKey(block);
  const seen = memory.seen ?? [];
  if (seen.includes(key)) return memory;
  let evidence = memory.evidence ?? emptyEvidence();

  if (block.completionStatus === "done") {
    const [startH, startM] = block.startTime.split(":").map(Number);
    const [endH, endM] = block.endTime.split(":").map(Number);
    if ([startH, startM, endH, endM].every((n) => Number.isFinite(n))) {
      evidence = decay(evidence);
      evidence.timeOfDay[timeOfDayOf(startH!)] += 1;
      const durationMins = (endH! * 60 + endM!) - (startH! * 60 + startM!);
      if (durationMins > 0 && durationMins <= 240) {
        evidence.studyMinutesSum += durationMins;
        evidence.studyMinutesWeight += 1;
      }
    }
  }
  // A skip is remembered (so it is not replayed) but is not, on its own, evidence of anything.
  return deriveFromEvidence({ ...memory, seen: remember(seen, key), evidence });
}

/** Learn the kinds of events the student adds (a set: repeating it changes nothing). */
export function applyEventObservations(memory: AIMemory, events: ReadonlyArray<{ type: string }>): AIMemory {
  let commonEventTypes = memory.commonEventTypes;
  for (const ev of events) {
    const type = ev.type?.trim();
    if (!type || RETIRED_EVENT_TYPES.has(type.toLowerCase())) continue;
    commonEventTypes = addToCappedList(commonEventTypes, type);
  }
  return commonEventTypes === memory.commonEventTypes ? memory : { ...memory, commonEventTypes };
}

// ── Storage (serialised) ────────────────────────────────────────────────────

export async function loadAIMemory(): Promise<AIMemory> {
  try {
    const raw = await appStorage.getItem(STORAGE_KEY);
    return normalizeAIMemory(raw ? JSON.parse(raw) : null);
  } catch {
    return createEmptyAIMemory();
  }
}

export async function saveAIMemory(memory: AIMemory): Promise<void> {
  try {
    await appStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...memory,
      version: AI_MEMORY_VERSION,
      lastUpdatedAt: new Date().toISOString(),
    }));
  } catch {
    // ignore storage errors
  }
}

/**
 * Every read-modify-write goes through one queue: the app fires learners without awaiting them (one per block that
 * just finished), and parallel load/save pairs would overwrite each other. Nothing is written when nothing changed.
 */
let memoryQueue: Promise<unknown> = Promise.resolve();
function updateMemory(change: (memory: AIMemory) => AIMemory): Promise<void> {
  const run = memoryQueue.then(async () => {
    const raw = await appStorage.getItem(STORAGE_KEY).catch(() => null);
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const current = normalizeAIMemory(parsed);
    const next = change(current);
    // Also persist when the stored copy needed repair (old version / corrupt), so the repair happens once.
    const needsRepair = raw !== null && (typeof parsed !== "object" || parsed === null || (parsed as AIMemory).version !== AI_MEMORY_VERSION);
    if (next !== current || needsRepair) await saveAIMemory(next);
  });
  memoryQueue = run.catch(() => undefined);
  return run;
}

/**
 * Update memory based on a batch of tasks. Call it with `{ source: "added" }` after the user confirms tasks from
 * the AI chat, and with `{ source: "completed" }` (the default) when tasks are finished.
 */
export async function learnFromTasks(tasks: TaskObservation[], options: LearnTaskOptions = {}): Promise<void> {
  if (tasks.length === 0) return;
  await updateMemory((memory) => applyTaskObservations(memory, tasks, options));
}

/**
 * Update memory based on events the user just added.
 */
export async function learnFromEvents(events: Array<{ type: string; startTime?: string }>): Promise<void> {
  if (events.length === 0) return;
  await updateMemory((memory) => applyEventObservations(memory, events));
}

/**
 * Update memory based on a study block the user just completed or skipped.
 * Pass the block's `id` and `date` so the same block is never counted twice (the app replays finished blocks
 * on every launch). Safe to call repeatedly.
 */
export async function learnFromBlockCompletion(block: BlockObservation): Promise<void> {
  await updateMemory((memory) => applyBlockObservation(memory, block));
}

/** Batch form of learnFromBlockCompletion (one storage round trip for many blocks). */
export async function learnFromBlockCompletions(blocks: BlockObservation[]): Promise<void> {
  if (blocks.length === 0) return;
  await updateMemory((memory) => blocks.reduce(applyBlockObservation, memory));
}

/**
 * Build a concise memory context string to inject into the AI system prompt.
 */
export function buildMemoryContext(memory: AIMemory): string {
  const lines: string[] = [];

  if (memory.avgTaskMinutes !== null) {
    lines.push(`- Their tasks typically take around ${memory.avgTaskMinutes} minutes — use this to calibrate time estimates.`);
  }

  if (memory.hardCourses.length > 0) {
    lines.push(`- They find these courses challenging: ${[...new Set(memory.hardCourses)].join(", ")} — suggest more study time for these.`);
  }

  if (memory.easyCourses.length > 0) {
    lines.push(`- These courses come easily to them: ${[...new Set(memory.easyCourses)].join(", ")} — suggest less study time for these.`);
  }

  if (memory.tendsToProcrastinate === true) {
    lines.push(`- They tend to add tasks close to their due dates — gently encourage earlier scheduling when possible.`);
  }

  if (memory.preferredStudyTime !== null) {
    lines.push(`- They prefer studying in the ${memory.preferredStudyTime}.`);
  }

  if (memory.preferredStudyLengthMinutes !== null) {
    lines.push(`- Their finished study sessions usually last about ${memory.preferredStudyLengthMinutes} minutes.`);
  }

  if (memory.commonEventTypes.length > 0) {
    lines.push(`- They commonly schedule: ${[...new Set(memory.commonEventTypes)].join(", ")}.`);
  }

  if (memory.notes.length > 0) {
    lines.push(...memory.notes.map((n) => `- ${n}`));
  }

  if (lines.length === 0) return "";

  return `\nWhat you know about this student:\n${lines.join("\n")}`;
}
