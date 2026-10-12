import { beforeEach, describe, expect, it, vi } from "vitest";

// The AI memory lives in this browser's localStorage through lib/storage.ts appStorage; here it is an in-memory map.
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/lib/storage", () => ({
  appStorage: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    removeItem: vi.fn(async (key: string) => void store.delete(key)),
    getAllKeys: vi.fn(async () => [...store.keys()]),
    multiRemove: vi.fn(async (keys: readonly string[]) => keys.forEach((key) => store.delete(key))),
  },
  readLocal: (key: string) => store.get(key) ?? null,
  writeLocal: (key: string, value: string | null) => {
    if (value === null) store.delete(key);
    else store.set(key, value);
    return true;
  },
}));

import {
  AI_MEMORY_VERSION,
  MAX_SEEN_KEYS,
  applyBlockObservation,
  applyEventObservations,
  applyTaskObservations,
  buildMemoryContext,
  createEmptyAIMemory,
  learnFromBlockCompletion,
  learnFromBlockCompletions,
  learnFromTasks,
  loadAIMemory,
  normalizeAIMemory,
  type BlockObservation,
  type TaskObservation,
} from "../../src/lib/ai-memory";

const KEY = "@trajectory/aiMemory";
const NOW = new Date(2026, 8, 26, 12, 0, 0); // Sat 26 Sep 2026, local

function doneBlock(id: string, startTime = "19:00", endTime = "20:00", date = "2026-09-20"): BlockObservation {
  return { id, date, type: "study", startTime, endTime, completionStatus: "done" };
}

function task(name: string, dueDate: string, over: Partial<TaskObservation> = {}): TaskObservation {
  return { name, courseName: "CHEM 101", estimatedMinutes: 60, difficulty: 3, dueDate, ...over };
}

beforeEach(() => store.clear());

describe("learning is idempotent (the launch replay bug)", () => {
  it("replaying the same finished blocks changes nothing", () => {
    const blocks = [doneBlock("a"), doneBlock("b", "08:00", "09:00"), doneBlock("c")];
    const once = blocks.reduce(applyBlockObservation, createEmptyAIMemory(NOW));
    let replayed = once;
    for (let launch = 0; launch < 20; launch++) replayed = blocks.reduce(applyBlockObservation, replayed);
    expect(replayed).toBe(once);
    expect(replayed.preferredStudyTime).toBe("evening");
    expect(replayed.preferredStudyLengthMinutes).toBe(60);
  });

  it("replaying completed tasks never flags procrastination (only ADDED work with a future due date counts)", () => {
    const completed = Array.from({ length: 12 }, (_, i) => task(`HW ${i}`, "2026-09-27"));
    let memory = createEmptyAIMemory(NOW);
    for (let launch = 0; launch < 10; launch++) memory = applyTaskObservations(memory, completed, { source: "completed", now: NOW });
    expect(memory.tendsToProcrastinate).toBeNull();
    expect(memory.avgTaskMinutes).toBe(60);
  });

  it("a caller that does not say where the tasks come from never feeds the procrastination signal", () => {
    const soon = Array.from({ length: 12 }, (_, i) => task(`Soon ${i}`, "2026-09-27"));
    expect(applyTaskObservations(createEmptyAIMemory(NOW), soon, { now: NOW }).tendsToProcrastinate).toBeNull();
  });

  it("past-due tasks are not evidence of adding work late", () => {
    const past = Array.from({ length: 10 }, (_, i) => task(`Old ${i}`, "2026-09-01"));
    expect(applyTaskObservations(createEmptyAIMemory(NOW), past, { source: "added", now: NOW }).tendsToProcrastinate).toBeNull();
  });

  it("needs enough evidence, then reflects the real share of late additions", () => {
    const added = { source: "added" as const, now: NOW };
    const late = Array.from({ length: 4 }, (_, i) => task(`Late ${i}`, "2026-09-27"));
    const early = Array.from({ length: 4 }, (_, i) => task(`Early ${i}`, "2026-10-20"));
    const few = applyTaskObservations(createEmptyAIMemory(NOW), late, added);
    expect(few.tendsToProcrastinate).toBeNull(); // 4 observations is not enough
    const mixed = applyTaskObservations(few, early, added);
    expect(mixed.tendsToProcrastinate).toBe(false); // ~50% late
    const mostlyLate = applyTaskObservations(createEmptyAIMemory(NOW), [...late, ...Array.from({ length: 6 }, (_, i) => task(`L2 ${i}`, "2026-09-26"))], added);
    expect(mostlyLate.tendsToProcrastinate).toBe(true);
  });

  it("the same task added twice (e.g. a retried confirm) counts once", () => {
    const t = task("Essay", "2026-09-27");
    const once = applyTaskObservations(createEmptyAIMemory(NOW), [t], { source: "added", now: NOW });
    expect(applyTaskObservations(once, [t, { ...t }], { source: "added", now: NOW })).toBe(once);
  });
});

