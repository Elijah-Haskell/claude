// Printable trust reports: one self-contained HTML document each (inline CSS, no scripts).
// Every value from the database is escaped.

import { escapeHtml as e } from "../billing/render.ts";
import { formatCents } from "../billing/money.ts";
import type { Row } from "./trust.ts";
import { RULES, SOURCES } from "./rules.ts";

const money = (c: number) => e(formatCents(c));

const CSS = `
*{box-sizing:border-box}
body{font:13px/1.45 Georgia,"Times New Roman",serif;color:#111;background:#fff;margin:0;padding:32px}
.page{max-width:900px;margin:0 auto}
header{border-bottom:2px solid #1d3557;padding-bottom:10px;margin-bottom:18px}
h1{font-size:21px;margin:0 0 4px;color:#1d3557}
h2{font-size:14px;margin:22px 0 6px;text-transform:uppercase;letter-spacing:.05em;color:#1d3557}
.sub{color:#444}
table{width:100%;border-collapse:collapse;margin-top:4px}
th,td{padding:5px 7px;border-bottom:1px solid #ccc;vertical-align:top;text-align:left}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #111}
td.n,th.n{text-align:right;white-space:nowrap}
tr.total td{border-top:2px solid #111;font-weight:bold}
.ok{color:#2f6b45;font-weight:bold}.bad{color:#9b2c2c;font-weight:bold}
.note{font-size:11px;color:#555;margin-top:18px;border-top:1px solid #ccc;padding-top:8px}
.sig{margin-top:28px;display:flex;gap:40px}.sig div{flex:1;border-top:1px solid #111;padding-top:4px;font-size:12px}
.rev{color:#666;font-style:italic}
@media print{body{padding:0}@page{margin:16mm}}
`;

