import { describe, expect, it } from "vitest";
import {
  allDayEventCovers,
  blockCourseLabel,
  classOfTask,
  classShortName,
  normalizeShortName,
  SHORT_NAME_MAX,
  suggestShortName,
  blockDisplayTitle,
  blockFrame,
  calendarEventKey,
  calendarEventTimeLabel,
  calendarSourceLabel,
  computeVisibleHourRange,
  courseShortName,
  shortWord,
  currentTimeY,
  deadlineChipLabel,
  defaultAddDate,
  describeBlockForA11y,
  describeCalendarEventForA11y,
  formatWeekRange,
  gridHeight,
  hourLabel,
  isFlexibleSession,
  laneFrame,
  layoutDayBlocks,
  lockTogglePatch,
  minuteWheelOptions,
  moveDayPatch,
  scrollTargetForNow,
  showsOnWeekGrid,
  sleepBandsForDate,
  spokenTimeRange,
  summarizeWeek,
  timedEventSpanOn,
  timeEditPatch,
  verticalTouchSlops,
  weekDateKeys,
  weekStartForOffset,
} from "../../src/engine/week-layout";
import { GoogleCalendarEventLocal, ScheduleBlock } from "../../src/engine/types";

const item = (id: string, startTime: string, endTime: string) => ({ id, startTime, endTime });
const lanes = (items: ReturnType<typeof item>[], options?: { minDurationMinutes?: number }) =>
  layoutDayBlocks(items, options).map(({ block, lane, laneCount }) => `${block.id}:${lane}/${laneCount}`);

describe("layoutDayBlocks (overlap lanes)", () => {
  it("returns nothing for an empty day and full width for a lone block", () => {
    expect(layoutDayBlocks([])).toEqual([]);
    expect(lanes([item("a", "09:00", "10:00")])).toEqual(["a:0/1"]);
  });

  it("keeps disjoint blocks full width", () => {
    expect(lanes([item("a", "09:00", "10:00"), item("b", "11:00", "12:00")])).toEqual(["a:0/1", "b:0/1"]);
  });

  it("treats touching blocks (one ends exactly when the next starts) as not overlapping", () => {
    expect(lanes([item("a", "09:00", "10:00"), item("b", "10:00", "11:00")])).toEqual(["a:0/1", "b:0/1"]);
  });

  it("puts two overlapping blocks side by side", () => {
    expect(lanes([item("study", "10:00", "12:00"), item("gcal", "11:00", "13:00")])).toEqual(["study:0/2", "gcal:1/2"]);
  });

  it("needs three lanes for a 3-way overlap", () => {
    expect(lanes([item("a", "09:00", "12:00"), item("b", "09:30", "10:30"), item("c", "10:00", "11:00")])).toEqual(["a:0/3", "b:1/3", "c:2/3"]);
  });

  it("reuses a lane once its block has ended inside the same cluster", () => {
    // b (the longer of the two that start at 09:00) takes lane 0. a ends at 10:00 exactly when c starts,
    // so c reuses a's lane: only two lanes are needed for three blocks.
    expect(lanes([item("a", "09:00", "10:00"), item("b", "09:00", "11:00"), item("c", "10:00", "12:00")])).toEqual(["a:1/2", "b:0/2", "c:1/2"]);
  });

  it("chains overlaps into one cluster (a overlaps b, b overlaps c, a does not overlap c)", () => {
    expect(lanes([item("a", "09:00", "10:00"), item("b", "09:30", "10:30"), item("c", "10:15", "11:00")])).toEqual(["a:0/2", "b:1/2", "c:0/2"]);
  });

  it("gives blocks with identical times their own lane each, in input order", () => {
    expect(lanes([item("a", "09:00", "10:00"), item("b", "09:00", "10:00"), item("c", "09:00", "10:00")])).toEqual(["a:0/3", "b:1/3", "c:2/3"]);
  });

  it("sizes each cluster independently", () => {
    expect(lanes([item("a", "09:00", "10:00"), item("b", "09:00", "10:00"), item("c", "13:00", "14:00")])).toEqual(["a:0/2", "b:1/2", "c:0/1"]);
  });

  it("returns results in input order even when the input is unsorted", () => {
    const result = layoutDayBlocks([item("late", "15:00", "16:00"), item("early", "09:00", "10:00"), item("early2", "09:30", "10:30")]);
    expect(result.map((entry) => entry.block.id)).toEqual(["late", "early", "early2"]);
    expect(result.map((entry) => entry.laneCount)).toEqual([1, 2, 2]);
  });

  it("gives the longer block the first lane when two start together", () => {
    expect(lanes([item("short", "09:00", "09:30"), item("long", "09:00", "11:00")])).toEqual(["short:1/2", "long:0/2"]);
  });

  it("uses the drawn (minimum) height so a short block cannot hide the next one", () => {
    const blocks = [item("a", "09:00", "09:05"), item("b", "09:10", "09:20")];
    expect(lanes(blocks)).toEqual(["a:0/1", "b:0/1"]);
    expect(lanes(blocks, { minDurationMinutes: 20 })).toEqual(["a:0/2", "b:1/2"]);
  });

  it("does not lose zero-length or backwards blocks", () => {
    expect(lanes([item("a", "09:00", "09:00"), item("b", "09:00", "09:00")])).toEqual(["a:0/2", "b:1/2"]);
    expect(lanes([item("a", "22:00", "01:00")])).toEqual(["a:0/1"]);
  });

  it("never assigns two overlapping blocks the same lane (randomised property check)", () => {
    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 40; round += 1) {
      const items = Array.from({ length: 12 }, (_, i) => {
        const start = Math.floor(random() * 20) * 30 + 360;
        const end = start + (Math.floor(random() * 5) + 1) * 30;
        const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        return item(`i${i}`, clock(start), clock(end));
      });
      const laid = layoutDayBlocks(items);
      for (let x = 0; x < laid.length; x += 1) {
        for (let y = x + 1; y < laid.length; y += 1) {
          const a = laid[x]!.block;
          const b = laid[y]!.block;
          const overlap = a.startTime < b.endTime && b.startTime < a.endTime;
          if (overlap) expect(laid[x]!.lane).not.toBe(laid[y]!.lane);
        }
        expect(laid[x]!.lane).toBeLessThan(laid[x]!.laneCount);
      }
    }
  });
});

