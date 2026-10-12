import { describe, expect, it } from "vitest";
import {
  MAX_SLEEP_TARGET_HOURS,
  MIN_SLEEP_TARGET_HOURS,
  clampSleepTarget,
  formatSleepDuration,
  sleepWindowMinutes,
  sleepWindowWarning,
} from "../../src/engine/sleep-window";

describe("sleep window", () => {
  it("measures the window between bedtime and the next wake time", () => {
    expect(sleepWindowMinutes("23:00", "07:00")).toBe(8 * 60);
    expect(sleepWindowMinutes("22:30", "06:15")).toBe(7 * 60 + 45);
  });

  it("handles a bedtime after midnight (window stays within the same morning)", () => {
    expect(sleepWindowMinutes("00:30", "08:00")).toBe(7 * 60 + 30);
    expect(sleepWindowMinutes("02:00", "02:00")).toBe(24 * 60);
  });

  it("formats durations", () => {
    expect(formatSleepDuration(480)).toBe("8h");
    expect(formatSleepDuration(450)).toBe("7h 30m");
  });

  it("keeps the sleep target in half-hour steps within a sane range", () => {
    expect(clampSleepTarget(7.3)).toBe(7.5);
    expect(clampSleepTarget(1)).toBe(MIN_SLEEP_TARGET_HOURS);
    expect(clampSleepTarget(20)).toBe(MAX_SLEEP_TARGET_HOURS);
  });

  it("warns when the window is shorter than the target, and stays quiet otherwise", () => {
    expect(sleepWindowWarning("23:00", "07:00", 8)).toBeNull();
    expect(sleepWindowWarning("01:00", "06:00", 8)).toBe("This window is 5h, shorter than your 8h target.");
    // within half an hour of the target is fine
    expect(sleepWindowWarning("23:30", "07:00", 8)).toBeNull();
  });
});
