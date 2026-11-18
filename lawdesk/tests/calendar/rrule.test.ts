import { test } from "node:test";
import assert from "node:assert/strict";
import { RRuleError, formatRRule, occurrenceDates, parseRRule, startMatchesRule } from "../../src/calendar/rrule.ts";

const take = (rule: string, start: string, n = 100) => {
  const out: string[] = [];
  for (const d of occurrenceDates(parseRRule(rule), start)) {
    out.push(d);
    if (out.length >= n) break;
  }
  return out;
};

test("rrule: parses and re-serialises the supported subset", () => {
  assert.equal(formatRRule(parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6")), "FREQ=WEEKLY;INTERVAL=2;COUNT=6;BYDAY=MO,WE");
  assert.equal(formatRRule(parseRRule("rrule:freq=monthly;byday=-1fr;until=20271231")), "FREQ=MONTHLY;UNTIL=20271231;BYDAY=-1FR");
  assert.equal(formatRRule(parseRRule("FREQ=DAILY;INTERVAL=1")), "FREQ=DAILY");
  assert.equal(formatRRule(parseRRule("FREQ=WEEKLY;WKST=SU;BYDAY=TU")), "FREQ=WEEKLY;BYDAY=TU;WKST=SU");
});

test("rrule: rejects what it does not support instead of misreading it", () => {
  for (const bad of [
    "",
    "FREQ=HOURLY",
    "INTERVAL=2",
    "FREQ=MONTHLY;BYMONTHDAY=15",
    "FREQ=MONTHLY;BYDAY=1MO;BYSETPOS=1",
    "FREQ=DAILY;BYDAY=MO",
    "FREQ=YEARLY;BYDAY=1MO",
    "FREQ=WEEKLY;BYDAY=2MO",
    "FREQ=MONTHLY;BYDAY=6MO",
    "FREQ=MONTHLY;BYDAY=0MO",
    "FREQ=WEEKLY;BYDAY=XX",
    "FREQ=WEEKLY;BYDAY=MO,MO",
    "FREQ=DAILY;COUNT=0",
    "FREQ=DAILY;COUNT=3;UNTIL=20261231",
    "FREQ=DAILY;UNTIL=20260231",
    "FREQ=DAILY;INTERVAL=0",
    "FREQ=DAILY;FREQ=WEEKLY",
    "FREQ=DAILY;garbage",
  ]) {
    assert.throws(() => parseRRule(bad), RRuleError, bad);
  }
});

test("rrule: daily with interval and count", () => {
  assert.deepEqual(take("FREQ=DAILY;INTERVAL=3;COUNT=4", "2026-02-26"), ["2026-02-26", "2026-03-01", "2026-03-04", "2026-03-07"]);
});

test("rrule: weekly on several days, every other week (WKST=MO)", () => {
  // 2026-03-02 is a Monday
  assert.deepEqual(take("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=6", "2026-03-02"), [
    "2026-03-02",
    "2026-03-05",
    "2026-03-16",
    "2026-03-19",
    "2026-03-30",
    "2026-04-02",
  ]);
  // starting mid-week: days of the first week before the start are not included
  assert.deepEqual(take("FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4", "2026-03-04"), ["2026-03-04", "2026-03-06", "2026-03-09", "2026-03-11"]);
});

test("rrule: WKST changes which days share a week when INTERVAL > 1 (RFC 5545 §3.3.10 example)", () => {
  // The RFC's own example: DTSTART 1997-08-05 (Tue), FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU
  assert.deepEqual(take("FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO", "1997-08-05"), ["1997-08-05", "1997-08-10", "1997-08-19", "1997-08-24"]);
  assert.deepEqual(take("FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU", "1997-08-05"), ["1997-08-05", "1997-08-17", "1997-08-19", "1997-08-31"]);
});

test("rrule: weekly without BYDAY repeats on the start's weekday", () => {
  assert.deepEqual(take("FREQ=WEEKLY;COUNT=3", "2026-12-29"), ["2026-12-29", "2027-01-05", "2027-01-12"]);
});

test("rrule: monthly on the 31st skips months without one (RFC 5545 §3.3.10: invalid dates are ignored)", () => {
  assert.deepEqual(take("FREQ=MONTHLY;COUNT=5", "2026-01-31"), ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31"]);
});

test("rrule: monthly by weekday — second Tuesday and last Friday", () => {
  assert.deepEqual(take("FREQ=MONTHLY;BYDAY=2TU;COUNT=4", "2026-01-13"), ["2026-01-13", "2026-02-10", "2026-03-10", "2026-04-14"]);
  assert.deepEqual(take("FREQ=MONTHLY;BYDAY=-1FR;COUNT=3", "2026-01-30"), ["2026-01-30", "2026-02-27", "2026-03-27"]);
  // a fifth Monday only exists in some months
  assert.deepEqual(take("FREQ=MONTHLY;BYDAY=5MO;COUNT=3", "2026-03-30"), ["2026-03-30", "2026-06-29", "2026-08-31"]);
  // quarterly
  assert.deepEqual(take("FREQ=MONTHLY;INTERVAL=3;COUNT=3", "2026-11-15"), ["2026-11-15", "2027-02-15", "2027-05-15"]);
});

test("rrule: yearly on 29 February only in leap years", () => {
  assert.deepEqual(take("FREQ=YEARLY;COUNT=3", "2024-02-29"), ["2024-02-29", "2028-02-29", "2032-02-29"]);
  assert.deepEqual(take("FREQ=YEARLY;INTERVAL=2;COUNT=3", "2026-06-30"), ["2026-06-30", "2028-06-30", "2030-06-30"]);
});

test("rrule: without COUNT the series is unbounded (caller stops)", () => {
  assert.equal(take("FREQ=DAILY", "2026-01-01", 1000).length, 1000);
});

test("rrule: start date must be one of the repeat days", () => {
  assert.ok(startMatchesRule(parseRRule("FREQ=WEEKLY;BYDAY=MO,WE"), "2026-03-04"));
  assert.ok(!startMatchesRule(parseRRule("FREQ=WEEKLY;BYDAY=MO,WE"), "2026-03-03"));
  assert.ok(startMatchesRule(parseRRule("FREQ=MONTHLY;BYDAY=2TU"), "2026-03-10"));
  assert.ok(!startMatchesRule(parseRRule("FREQ=MONTHLY;BYDAY=2TU"), "2026-03-03"));
  assert.ok(startMatchesRule(parseRRule("FREQ=DAILY"), "2026-03-03"));
});
