import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseCsvRecords, toCsv } from "../../src/clio_import/csv.ts";
import { parseBool, parseDate, parseHours, parseMoney, parseTime, ValueError, fmtCents, nameKey } from "../../src/clio_import/values.ts";

const cells = (s: string) => parseCsvRecords(s).records.map((r) => r.cells);

test("csv: plain rows, LF and CRLF and lone CR", () => {
  assert.deepEqual(cells("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(cells("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(cells("a,b\r1,2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(cells("a,b\r\n1,2\n3,4\r5,6"), [["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
});

test("csv: byte-order mark is dropped from the first heading", () => {
  const t = parseCsv("﻿first_name,last_name\r\nAvery,Fictional\r\n");
  assert.deepEqual(t.headers, ["first_name", "last_name"]);
  assert.deepEqual(t.rows[0].cells, ["Avery", "Fictional"]);
});

test("csv: quotes, doubled quotes, commas and line breaks inside quotes", () => {
  assert.deepEqual(cells('"a, b","say ""hi""","line1\r\nline2",plain'), [["a, b", 'say "hi"', "line1\nline2", "plain"]]);
  assert.deepEqual(cells('"",x'), [["", "x"]]);
  // A record with an embedded newline reports the line it started on; the next row's line is right too.
  const r = parseCsvRecords('h\n"one\ntwo"\nthree\n').records;
  assert.deepEqual(r.map((x) => x.line), [1, 2, 4]);
});

test("csv: empty cells, trailing comma, missing final newline, blank lines skipped", () => {
  assert.deepEqual(cells("a,,c,\n\n\n1,2,3,4"), [["a", "", "c", ""], ["1", "2", "3", "4"]]);
  assert.deepEqual(cells(""), []);
  assert.deepEqual(cells('""'), [[""]]); // a quoted empty cell is a row, not a blank line
});

test("csv: stray quote in an unquoted cell is kept; text after a closing quote warns", () => {
  assert.deepEqual(cells('5" pipe,x'), [['5" pipe', "x"]]);
  const r = parseCsvRecords('"abc"def,x');
  assert.deepEqual(r.records[0].cells, ["abcdef", "x"]);
  assert.match(r.warnings[0], /after a closing quote/);
});

test("csv: unclosed quote is reported, not thrown", () => {
  const r = parseCsvRecords('a,"never closed\nb,c');
  assert.equal(r.records.length, 1);
  assert.match(r.warnings[0], /never closed/);
});

test("csv: header table pads short rows and flags long ones", () => {
  assert.equal(parseCsv("a,b\n,\n , \n1,2\n").rows.length, 1, "rows of empty cells are dropped");
  const t = parseCsv("a,b,c\n1\n1,2,3,4\n");
  assert.deepEqual(t.rows[0].cells, ["1", "", ""]);
  assert.deepEqual(t.rows[1].cells, ["1", "2", "3"]);
  assert.match(t.warnings.join(), /Line 3: 4 cells/);
  assert.match(parseCsv("").warnings[0], /empty/);
});

test("csv: writing and reading back round-trips", () => {
  const rows = [["a", 'say "x"', "multi\nline", " lead", "1,2"], ["", null, 3, "ok", "end"]];
  const back = cells(toCsv(rows));
  assert.deepEqual(back, [["a", 'say "x"', "multi\nline", " lead", "1,2"], ["", "", "3", "ok", "end"]]);
});

test("values: dates in Clio's MM/DD/YYYY, ISO, and instants on the firm's day", () => {
  assert.equal(parseDate("03/09/2026"), "2026-03-09");
  assert.equal(parseDate("3/9/2026"), "2026-03-09");
  assert.equal(parseDate("3/9/26"), "2026-03-09");
  assert.equal(parseDate("09/03/2026", "dmy"), "2026-03-09");
  assert.equal(parseDate("2026-03-09"), "2026-03-09");
  assert.equal(parseDate("2026-03-09T03:00:00Z"), "2026-03-08"); // 9 pm the night before in Kansas
  assert.equal(parseDate("2026-03-09T15:00:00-06:00"), "2026-03-09");
  assert.equal(parseDate(""), null);
  assert.throws(() => parseDate("02/30/2026"), ValueError);
  assert.throws(() => parseDate("13/45/2026"), ValueError);
  assert.throws(() => parseDate("next week"), ValueError);
});

test("values: times in Clio's H:MM:SS AM/PM form and 24-hour", () => {
  assert.equal(parseTime("9:30:00 AM"), "09:30:00");
  assert.equal(parseTime("12:00:00 PM"), "12:00:00");
  assert.equal(parseTime("12:15 am"), "00:15:00");
  assert.equal(parseTime("2pm"), "14:00:00");
  assert.equal(parseTime("14:05"), "14:05:00");
  assert.throws(() => parseTime("25:00:00 PM"), ValueError);
  assert.throws(() => parseTime("9"), ValueError);
});

test("values: money to integer cents without floating point", () => {
  assert.equal(parseMoney("$1,234.56"), 123456);
  assert.equal(parseMoney("1195.5"), 119550);
  assert.equal(parseMoney("0.1"), 10);
  assert.equal(parseMoney("(12.00)"), -1200);
  assert.equal(parseMoney("-$5"), -500);
  assert.equal(parseMoney("2.675"), 268); // half rounds away from zero, exactly
  assert.equal(parseMoney(250.1), 25010);
  assert.equal(parseMoney(""), null);
  assert.throws(() => parseMoney("12.3.4"), ValueError);
  assert.throws(() => parseMoney("abc"), ValueError);
});

test("values: hours to minutes", () => {
  assert.equal(parseHours("1.5"), 90);
  assert.equal(parseHours("0.1"), 6);
  assert.equal(parseHours("0.25"), 15);
  assert.equal(parseHours("1:45"), 105);
  assert.equal(parseHours("2 hrs"), 120);
  assert.equal(parseHours("0.0083"), 0);
  assert.throws(() => parseHours("-1"), ValueError);
});

test("values: yes/no, names, money display", () => {
  assert.equal(parseBool("1"), true);
  assert.equal(parseBool("No"), false);
  assert.equal(parseBool("Billed"), true);
  assert.equal(parseBool(""), null);
  assert.throws(() => parseBool("maybe"), ValueError);
  assert.equal(nameKey("  Prairie  Example, Bakery L.L.C. "), "prairie example bakery l l c");
  assert.equal(fmtCents(123456), "$1,234.56");
  assert.equal(fmtCents(-5), "-$0.05");
});