describe("decay and caps", () => {
  it("recent study times outweigh old ones", () => {
    let memory = createEmptyAIMemory(NOW);
    for (let i = 0; i < 30; i++) memory = applyBlockObservation(memory, doneBlock(`m${i}`, "08:00", "09:00"));
    expect(memory.preferredStudyTime).toBe("morning");
    for (let i = 0; i < 40; i++) memory = applyBlockObservation(memory, doneBlock(`e${i}`, "19:00", "20:00"));
    expect(memory.preferredStudyTime).toBe("evening");
  });

  it("keeps the seen-key list and course lists bounded", () => {
    let memory = createEmptyAIMemory(NOW);
    const blocks = Array.from({ length: MAX_SEEN_KEYS + 50 }, (_, i) => doneBlock(`x${i}`));
    memory = blocks.reduce(applyBlockObservation, memory);
    expect(memory.seen!.length).toBe(MAX_SEEN_KEYS);
    const courses = Array.from({ length: 25 }, (_, i) => task(`T${i}`, "2026-10-30", { courseName: `C${i}`, difficulty: 5 }));
    memory = applyTaskObservations(memory, courses, { now: NOW });
    expect(memory.hardCourses.length).toBe(10);
    expect(memory.hardCourses.at(-1)).toBe("C24");
  });

  it("drops event types from cut features and repeats nothing", () => {
    const memory = applyEventObservations(createEmptyAIMemory(NOW), [{ type: "work" }, { type: "workout" }, { type: "work" }, { type: "meal" }]);
    expect(memory.commonEventTypes).toEqual(["work"]);
  });
});

describe("one-time repair of memories written by the replaying learners", () => {
  const corrupted = {
    sessionCount: 4812,
    preferredStudyLengthMinutes: 7,
    preferredStudyTime: "night",
    tendsToProcrastinate: true,
    hardCourses: ["CHEM 101", "CHEM 101"],
    easyCourses: [],
    avgTaskMinutes: 3,
    commonEventTypes: ["workout", "meal", "work"],
    notes: ["Prefers flashcards"],
    lastUpdatedAt: "2026-09-20T00:00:00.000Z",
  };

  it("discards the inflated conclusions and keeps free-form notes", () => {
    const repaired = normalizeAIMemory(corrupted, NOW);
    expect(repaired.version).toBe(AI_MEMORY_VERSION);
    expect(repaired.tendsToProcrastinate).toBeNull();
    expect(repaired.sessionCount).toBe(0);
    expect(repaired.preferredStudyTime).toBeNull();
    expect(repaired.notes).toEqual(["Prefers flashcards"]);
    expect(buildMemoryContext(repaired)).not.toMatch(/procrastinat|due dates|used the AI planner/);
  });

  it("tolerates garbage", () => {
    expect(normalizeAIMemory("nope", NOW).version).toBe(AI_MEMORY_VERSION);
    const weird = normalizeAIMemory({ version: AI_MEMORY_VERSION, evidence: { timeOfDay: { night: -5, morning: Number.NaN }, urgentTasks: 50, datedTasks: 2 }, seen: [1, "a"] }, NOW);
    expect(weird.evidence!.timeOfDay.night).toBe(0);
    expect(weird.evidence!.urgentTasks).toBe(2);
    expect(weird.seen).toEqual(["a"]);
  });

  it("the stored copy is rewritten once, then the launch replay relearns each item exactly once", async () => {
    store.set(KEY, JSON.stringify(corrupted));
    const history = [doneBlock("h1", "15:00", "16:00"), doneBlock("h2", "15:00", "16:00"), doneBlock("h3", "15:30", "16:30")];
    for (let launch = 0; launch < 5; launch++) {
      // the app fires one call per finished block without awaiting them
      await Promise.all(history.map((b) => learnFromBlockCompletion(b)));
    }
    const memory = await loadAIMemory();
    expect(memory.version).toBe(AI_MEMORY_VERSION);
    expect(memory.tendsToProcrastinate).toBeNull();
    expect(memory.preferredStudyTime).toBe("afternoon");
    expect(memory.seen).toHaveLength(3);
    expect(JSON.parse(store.get(KEY)!).version).toBe(AI_MEMORY_VERSION);
  });
});

describe("storage wrappers", () => {
  it("parallel learners do not overwrite each other", async () => {
    await Promise.all([
      learnFromBlockCompletions([doneBlock("p1"), doneBlock("p2")]),
      learnFromBlockCompletion(doneBlock("p3")),
      learnFromTasks([task("Lab", "2026-10-10")], { now: NOW }),
    ]);
    const memory = await loadAIMemory();
    expect(memory.seen).toHaveLength(4);
  });

  it("calls without ids (the 1.0.6 call sites) are still de-duplicated", async () => {
    const legacy = { type: "study", startTime: "19:00", endTime: "20:00", completionStatus: "done" as const };
    for (let i = 0; i < 5; i++) await learnFromBlockCompletion(legacy);
    expect((await loadAIMemory()).seen).toHaveLength(1);
  });

  it("an unreadable store yields an empty memory rather than a throw", async () => {
    const { appStorage } = await import("../../src/lib/storage");
    (appStorage.getItem as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Storage is unavailable."));
    const memory = await loadAIMemory();
    expect(memory.version).toBe(AI_MEMORY_VERSION);
    expect(memory.seen).toEqual([]);
  });
});
