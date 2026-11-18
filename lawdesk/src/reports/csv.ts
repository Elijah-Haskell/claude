// CSV export for any report table.
//
//   * RFC 4180 quoting: a field containing a comma, quote, CR or LF (or leading/trailing
//     space) is wrapped in double quotes, and quotes inside it are doubled.
//   * Lines end in CRLF, and the file starts with a UTF-8 byte-order mark so Excel opens
//     names like "Peña" correctly instead of guessing the wrong encoding.
//   * Text that starts with = + - @ tab or CR is prefixed with an apostrophe, so a name
//     typed as "=HYPERLINK(...)" is shown as text and never run as a spreadsheet formula.
//     Numbers are written as plain numbers (money as 1234.56, hours as 1.50, rates as 92.5%).

import type { Column, ReportResult } from "./reports.ts";
import { centsToDecimal, minutesToHours, percent } from "./format.ts";

export const BOM = "﻿";

export function csvField(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (s === "") return "";
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Text from a user: neutralise spreadsheet formulas, then quote as needed. */
export function csvText(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return csvField(s);
}

export function csvCell(col: Column, v: unknown): string {
  if (v == null || v === "") return "";
  switch (col.type) {
    case "cents":
      return csvField(centsToDecimal(Number(v)));
    case "minutes":
      return csvField(minutesToHours(Number(v)));
    case "ratio":
      return csvField(percent(Number(v)));
    case "int":
      return csvField(String(Math.trunc(Number(v))));
    case "date":
      return csvField(String(v));
    case "links":
      return csvText((v as { label: string }[]).map((l) => l.label).join("; "));
    default:
      return csvText(v);
  }
}

export function toCsv(r: ReportResult): string {
  const lines: string[] = [];
  lines.push(r.columns.map((c) => csvText(c.label)).join(","));
  for (const row of r.rows) lines.push(r.columns.map((c) => csvCell(c, row[c.key])).join(","));
  if (r.totals) lines.push(r.columns.map((c, i) => (i === 0 && r.totals![c.key] == null ? "Total" : csvCell(c, r.totals![c.key]))).join(","));
  return BOM + lines.join("\r\n") + "\r\n";
}
