import { describe, expect, it } from "vitest";
import { DAILY_STUDY_CAP } from "../../src/engine/intelligent-scheduler";
import { fixMyDay, fixMyDayDetailed, stripLegacyBlocks } from "../../src/engine/scheduler";
import { DEFAULT_HEALTH_PREFS, ScheduleBlock } from "../../src/engine/types";
import { timeToMinutes } from "../../src/engine/utils";
import { localMoment, makeBlock, overlaps, TODAY } from "./scheduler-fixtures";

const NOON = localMoment(2030, 3, 13, 12, 0);
const study = (overrides: Partial<ScheduleBlock>) => makeBlock({ type: "study", taskId: "task-x", ...overrides });
const at = (blocks: ScheduleBlock[], id: string) => blocks.find((b) => b.id === id)!;

describe("fixMyDay (bugs: dropped an in-progress block, moved a user-added 14:00 event, ignored 'now')", () => {
  it("never drops a block: every input id is in the output, moved or not", () => {
    const blocks = [
      study({ id: "in-progress", startTime: "11:30", endTime: "13:00" }),
      study({ id: "later", startTime: "15:00", endTime: "16:00" }),
      study({ id: "missed", startTime: "08:00", endTime: "09:00" }),
      makeBlock({ id: "class", type: "class", startTime: "14:00", endTime: "15:00", locked: false }),
    ];
    const result = fixMyDayDetailed(blocks, TODAY, "protect_sleep", DEFAULT_HEALTH_PREFS, { now: NOON });
    expect(result.blocks.map((b) => b.id).sort()).toEqual(blocks.map((b) => b.id).sort());
    expect(fixMyDay(blocks, TODAY, "protect_sleep", DEFAULT_HEALTH_PREFS, NOON)).toEqual(result.blocks);
  });

  it("an in-progress block is immovable and other blocks flow around it", () => {
    const blocks = [
      study({ id: "in-progress", startTime: "11:30", endTime: "13:00" }),
      study({ id: "missed", startTime: "08:00", endTime: "09:00" }),
    ];
    const result = fixMyDayDetailed(blocks, TODAY, "protect_sleep", DEFAULT_HEALTH_PREFS, { now: NOON });
    expect(at(result.blocks, "in-progress")).toEqual(blocks[0]);
    const missed = at(result.blocks, "missed");
    expect(timeToMinutes(missed.startTime)).toBeGreaterThanOrEqual(13 * 60); // after the in-progress block ends
    expect(overlaps(missed, at(result.blocks, "in-progress"))).toBe(false);
  });

  it("missed blocks are re-placed after now, and NOTHING lands before now", () => {
    const blocks = [
      study({ id: "m1", startTime: "07:30", endTime: "09:00" }),
      study({ id: "m2", startTime: "09:30", endTime: "10:30" }),
      study({ id: "future", startTime: "18:00", endTime: "19:00" }),
    ];
    const result = fixMyDayDetailed(blocks, TODAY, "protect_sleep", DEFAULT_HEALTH_PREFS, { now: NOON });
    for (const move of result.moved) {
      expect(timeToMinutes(move.to.startTime)).toBeGreaterThanOrEqual(12 * 60 + 5);
      expect(move.wasMissed).toBe(move.id !== "future");
    }
    expect(result.moved.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(at(result.blocks, "future")).toEqual(blocks[2]); // untouched: it was fine where it was
    for (const block of result.blocks) expect(block.completionStatus).toBe("pending");
    expect(result.unplaced).toEqual([]);
  });

  it("user-created events and structural blocks are fixed: a 14:00 user event is not moved to 12:05", () => {
    const event = makeBlock({ id: "doctor", type: "free", title: "Doctor appointment", startTime: "14:00", endTime: "15:00" });
    const cls = makeBlock({ id: "class", type: "class", locked: true, startTime: "16:00", endTime: "17:00" });
    const work = makeBlock({ id: "shift", type: "work", startTime: "17:30", endTime: "19:00" });
    const userStudy = makeBlock({ id: "user-study", type: "study", title: "Study group", startTime: "13:00", endTime: "14:00" }); // no taskId: user-created
    const planned = study({ id: "planned", startTime: "15:30", endTime: "16:30" }); // collides with the class
    const result = fixMyDayDetailed([event, cls, work, userStudy, planned], TODAY, "protect_sleep", DEFAULT_HEALTH_PREFS, { now: NOON });

    for (const fixed of [event, cls, work, userStudy]) expect(at(result.blocks, fixed.id)).toEqual(fixed);
    const moved = at(result.blocks, "planned");
    expect([event, cls, work, userStudy].some((f) => overlaps(f, moved))).toBe(false);
    expect(result.moved.map((m) => m.id)).toEqual(["planned"]);
  });

  it("started, edited, locked, finished and skipped blocks are never moved", () => {
    const blocks = [
      study({ id: "started", startTime: "08:00", endTime: "09:00", startedAt: "2030-03-13T08:01:00.000Z" }),
      study({ id: "edited", startTime: "09:00", endTime: "10:00", userEdited: true }),
      study({ id: "locked", startTime: "10:00", endTime: "11:00", locked: true }),
      study({ id: "done", startTime: "07:30", endTime: "08:00", completionStatus: "done" }),
      study({ id: "skipped", startTime: "06:00", endTime: "07:00", completionStatus: "skipped" }),
      study({ id: "flagged", startTime: "11:00", endTime: "11:45" }),
    ];
    const result = fixMyDayDetailed(blocks, TODAY, "protect_sleep", DEFAULT_HEALTH_PREFS, { now: NOON, startedBlockIds: ["flagged"] });
    expect(result.blocks).toEqual(blocks);
    expect(result.moved).toEqual([]);
    expect(result.unplaced).toEqual([]);
  });

  it("blocks that cannot be placed are returned as unplaced with a reason (not dropped) and flagged in the output", () => {
    const now = localMoment(2030, 3, 13, 21, 0);
    const blocks = [
      study({ id: "missed-big", title: "Missed", startTime: "10:00", endTime: "11:30" }),
      study({ id: "also-missed", startTime: "13:00", endTime: "14:30" }),
    ];
    const result = fixMyDayDetailed(blocks, TODAY, "protect_sleep", { ...DEFAULT_HEALTH_PREFS, bedtime: "23:00" }, { now });

    expect(result.blocks).toHaveLength(2);
    expect(result.unplaced.map((u) => u.block.id).sort()).toEqual(["also-missed", "missed-big"]);
    for (const { block, reason } of result.unplaced) {
      expect(reason).toMatch(/no free slot is left before your wind-down time/i);
      expect(block.accepted).toBe(false);
      expect(block.completionStatus).toBe("missed");
      expect(at(result.blocks, block.id)).toEqual(block);
    }
    expect(result.moved).toEqual([]);
  });

  it("crunch mode may use the late evening that protect-sleep mode keeps free", () => {
    const now = localMoment(2030, 3, 13, 21, 0);
    const blocks = [study({ id: "missed", startTime: "10:00", endTime: "11:30" })];
    const prefs = { ...DEFAULT_HEALTH_PREFS, bedtime: "23:00" };
    expect(fixMyDayDetailed(blocks, TODAY, "protect_sleep", prefs, { now }).unplaced).toHaveLength(1);
    const crunch = fixMyDayDetailed(blocks, TODAY, "crunch_mode", prefs, { now });
    expect(crunch.unplaced).toEqual([]);
    const placed = at(crunch.blocks, "missed");
    expect(timeToMinutes(placed.startTime)).toBeGreaterThanOrEqual(21 * 60 + 5);
    expect(timeToMinutes(placed.endTime)).toBeLessThanOrEqual(23 * 60 + 55);
  });

  it("works with a bedtime after midnight and never wraps a block past midnight", () => {
    const now = localMoment(2030, 3, 13, 21, 0);
    const blocks = [study({ id: "missed", startTime: "10:00", endTime: "11:30" })];
    const result = fixMyDayDetailed(blocks, TODAY, "protect_sleep", { ...DEFAULT_HEALTH_PREFS, wakeTime: "08:00", bedtime: "01:00" }, { now });
    const placed = at(result.blocks, "missed");
    expect(result.unplaced).toEqual([]);
    expect(timeToMinutes(placed.endTime)).toBeGreaterThan(timeToMinutes(placed.startTime));
  });

  it("re-plans a future day from the start of its window, and leaves past days alone", () => {
    const tomorrow = "2030-03-14";
    const blocks = [study({ id: "early", date: tomorrow, startTime: "05:00", endTime: "06:00" }), study({ id: "past", date: "2030-03-12", startTime: "10:00", endTime: "11:00" })];
    const future = fixMyDayDetailed(blocks, tomorrow, "protect_sleep", DEFAULT_HEALTH_PREFS, { now: NOON });
    expect(timeToMinutes(at(future.blocks, "early").startTime)).toBeGreaterThanOrEqual(7 * 60 + 30);
    const past = fixMyDayDetailed(blocks, "2030-03-12", "protect_sleep", DEFAULT_HEALTH_PREFS, { now: NOON });
    expect(past.blocks).toEqual(blocks);
  });

  it("other days are untouched and no block is duplicated", () => {
    const other = study({ id: "other-day", date: "2030-03-15", startTime: "10:00", endTime: "11:00" });
    const result = fixMyDayDetailed([other, study({ id: "missed", startTime: "08:00", endTime: "09:00" })], TODAY, "protect_sleep", DEFAULT_HEALTH_PREFS, { now: NOON });
    expect(at(result.blocks, "other-day")).toEqual(other);
    expect(new Set(result.blocks.map((b) => b.id)).size).toBe(result.blocks.length);
  });

  it("brings missed sessions back only while the day has room for them (1.0.9 audit: 4 sessions + a missed one ended as 5)", () => {
    const four = ["13:00", "14:30", "16:00", "17:30"].map((start, i) => study({ id: `f${i}`, startTime: start, endTime: `${String(Number(start.slice(0, 2)) + 1)}:${start.slice(3)}` }));
    const missed = [study({ id: "m1", startTime: "08:00", endTime: "09:00" }), study({ id: "m2", startTime: "10:00", endTime: "11:00", completionStatus: "missed" })];
    const open = (blocks: ScheduleBlock[]) => blocks.filter((b) => b.type === "study" && (b.completionStatus === "pending" || b.completionStatus === "done"));
    const full = fixMyDayDetailed([...missed, ...four], TODAY, "crunch_mode", DEFAULT_HEALTH_PREFS, { now: NOON });
    expect(open(full.blocks)).toHaveLength(4);
    expect(full.moved).toEqual([]);
    expect(full.unplaced.map((u) => [u.block.id, u.block.completionStatus, u.reason])).toEqual([
      ["m1", "missed", "Today already has 4 study sessions."],
      ["m2", "missed", "Today already has 4 study sessions."],
    ]);
    // A finished and a started session count too; a skipped one does not. The earliest missed session comes back first.
    const mixed = [...missed, study({ id: "done", startTime: "07:00", endTime: "07:45", completionStatus: "done" }), study({ id: "skip", startTime: "11:15", endTime: "11:45", completionStatus: "skipped" }), ...four.slice(0, 2)];
    const room = fixMyDayDetailed(mixed, TODAY, "crunch_mode", DEFAULT_HEALTH_PREFS, { now: NOON });
    expect(room.moved.map((m) => m.id)).toEqual(["m1"]);
    expect(room.unplaced.map((u) => u.block.id)).toEqual(["m2"]);
    expect(open(room.blocks)).toHaveLength(4);
    // The cap is an option (default: the planner's 4 a day).
    expect(fixMyDayDetailed([...missed, ...four], TODAY, "crunch_mode", DEFAULT_HEALTH_PREFS, { now: NOON, maxSessions: 6 }).moved.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("a missed session that can no longer be placed takes no room: another missed one comes back (1.0.9 audit: the day ended with 3)", () => {
    // 1 finished + 2 still to come: room for one missed session. The earliest missed ones are prep for a quiz that took
    // place at 10:00 and homework that was due at 11:00: neither can be placed any more, so the 10:00 session comes back.
    const blocks = [
      study({ id: "done", startTime: "07:00", endTime: "07:45", completionStatus: "done" }),
      study({ id: "quiz-prep", taskId: "quiz", startTime: "08:00", endTime: "09:00" }),
      study({ id: "hw-due-11", taskId: "hw-due", startTime: "09:15", endTime: "09:45", completionStatus: "missed" }),
      study({ id: "essay", taskId: "essay", startTime: "10:00", endTime: "11:00" }),
      study({ id: "f0", startTime: "13:00", endTime: "14:00" }),
      study({ id: "f1", startTime: "14:30", endTime: "15:30" }),
    ];
    const latestEndFor = (block: ScheduleBlock) => (block.taskId === "quiz" ? null : block.taskId === "hw-due" ? 11 * 60 : undefined);
    const open = (list: ScheduleBlock[]) => list.filter((b) => b.type === "study" && (b.completionStatus === "pending" || b.completionStatus === "done"));
    const result = fixMyDayDetailed(blocks, TODAY, "protect_sleep", DEFAULT_HEALTH_PREFS, { now: NOON, latestEndFor });
    expect(result.moved.map((m) => m.id)).toEqual(["essay"]);
    expect(timeToMinutes(at(result.blocks, "essay").startTime)).toBeGreaterThanOrEqual(12 * 60 + 5);
    expect(result.unplaced.map((u) => [u.block.id, u.reason])).toEqual([
      ["quiz-prep", "There is no time left before its deadline."],
      ["hw-due-11", "It was due at 11:00 AM."],
    ]);
    expect(open(result.blocks)).toHaveLength(DAILY_STUDY_CAP);
  });

  it("property: with many mixed blocks, nothing is lost, nothing overlaps a fixed block, nothing lands before now, the day never gains past 4", () => {
    for (const hour of [7, 10, 12, 15, 18, 20]) {
      const now = localMoment(2030, 3, 13, hour, 10);
      const blocks: ScheduleBlock[] = [
        makeBlock({ id: "class", type: "class", locked: true, startTime: "09:00", endTime: "10:30" }),
        makeBlock({ id: "event", type: "free", startTime: "13:00", endTime: "14:00" }),
        makeBlock({ id: "shift", type: "work", locked: true, startTime: "16:30", endTime: "18:00" }),
        ...Array.from({ length: 6 }, (_, i) => study({ id: `s${i}`, startTime: `${String(8 + i * 2).padStart(2, "0")}:00`, endTime: `${String(9 + i * 2).padStart(2, "0")}:00` })),
      ];
      const result = fixMyDayDetailed(blocks, TODAY, "protect_sleep", DEFAULT_HEALTH_PREFS, { now });
      expect(result.blocks.map((b) => b.id).sort()).toEqual(blocks.map((b) => b.id).sort());
      // Sessions still to come (or done) stay; one that ended only comes back while the day holds fewer than 4.
      const left = (list: ScheduleBlock[]) => list.filter((b) => b.type === "study" && (b.completionStatus === "done" || (b.completionStatus === "pending" && timeToMinutes(b.endTime) > hour * 60 + 10)));
      expect(left(result.blocks).length, `at ${hour}:10`).toBeLessThanOrEqual(Math.max(DAILY_STUDY_CAP, left(blocks).length));
      const fixed = result.blocks.filter((b) => b.type !== "study");
      const nowMinutes = hour * 60 + 10;
      for (const move of result.moved) expect(timeToMinutes(move.to.startTime)).toBeGreaterThanOrEqual(nowMinutes);
      const movedIds = new Set(result.moved.map((m) => m.id));
      for (const block of result.blocks.filter((b) => movedIds.has(b.id))) {
        expect(fixed.some((f) => overlaps(f, block))).toBe(false);
      }
      const unplacedIds = new Set(result.unplaced.map((u) => u.block.id));
      const placedStudy = result.blocks.filter((b) => b.type === "study" && !unplacedIds.has(b.id) && (movedIds.has(b.id) || timeToMinutes(b.startTime) >= nowMinutes));
      for (let i = 0; i < placedStudy.length; i += 1) {
        for (let j = i + 1; j < placedStudy.length; j += 1) expect(overlaps(placedStudy[i]!, placedStudy[j]!)).toBe(false);
      }
    }
  });
});

describe("stripLegacyBlocks (meals and workouts were removed from the product)", () => {
  it("drops meal and workout blocks persisted by older versions and keeps everything else", () => {
    const blocks = [
      makeBlock({ id: "meal", type: "meal" as never }),
      makeBlock({ id: "workout", type: "workout" as never }),
      makeBlock({ id: "study" }),
      makeBlock({ id: "class", type: "class" }),
      makeBlock({ id: "sleep", type: "sleep" }),
      makeBlock({ id: "free", type: "free" }),
    ];
    expect(stripLegacyBlocks(blocks).map((b) => b.id)).toEqual(["study", "class", "sleep", "free"]);
    expect(stripLegacyBlocks([])).toEqual([]);
  });
});