function doc(title: string, sub: string, body: string, firm: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${e(title)}</title><style>${CSS}</style></head>
<body><div class="page"><header><div class="sub">${e(firm || "Client trust account records")}</div><h1>${e(title)}</h1><div class="sub">${sub}</div></header>
${body}
<p class="note">Prepared from the Lawdesk trust journal, which cannot be edited or deleted; corrections appear as reversing entries.
Records must be preserved for five years after termination of the representation (KRPC 1.15(a), Kansas Supreme Court Rule 240).
Printed ${e(new Date().toISOString().slice(0, 10))}.</p></div></body></html>`;
}

function acctLine(a: Row): string {
  return `${e(a.name)} · ${e(a.bank_name)}${a.account_last4 ? ` ····${e(a.account_last4)}` : ""} · ${a.kind === "iolta" ? "IOLTA" : "Non-IOLTA trust account"}`;
}

export function ledgerStatementHtml(l: Row, from: string | undefined, to: string | undefined, firm: string): string {
  const rows = (l.entries as Row[]).filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  const opening = rows.length ? rows[0].balance_cents - rows[0].amount_cents : l.balance_cents;
  const body = `
<table><tbody>
<tr><th>Client</th><td>${e(l.matter?.client_name ?? "Firm funds for bank charges")}</td></tr>
${l.matter ? `<tr><th>Matter</th><td>${e(l.matter.number ?? "")} ${e(l.matter.name)}</td></tr>` : ""}
<tr><th>Account</th><td>${e(l.account.name)}</td></tr>
<tr><th>Record retention</th><td>${e(l.retention.note)}</td></tr>
</tbody></table>
<h2>Activity</h2>
<table><thead><tr><th>Date</th><th>Entry</th><th>Type</th><th>Details</th><th class="n">In</th><th class="n">Out</th><th class="n">Balance</th></tr></thead><tbody>
<tr><td></td><td></td><td>Opening balance</td><td></td><td></td><td></td><td class="n">${money(opening)}</td></tr>
${rows
  .map(
    (r) => `<tr${r.kind === "reversal" ? ' class="rev"' : ""}><td>${e(r.date)}</td><td>${r.id}</td><td>${e(r.kind_label)}</td><td>${e(r.description)}</td>
<td class="n">${r.amount_cents > 0 ? money(r.amount_cents) : ""}</td><td class="n">${r.amount_cents < 0 ? money(-r.amount_cents) : ""}</td><td class="n">${money(r.balance_cents)}</td></tr>`,
  )
  .join("")}
<tr class="total"><td colspan="6">Closing balance</td><td class="n">${money(rows.length ? rows[rows.length - 1].balance_cents : opening)}</td></tr>
</tbody></table>
${l.held_cents ? `<p><strong>On hold as disputed:</strong> ${money(l.held_cents)} (KRPC 1.15(d)(1)(ii))</p>` : ""}`;
  const period = from || to ? `${e(from ?? "beginning")} to ${e(to ?? "today")}` : "All activity";
  return doc(`Client trust ledger: ${l.label}`, period, body, firm);
}

export function journalHtml(a: Row, rows: Row[], from: string | undefined, to: string | undefined, firm: string): string {
  const opening = rows.length ? rows[0].balance_cents - rows[0].amount_cents : 0;
  const body = `
<table><thead><tr><th>Date</th><th>Entry</th><th>Type</th><th>Client ledger(s)</th><th>Details</th><th>Cleared</th><th class="n">In</th><th class="n">Out</th><th class="n">Balance</th></tr></thead><tbody>
<tr><td></td><td></td><td>Opening balance</td><td></td><td></td><td></td><td></td><td></td><td class="n">${money(opening)}</td></tr>
${rows
  .map(
    (r) => `<tr${r.kind === "reversal" || r.reversed_by_id ? ' class="rev"' : ""}><td>${e(r.date)}</td><td>${r.id}${r.reversed_by_id ? ` (reversed by ${r.reversed_by_id})` : ""}</td><td>${e(r.kind_label)}</td>
<td>${(r.lines as Row[]).map((l) => `${e(l.label)}: ${money(l.amount_cents)}`).join("<br>")}</td><td>${e(r.description)}</td><td>${e(r.cleared_on ?? "")}</td>
<td class="n">${r.amount_cents > 0 ? money(r.amount_cents) : ""}</td><td class="n">${r.amount_cents < 0 ? money(-r.amount_cents) : ""}</td><td class="n">${money(r.balance_cents)}</td></tr>`,
  )
  .join("")}
</tbody></table>`;
  return doc("Trust account journal", `${acctLine(a)} · ${e(from ?? "beginning")} to ${e(to ?? "today")}`, body, firm);
}

export function balancesHtml(a: Row, rows: Row[], asOf: string, firm: string, title = "Client trust balances", extra = ""): string {
  const total = rows.reduce((s, r) => s + r.balance_cents, 0);
  const body = `${extra}
<table><thead><tr><th>Client</th><th>Matter</th><th>Last activity</th><th>Keep records until</th><th class="n">On hold</th><th class="n">Balance</th></tr></thead><tbody>
${rows
  .map(
    (r) => `<tr><td>${e(r.client_name ?? "Firm funds for bank charges")}</td><td>${e(r.matter_number ?? "")} ${e(r.matter_name ?? "")}</td><td>${e(r.last_activity ?? "")}</td>
<td>${e(r.retention?.keep_until ?? "5 years after the matter closes")}</td><td class="n">${r.held_cents ? money(r.held_cents) : ""}</td><td class="n">${money(r.balance_cents)}</td></tr>`,
  )
  .join("")}
<tr class="total"><td colspan="5">Total</td><td class="n">${money(total)}</td></tr>
</tbody></table>`;
  return doc(title, `${acctLine(a)} · as of ${e(asOf)}`, body, firm);
}

export function reconciliationHtml(rec: Row, firm: string): string {
  const s = rec.snapshot as Row;
  const status = rec.status === "signed"
    ? `Signed by ${e(rec.signed_by_name ?? "")} on ${e(rec.signed_on ?? "")} · locked`
    : "Draft · not signed";
  const line = (label: string, c: number, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}><td>${label}</td><td class="n">${money(c)}</td></tr>`;
  const body = `
<p>${s.balanced ? '<span class="ok">Balanced: all three totals agree to the cent.</span>' : `<span class="bad">Does not balance.</span> ${(s.problems as string[]).map(e).join(" ")}`}</p>
<h2>1. Bank</h2>
<table><tbody>
${line("Statement ending balance", s.statement_balance_cents)}
${line("Plus deposits in transit", s.deposits_in_transit_cents)}
${line("Less outstanding checks and payments", -s.outstanding_payments_cents)}
${line("Adjusted bank balance", s.adjusted_bank_cents, "total")}
</tbody></table>
<h2>2. Trust journal</h2>
<table><tbody>${line(`Journal balance at ${e(s.period_end)}`, s.journal_cents, "total")}</tbody></table>
<h2>3. Client ledgers</h2>
<table><thead><tr><th>Ledger</th><th class="n">Balance</th></tr></thead><tbody>
${(s.ledgers as Row[]).map((g) => line(e(g.label), g.balance_cents, g.balance_cents < 0 ? "bad" : "")).join("")}
${line("Total of ledgers", s.ledgers_cents, "total")}
</tbody></table>
<h2>Differences</h2>
<table><tbody>
<tr><td>Adjusted bank minus journal</td><td class="n ${s.bank_vs_journal_cents ? "bad" : "ok"}">${money(s.bank_vs_journal_cents)}</td></tr>
<tr><td>Journal minus ledgers</td><td class="n ${s.journal_vs_ledgers_cents ? "bad" : "ok"}">${money(s.journal_vs_ledgers_cents)}</td></tr>
</tbody></table>
<h2>Outstanding items</h2>
${(s.outstanding as Row[]).length
  ? `<table><thead><tr><th>Date</th><th>Entry</th><th>Type</th><th>Details</th><th class="n">Amount</th></tr></thead><tbody>
${(s.outstanding as Row[]).map((o) => `<tr><td>${e(o.date)}</td><td>${o.id}</td><td>${e(o.kind_label)}</td><td>${e(o.description)}</td><td class="n">${money(o.amount_cents)}</td></tr>`).join("")}
</tbody></table>`
  : "<p>None.</p>"}
${rec.notes ? `<h2>Notes</h2><p>${e(rec.notes)}</p>` : ""}
<div class="sig"><div>Prepared by ${e(rec.prepared_by_name ?? "")} · ${e(String(rec.prepared_at ?? "").slice(0, 10))}</div><div>Reviewed and signed by ${e(rec.signed_by_name ?? "")} ${rec.signed_on ? "· " + e(rec.signed_on) : ""}</div></div>`;
  return doc(`Three-way reconciliation: ${s.period}`, `${acctLine(s.account)} · ${status}`, body, firm);
}

