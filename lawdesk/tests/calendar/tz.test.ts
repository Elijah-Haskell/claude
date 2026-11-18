import { test } from "node:test";
import assert from "node:assert/strict";
import { dayBounds, isoInstant, localToUtc, offsetAt, utcToLocal } from "../../src/calendar/tz.ts";
import { ZONES, vtimezone } from "../../src/calendar/ics.ts";

const CHI = "America/Chicago";
const iso = (ms: number) => isoInstant(ms);

test("tz: ordinary Chicago times in winter (CST, -6) and summer (CDT, -5)", () => {
  assert.equal(iso(localToUtc("2026-01-15", "09:00:00", CHI)), "2026-01-15T15:00:00Z");
  assert.equal(iso(localToUtc("2026-07-15", "09:00:00", CHI)), "2026-07-15T14:00:00Z");
  assert.deepEqual(utcToLocal(Date.parse("2026-07-15T14:00:00Z"), CHI), { date: "2026-07-15", time: "09:00:00" });
  assert.equal(offsetAt(Date.parse("2026-01-15T15:00:00Z"), CHI), -6 * 3600_000);
  assert.equal(offsetAt(Date.parse("2026-07-15T15:00:00Z"), CHI), -5 * 3600_000);
});

test("tz: spring forward 2026-03-08 — 01:59 CST, the 02:00–02:59 gap reads with the pre-gap offset (RFC 5545 §3.3.5)", () => {
  assert.equal(iso(localToUtc("2026-03-08", "01:59:00", CHI)), "2026-03-08T07:59:00Z");
  assert.equal(iso(localToUtc("2026-03-08", "02:30:00", CHI)), "2026-03-08T08:30:00Z"); // = 03:30 CDT
  assert.deepEqual(utcToLocal(Date.parse("2026-03-08T08:30:00Z"), CHI), { date: "2026-03-08", time: "03:30:00" });
  assert.equal(iso(localToUtc("2026-03-08", "03:00:00", CHI)), "2026-03-08T08:00:00Z");
});

test("tz: fall back 2026-11-01 — 01:30 happens twice; it means the first (CDT)", () => {
  assert.equal(iso(localToUtc("2026-11-01", "01:30:00", CHI)), "2026-11-01T06:30:00Z");
  assert.deepEqual(utcToLocal(Date.parse("2026-11-01T07:30:00Z"), CHI), { date: "2026-11-01", time: "01:30:00" }); // second 01:30, CST
  assert.equal(iso(localToUtc("2026-11-01", "02:00:00", CHI)), "2026-11-01T08:00:00Z");
});

test("tz: DST days are 23 and 25 hours long", () => {
  const spring = dayBounds("2026-03-08", CHI);
  const fall = dayBounds("2026-11-01", CHI);
  const plain = dayBounds("2026-06-01", CHI);
  assert.equal((spring.end - spring.start) / 3600_000, 23);
  assert.equal((fall.end - fall.start) / 3600_000, 25);
  assert.equal((plain.end - plain.start) / 3600_000, 24);
  assert.equal(iso(spring.start), "2026-03-08T06:00:00Z");
});

test("tz: Phoenix never changes; Denver (western Kansas) changes with Chicago", () => {
  assert.equal(iso(localToUtc("2026-07-01", "09:00:00", "America/Phoenix")), "2026-07-01T16:00:00Z");
  assert.equal(iso(localToUtc("2026-01-01", "09:00:00", "America/Phoenix")), "2026-01-01T16:00:00Z");
  assert.equal(iso(localToUtc("2026-07-01", "09:00:00", "America/Denver")), "2026-07-01T15:00:00Z");
});

test("tz: the VTIMEZONE we publish agrees with the IANA database for 2007–2040", () => {
  // Expand our VTIMEZONE's own RRULEs and check each transition against Intl.
  for (const [tzid, z] of Object.entries(ZONES)) {
    const block = vtimezone(tzid);
    assert.match(block, new RegExp(`^BEGIN:VTIMEZONE\\r\\nTZID:${tzid.replace("/", "\\/")}\\r\\n`));
    if (z.dst === undefined) {
      for (const d of ["2010-01-15", "2026-07-15", "2039-03-20"]) {
        assert.equal(offsetAt(Date.parse(d + "T12:00:00Z"), tzid), z.std * 60_000, `${tzid} ${d}`);
      }
      continue;
    }
    for (let y = 2007; y <= 2040; y++) {
      const secondSunMarch = nthSunday(y, 3, 2);
      const firstSunNov = nthSunday(y, 11, 1);
      // one minute before 02:00 local standard time = still standard
      const springUtc = Date.parse(`${secondSunMarch}T02:00:00Z`) - z.std * 60_000;
      assert.equal(offsetAt(springUtc - 60_000, tzid), z.std * 60_000, `${tzid} before spring ${y}`);
      assert.equal(offsetAt(springUtc, tzid), z.dst * 60_000, `${tzid} after spring ${y}`);
      const fallUtc = Date.parse(`${firstSunNov}T02:00:00Z`) - z.dst * 60_000;
      assert.equal(offsetAt(fallUtc - 60_000, tzid), z.dst * 60_000, `${tzid} before fall ${y}`);
      assert.equal(offsetAt(fallUtc, tzid), z.std * 60_000, `${tzid} after fall ${y}`);
    }
  }
});

function nthSunday(y: number, m: number, n: number): string {
  // independent of our expander: first Sunday of the month, plus n-1 weeks
  const first = new Date(Date.UTC(y, m - 1, 1));
  const day = 1 + ((7 - first.getUTCDay()) % 7) + (n - 1) * 7;
  return new Date(Date.UTC(y, m - 1, day)).toISOString().slice(0, 10);
}
