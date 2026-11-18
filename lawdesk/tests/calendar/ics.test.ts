import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IcsWriter,
  escapeText,
  foldLine,
  getProp,
  paramValue,
  parseDuration,
  parseIcs,
  parseIcsTime,
  parseLine,
  unescapeText,
  unfold,
  vtimezone,
} from "../../src/calendar/ics.ts";

const octets = (s: string) => new TextEncoder().encode(s).length;

test("ics: TEXT escaping per RFC 5545 §3.3.11", () => {
  assert.equal(escapeText("a\\b;c,d\ne"), "a\\\\b\\;c\\,d\\ne");
  assert.equal(escapeText("line1\r\nline2\rline3"), "line1\\nline2\\nline3");
  assert.equal(escapeText("colon: is fine"), "colon: is fine");
  for (const s of ["Smith v. Jones; hearing, Room 3\\B\nBring exhibits", "plain", "é, ü; 漢字\n"]) {
    assert.equal(unescapeText(escapeText(s)), s);
  }
  assert.equal(unescapeText("a\\Nb"), "a\nb"); // \N is also a newline
});

test("ics: parameter values with : ; , are quoted, quotes dropped", () => {
  assert.equal(paramValue("America/Chicago"), "America/Chicago");
  assert.equal(paramValue("Smith, Jane"), '"Smith, Jane"');
  assert.equal(paramValue('say "hi"'), "say hi");
});

test("ics: lines fold at 75 octets with CRLF + space (RFC 5545 §3.1)", () => {
  const line = "DESCRIPTION:" + "x".repeat(200);
  const folded = foldLine(line);
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1);
  assert.equal(octets(parts[0]), 75);
  for (const p of parts.slice(1)) {
    assert.ok(p.startsWith(" "));
    assert.ok(octets(p) <= 75);
  }
  assert.equal(unfold(folded)[0], line);
  assert.equal(foldLine("SHORT:x"), "SHORT:x");
  assert.equal(foldLine("A:" + "y".repeat(73)), "A:" + "y".repeat(73)); // exactly 75 stays
  assert.equal(foldLine("A:" + "y".repeat(74)).split("\r\n").length, 2); // 76 folds
});

test("ics: folding never splits a multi-byte UTF-8 character", () => {
  const line = "SUMMARY:" + "é漢😀".repeat(40);
  const parts = foldLine(line).split("\r\n");
  for (const p of parts) {
    assert.ok(octets(p) <= 75, `${octets(p)} octets`);
    assert.ok(!p.includes("�"));
    // each part decodes on its own, so no character was cut in half
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(p)), p);
  }
  assert.equal(unfold(parts.join("\r\n"))[0], line);
});

test("ics: writer output uses CRLF everywhere and folds every line", () => {
  const w = new IcsWriter().begin("VCALENDAR").text("X-NOTE", "a;b,c\n" + "z".repeat(150)).end("VCALENDAR").toString();
  assert.ok(w.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(w), "bare LF found");
  for (const l of w.split("\r\n")) assert.ok(octets(l) <= 75);
  const root = parseIcs(w);
  assert.equal(unescapeText(getProp(root.children[0], "X-NOTE")!.value), "a;b,c\n" + "z".repeat(150));
});

test("ics: unfolding accepts tabs and bare LF", () => {
  assert.deepEqual(unfold("SUMMARY:Hel\r\n lo\r\n\tthere\nX:1\n"), ["SUMMARY:Hellothere", "X:1"]);
});

test("ics: content line parsing with quoted parameters", () => {
  const p = parseLine('ATTENDEE;CN="Doe, Jane";ROLE=REQ-PARTICIPANT:mailto:jane@example.com');
  assert.equal(p.name, "ATTENDEE");
  assert.deepEqual(p.params, { CN: "Doe, Jane", ROLE: "REQ-PARTICIPANT" });
  assert.equal(p.value, "mailto:jane@example.com");
  const q = parseLine('X-THING;X-P="a:b":value:with:colons');
  assert.equal(q.params["X-P"], "a:b");
  assert.equal(q.value, "value:with:colons");
  assert.throws(() => parseLine("no colon here"));
});

test("ics: component nesting and errors", () => {
  const c = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nBEGIN:VALARM\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
  assert.equal(c.children[0].children[0].children[0].type, "VALARM");
  assert.throws(() => parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n"));
  assert.throws(() => parseIcs("BEGIN:VCALENDAR\r\n"));
});

test("ics: date and date-time values", () => {
  assert.deepEqual(parseIcsTime("20260309", { VALUE: "DATE" }), { kind: "date", date: "2026-03-09" });
  assert.deepEqual(parseIcsTime("20260309T140000Z", {}), { kind: "utc", ms: Date.parse("2026-03-09T14:00:00Z") });
  assert.deepEqual(parseIcsTime("20260309T090000", { TZID: "America/Chicago" }), {
    kind: "local",
    date: "2026-03-09",
    time: "09:00:00",
    tzid: "America/Chicago",
  });
  assert.equal((parseIcsTime("20260309T090000", {}) as any).tzid, null);
  assert.throws(() => parseIcsTime("2026-03-09", {}));
});

test("ics: durations (RFC 5545 §3.3.6)", () => {
  assert.equal(parseDuration("PT1H30M"), 90 * 60_000);
  assert.equal(parseDuration("-PT15M"), -15 * 60_000);
  assert.equal(parseDuration("P1D"), 86_400_000);
  assert.equal(parseDuration("P1W"), 7 * 86_400_000);
  assert.equal(parseDuration("P1DT2H"), 26 * 3600_000);
  assert.throws(() => parseDuration("P"));
  assert.throws(() => parseDuration("PT"));
  assert.throws(() => parseDuration("1H"));
});

test("ics: America/Chicago VTIMEZONE", () => {
  assert.equal(
    vtimezone("America/Chicago"),
    [
      "BEGIN:VTIMEZONE",
      "TZID:America/Chicago",
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:-0600",
      "TZOFFSETTO:-0500",
      "TZNAME:CDT",
      "DTSTART:20070311T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0600",
      "TZNAME:CST",
      "DTSTART:20071104T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
    ].join("\r\n"),
  );
  assert.match(vtimezone("America/Phoenix"), /TZOFFSETFROM:-0700\r\nTZOFFSETTO:-0700/);
  assert.throws(() => vtimezone("Europe/Paris"));
});
