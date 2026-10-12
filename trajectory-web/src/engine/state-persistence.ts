import {
  AppState,
  ClassBlock,
  DEFAULT_HEALTH_PREFS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_USER_PREFS,
  GoogleCalendarEventLocal,
  HealthPreferences,
  NotificationSettings,
  PlanAlerts,
  ScheduleBlock,
  Semester,
  SyllabusImport,
  UserPreferences,
} from "./types";
import { validateSemester } from "./semester";

/**
 * AsyncStorage key holding the app snapshot: this iPhone's own copy of the plan, which the screens always work from.
 * The plan is also saved to the account (lib/plan-snapshot.ts says which part of the snapshot).
 */
export const APP_STATE_STORAGE_KEY = "trajectory_app_state_v1";

/** The state a fresh install starts from (and what signing out / account deletion resets to). */
export function createInitialState(): AppState {
  return {
    onboardingComplete: false,
    user: undefined,
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
    deviceCalendarEvents: [],
  };
}

/** The app snapshot as written to disk: AppState with the iPhone's calendar events packed (packDeviceEvents). */
export type PersistedAppState = Omit<AppState, "undoSnapshots" | "replanNotice" | "deviceCalendarEvents"> & {
  deviceCalendarEvents?: PackedDeviceEvents;
};

/**
 * Remove fields that cannot survive a process restart, and pack what is bulky.
 *  - Notification ids belong to the OS session.
 *  - Undo snapshots are in-memory only: each holds a whole copy of the schedule (a full semester is thousands
 *    of blocks), and restoring a snapshot from an earlier session would silently discard everything done since.
 *  - The "Plan updated for calendar changes" notice (lib/app-context.tsx) is only news while the app is open.
 *  - The events read from the iPhone's calendars are saved packed (packDeviceEvents).
 */
export function toLocalPersistedState(state: AppState): PersistedAppState {
  const { undoSnapshots: _undoSnapshots, replanNotice: _replanNotice, deviceCalendarEvents, ...persisted } = state;
  return {
    ...persisted,
    scheduleBlocks: state.scheduleBlocks.map((block) => ({ ...block, notificationId: undefined })),
    ...(deviceCalendarEvents ? { deviceCalendarEvents: packDeviceEvents(deviceCalendarEvents) } : {}),
  };
}

// ── iPhone calendar events on disk ────────────────────────────

/**
 * The events read from the iPhone's calendars as saved. The whole snapshot is written again on every change, and 1,500
 * events saved as full objects took it from 256 KB to 771 KB (1.0.9 audit). Only what busy time, conflict labels and
 * the Week / Today screens read is kept: calendarId, syncedAt and description are dropped (source and status come back
 * on load), and the ids and titles that a repeating event's occurrences share are saved once.
 */
export interface PackedDeviceEvents {
  /** Format version. */
  v: 1;
  /** Distinct event ids without their "@<start instant>" occurrence suffix (lib/device-calendars.ts toDeviceBusyEvents). */
  ids: string[];
  /** Distinct titles. */
  titles: string[];
  events: PackedDeviceEvent[];
}

/**
 * One occurrence: [index in `ids`, index in `titles`, the id's start instant in epoch ms (null: the id has no such
 * suffix), startDate, endDate (0: the start date, null: none), startTime (null: none), endTime (null: none),
 * flags (1 all-day, 2 repeating, 4 cancelled)].
 */
type PackedDeviceEvent = [number, number, number | null, string, string | 0 | null, string | null, string | null, number];

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The id split into the part its occurrences share and the start instant it ends with ("<id>@<ISO instant>"). */
function splitOccurrenceId(id: string): { base: string; instant: number | null } {
  const at = id.lastIndexOf("@");
  const suffix = at >= 0 ? id.slice(at + 1) : "";
  const instant = ISO_INSTANT.test(suffix) ? Date.parse(suffix) : NaN;
  return Number.isFinite(instant) && new Date(instant).toISOString() === suffix ? { base: id.slice(0, at), instant } : { base: id, instant: null };
}

/** Device calendar events in their saved form (restored exactly by unpackDeviceEvents, apart from the dropped fields). */
export function packDeviceEvents(events: readonly GoogleCalendarEventLocal[]): PackedDeviceEvents {
  const ids: string[] = [];
  const titles: string[] = [];
  const idIndex = new Map<string, number>();
  const titleIndex = new Map<string, number>();
  const indexOf = (value: string, list: string[], index: Map<string, number>) => {
    let at = index.get(value);
    if (at === undefined) {
      at = list.push(value) - 1;
      index.set(value, at);
    }
    return at;
  };
  const packed = events.map((event): PackedDeviceEvent => {
    const { base, instant } = splitOccurrenceId(event.id);
    const flags = (event.isAllDay ? 1 : 0) | (event.isRecurring ? 2 : 0) | (event.status === "cancelled" ? 4 : 0);
    const endDate = event.endDate === undefined ? null : event.endDate === event.startDate ? 0 : event.endDate;
    return [indexOf(base, ids, idIndex), indexOf(event.title, titles, titleIndex), instant, event.startDate, endDate, event.startTime ?? null, event.endTime ?? null, flags];
  });
  return { v: 1, ids, titles, events: packed };
}