describe("laneFrame", () => {
  it("splits a column into equal lanes inside its inset", () => {
    expect(laneFrame(0, 1, 50)).toEqual({ left: 1, width: 48 });
    const first = laneFrame(0, 2, 50);
    const second = laneFrame(1, 2, 50);
    expect(first.left).toBe(1);
    expect(second.left).toBeCloseTo(first.left + first.width + 1);
    expect(second.left + second.width).toBeCloseTo(49);
  });
});

describe("visible hour range", () => {
  const block = (startTime: string, endTime: string, type = "study") => ({ type, startTime, endTime });

  it("is 06:00-23:00 for an empty or ordinary week", () => {
    expect(computeVisibleHourRange([])).toEqual({ startHour: 6, endHour: 23 });
    expect(computeVisibleHourRange([block("08:00", "09:30"), block("21:00", "23:00")])).toEqual({ startHour: 6, endHour: 23 });
  });

  it("extends to show an early block", () => {
    expect(computeVisibleHourRange([block("05:15", "06:30")])).toEqual({ startHour: 5, endHour: 23 });
    expect(computeVisibleHourRange([block("00:30", "01:30")])).toEqual({ startHour: 0, endHour: 23 });
  });

  it("extends to show a late block, rounding the end up to the next hour", () => {
    expect(computeVisibleHourRange([block("22:00", "23:15")])).toEqual({ startHour: 6, endHour: 24 });
    expect(computeVisibleHourRange([block("23:30", "23:59")])).toEqual({ startHour: 6, endHour: 24 });
  });

  it("clips a block that runs past midnight at 24:00", () => {
    expect(computeVisibleHourRange([block("22:00", "01:00", "recurring")])).toEqual({ startHour: 6, endHour: 24 });
  });

  it("ignores sleep blocks (they are clipped bands, not content)", () => {
    expect(computeVisibleHourRange([block("23:00", "07:00", "sleep"), block("00:30", "08:00", "sleep")])).toEqual({ startHour: 6, endHour: 23 });
  });

  it("labels hours for the time column", () => {
    expect([0, 5, 6, 12, 13, 23, 24].map(hourLabel)).toEqual(["12am", "5am", "6am", "12pm", "1pm", "11pm", "12am"]);
  });

  it("positions blocks relative to the range start, not a fixed 06:00", () => {
    const early = { startHour: 5, endHour: 23 };
    expect(blockFrame("05:00", "06:00", early, 56)).toEqual({ top: 0, height: 56 });
    expect(blockFrame("06:30", "07:00", early, 56).top).toBeCloseTo(84);
    expect(blockFrame("09:00", "09:05", early, 56).height).toBe(18); // minimum tap height
    expect(gridHeight(early, 56)).toBe(18 * 56);
  });

  it("keeps the current-time line aligned with the range and hides it outside the grid", () => {
    const range = { startHour: 5, endHour: 23 };
    expect(currentTimeY(6 * 60, range, 56)).toBe(56);
    expect(currentTimeY(4 * 60, range, 56)).toBeNull();
    expect(currentTimeY(23 * 60 + 30, range, 56)).toBeNull();
    const wide = { startHour: 5, endHour: 24 };
    expect(currentTimeY(23 * 60 + 30, wide, 56)).toBeCloseTo((18.5) * 56);
  });

  it("computes an auto-scroll target that never goes negative and clamps 'now' into the grid", () => {
    const range = { startHour: 6, endHour: 23 };
    expect(scrollTargetForNow(6 * 60 + 10, range, 56)).toBe(0);
    expect(scrollTargetForNow(12 * 60, range, 56, 100)).toBe(6 * 56 - 100);
    expect(scrollTargetForNow(2 * 60, range, 56)).toBe(0);
    expect(scrollTargetForNow(23 * 60 + 50, range, 56, 0)).toBe(17 * 56);
  });
});

