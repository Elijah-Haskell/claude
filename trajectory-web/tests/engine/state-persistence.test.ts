import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_STATE_STORAGE_KEY,
  PERSIST_DEBOUNCE_MS,
  createInitialState,
  createStatePersister,
  parsePersistedState,
  restorePersistedState,
  toLocalPersistedState,
} from "../../src/engine/state-persistence";
import { DEFAULT_HEALTH_PREFS, DEFAULT_NOTIFICATION_SETTINGS, type GoogleCalendarEventLocal } from "../../src/engine/types";

/** A snapshot as written by the build that still had Journal, Notes, Goals, Insights and cloud sync. */
const OLD_SHAPE_SNAPSHOT = JSON.stringify({
  onboardingComplete: true,
  isLoggedIn: true,
  user: { id: "u1", email: "sam@example.com", name: "Sam", currentSemester: "Fall 2026", createdAt: "2026-08-20T10:00:00.000Z" },
  classes: [
    { id: "c1", name: "Organic Chemistry", days: ["Mon", "Wed"], startTime: "09:00", endTime: "09:50", color: "#4F6EF7" },
  ],
  recurringEvents: [
    { id: "r1", title: "Work", days: ["Sat"], startTime: "10:00", endTime: "16:00", color: "#06B6D4", locked: true },
  ],
  tasks: [
    { id: "t1", name: "Problem set 3", courseId: "c1", courseName: "Organic Chemistry", dueDate: "2026-09-25", estimatedMinutes: 120, difficulty: 3, requiresOnCampus: false, status: "pending", createdAt: "2026-09-01T00:00:00.000Z" },
  ],
  scheduleBlocks: [
    { id: "b-study", type: "study", title: "Study: Problem set 3", date: "2026-09-21", startTime: "16:00", endTime: "17:00", locked: false, accepted: true, color: "#8B5CF6", completionStatus: "pending", taskId: "t1", notificationId: "os-123" },
    { id: "b-meal", type: "meal", title: "Lunch", date: "2026-09-21", startTime: "12:30", endTime: "13:00", locked: false, accepted: true, color: "#F59E0B", completionStatus: "pending" },
    { id: "b-workout", type: "workout", title: "Workout", date: "2026-09-22", startTime: "17:00", endTime: "17:45", locked: false, accepted: true, color: "#22C55E", completionStatus: "pending" },
    { id: "b-class", type: "class", title: "Organic Chemistry", date: "2026-09-21", startTime: "09:00", endTime: "09:50", locked: true, accepted: true, color: "#4F6EF7", completionStatus: "pending", courseId: "c1" },
  ],
  healthPrefs: {
    sleepTargetHours: 7.5, bedtime: "00:30", wakeTime: "08:00",
    mealCount: 4, mealTimes: ["07:00", "11:00", "15:00", "19:00"],
    workoutFrequency: 5, workoutDurationMinutes: 90, workoutDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  },
  userPrefs: { studyStyle: "short_bursts", energyProfile: "night", noGoZones: [], scheduleIntensity: 80 },
  insights: [{ weekStart: "2026-09-14", plannedBlocks: 10, completedBlocks: 7, avgStartDelayMinutes: 5, slipCauses: {}, bestStudyHour: 16 }],
  grades: [],
  recommendations: [],
  examPreps: [],
  focusSession: { id: "f1", title: "Focus", durationMinutes: 25, status: "active" },
  notes: [{ id: "n1", title: "Lecture 4", content: "Sn2 vs Sn1", tags: [], color: "#4F6EF7", isPinned: false, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" }],
  studyGuides: [],
  practiceExams: [],
  goals: [{ id: "g1", title: "A in Orgo", weeklyStudyHours: 8, status: "active", generatedTasks: [], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }],
  notificationSettings: { enabled: true, leadTimeHours: 24, reminders: [{ id: "default", leadTimeHours: 24 }] },
  syllabusImports: [],
  journalEntries: [{ id: "j1", date: "2026-09-10", answers: [], mood: 4, completedAt: "2026-09-10T22:00:00.000Z", recoveryScore: 71 }],
  googleCalendarEvents: [],
  googleCalendarConnected: false,
});

describe("loading old persisted snapshots", () => {
  it("ignores removed keys (journalEntries, notes, goals, insights, isLoggedIn, focusSession) without throwing", () => {
    const state = parsePersistedState(OLD_SHAPE_SNAPSHOT);

    expect(state).not.toBeNull();
    for (const removed of ["journalEntries", "notes", "goals", "insights", "isLoggedIn", "focusSession"]) {
      expect(state).not.toHaveProperty(removed);
    }
  });

  it("keeps the user's real planning data from an old snapshot", () => {
    const state = parsePersistedState(OLD_SHAPE_SNAPSHOT)!;

    expect(state.onboardingComplete).toBe(true);
    expect(state.user?.currentSemester).toBe("Fall 2026");
    expect(state.classes.map((c) => c.name)).toEqual(["Organic Chemistry"]);
    expect(state.recurringEvents.map((r) => r.title)).toEqual(["Work"]);
    expect(state.tasks.map((t) => t.name)).toEqual(["Problem set 3"]);
    expect(state.userPrefs.scheduleIntensity).toBe(80);
  });

  it("keeps the sleep window and drops the meal/workout preferences", () => {
    const { healthPrefs } = parsePersistedState(OLD_SHAPE_SNAPSHOT)!;

    expect(healthPrefs.bedtime).toBe("00:30");
    expect(healthPrefs.wakeTime).toBe("08:00");
    expect(healthPrefs.sleepTargetHours).toBe(7.5);
    // The old customised meal/workout values are gone: only the sleep window remains.
    expect(Object.keys(healthPrefs).sort()).toEqual(["bedtime", "sleepTargetHours", "wakeTime"]);
    expect(Object.keys(DEFAULT_HEALTH_PREFS).sort()).toEqual(["bedtime", "sleepTargetHours", "wakeTime"]);
  });

  it("drops meal and workout blocks, keeps study/class blocks, and forgets stale OS notification ids", () => {
    const { scheduleBlocks } = parsePersistedState(OLD_SHAPE_SNAPSHOT)!;

    expect(scheduleBlocks.map((b) => b.id)).toEqual(["b-study", "b-class"]);
    expect(scheduleBlocks.every((b) => b.notificationId === undefined)).toBe(true);
    expect(scheduleBlocks.find((b) => b.id === "b-class")?.locked).toBe(true);
  });

  it("tolerates missing keys, wrong types and an invalid sleep window by falling back to defaults", () => {
    const state = restorePersistedState({
      onboardingComplete: "yes",
      tasks: "not an array",
      classes: null,
      scheduleBlocks: { 0: "x" },
      healthPrefs: { bedtime: "late", wakeTime: 7, sleepTargetHours: 99 },
      notificationSettings: 5,
    });

    expect(state.onboardingComplete).toBe(false);
    expect(state.tasks).toEqual([]);
    expect(state.classes).toEqual([]);
    expect(state.scheduleBlocks).toEqual([]);
    expect(state.healthPrefs.bedtime).toBe(DEFAULT_HEALTH_PREFS.bedtime);
    expect(state.healthPrefs.wakeTime).toBe(DEFAULT_HEALTH_PREFS.wakeTime);
    expect(state.healthPrefs.sleepTargetHours).toBe(DEFAULT_HEALTH_PREFS.sleepTargetHours);
    expect(state.notificationSettings).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("drops the grade weights an earlier build kept on a class (grade tracking was removed), and nothing else of the class", () => {
    const weights = [{ id: "c1-gc-0", name: "Homework", weight: 20 }, { id: "c1-gc-1", name: "Final", weight: 40 }];
    const orgo = { id: "c1", name: "Organic Chemistry", shortName: "ORGO", days: ["Mon", "Wed"], startTime: "09:00", endTime: "09:50", location: "Hall 2", color: "#4F6EF7" };
    const online = { id: "c2", name: "Statistics", days: [], startTime: "", endTime: "", isAsynchronous: true, color: "#22C55E" };
    const untouched = { id: "imp2", importedAt: "2026-08-23T10:00:00.000Z", courseName: "Statistics", linkedClassId: "c2", linkedClassName: "Statistics", itemCount: 2, skippedCount: 0, isNewClass: true };
    const saved = JSON.stringify({
      ...JSON.parse(OLD_SHAPE_SNAPSHOT),
      classes: [{ ...orgo, gradeComponents: weights }, { ...online, gradeComponents: [] }],
      // An import that edited a class keeps a copy of it for its undo: undoing must not bring the weights back.
      syllabusImports: [
        { id: "imp1", importedAt: "2026-08-22T10:00:00.000Z", courseName: "Organic Chemistry", linkedClassId: "c1", linkedClassName: "Organic Chemistry", itemCount: 3, skippedCount: 0, isNewClass: false, previousClass: { ...orgo, days: ["Tue"], gradeComponents: weights } },
        untouched,
      ],
    });
    expect(saved).toContain("gradeComponents");

    const state = parsePersistedState(saved)!;
    expect(state.classes).toEqual([orgo, online]);
    expect(state.syllabusImports?.[0]?.previousClass).toEqual({ ...orgo, days: ["Tue"] });
    expect(state.syllabusImports?.[1]).toEqual(untouched);
    expect(JSON.stringify(state)).not.toContain("gradeComponents");
    // So what is written back to this iPhone, at the next change, no longer holds them either.
    expect(JSON.stringify(toLocalPersistedState(state))).not.toContain("gradeComponents");
    // The legacy `grades` list of the stored state is not part of this: it loads as before.
    const withList = restorePersistedState({ classes: [orgo], grades: [{ id: "gr1", classId: "c1", letterGrade: "A", recordedAt: "x" }] });
    expect(withList.grades).toHaveLength(1);
  });

  it("a state without such weights is loaded as it is: the very same class and import lists", () => {
    const classes = [{ id: "c1", name: "Organic Chemistry", days: ["Mon"], startTime: "09:00", endTime: "09:50", color: "#4F6EF7" }];
    const syllabusImports = [{ id: "imp1", importedAt: "x", courseName: "C", linkedClassId: "c1", linkedClassName: "C", itemCount: 0, skippedCount: 0, isNewClass: false, previousClass: classes[0] }];
    const state = restorePersistedState({ classes, syllabusImports });
    expect(state.classes).toBe(classes);
    expect(state.syllabusImports).toBe(syllabusImports);
    // Entries that are not objects are left for the rest of the app to deal with, as before.
    expect(restorePersistedState({ classes: [null, "x", classes[0]] }).classes).toEqual([null, "x", classes[0]]);
  });

  it("returns null (caller keeps its defaults) for empty, corrupt or non-object storage values", () => {
    expect(parsePersistedState(null)).toBeNull();
    expect(parsePersistedState("")).toBeNull();
    expect(parsePersistedState("{not json")).toBeNull();
    expect(parsePersistedState("[1,2,3]")).toBeNull();
    expect(parsePersistedState("42")).toBeNull();
  });
});

describe("local persistence", () => {
  it("a fresh install has reminders switched off", () => {
    expect(createInitialState().notificationSettings.enabled).toBe(false);
    expect(DEFAULT_NOTIFICATION_SETTINGS.enabled).toBe(false);
  });

  it("never persists device notification identifiers", () => {
    const state = createInitialState();
    const persisted = toLocalPersistedState({
      ...state,
      scheduleBlocks: [{ id: "study", type: "study", title: "Study", date: "2030-01-01", startTime: "10:00", endTime: "11:00", locked: false, accepted: true, notificationId: "os-notification", color: "#4F6EF7", completionStatus: "pending" }],
    });

    expect(persisted.scheduleBlocks[0].notificationId).toBeUndefined();
  });

  it("round-trips a saved snapshot", () => {
    const original = parsePersistedState(OLD_SHAPE_SNAPSHOT)!;
    const reloaded = parsePersistedState(JSON.stringify(toLocalPersistedState(original)))!;

    expect(reloaded).toEqual(original);
  });
});

describe("iPhone calendar events on disk (1.0.9 audit: 1,500 events took the snapshot from 256 KB to 771 KB)", () => {
  const hex = (n: number, length: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, "0").repeat(4).slice(0, length);
  /** An EventKit-like id ("<UUID>:<UUID without dashes>", 73 characters), shared by a repeating event's occurrences. */
  const eventKitId = (n: number) => `${hex(n * 2654435761, 8)}-${hex(n * 40503, 4)}-4${hex(n * 977, 3)}-8${hex(n * 131, 3)}-${hex(n * 7919, 12)}:${hex(n * 104729, 32)}`;
  const pad = (n: number) => String(n).padStart(2, "0");

  /** What lib/device-calendars.ts toDeviceBusyEvents saves for 16 weeks of a busy calendar: 1,500 occurrences. */
  function busyCalendar(): GoogleCalendarEventLocal[] {
    const events: GoogleCalendarEventLocal[] = [];
    const titles = ["Work shift", "Gym", "Team practice", "Tutoring", "Family dinner", "Club meeting", "Lab group", "Church", "Volunteering", "Commute"];
    for (let i = 0; events.length < 1500; i += 1) {
      const series = i % 50; // 40 repeating series, then one-off events
      const repeating = series < 40;
      const day = repeating ? (i * 7 + series) % 112 : (i * 13) % 112;
      const start = new Date(2026, 8, 7 + day, 8 + (i % 11), (i % 4) * 15);
      const end = new Date(start.getTime() + (45 + (i % 5) * 30) * 60_000);
      const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
      events.push({
        id: `${eventKitId(repeating ? series + 1 : 1000 + i)}@${start.toISOString()}`,
        calendarId: `${hex(series % 3, 8)}-CALENDAR-${series % 3}`,
        title: repeating ? titles[series % titles.length]! : `Appointment ${i}`,
        isRecurring: repeating,
        status: "active",
        syncedAt: "2026-10-01T15:04:05.678Z",
        source: "device",
        startDate: date,
        endDate: date,
        startTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
        endTime: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
        isAllDay: false,
      });
    }
    events.push({ id: `${eventKitId(5000)}@${new Date(2026, 9, 9).toISOString()}`, calendarId: "c", title: "Trip", isRecurring: false, status: "active", syncedAt: "x", source: "device", startDate: "2026-10-09", endDate: "2026-10-12", isAllDay: true });
    return events;
  }
  /** Everything the planner, the conflict labels and the Week / Today screens read from an event. */
  const shown = (events: readonly GoogleCalendarEventLocal[] | undefined) => (events ?? []).map((e) => [e.id, e.title, e.startDate, e.endDate, e.startTime, e.endTime, e.isAllDay, e.status, e.source]);

  it("are saved packed: about a fifth of the bytes, and everything the plan and the screens read comes back exactly", () => {
    const events = busyCalendar();
    const state = { ...createInitialState(), onboardingComplete: true, deviceCalendarEvents: events };
    const without = JSON.stringify(toLocalPersistedState({ ...state, deviceCalendarEvents: [] })).length;
    const packed = JSON.stringify(toLocalPersistedState(state)).length - without;
    const full = JSON.stringify(events).length;
    console.log(`1,501 iPhone calendar events on disk: ${Math.round(full / 1024)} KB as objects -> ${Math.round(packed / 1024)} KB packed`);
    expect(full).toBeGreaterThan(450 * 1024);
    expect(packed).toBeLessThan(full / 4); // measured: 523 KB -> 109 KB
    const restored = parsePersistedState(JSON.stringify(toLocalPersistedState(state)))!;
    expect(shown(restored.deviceCalendarEvents)).toEqual(shown(events));
    // The fields nobody reads for a device event are not kept.
    expect(restored.deviceCalendarEvents![0]).toMatchObject({ calendarId: "", syncedAt: "", isRecurring: true });
  });

  it("still loads events saved by 1.0.8 as full objects, and drops malformed packed entries", () => {
    const events = busyCalendar().slice(0, 3);
    expect(shown(parsePersistedState(JSON.stringify({ deviceCalendarEvents: events }))!.deviceCalendarEvents)).toEqual(shown(events));
    const packed = toLocalPersistedState({ ...createInitialState(), deviceCalendarEvents: events }).deviceCalendarEvents!;
    const broken = { ...packed, events: [...packed.events, [99, 0, null, "2026-10-01", 0, null, null, 0], "x", [0, 0, null, 7]] };
    expect(shown(parsePersistedState(JSON.stringify({ deviceCalendarEvents: broken }))!.deviceCalendarEvents)).toEqual(shown(events));
    expect(parsePersistedState(JSON.stringify({ deviceCalendarEvents: { v: 2, ids: [], titles: [], events: [] } }))!.deviceCalendarEvents).toEqual([]);
    // An id without an occurrence suffix (or with one that is not an exact instant) is kept as it is.
    const odd = [{ ...events[0]!, id: "plain-id" }, { ...events[1]!, id: "x@2026-10-01T10:00:00Z" }];
    expect(shown(parsePersistedState(JSON.stringify(toLocalPersistedState({ ...createInitialState(), deviceCalendarEvents: odd })))!.deviceCalendarEvents)).toEqual(shown(odd));
  });
});

describe("snapshot writer (createStatePersister)", () => {
  afterEach(() => vi.useRealTimers());

  function withTasks(n: number) {
    const base = createInitialState();
    return { ...base, onboardingComplete: true, tasks: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `T${i}`, courseId: "c", courseName: "C", dueDate: "2026-10-01", estimatedMinutes: 30, difficulty: 3 as const, requiresOnCampus: false, status: "pending" as const, createdAt: "2026-09-01T00:00:00.000Z" })) };
  }

  /** Storage whose writes resolve only when the test releases them, to expose ordering/concurrency. */
  function slowStorage() {
    const writes: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    return {
      writes,
      maxInFlight: () => maxInFlight,
      releaseAll: async () => {
        while (releases.length) {
          releases.shift()!();
          await Promise.resolve();
          await new Promise((r) => setImmediate(r));
        }
      },
      storage: {
        setItem: (_key: string, value: string) => new Promise<void>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          releases.push(() => {
            writes.push(value);
            inFlight--;
            resolve();
          });
        }),
      },
    };
  }

  it("a burst of changes is written once, with the last state, under the existing key", async () => {
    vi.useFakeTimers();
    const setItem = vi.fn(async () => undefined);
    const persister = createStatePersister({ storage: { setItem } });
    for (let i = 1; i <= 10; i++) persister.schedule(withTasks(i));
    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS - 1);
    expect(setItem).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(setItem).toHaveBeenCalledTimes(1);
    const [key, json] = setItem.mock.calls[0] as unknown as [string, string];
    expect(key).toBe(APP_STATE_STORAGE_KEY);
    expect(parsePersistedState(json)!.tasks).toHaveLength(10);
  });

  it("flush writes immediately (app going to the background) and cancels the timer", async () => {
    vi.useFakeTimers();
    const setItem = vi.fn(async () => undefined);
    const persister = createStatePersister({ storage: { setItem } });
    persister.schedule(withTasks(1));
    await persister.flush();
    expect(setItem).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(setItem).toHaveBeenCalledTimes(1); // nothing left to write, identical snapshot not rewritten
  });

  it("never writes concurrently and never lets an older snapshot land after a newer one", async () => {
    const slow = slowStorage();
    const persister = createStatePersister({ storage: slow.storage, debounceMs: 0 });
    persister.schedule(withTasks(1));
    const first = persister.flush(); // write #1 in flight
    persister.schedule(withTasks(2));
    const second = persister.flush();
    persister.schedule(withTasks(3));
    const third = persister.flush();
    let settled = false;
    const all = Promise.all([first, second, third]).then(() => void (settled = true));
    for (let i = 0; i < 20 && !settled; i++) await slow.releaseAll();
    await all;
    expect(slow.maxInFlight()).toBe(1);
    const counts = slow.writes.map((w) => JSON.parse(w).tasks.length);
    expect(counts.at(-1)).toBe(3);
    expect([...counts].sort()).toEqual(counts); // monotonic: older never after newer
  });

  it("cancel drops an unwritten snapshot (logout must not resurrect data)", async () => {
    vi.useFakeTimers();
    const setItem = vi.fn(async () => undefined);
    const persister = createStatePersister({ storage: { setItem } });
    persister.schedule(withTasks(2));
    persister.cancel();
    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS * 3);
    await persister.flush();
    expect(setItem).not.toHaveBeenCalled();
    expect(persister.hasPending()).toBe(false);
  });

  it("after a cancel the same snapshot is written again: the wipe that follows a cancel erased the copy on disk", async () => {
    const disk = new Map<string, string>();
    const setItem = vi.fn(async (key: string, value: string) => void disk.set(key, value));
    const persister = createStatePersister({ storage: { setItem } });
    persister.schedule(withTasks(2));
    expect(await persister.flush()).toBe(true);
    // Signing out: cancel, wait for the writer, wipe.
    persister.cancel();
    await persister.idle();
    disk.clear();
    // The plan comes back from the account, the very same snapshot as before.
    persister.schedule(withTasks(2));
    expect(await persister.flush()).toBe(true);
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(parsePersistedState(disk.get(APP_STATE_STORAGE_KEY))!.tasks).toHaveLength(2);
  });

  it("the same when a write was still on its way at the cancel", async () => {
    const slow = slowStorage();
    const persister = createStatePersister({ storage: slow.storage });
    persister.schedule(withTasks(2));
    const inFlight = persister.flush();
    await Promise.resolve();
    await Promise.resolve();
    persister.cancel();
    const idle = persister.idle();
    await slow.releaseAll();
    await Promise.all([inFlight, idle]);
    expect(slow.writes).toHaveLength(1);
    // (the wipe happens here)
    persister.schedule(withTasks(2));
    const again = persister.flush();
    for (let i = 0; i < 5; i++) await slow.releaseAll();
    expect(await again).toBe(true);
    expect(slow.writes).toHaveLength(2);
  });

  it("a storage error does not break later writes", async () => {
    const setItem = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const persister = createStatePersister({ storage: { setItem } });
    persister.schedule(withTasks(1));
    await persister.flush();
    persister.schedule(withTasks(1));
    await persister.flush();
    expect(setItem).toHaveBeenCalledTimes(2); // the failed snapshot is retried
  });

  it("flush says whether the snapshot reached the disk (a plan loaded from the account only counts as loaded when it did)", async () => {
    const setItem = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const persister = createStatePersister({ storage: { setItem } });
    persister.schedule(withTasks(1));
    expect(await persister.flush()).toBe(true);
    expect(await persister.flush()).toBe(true); // nothing new: the last write stands
    persister.schedule(withTasks(2));
    expect(await persister.flush()).toBe(false); // not on disk
    expect(await persister.flush()).toBe(false); // and still not, until something is written
    persister.schedule(withTasks(2));
    expect(await persister.flush()).toBe(true); // the same snapshot again: written this time
    persister.schedule(withTasks(2));
    expect(await persister.flush()).toBe(true); // already on disk: nothing to write, and that is fine
    expect(setItem).toHaveBeenCalledTimes(3);
    // A state that cannot be turned into JSON is not on disk either.
    const circular = withTasks(1) as ReturnType<typeof withTasks> & { self?: unknown };
    circular.self = circular;
    persister.schedule(circular);
    expect(await persister.flush()).toBe(false);
  });

  it("a write that fails in the background leaves the next flush to try again, in order", async () => {
    vi.useFakeTimers();
    const written: number[] = [];
    let fail = true;
    const setItem = vi.fn(async (_key: string, value: string) => {
      if (fail) throw new Error("disk full");
      written.push(JSON.parse(value).tasks.length);
    });
    const persister = createStatePersister({ storage: { setItem } });
    persister.schedule(withTasks(1));
    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS);
    expect(written).toEqual([]);
    fail = false;
    persister.schedule(withTasks(2));
    expect(await persister.flush()).toBe(true);
    expect(written).toEqual([2]);
  });
});