/** The saved form back as events (source "device"); malformed entries are dropped. */
export function unpackDeviceEvents(value: Pick<PackedDeviceEvents, "ids" | "titles" | "events">): GoogleCalendarEventLocal[] {
  const out: GoogleCalendarEventLocal[] = [];
  for (const entry of asArray<unknown>(value.events, [])) {
    if (!Array.isArray(entry)) continue;
    const [idAt, titleAt, instant, startDate, endDate, startTime, endTime, flags] = entry as Partial<PackedDeviceEvent>;
    const base = typeof idAt === "number" ? value.ids[idAt] : undefined;
    const title = typeof titleAt === "number" ? value.titles[titleAt] : undefined;
    if (typeof base !== "string" || typeof title !== "string" || typeof startDate !== "string") continue;
    const bits = typeof flags === "number" ? flags : 0;
    const event: GoogleCalendarEventLocal = {
      id: typeof instant === "number" && Number.isFinite(instant) ? `${base}@${new Date(instant).toISOString()}` : base,
      calendarId: "",
      title,
      startDate,
      isAllDay: (bits & 1) !== 0,
      isRecurring: (bits & 2) !== 0,
      status: (bits & 4) !== 0 ? "cancelled" : "active",
      syncedAt: "",
      source: "device",
    };
    if (endDate === 0) event.endDate = startDate;
    else if (typeof endDate === "string") event.endDate = endDate;
    if (typeof startTime === "string") event.startTime = startTime;
    if (typeof endTime === "string") event.endTime = endTime;
    out.push(event);
  }
  return out;
}

/** Block types that existed in older snapshots but are no longer generated or shown. */
const REMOVED_BLOCK_TYPES = new Set<string>(["meal", "workout"]);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

function sanitizeHealthPrefs(value: unknown): HealthPreferences {
  // Only the sleep window is a user setting now; meal*/workout* values from old
  // snapshots are dropped and replaced with the scheduler defaults.
  const saved = isRecord(value) ? value : {};
  const hours = typeof saved.sleepTargetHours === "number" && saved.sleepTargetHours >= 3 && saved.sleepTargetHours <= 14
    ? saved.sleepTargetHours
    : DEFAULT_HEALTH_PREFS.sleepTargetHours;
  return {
    ...DEFAULT_HEALTH_PREFS,
    sleepTargetHours: hours,
    bedtime: typeof saved.bedtime === "string" && HHMM.test(saved.bedtime) ? saved.bedtime : DEFAULT_HEALTH_PREFS.bedtime,
    wakeTime: typeof saved.wakeTime === "string" && HHMM.test(saved.wakeTime) ? saved.wakeTime : DEFAULT_HEALTH_PREFS.wakeTime,
  };
}

function sanitizeNotificationSettings(value: unknown): NotificationSettings {
  if (!isRecord(value)) return DEFAULT_NOTIFICATION_SETTINGS;
  return { ...DEFAULT_NOTIFICATION_SETTINGS, ...(value as Partial<NotificationSettings>) };
}

function sanitizeUserPrefs(value: unknown): UserPreferences {
  return isRecord(value) ? { ...DEFAULT_USER_PREFS, ...(value as Partial<UserPreferences>) } : DEFAULT_USER_PREFS;
}

/** A saved semester that is malformed or inconsistent is dropped (the planner then infers its horizon from due dates). */
function sanitizeSemester(value: unknown): Semester | undefined {
  if (!isRecord(value)) return undefined;
  const result = validateSemester(value as unknown as Semester);
  return result.ok ? result.semester : undefined;
}

/** Plan alerts are derived data: anything malformed is dropped and the next plan rewrites them. */
function sanitizePlanAlerts(value: unknown): PlanAlerts | undefined {
  if (!isRecord(value) || !Array.isArray(value.shortfalls) || !Array.isArray(value.overdueTasks)) return undefined;
  const valid = (item: unknown) => isRecord(item) && typeof item.taskId === "string";
  return {
    shortfalls: (value.shortfalls as PlanAlerts["shortfalls"]).filter(valid),
    overdueTasks: (value.overdueTasks as PlanAlerts["overdueTasks"]).filter(valid),
    computedAt: typeof value.computedAt === "string" ? value.computedAt : "",
  };
}

