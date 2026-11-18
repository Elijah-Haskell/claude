// Printable invoice as one self-contained HTML document: inline CSS, no scripts, no
// external fonts or images. Every piece of text from the database is escaped.

import type { Row } from "./billing.ts";
import { formatCents, hoursLabel } from "./money.ts";

export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const e = escapeHtml;
const money = (c: number) => e(formatCents(c));
const multiline = (s: unknown) => e(s).replace(/\r?\n/g, "<br>");

const CSS = `
*{box-sizing:border-box}
body{font:14px/1.45 Georgia,"Times New Roman",serif;color:#111;background:#fff;margin:0;padding:32px}
.page{max-width:800px;margin:0 auto;position:relative}
header{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:20px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:15px;margin:24px 0 8px;text-transform:uppercase;letter-spacing:.05em}
.meta{text-align:right}
.meta div{margin:2px 0}
table{width:100%;border-collapse:collapse;margin-top:4px}
th,td{padding:6px 8px;border-bottom:1px solid #ccc;vertical-align:top;text-align:left}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #111}
td.n,th.n{text-align:right;white-space:nowrap}
.note{font-size:12px;color:#555;font-style:italic}
.totals{margin-left:auto;width:320px;margin-top:12px}
.totals td{border:none;padding:3px 8px}
.totals tr.grand td{border-top:2px solid #111;font-weight:bold;font-size:16px}
.void{position:absolute;top:120px;left:0;right:0;text-align:center;font-size:110px;color:rgba(200,0,0,.18);transform:rotate(-20deg);pointer-events:none;font-weight:bold}
.draft{color:rgba(0,0,0,.12)}
.notes{margin-top:24px;padding-top:8px;border-top:1px solid #ccc}
@media print{body{padding:0}@page{margin:18mm}}
`;

/** Render an invoice as returned by Billing.invoice(), with the firm settings row. */
export function renderInvoiceHtml(inv: Row, settings: Row): string {
  const title = inv.number != null ? `Invoice ${inv.number}` : "Draft invoice";
  const fees = inv.lines.filter((l: Row) => l.kind !== "expense");
  const expenses = inv.lines.filter((l: Row) => l.kind === "expense");
  const t = inv.totals;

  const lineRows = (lines: Row[], withTime: boolean) =>
    lines
      .map((l) => {
        const notes = [l.no_charge_note, l.writedown_cents ? `Written down ${formatCents(l.writedown_cents)}${l.writedown_reason ? `: ${l.writedown_reason}` : ""}` : null]
          .filter(Boolean)
          .map((n) => `<div class="note">${e(n)}</div>`)
          .join("");
        return `<tr><td>${e(l.date ?? "")}</td>${withTime ? `<td>${e(l.user_name ?? "")}</td>` : ""}<td>${multiline(l.description)}${notes}</td>${
          withTime ? `<td class="n">${l.minutes != null ? e(hoursLabel(l.minutes)) : ""}</td><td class="n">${l.rate_cents != null ? money(l.rate_cents) : ""}</td>` : ""
        }<td class="n">${money(l.net_cents)}</td></tr>`;
      })
      .join("\n");

  const discountLabel =
    inv.discount_kind === "percent" ? `Discount (${e(inv.discount_value / 100)}%)` : inv.discount_kind === "fixed" ? "Discount" : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}${inv.client ? ` – ${e(inv.client.name)}` : ""}</title>
<style>${CSS}</style></head>
<body><div class="page">
${inv.status === "void" ? `<div class="void">VOID</div>` : inv.status === "draft" ? `<div class="void draft">DRAFT</div>` : ""}
<header>
  <div><h1>${e(settings.firm_name || "Invoice")}</h1><div>${multiline(settings.firm_address)}</div></div>
  <div class="meta">
    <div><strong>${e(title)}</strong></div>
    ${inv.issued_on ? `<div>Date: ${e(inv.issued_on)}</div>` : ""}
    ${inv.due_on ? `<div>Due: ${e(inv.due_on)}</div>` : ""}
    ${inv.period_from || inv.period_to ? `<div>For services ${inv.period_from ? `from ${e(inv.period_from)} ` : ""}${inv.period_to ? `through ${e(inv.period_to)}` : ""}</div>` : ""}
  </div>
</header>
<section>
  <div><strong>Bill to:</strong> ${e(inv.client?.name ?? "")}</div>
  <div><strong>Matter:</strong> ${inv.matter?.number ? `${e(inv.matter.number)} – ` : ""}${e(inv.matter?.name ?? "")}</div>
  ${inv.status === "void" ? `<div><strong>Voided ${e(inv.voided_on)}:</strong> ${e(inv.void_reason)}</div>` : ""}
</section>
${
  fees.length
    ? `<h2>Professional services</h2>
<table><thead><tr><th>Date</th><th>By</th><th>Description</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
<tbody>${lineRows(fees, true)}</tbody></table>`
    : ""
}
${
  expenses.length
    ? `<h2>Expenses</h2>
<table><thead><tr><th>Date</th><th>Description</th><th class="n">Amount</th></tr></thead>
<tbody>${lineRows(expenses, false)}</tbody></table>`
    : ""
}
<table class="totals">
  <tr><td>Subtotal</td><td class="n">${money(t.subtotal_cents)}</td></tr>
  ${t.discount_cents ? `<tr><td>${discountLabel}</td><td class="n">-${money(t.discount_cents)}</td></tr>` : ""}
  ${t.tax_cents ? `<tr><td>Tax</td><td class="n">${money(t.tax_cents)}</td></tr>` : ""}
  <tr class="grand"><td>Total</td><td class="n">${money(t.total_cents)}</td></tr>
  ${inv.paid_cents ? `<tr><td>Payments applied</td><td class="n">-${money(inv.paid_cents)}</td></tr>` : ""}
  ${inv.written_off_cents ? `<tr><td>Written off</td><td class="n">-${money(inv.written_off_cents)}</td></tr>` : ""}
  ${inv.status === "final" ? `<tr class="grand"><td>Balance due</td><td class="n">${money(inv.balance_cents)}</td></tr>` : ""}
</table>
${inv.notes ? `<div class="notes">${multiline(inv.notes)}</div>` : ""}
</div></body></html>
`;
}