describe("sleepBandsForDate", () => {
  const range = { startHour: 6, endHour: 23 };
  const nights = [
    { date: "2030-04-01", startTime: "23:00", endTime: "07:00" },
    { date: "2030-04-02", startTime: "23:00", endTime: "07:00" },
  ];

  it("shows the morning half of last night, clipped to the visible hours", () => {
    expect(sleepBandsForDate("2030-04-02", nights, range)).toEqual([{ startMinutes: 6 * 60, endMinutes: 7 * 60 }]);
  });

  it("shows the evening half only when the grid extends to it", () => {
    expect(sleepBandsForDate("2030-04-02", nights, { startHour: 6, endHour: 24 })).toEqual([
      { startMinutes: 6 * 60, endMinutes: 7 * 60 },
      { startMinutes: 23 * 60, endMinutes: 24 * 60 },
    ]);
  });

  it("handles a bedtime after midnight on the same day", () => {
    const late = [{ date: "2030-04-02", startTime: "00:30", endTime: "08:00" }];
    expect(sleepBandsForDate("2030-04-02", late, range)).toEqual([{ startMinutes: 6 * 60, endMinutes: 8 * 60 }]);
  });
});

describe("course labels and spoken descriptions", () => {
  it("shortens course names to something that fits a narrow block", () => {
    expect(courseShortName("CHEM 101 - General Chemistry")).toBe("CHEM 101");
    expect(courseShortName("cs101")).toBe("CS 101");
    expect(courseShortName("Intro to Bio 101")).toBe("BIO 101");
    expect(courseShortName("Organic Chemistry")).toBe("OC");
    expect(courseShortName("Organic Chemistry II")).toBe("OC II");
    expect(courseShortName("Introduction to Psychology")).toBe("IP");
    expect(courseShortName("Statistics")).toBe("STAT");
    expect(courseShortName("Calculus II")).toBe("CALC II");
    expect(courseShortName("Art")).toBe("ART");
    expect(courseShortName("Latin")).toBe("LATIN");
    // A cut or initials that would spell something else are made another way.
    expect(courseShortName("Analysis")).toBe("ANLY");
    expect(courseShortName("Analysis II")).toBe("ANLY II");
    expect(courseShortName("Applied Social Science")).toBe("APPL");
    expect(shortWord("Assessment")).toBe("ASMN");
    expect(shortWord("Butterfly")).toBe("BTRF");
    expect(shortWord("Hellenistic")).toBe("HLNS");
    expect(shortWord("Chemistry")).toBe("CHEM");
    expect(shortWord("gym")).toBe("GYM");
    expect(courseShortName("   ")).toBe("");
  });

  it("finds a block's course from the class or through its task", () => {
    const context = {
      classes: [{ id: "c1", name: "CHEM 101 - General Chemistry" }],
      tasks: [{ id: "t1", courseId: "c1", courseName: "General Chemistry" }, { id: "t2", courseId: "gone", courseName: "History of Art" }],
    };
    expect(blockCourseLabel({ courseId: "c1" }, context)).toBe("CHEM 101");
    expect(blockCourseLabel({ taskId: "t1" }, context)).toBe("CHEM 101");
    expect(blockCourseLabel({ taskId: "t2" }, context)).toBe("HA");
    expect(blockCourseLabel({}, context)).toBeUndefined();
    expect(blockCourseLabel({ taskId: "missing" }, context)).toBeUndefined();
  });

  it("a class's own short name wins over the one made from its name, wherever the class is shown", () => {
    const cls = { id: "c1", name: "FINC 3100: Principles of Finance", shortName: "FINC" };
    expect(classShortName(cls)).toBe("FINC");
    expect(classShortName({ name: "Principles of Finance" })).toBe("PF");
    expect(classShortName({ name: "Principles of Finance", shortName: "   " })).toBe("PF");
    expect(classShortName(undefined, "Calculus II")).toBe("CALC II");
    expect(classShortName(null)).toBe("");
    const context = { classes: [cls], tasks: [{ id: "t1", courseId: "c1", courseName: cls.name }, { id: "t2", courseId: "old-id", courseName: cls.name }] };
    expect(blockCourseLabel({ courseId: "c1" }, context)).toBe("FINC");
    expect(blockCourseLabel({ taskId: "t1" }, context)).toBe("FINC");
    // A task whose class id went stale still finds the class by its name.
    expect(blockCourseLabel({ taskId: "t2" }, context)).toBe("FINC");
  });

  it("a task's class is found by its id, or by its name when the id has gone stale, the same way everywhere", () => {
    const classes = [{ id: "c1", name: "Calculus II", shortName: "CALC" }, { id: "c2", name: "Organic Chemistry" }];
    expect(classOfTask({ courseId: "c1", courseName: "whatever" }, classes)?.id).toBe("c1");
    expect(classOfTask({ courseId: "gone", courseName: "Calculus II" }, classes)?.id).toBe("c1");
    expect(classOfTask({ courseId: "gone", courseName: "History" }, classes)).toBeUndefined();
    expect(classOfTask({}, classes)).toBeUndefined();
    // Week's "due" row uses the class's own tag for something that is not a quiz or an exam.
    expect(deadlineChipLabel({ name: "Lab report", courseName: "Calculus II" }, classShortName(classOfTask({ courseId: "c1" }, classes)))).toBe("CALC");
    expect(deadlineChipLabel({ name: "Lab report", courseName: "Calculus II" })).toBe("CALC II");
    expect(deadlineChipLabel({ name: "Quiz 4", courseName: "Calculus II" }, "CALC")).toBe("QUIZ 4");
  });

  it("stores a short name in capitals, without punctuation, and no longer than a chip can hold", () => {
    expect(normalizeShortName("  finc ")).toBe("FINC");
    expect(normalizeShortName("calc  ii")).toBe("CALC II");
    expect(normalizeShortName("c.s.-101")).toBe("C S 101");
    expect(normalizeShortName("ABCDEFGHIJKLMNOP")).toHaveLength(SHORT_NAME_MAX);
    expect(normalizeShortName("!!!")).toBe("");
  });

  it("offers the letters of the course code, the longer form when another class has that tag, and initials with no code", () => {
    expect(suggestShortName({ name: "Principles of Finance", code: "FINC 3100" })).toBe("FINC");
    expect(suggestShortName({ name: "Corporate Finance", code: "FINC 3200", taken: ["FINC"] })).toBe("FINC 3200");
    expect(suggestShortName({ name: "Principles of Finance", code: "" })).toBe("PF");
    expect(suggestShortName({ name: "Calculus II" })).toBe("CALC II");
    expect(suggestShortName({ name: "", code: "" })).toBe("");
    // A long word is not a course code, and a code with no letters is not part of the name.
    expect(suggestShortName({ name: "Financial Reporting", code: "ACCOUNTING 101" })).toBe("FR");
    expect(suggestShortName({ name: "Principles of Finance", code: "3100" })).toBe("PF");
    expect(suggestShortName({ name: "Principles of Finance", code: "FINC-3100" })).toBe("FINC");
    // Whatever is offered is something the field accepts unchanged.
    for (const offered of [suggestShortName({ name: "Introduction to Organic Chemistry Laboratory", code: "CHEM 2010A", taken: ["CHEM"] }), suggestShortName({ name: "Statistics" })]) {
      expect(normalizeShortName(offered)).toBe(offered);
      expect(offered.length).toBeLessThanOrEqual(SHORT_NAME_MAX);
    }
  });

  it("strips the generated verb prefix from titles", () => {
    expect(blockDisplayTitle("Work on: Essay (1/2)")).toBe("Essay (1/2)");
    expect(blockDisplayTitle("Study: Chem exam prep — Practice")).toBe("Chem exam prep — Practice");
    expect(blockDisplayTitle("Catch up: Lab report")).toBe("Lab report");
    expect(blockDisplayTitle("Club meeting")).toBe("Club meeting");
  });

  it("speaks time ranges the way a person would", () => {
    expect(spokenTimeRange("15:00", "16:00")).toBe("3 to 4 PM");
    expect(spokenTimeRange("11:00", "13:00")).toBe("11 AM to 1 PM");
    expect(spokenTimeRange("09:30", "10:45")).toBe("9:30 to 10:45 AM");
    expect(spokenTimeRange("12:00", "13:00")).toBe("12 to 1 PM");
  });

  const study = (overrides: Partial<ScheduleBlock> = {}): ScheduleBlock => ({
    id: "study-t1-1-2030-04-02", type: "study", title: "Study: Chem exam prep", date: "2030-04-02", startTime: "15:00", endTime: "16:00",
    locked: false, accepted: false, taskId: "t1", color: "#8B5CF6", completionStatus: "pending", ...overrides,
  });

  it("describes a flexible study block for a screen reader", () => {
    expect(describeBlockForA11y(study())).toBe("Study: Chem exam prep, Tuesday 3 to 4 PM, flexible");
  });

  it("adds the course, flexible / kept, never-moves and completion state", () => {
    expect(describeBlockForA11y(study(), "CHEM 101")).toBe("Study: Chem exam prep (CHEM 101), Tuesday 3 to 4 PM, flexible");
    expect(describeBlockForA11y(study({ accepted: true }))).toBe("Study: Chem exam prep, Tuesday 3 to 4 PM, kept");
    expect(describeBlockForA11y(study({ accepted: true, locked: true }))).toBe("Study: Chem exam prep, Tuesday 3 to 4 PM, kept, never moves");
    expect(describeBlockForA11y(study({ completionStatus: "done" }))).toBe("Study: Chem exam prep, Tuesday 3 to 4 PM, done");
    expect(describeBlockForA11y(study({ completionStatus: "skipped" }))).toBe("Study: Chem exam prep, Tuesday 3 to 4 PM, skipped");
  });

  it("does not call a class 'kept' or 'never moves'", () => {
    const cls = study({ type: "class", title: "General Chemistry", accepted: true, locked: true, taskId: undefined });
    expect(describeBlockForA11y(cls)).toBe("Class: General Chemistry, Tuesday 3 to 4 PM");
  });

  it("knows which sessions are flexible: auto-planned study the student has not kept, still to do", () => {
    expect(isFlexibleSession(study())).toBe(true);
    expect(isFlexibleSession(study({ accepted: true }))).toBe(false);
    expect(isFlexibleSession(study({ completionStatus: "done" }))).toBe(false);
    expect(isFlexibleSession(study({ type: "class", taskId: undefined }))).toBe(false);
  });
});