/**
 * What older snapshots kept on a class for a feature that is gone: the grade weights of the removed Grades screen.
 * Dropped on load, so they are neither kept on this iPhone nor written into the plan saved to the account.
 */
const REMOVED_CLASS_FIELDS = ["gradeComponents"] as const;

function hasRemovedClassField(cls: unknown): cls is Record<string, unknown> {
  return isRecord(cls) && REMOVED_CLASS_FIELDS.some((field) => field in cls);
}

function withoutRemovedClassFields<T>(cls: T): T {
  if (!hasRemovedClassField(cls)) return cls;
  const kept: Record<string, unknown> = { ...cls };
  for (const field of REMOVED_CLASS_FIELDS) delete kept[field];
  return kept as T;
}

/** The classes as saved, without the removed fields. The same list when no class carries one. */
function sanitizeClasses(value: unknown, fallback: ClassBlock[]): ClassBlock[] {
  const classes = asArray<ClassBlock>(value, fallback);
  return classes.some(hasRemovedClassField) ? classes.map(withoutRemovedClassFields) : classes;
}

/**
 * The syllabus imports as saved. An import that edited a class keeps a copy of that class as it was, for its undo
 * (`previousClass`): the removed fields are dropped from that copy too, or undoing the import would bring them back.
 */
function sanitizeImports(value: unknown, fallback: SyllabusImport[]): SyllabusImport[] {
  const imports = asArray<SyllabusImport>(value, fallback);
  const carries = (entry: unknown) => isRecord(entry) && hasRemovedClassField(entry.previousClass);
  return imports.some(carries)
    ? imports.map((entry) => (carries(entry) ? { ...entry, previousClass: withoutRemovedClassFields(entry.previousClass) } : entry))
    : imports;
}

function sanitizeBlocks(value: unknown): ScheduleBlock[] {
  return asArray<ScheduleBlock>(value, [])
    .filter((block) => isRecord(block) && !REMOVED_BLOCK_TYPES.has(String((block as ScheduleBlock).type)))
    .map((block) => ({ ...block, notificationId: undefined }));
}

/**
 * Events read from the iPhone's calendars (they never leave the phone). Kept across launches so the first plan after a
 * launch already avoids them, instead of planning without them and moving sessions again a few seconds later when the
 * refresher has read the calendars. Saved packed (packDeviceEvents); snapshots written before 1.0.9 hold full objects.
 * Malformed entries are dropped.
 */
function sanitizeDeviceEvents(value: unknown): GoogleCalendarEventLocal[] {
  if (isRecord(value)) {
    return value.v === 1 && Array.isArray(value.ids) && Array.isArray(value.titles)
      ? unpackDeviceEvents(value as unknown as PackedDeviceEvents)
      : [];
  }
  return asArray<GoogleCalendarEventLocal>(value, [])
    .filter((event) => isRecord(event) && typeof event.id === "string" && typeof event.startDate === "string")
    .map((event) => (event.source === "device" ? event : { ...event, source: "device" as const }));
}

/**
 * Turn whatever was saved on disk into a valid AppState. Tolerates snapshots
 * written by older versions: removed keys (journalEntries, notes, goals,
 * insights, isLoggedIn, focusSession, healthPrefs.meal*, a class's
 * gradeComponents, ...) are ignored and missing keys fall back to defaults.
 * Never throws.
 */
export function restorePersistedState(saved: unknown, base: AppState = createInitialState()): AppState {
  if (!isRecord(saved)) return base;
  return {
    ...base,
    onboardingComplete: saved.onboardingComplete === true,
    user: isRecord(saved.user) ? (saved.user as unknown as AppState["user"]) : undefined,
    semester: sanitizeSemester(saved.semester),
    planAlerts: sanitizePlanAlerts(saved.planAlerts),
    undoSnapshots: undefined,
    classes: sanitizeClasses(saved.classes, base.classes),
    recurringEvents: asArray(saved.recurringEvents, base.recurringEvents),
    tasks: asArray(saved.tasks, base.tasks),
    scheduleBlocks: sanitizeBlocks(saved.scheduleBlocks),
    healthPrefs: sanitizeHealthPrefs(saved.healthPrefs),
    userPrefs: sanitizeUserPrefs(saved.userPrefs),
    grades: asArray(saved.grades, base.grades),
    recommendations: asArray(saved.recommendations, base.recommendations),
    examPreps: asArray(saved.examPreps, base.examPreps),
    studyGuides: asArray(saved.studyGuides, base.studyGuides),
    practiceExams: asArray(saved.practiceExams, base.practiceExams),
    notificationSettings: sanitizeNotificationSettings(saved.notificationSettings),
    syllabusImports: sanitizeImports(saved.syllabusImports, base.syllabusImports ?? []),
    googleCalendarEvents: asArray(saved.googleCalendarEvents, base.googleCalendarEvents),
    googleCalendarConnected: saved.googleCalendarConnected === true,
    googleCalendarLastSync: typeof saved.googleCalendarLastSync === "string" ? saved.googleCalendarLastSync : undefined,
    deviceCalendarEvents: sanitizeDeviceEvents(saved.deviceCalendarEvents),
  };
}

