import { describe, it, expect } from "vitest";
import {
  timeToMinutes,
  minutesToTime,
  formatTime,
  getWeekStart,
  addDays,
  toDateString,
  getDurationMinutes,
  formatDuration,
  generateId,
} from "../../src/engine/utils";
import { generateWeekSchedule } from "../../src/engine/scheduler";
import {
  DEFAULT_HEALTH_PREFS,
  DEFAULT_USER_PREFS,
  ClassBlock,
  Task,
  COURSE_COLORS,
} from "../../src/engine/types";

// ── Utility tests ─────────────────────────────────────────────

describe("timeToMinutes", () => {
  it("converts 00:00 to 0", () => expect(timeToMinutes("00:00")).toBe(0));
  it("converts 09:00 to 540", () => expect(timeToMinutes("09:00")).toBe(540));
  it("converts 23:59 to 1439", () => expect(timeToMinutes("23:59")).toBe(1439));
  it("converts 12:30 to 750", () => expect(timeToMinutes("12:30")).toBe(750));
});

describe("minutesToTime", () => {
  it("converts 0 to 00:00", () => expect(minutesToTime(0)).toBe("00:00"));
  it("converts 540 to 09:00", () => expect(minutesToTime(540)).toBe("09:00"));
  it("converts 750 to 12:30", () => expect(minutesToTime(750)).toBe("12:30"));
  it("converts 1439 to 23:59", () => expect(minutesToTime(1439)).toBe("23:59"));
});

describe("formatTime", () => {
  it("formats 09:00 as 9:00 AM", () => expect(formatTime("09:00")).toBe("9:00 AM"));
  it("formats 13:30 as 1:30 PM", () => expect(formatTime("13:30")).toBe("1:30 PM"));
  it("formats 00:00 as 12:00 AM", () => expect(formatTime("00:00")).toBe("12:00 AM"));
  it("formats 12:00 as 12:00 PM", () => expect(formatTime("12:00")).toBe("12:00 PM"));
});

describe("getDurationMinutes", () => {
  it("calculates 1 hour", () => expect(getDurationMinutes("09:00", "10:00")).toBe(60));
  it("calculates 90 minutes", () => expect(getDurationMinutes("10:00", "11:30")).toBe(90));
  it("calculates 50 minutes", () => expect(getDurationMinutes("10:00", "10:50")).toBe(50));
});

describe("formatDuration", () => {
  it("formats 30 as 30m", () => expect(formatDuration(30)).toBe("30m"));
  it("formats 60 as 1h", () => expect(formatDuration(60)).toBe("1h"));
  it("formats 90 as 1h 30m", () => expect(formatDuration(90)).toBe("1h 30m"));
  it("formats 120 as 2h", () => expect(formatDuration(120)).toBe("2h"));
});

describe("getWeekStart", () => {
  it("returns Monday for a Wednesday", () => {
    const wed = new Date("2026-02-25"); // Wednesday
    const mon = getWeekStart(wed);
    expect(mon.getDay()).toBe(1); // Monday
    expect(toDateString(mon)).toBe("2026-02-23");
  });

  it("returns Monday for a Monday", () => {
    const mon = new Date("2026-02-23T12:00:00"); // Monday
    const result = getWeekStart(mon);
    expect(result.getDay()).toBe(1); // Must be a Monday
  });

  it("returns Monday for a Sunday", () => {
    const sun = new Date("2026-03-01"); // Sunday
    const result = getWeekStart(sun);
    expect(result.getDay()).toBe(1);
  });
});

describe("addDays", () => {
  it("adds 7 days", () => {
    const d = new Date(2026, 1, 23, 9, 0);
    expect(toDateString(addDays(d, 7))).toBe("2026-03-02");
  });
  it("adds 0 days", () => {
    const d = new Date(2026, 1, 23, 9, 0);
    expect(toDateString(addDays(d, 0))).toBe("2026-02-23");
  });
});

describe("generateId", () => {
  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
  it("generates non-empty strings", () => {
    expect(generateId().length).toBeGreaterThan(0);
  });
});

// ── Scheduler tests ───────────────────────────────────────────

const mockClass: ClassBlock = {
  id: "cls1",
  name: "Business Law",
  days: ["Mon", "Wed", "Fri"],
  startTime: "10:00",
  endTime: "10:50",
  color: COURSE_COLORS[0]!,
};

// Use a future week start (always 2 weeks from now) so the past-date guard doesn't skip blocks
const futureWeekStart = getWeekStart(addDays(new Date(), 14));

const mockTask: Task = {
  id: "task1",
  name: "Read Chapter 5",
  courseId: "cls1",
  courseName: "Business Law",
  // Due date is Friday of the future test week
  dueDate: toDateString(addDays(futureWeekStart, 4)),
  estimatedMinutes: 60,
  difficulty: 2,
  requiresOnCampus: false,
  status: "pending",
  createdAt: new Date().toISOString(),
};