describe("what the Week grid draws", () => {
  it("leaves out sleep (drawn as bands) and transitions (busy time for the planner only)", () => {
    expect(showsOnWeekGrid({ type: "sleep" })).toBe(false);
    expect(showsOnWeekGrid({ type: "buffer", title: "Transition" })).toBe(false);
    // A "buffer" event the student made (Ask AI can create one) is shown, so it can be seen, edited and deleted.
    expect(showsOnWeekGrid({ type: "buffer", title: "Commute" })).toBe(true);
    for (const type of ["class", "study", "recurring", "work", "free"] as const) expect(showsOnWeekGrid({ type })).toBe(true);
  });
});

describe("verticalTouchSlops (44 pt touch areas that never reach into a neighbour)", () => {
  const frame = (top: number, height: number, left = 2, width = 40) => ({ top, height, left, width });

  it("grows a short block evenly, and a block at the top of the grid only downwards", () => {
    expect(verticalTouchSlops([frame(100, 18)], 500)).toEqual([{ top: 13, bottom: 13 }]);
    expect(verticalTouchSlops([frame(0, 20)], 500)).toEqual([{ top: 0, bottom: 24 }]);
    expect(verticalTouchSlops([frame(480, 20)], 500)).toEqual([{ top: 24, bottom: 0 }]);
  });

  it("leaves blocks that are tall enough alone", () => {
    expect(verticalTouchSlops([frame(100, 56)], 500)).toEqual([{ top: 0, bottom: 0 }]);
  });

  it("never grows into a touching block: each grows away from the other", () => {
    expect(verticalTouchSlops([frame(100, 20), frame(120, 20)], 500)).toEqual([{ top: 24, bottom: 0 }, { top: 0, bottom: 24 }]);
  });

  it("splits a gap between two blocks half and half, so the touch areas meet but do not overlap", () => {
    const [a, b] = verticalTouchSlops([frame(100, 20), frame(130, 20)], 500);
    expect(a).toEqual({ top: 19, bottom: 5 });
    expect(b).toEqual({ top: 5, bottom: 19 });
    expect(100 + 20 + a!.bottom).toBeLessThanOrEqual(130 - b!.top);
  });

  it("ignores blocks in another lane (beside it, not above or below)", () => {
    const slops = verticalTouchSlops([frame(100, 20, 2, 20), frame(120, 20, 24, 20)], 500);
    expect(slops).toEqual([{ top: 12, bottom: 12 }, { top: 12, bottom: 12 }]);
  });

  it("touch areas never overlap, never leave the grid, and reach 44 pt when the gaps allow (randomised)", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 30; round += 1) {
      const frames: ReturnType<typeof frame>[] = [];
      let y = Math.floor(random() * 30);
      for (let i = 0; i < 8; i += 1) {
        const height = 18 + Math.floor(random() * 40);
        frames.push(frame(y, height));
        y += height + Math.floor(random() * 60);
      }
      const grid = y + 40;
      const slops = verticalTouchSlops(frames, grid);
      for (let i = 0; i < frames.length; i += 1) {
        const top = frames[i]!.top - slops[i]!.top;
        const bottom = frames[i]!.top + frames[i]!.height + slops[i]!.bottom;
        if (i > 0) expect(top).toBeGreaterThanOrEqual(frames[i - 1]!.top + frames[i - 1]!.height + slops[i - 1]!.bottom);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(bottom).toBeLessThanOrEqual(grid);
        // Enough room around it (its share of each gap): the block reaches the minimum, give or take a point of rounding.
        const gapAbove = i === 0 ? frames[0]!.top : (frames[i]!.top - (frames[i - 1]!.top + frames[i - 1]!.height)) / 2;
        const gapBelow = i === frames.length - 1 ? grid - (frames[i]!.top + frames[i]!.height) : (frames[i + 1]!.top - (frames[i]!.top + frames[i]!.height)) / 2;
        if (gapAbove + gapBelow >= 44 - frames[i]!.height) expect(bottom - top).toBeGreaterThanOrEqual(43);
      }
    }
  });
});

