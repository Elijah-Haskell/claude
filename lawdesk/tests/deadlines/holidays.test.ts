// Legal holidays under K.S.A. 60-206(a)(6). Expected dates worked out by hand from the rules in
// K.S.A. 35-107(a) and 5 U.S.C. 6103(a) (e.g. "the third Monday in January") and a calendar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { legalHolidays, nthWeekday, kansasStatutoryHolidays, federalStatutoryHolidays, YEARS_WITH_COURT_ORDER } from "../../src/deadlines/holidays.ts";

const dates = (year: number) => legalHolidays(year).map((h) => h.date);

test("nthWeekday: first, third, last weekdays of a month", () => {
  // January 2026 starts on a Thursday, so its Mondays are the 5th, 12th, 19th, 26th.
  assert.equal(nthWeekday(2026, 1, 1, 1), "2026-01-05");
  assert.equal(nthWeekday(2026, 1, 1, 3), "2026-01-19");
  // May 2027 starts on a Saturday: Mondays 3, 10, 17, 24, 31 -> the last is the 31st.
  assert.equal(nthWeekday(2027, 5, 1, -1), "2027-05-31");
  // November 2026 starts on a Sunday: Thursdays 5, 12, 19, 26 -> the fourth is the 26th.
  assert.equal(nthWeekday(2026, 11, 4, 4), "2026-11-26");
  // A month whose 1st is the weekday itself: September 2025 starts on a Monday.
  assert.equal(nthWeekday(2025, 9, 1, 1), "2025-09-01");
});

test("2026 legal holidays: Kansas 35-107 days plus Juneteenth from 5 U.S.C. 6103", () => {
  assert.deepEqual(dates(2026), [
    "2026-01-01", // New Year's Day (Thursday)
    "2026-01-19", // 3rd Monday of January
    "2026-02-16", // Feb 1 is a Sunday; Mondays 2, 9, 16
    "2026-05-25", // May 1 is a Friday; Mondays 4, 11, 18, 25
    "2026-06-19", // Juneteenth: federal only (not in K.S.A. 35-107)
    "2026-07-04", // Saturday; NOT moved to Friday: no source read moves it for this purpose
    "2026-09-07", // Sept 1 is a Tuesday; first Monday is the 7th
    "2026-10-12", // Oct 1 is a Thursday; Mondays 5, 12
    "2026-11-11", // Veterans Day (Wednesday)
    "2026-11-26", // 4th Thursday
    "2026-12-25", // Christmas (Friday)
  ]);
  const june = legalHolidays(2026).find((h) => h.date === "2026-06-19")!;
  assert.equal(june.sources.length, 1);
  assert.match(june.sources[0], /6103/);
  const xmas = legalHolidays(2026).find((h) => h.date === "2026-12-25")!;
  assert.equal(xmas.sources.length, 2); // declared by both the Kansas legislature and Congress
});

test("2027: weekend holidays stay on their weekend date (no observed shift without an order)", () => {
  const d = dates(2027);
  assert.ok(d.includes("2027-06-19")); // Saturday
  assert.ok(d.includes("2027-07-04")); // Sunday
  assert.ok(d.includes("2027-12-25")); // Saturday
  assert.ok(!d.includes("2027-07-05"));
  assert.ok(!d.includes("2027-12-24"));
  assert.ok(d.includes("2027-05-31")); // Memorial Day, last Monday
  assert.ok(d.includes("2027-11-25")); // Thanksgiving: Nov 1 is a Monday; Thursdays 4, 11, 18, 25
});

test("2023 includes the Supreme Court order's observed days (Order 2022-CC-080)", () => {
  const d = dates(2023);
  assert.ok(d.includes("2023-01-01")); // statutory date (a Sunday)
  assert.ok(d.includes("2023-01-02")); // observed by the order
  assert.ok(d.includes("2023-11-10")); // Veterans Day observed on Friday by the order
  assert.ok(d.includes("2023-11-11")); // and the statutory Saturday date still counts
  assert.ok(d.includes("2023-11-24")); // Friday after Thanksgiving, by the order
  assert.ok(YEARS_WITH_COURT_ORDER.has(2023));
});

test("2025 includes Order 2024-CC-081 and the Jan. 9 National Day of Mourning (Order 2024-CC-105)", () => {
  const d = dates(2025);
  assert.ok(d.includes("2025-01-09"));
  assert.ok(d.includes("2025-11-28"));
  assert.ok(YEARS_WITH_COURT_ORDER.has(2025));
  assert.ok(!YEARS_WITH_COURT_ORDER.has(2026));
});

test("statutory lists: Kansas has 10 days, Congress 11", () => {
  assert.equal(kansasStatutoryHolidays(2026).length, 10);
  assert.equal(federalStatutoryHolidays(2026).length, 11);
});

test("extra holidays are merged and years outside the supported range are refused", () => {
  const d = legalHolidays(2026, [{ date: "2026-12-24", name: "Declared by the President", sources: ["Executive order (example)"] }]);
  assert.ok(d.some((h) => h.date === "2026-12-24"));
  assert.throws(() => legalHolidays(2019), RangeError);
});