/** Parse a raw AsyncStorage value; a missing or corrupt value yields null so callers keep their defaults. */
export function parsePersistedState(raw: string | null | undefined): AppState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? restorePersistedState(parsed) : null;
  } catch {
    return null;
  }
}

// ── Writer ────────────────────────────────────────────────────

/** Quiet period before a change is written (a burst of taps / dispatches costs one write). */
export const PERSIST_DEBOUNCE_MS = 400;

export interface PersistStorage {
  setItem(key: string, value: string): Promise<void>;
}

export interface StatePersister {
  /** Remember `state` as the newest snapshot and write it after the quiet period. */
  schedule(state: AppState): void;
  /**
   * Write the newest scheduled snapshot now (app going to the background). Resolves when the write is over: true when
   * that snapshot is on disk, false when it could not be written (a plan loaded from the account must not count as
   * loaded then, lib/plan-sync-engine.ts). With nothing scheduled, the outcome of the last write.
   */
  flush(): Promise<boolean>;
  /**
   * Forget a scheduled snapshot without writing it (signing out / account deletion: nothing may reappear), and forget
   * what was written last: the copy on disk is about to be erased, so the same snapshot is written again if it returns.
   */
  cancel(): void;
  /** True while a snapshot is waiting for its quiet period to end. */
  hasPending(): boolean;
  /** Resolves when no write is in flight (e.g. before wiping storage, so a late write cannot restore data). */
  idle(): Promise<void>;
}

/**
 * The single writer of the app snapshot. Guarantees:
 *  - debounced: many changes inside `debounceMs` produce one write of the LAST state;
 *  - never concurrent and never out of order: writes run one after another, and each takes the newest snapshot
 *    at the moment it starts, so an older state can never land on disk after a newer one;
 *  - flush() writes immediately (used when iOS moves the app to the background, where it may be killed
 *    without further notice) and resolves once that write is done;
 *  - an identical snapshot is not written twice.
 * Storage errors are swallowed (the next change retries); the key and the snapshot format are unchanged.
 */
export function createStatePersister(options: {
  storage: PersistStorage;
  key?: string;
  debounceMs?: number;
  serialize?: (state: AppState) => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): StatePersister {
  const key = options.key ?? APP_STATE_STORAGE_KEY;
  const debounceMs = options.debounceMs ?? PERSIST_DEBOUNCE_MS;
  const serialize = options.serialize ?? ((state: AppState) => JSON.stringify(toLocalPersistedState(state)));
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let pending: AppState | null = null;
  let timer: unknown = null;
  let lastWritten: string | null = null;
  /** Whether the last snapshot handed to a write reached the disk. */
  let lastWriteOk = true;
  /** Tail of the write chain: every write starts after the previous one finished. */
  let chain: Promise<void> = Promise.resolve();

  function stopTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function writeNewest(): Promise<boolean> {
    const written = chain.then(async () => {
      const state = pending;
      pending = null;
      if (!state) return lastWriteOk;
      let json: string;
      try {
        json = serialize(state);
      } catch {
        return (lastWriteOk = false);
      }
      if (json === lastWritten) return (lastWriteOk = true);
      try {
        await options.storage.setItem(key, json);
        lastWritten = json;
        return (lastWriteOk = true);
      } catch {
        // Best effort: the next change (or flush) writes again.
        return (lastWriteOk = false);
      }
    });
    chain = written.then(() => undefined);
    return written;
  }

  return {
    schedule(state) {
      pending = state;
      stopTimer();
      timer = setTimer(() => {
        timer = null;
        void writeNewest();
      }, debounceMs);
    },
    flush() {
      stopTimer();
      return writeNewest();
    },
    cancel() {
      stopTimer();
      pending = null;
      // Whoever cancels is about to erase the copy on disk (a wipe), so "already written" no longer says what is
      // there: if the very same snapshot comes back (the plan restored from the account), it is written again.
      // Forgotten in the writer's own order: after a write still in flight has landed (idle() waits for it), and
      // before any write that is asked for from here on.
      chain = chain.then(() => {
        lastWritten = null;
      });
    },
    hasPending() {
      return pending !== null;
    },
    idle() {
      return chain;
    },
  };
}