describe("outside calendar events on the Week grid", () => {
  const event = (overrides: Partial<GoogleCalendarEventLocal>): GoogleCalendarEventLocal => ({
    id: "e1", calendarId: "c", title: "Trip", startDate: "2030-04-05", endDate: "2030-04-05", startTime: "19:00", endTime: "21:00",
    isAllDay: false, isRecurring: false, status: "active", syncedAt: "2030-04-01T00:00:00.000Z", ...overrides,
  });
  const overnight = event({ startDate: "2030-04-05", endDate: "2030-04-07", startTime: "22:00", endTime: "02:00", source: "device" }); // Fri 22:00 - Sun 02:00

  it("draws a same-day event on its day only", () => {
    expect(timedEventSpanOn(event({}), "2030-04-05")).toEqual({ startTime: "19:00", endTime: "21:00" });
    expect(timedEventSpanOn(event({}), "2030-04-06")).toBeNull();
  });

  it("draws an event over several days on every day it covers", () => {
    expect(timedEventSpanOn(overnight, "2030-04-04")).toBeNull();
    expect(timedEventSpanOn(overnight, "2030-04-05")).toEqual({ startTime: "22:00", endTime: "24:00" });
    expect(timedEventSpanOn(overnight, "2030-04-06")).toEqual({ startTime: "00:00", endTime: "24:00" });
    expect(timedEventSpanOn(overnight, "2030-04-07")).toEqual({ startTime: "00:00", endTime: "02:00" });
    expect(timedEventSpanOn(overnight, "2030-04-08")).toBeNull();
  });

  it("skips all-day and cancelled events, a last day that ends at midnight, and gives a missing end an hour", () => {
    expect(timedEventSpanOn(event({ isAllDay: true, startTime: undefined }), "2030-04-05")).toBeNull();
    expect(timedEventSpanOn(event({ status: "cancelled" }), "2030-04-05")).toBeNull();
    expect(timedEventSpanOn(event({ endDate: "2030-04-06", startTime: "22:00", endTime: "00:00" }), "2030-04-06")).toBeNull();
    expect(timedEventSpanOn(event({ endTime: undefined }), "2030-04-05")).toEqual({ startTime: "19:00", endTime: "20:00" });
    expect(timedEventSpanOn(event({ startTime: "23:30", endTime: undefined }), "2030-04-05")).toEqual({ startTime: "23:30", endTime: "24:00" });
  });

  it("labels each event by where it came from", () => {
    expect(calendarSourceLabel({ source: "device" })).toBe("Calendar");
    expect(calendarSourceLabel({ source: "google" })).toBe("Google Calendar");
    expect(calendarSourceLabel({})).toBe("Google Calendar"); // older saved Google events have no source
    expect(calendarEventKey({ id: "x", source: "device" })).not.toBe(calendarEventKey({ id: "x" }));
  });

  it("shows and speaks the real times, with both days when an event runs into another day", () => {
    expect(calendarEventTimeLabel(event({}))).toBe("7:00 PM – 9:00 PM");
    expect(calendarEventTimeLabel(overnight)).toBe("10:00 PM Fri – 2:00 AM Sun");
    expect(calendarEventTimeLabel(event({ isAllDay: true, startTime: undefined }))).toBe("All day");
    expect(describeCalendarEventForA11y(event({ title: "Dinner" }))).toBe("Google Calendar: Dinner, Friday 7 to 9 PM");
    expect(describeCalendarEventForA11y(overnight)).toBe("Calendar: Trip, Friday 10 PM to Sunday 2 AM");
  });
});