export function historyHtml(a: Row, recs: Row[], firm: string): string {
  const body = `<table><thead><tr><th>Month</th><th>Status</th><th class="n">Statement</th><th class="n">Adjusted bank</th><th class="n">Journal</th><th class="n">Ledgers</th><th>Signed</th></tr></thead><tbody>
${recs
  .map(
    (r) => `<tr><td>${e(r.period)}</td><td>${r.status === "signed" ? "Signed, locked" : "Draft"}${r.balanced ? "" : ' <span class="bad">(does not balance)</span>'}</td>
<td class="n">${money(r.statement_balance_cents)}</td><td class="n">${money(r.adjusted_bank_cents)}</td><td class="n">${money(r.journal_cents)}</td><td class="n">${money(r.ledgers_cents)}</td>
<td>${e(r.signed_by_name ?? "")} ${e(r.signed_on ?? "")}</td></tr>`,
  )
  .join("")}
</tbody></table>`;
  return doc("Reconciliation history", acctLine(a), body, firm);
}

export function rulesHtml(): string {
  const body = `<p>The rules below were read from the Kansas sources listed and are what this software enforces. It has not been reviewed by an accountant or approved by the Disciplinary Administrator. The responsible lawyer and an accountant must review it before it is used for real client money.</p>
<table><thead><tr><th>Rule</th><th>Text relied on</th><th>What Lawdesk does</th></tr></thead><tbody>
${RULES.map((r) => `<tr><td>${e(r.cite)}</td><td>“${e(r.quote)}”</td><td>${e(r.applied)}</td></tr>`).join("")}
</tbody></table>
<h2>Sources</h2><ul>${Object.values(SOURCES).map((s) => `<li>${e(s.title)}: ${e(s.url)}${"read" in s && !s.read ? " (could not be loaded; not relied on)" : ""}</li>`).join("")}</ul>`;
  return doc("Trust accounting rules this follows", "Kansas Rule of Professional Conduct 1.15", body, "");
}
