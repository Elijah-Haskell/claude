import { test } from "node:test";
import assert from "node:assert/strict";
import { BOM, csvField, csvText, toCsv } from "../../src/reports/csv.ts";
import { centsToDecimal, minutesToHours, percent } from "../../src/reports/format.ts";
import type { ReportResult } from "../../src/reports/reports.ts";

test("number formats are exact", () => {
  assert.deepEqual([0, 5, 100, 123456, -5, -123456].map(centsToDecimal), ["0.00", "0.05", "1.00", "1234.56", "-0.05", "-1234.56"]);
  // 1 min = 0.0167 h -> 0.02; 7 min = 0.1167 -> 0.12; 3 min = 0.05 exactly; 90 = 1.50
  assert.deepEqual([0, 1, 3, 7, 90, 482].map(minutesToHours), ["0.00", "0.02", "0.05", "0.12", "1.50", "8.03"]);
  assert.deepEqual([1, 0.9444, 0.375, 0, 0.6667, 0.0005].map(percent), ["100.0%", "94.4%", "37.5%", "0.0%", "66.7%", "0.1%"]);
});

test("quoting and formula neutralising", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("two\nlines"), '"two\nlines"');
  assert.equal(csvField(" padded"), '" padded"');
  assert.equal(csvText("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvText("+1 555"), "'+1 555");
  assert.equal(csvText("-dash"), "'-dash");
  assert.equal(csvText("@sum"), "'@sum");
  assert.equal(csvText("Peña & Sons"), "Peña & Sons");
});

test("a whole report: BOM, header, rows, total line, CRLF", () => {
  const r: ReportResult = {
    key: "x",
    title: "X",
    period: null,
    filters: { options: {} },
    available: true,
    definitions: [],
    notes: [],
    columns: [
      { key: "name", label: "Client", type: "text" },
      { key: "amt", label: "Owed", type: "cents" },
      { key: "mins", label: "Hours", type: "minutes" },
      { key: "rate", label: "Rate", type: "ratio" },
      { key: "on", label: "Date", type: "date" },
      { key: "ms", label: "Matters", type: "links" },
    ],
    rows: [
      { name: "Acme, Inc.", amt: 123456, mins: 90, rate: 0.925, on: "2026-11-18", ms: [{ label: "A-1 Lease", href: "#" }, { label: "A-2 \"Big\" deal", href: "#" }] },
      { name: "=cmd", amt: -500, mins: 0, rate: null, on: null, ms: [] },
    ],
    totals: { amt: 122956, mins: 90 },
  };
  const csv = toCsv(r);
  assert.ok(csv.startsWith(BOM));
  assert.equal(
    csv.slice(1),
    [
      "Client,Owed,Hours,Rate,Date,Matters",
      'Acme, Inc.'.replace(/^(.*)$/, '"$1"') + ',1234.56,1.50,92.5%,2026-11-18,"A-1 Lease; A-2 ""Big"" deal"',
      "'=cmd,-5.00,0.00,,,",
      "Total,1229.56,1.50,,,",
      "",
    ].join("\r\n"),
  );
});