describe("deadlineChipLabel (the Week grid's due chips)", () => {
  it("keeps what tells deadlines apart, short enough for a day column", () => {
    expect(deadlineChipLabel({ name: "Quiz 4" })).toBe("QUIZ 4");
    expect(deadlineChipLabel({ name: "Quiz #3: Chapter 5" })).toBe("QUIZ 3");
    expect(deadlineChipLabel({ name: "Exam 2: Chapters 1-5" })).toBe("EXAM 2");
    expect(deadlineChipLabel({ name: "Midterm Exam" })).toBe("MIDTERM");
    expect(deadlineChipLabel({ name: "Mid-term" })).toBe("MIDTERM");
    expect(deadlineChipLabel({ name: "Final" })).toBe("FINAL");
  });

  it("falls back to the course code, then the first word", () => {
    expect(deadlineChipLabel({ name: "Weekly check-in", courseName: "CHEM 101 - General Chemistry" })).toBe("CHEM 101");
    expect(deadlineChipLabel({ name: "Weekly check-in", courseName: "General" })).toBe("WEEKLY");
    expect(deadlineChipLabel({ name: "Weekly check-in" })).toBe("WEEKLY");
  });
});

describe("week navigation helpers", () => {
  it("walks whole weeks from today, across the semester and the year boundary", () => {
    expect(weekStartForOffset("2030-04-02", 0)).toBe("2030-04-01");
    expect(weekStartForOffset("2030-04-02", 2)).toBe("2030-04-15");
    expect(weekStartForOffset("2030-04-02", -1)).toBe("2030-03-25");
    expect(weekStartForOffset("2030-04-07", 0)).toBe("2030-04-01"); // Sunday belongs to the Monday before
    expect(weekStartForOffset("2030-12-30", 1)).toBe("2031-01-06");
    expect(weekStartForOffset("2030-04-02", 30)).toBe("2030-10-28");
    expect(weekDateKeys("2030-04-01")).toEqual(["2030-04-01", "2030-04-02", "2030-04-03", "2030-04-04", "2030-04-05", "2030-04-06", "2030-04-07"]);
  });

  it("formats the week label", () => {
    expect(formatWeekRange("2030-04-01")).toBe("Apr 1 – Apr 7");
    expect(formatWeekRange("2029-12-31")).toBe("Dec 31 – Jan 6");
  });

  it("pre-fills the '+' button with a day that has not passed", () => {
    expect(defaultAddDate("2030-04-01", "2030-04-03")).toBe("2030-04-03"); // this week: today, not Monday
    expect(defaultAddDate("2030-04-08", "2030-04-03")).toBe("2030-04-08"); // future week: its first day
    expect(defaultAddDate("2030-03-25", "2030-04-03")).toBe("2030-04-03"); // past week: today
  });
});