describe("generateWeekSchedule", () => {
  // Use a future week start (2 weeks from now) so the past-date guard doesn't skip study blocks
  const weekStart = futureWeekStart;

  it("generates blocks for a week", () => {
    const blocks = generateWeekSchedule(
      {
        classes: [mockClass],
        recurringEvents: [],
        tasks: [],
        goals: [],
        healthPrefs: DEFAULT_HEALTH_PREFS,
        userPrefs: DEFAULT_USER_PREFS,
      },
      weekStart
    );
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("places class blocks on correct days", () => {
    const blocks = generateWeekSchedule(
      {
        classes: [mockClass],
        recurringEvents: [],
        tasks: [],
        goals: [],
        healthPrefs: DEFAULT_HEALTH_PREFS,
        userPrefs: DEFAULT_USER_PREFS,
      },
      weekStart
    );
    const classBlocks = blocks.filter((b) => b.type === "class");
    expect(classBlocks.length).toBe(3); // Mon, Wed, Fri
    classBlocks.forEach((b) => {
      expect(b.startTime).toBe("10:00");
      expect(b.endTime).toBe("10:50");
      expect(b.locked).toBe(true);
    });
  });

  it("places sleep blocks every day", () => {
    const blocks = generateWeekSchedule(
      {
        classes: [],
        recurringEvents: [],
        tasks: [],
        goals: [],
        healthPrefs: DEFAULT_HEALTH_PREFS,
        userPrefs: DEFAULT_USER_PREFS,
      },
      weekStart
    );
    const sleepBlocks = blocks.filter((b) => b.type === "sleep");
    expect(sleepBlocks.length).toBe(7);
  });

  it("no longer generates meal or workout blocks (health features were removed)", () => {
    const blocks = generateWeekSchedule(
      {
        classes: [mockClass],
        recurringEvents: [],
        // Preferences persisted by an older version still carry meal/workout fields: they must be inert.
        healthPrefs: { ...DEFAULT_HEALTH_PREFS, mealCount: 3, workoutFrequency: 3, workoutDays: ["Mon", "Wed", "Fri"] } as typeof DEFAULT_HEALTH_PREFS,
        userPrefs: DEFAULT_USER_PREFS,
      },
      weekStart
    );
    expect(blocks.filter((b) => (b.type as string) === "meal")).toHaveLength(0);
    expect(blocks.filter((b) => (b.type as string) === "workout")).toHaveLength(0);
    // the structural week is still there: sleep window + classes
    expect(blocks.filter((b) => b.type === "sleep")).toHaveLength(7);
    expect(blocks.filter((b) => b.type === "class")).toHaveLength(3);
  });

  it("does not place study blocks itself (study placement belongs to the intelligent scheduler)", () => {
    const blocks = generateWeekSchedule(
      {
        classes: [mockClass],
        recurringEvents: [],
        tasks: [mockTask],
        goals: [],
        healthPrefs: DEFAULT_HEALTH_PREFS,
        userPrefs: DEFAULT_USER_PREFS,
      },
      weekStart
    );
    expect(blocks.filter((b) => b.type === "study")).toHaveLength(0);
  });

  it("gives structural blocks deterministic ids so regenerating a week does not invent new identities", () => {
    const state = { classes: [mockClass], recurringEvents: [], healthPrefs: DEFAULT_HEALTH_PREFS, userPrefs: DEFAULT_USER_PREFS };
    const first = generateWeekSchedule(state, weekStart);
    const second = generateWeekSchedule(state, weekStart);
    expect(second).toEqual(first);
    expect(new Set(first.map((b) => b.id)).size).toBe(first.length);
  });

  it("does not overlap class blocks with each other or with recurring commitments", () => {
    const blocks = generateWeekSchedule(
      {
        classes: [mockClass],
        recurringEvents: [],
        healthPrefs: DEFAULT_HEALTH_PREFS,
        userPrefs: DEFAULT_USER_PREFS,
      },
      weekStart
    );

    // Group blocks by date
    const byDate: Record<string, typeof blocks> = {};
    for (const b of blocks) {
      if (!byDate[b.date]) byDate[b.date] = [];
      byDate[b.date]!.push(b);
    }

    // Check no overlaps within each day (excluding sleep which spans midnight)
    for (const [, dayBlocks] of Object.entries(byDate)) {
      const nonSleep = dayBlocks.filter((b) => b.type !== "sleep");
      for (let i = 0; i < nonSleep.length; i++) {
        for (let j = i + 1; j < nonSleep.length; j++) {
          const a = nonSleep[i]!;
          const b = nonSleep[j]!;
          const aStart = timeToMinutes(a.startTime);
          const aEnd = timeToMinutes(a.endTime);
          const bStart = timeToMinutes(b.startTime);
          const bEnd = timeToMinutes(b.endTime);
          const overlaps = aStart < bEnd && bStart < aEnd;
          if (overlaps) {
            console.log("Overlap:", a.title, a.startTime, "-", a.endTime, "vs", b.title, b.startTime, "-", b.endTime);
          }
          expect(overlaps).toBe(false);
        }
      }
    }
  });
});
