import { describe, expect, it } from "vitest";
import { fixMyDayDetailed } from "../../src/engine/scheduler";
import { getAwakeWindow } from "../../src/engine/awake-window";
import { DEFAULT_HEALTH_PREFS, ScheduleBlock } from "../../src/engine/types";
import { timeToMinutes } from "../../src/engine/utils";
import { localMoment, makeBlock, TODAY } from "./scheduler-fixtures";

// "Study sessions never land inside your sleep window" (website): Crunch mode may use the half hour protect-sleep
// keeps free before bedtime, but it stops AT bedtime (it used to run up to an hour past it).

const study = (overrides: Partial<ScheduleBlock>) => makeBlock({ type: "study", taskId: "task-x", ...overrides });
const at = (blocks: ScheduleBlock[], id: string) => blocks.find((b) => b.id === id)!;

describe("Crunch mode stops at bedtime", () => {
  it("bedtime 22:00: a 60-min session missed earlier does not fit after 21:05 and is reported, not pushed past bedtime", () => {
    const now = localMoment(2030, 3, 13, 21, 0);
    const prefs = { ...DEFAULT_HEALTH_PREFS, bedtime: "22:00" };
    const result = fixMyDayDetailed([study({ id: "missed", startTime: "10:00", endTime: "11:00" })], TODAY, "crunch_mode", prefs, { now });
    expect(result.moved).toEqual([]);
    expect(result.unplaced).toHaveLength(1);
    expect(result.unplaced[0]!.reason).toMatch(/no free slot is left before bedtime/i);
  });

  it("bedtime 22:00: crunch uses the last half hour protect-sleep keeps free, and ends by 22:00", () => {
    const now = localMoment(2030, 3, 13, 21, 0);
    const prefs = { ...DEFAULT_HEALTH_PREFS, bedtime: "22:00" };
    const blocks = [study({ id: "missed", startTime: "10:00", endTime: "10:45" })];
    expect(fixMyDayDetailed(blocks, TODAY, "protect_sleep", prefs, { now }).unplaced).toHaveLength(1); // 21:05-21:50 > 21:30
    const crunch = fixMyDayDetailed(blocks, TODAY, "crunch_mode", prefs, { now });
    expect(crunch.unplaced).toEqual([]);
    expect(timeToMinutes(at(crunch.blocks, "missed").endTime)).toBeLessThanOrEqual(22 * 60);
  });

  it("bedtime 01:00 (after midnight): crunch may use the evening up to 23:55 and never wraps past midnight", () => {
    const now = localMoment(2030, 3, 13, 22, 30);
    const prefs = { ...DEFAULT_HEALTH_PREFS, wakeTime: "08:00", bedtime: "01:00" };
    const result = fixMyDayDetailed([study({ id: "missed", startTime: "10:00", endTime: "11:00" })], TODAY, "crunch_mode", prefs, { now });
    const placed = at(result.blocks, "missed");
    expect(result.unplaced).toEqual([]);
    expect(timeToMinutes(placed.endTime)).toBeGreaterThan(timeToMinutes(placed.startTime));
    expect(timeToMinutes(placed.endTime)).toBeLessThanOrEqual(23 * 60 + 55);
  });

  it("property: for any bedtime and evening, no crunch session ends after bedtime", () => {
    for (const bedtime of ["21:00", "22:00", "22:30", "23:00", "23:30", "00:30", "01:00"]) {
      const prefs = { ...DEFAULT_HEALTH_PREFS, wakeTime: "07:00", bedtime };
      const awake = getAwakeWindow(prefs.wakeTime, bedtime);
      const latest = Math.min(awake.bedMinutes, 23 * 60 + 55);
      for (const hour of [17, 19, 20, 21, 22]) {
        const now = localMoment(2030, 3, 13, hour, 10);
        const blocks = Array.from({ length: 5 }, (_, i) => study({ id: `s${i}`, startTime: `${String(9 + i).padStart(2, "0")}:00`, endTime: `${String(9 + i).padStart(2, "0")}:50` }));
        const result = fixMyDayDetailed(blocks, TODAY, "crunch_mode", prefs, { now });
        for (const move of result.moved) {
          expect(timeToMinutes(move.to.endTime)).toBeLessThanOrEqual(latest);
          expect(timeToMinutes(move.to.endTime)).toBeGreaterThan(timeToMinutes(move.to.startTime));
        }
      }
    }
  });
});