describe("minuteWheelOptions", () => {
  const grid = [0, 5, 10, 15];
  it("leaves an on-grid minute alone and keeps an off-grid one selectable, in order", () => {
    expect(minuteWheelOptions(10, grid)).toEqual([0, 5, 10, 15]);
    expect(minuteWheelOptions(7, grid)).toEqual([0, 5, 7, 10, 15]);
    expect(grid).toEqual([0, 5, 10, 15]); // input not mutated
  });
});

describe("block edit patches", () => {
  it("every manual edit keeps the id and marks the block edited + accepted", () => {
    const block = { id: "study-t1-1-2030-03-05", locked: false };
    expect(timeEditPatch(block, "10:00", "11:00")).toEqual({ id: block.id, startTime: "10:00", endTime: "11:00", notificationId: undefined, accepted: true, userEdited: true });
    expect(moveDayPatch(block, "2030-03-06")).toEqual({ id: block.id, date: "2030-03-06", notificationId: undefined, accepted: true, userEdited: true });
    expect(lockTogglePatch(block)).toMatchObject({ id: block.id, locked: true, accepted: true, userEdited: true });
    expect(lockTogglePatch({ ...block, locked: true }).locked).toBe(false);
  });
});

describe("allDayEventCovers", () => {
  it("treats Google's exclusive all-day end date correctly", () => {
    const oneDay = { startDate: "2030-03-14", endDate: "2030-03-15" };
    expect(allDayEventCovers(oneDay, "2030-03-13")).toBe(false);
    expect(allDayEventCovers(oneDay, "2030-03-14")).toBe(true);
    expect(allDayEventCovers(oneDay, "2030-03-15")).toBe(false);
    const trip = { startDate: "2030-03-14", endDate: "2030-03-17" };
    expect(["2030-03-14", "2030-03-15", "2030-03-16"].every((d) => allDayEventCovers(trip, d))).toBe(true);
    expect(allDayEventCovers(trip, "2030-03-17")).toBe(false);
  });

  it("covers just its start date when there is no end date (or it equals the start)", () => {
    expect(allDayEventCovers({ startDate: "2030-03-14" }, "2030-03-14")).toBe(true);
    expect(allDayEventCovers({ startDate: "2030-03-14" }, "2030-03-15")).toBe(false);
    expect(allDayEventCovers({ startDate: "2030-03-14", endDate: "2030-03-14" }, "2030-03-14")).toBe(true);
  });
});

describe("summarizeWeek", () => {
  const block = (overrides: Partial<ScheduleBlock>): ScheduleBlock => ({
    id: "x", type: "study", title: "t", date: "2030-04-02", startTime: "10:00", endTime: "11:00", locked: false, accepted: true, color: "#000", completionStatus: "pending", ...overrides,
  });

  it("counts study time, tasks and the peak day, ignoring sleep, transitions and skipped sessions", () => {
    const summary = summarizeWeek([
      block({ id: "a", taskId: "t1", startTime: "10:00", endTime: "12:00" }),
      block({ id: "b", taskId: "t2", date: "2030-04-03", startTime: "10:00", endTime: "11:00" }),
      block({ id: "c", taskId: "t3", date: "2030-04-03", startTime: "12:00", endTime: "15:00", completionStatus: "skipped" }),
      block({ id: "d", type: "class", taskId: undefined }),
      block({ id: "e", type: "sleep", taskId: undefined }),
      block({ id: "f", type: "free", taskId: undefined }),
      block({ id: "g", type: "buffer", title: "Transition", taskId: undefined }),
    ]);
    expect(summary).toEqual({
      totalBlocks: 5, studyBlocks: 2, studyHours: 3, classBlocks: 1, freeBlocks: 1, tasksScheduled: 2, peakStudyDay: "Tuesday",
    });
  });

  it("reports an empty week as empty", () => {
    expect(summarizeWeek([])).toEqual({ totalBlocks: 0, studyBlocks: 0, studyHours: 0, classBlocks: 0, freeBlocks: 0, tasksScheduled: 0, peakStudyDay: "" });
  });
});
