// The conflict check report: one self-contained HTML page for the client file, laid out
// for printing (or "Save as PDF" from the browser's print dialog). It has no scripts and
// carries its own styles, so a downloaded copy reads the same years later.

import type { DB } from "../db.ts";
import { getCheck } from "../conflicts/search.ts";
import { BAND_LABELS, DECISION_LABELS, bandCounts, countsText, plainReasons, roleLabel } from "./plain.ts";

type Row = Record<string, any>;

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** "November 18, 2026 at 3:04 PM" in the firm's time zone. */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const date = d.toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "long", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

const STYLE = `
  @page { margin: 0.8in 0.75in; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f3ec; color: #23262b; font: 11.5pt/1.5 "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; }
  .sheet { max-width: 8.2in; margin: 24px auto; background: #fff; padding: 0.7in 0.75in; border: 1px solid #e2dccf; }
  .note { max-width: 8.2in; margin: 16px auto 0; font: 10pt/1.4 "Segoe UI", Arial, sans-serif; color: #6a6457; }
  h1 { font-size: 19pt; font-weight: 600; color: #1d3557; margin: 0 0 2px; }
  h2 { font-size: 13pt; font-weight: 600; color: #1d3557; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #cbc3b2; }
  h3 { font-size: 11.5pt; margin: 0; }
  .rule { border: 0; border-top: 3px double #1d3557; margin: 10px 0 14px; }
  .meta { width: 100%; border-collapse: collapse; }
  .meta th { text-align: left; font-weight: 600; width: 1.6in; padding: 3px 10px 3px 0; vertical-align: top; color: #4a463e; }
  .meta td { padding: 3px 0; }
  table.names { width: 100%; border-collapse: collapse; }
  table.names th, table.names td { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid #e2dccf; }
  table.names th { font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.05em; color: #6a6457; font-weight: 600; }
  .band { margin-top: 14px; }
  .band-title { font-size: 11pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #4a463e; margin: 0 0 6px; }
  .hit { border-left: 3px solid #cbc3b2; padding: 4px 0 6px 12px; margin: 0 0 10px; page-break-inside: avoid; }
  .hit.strong { border-left-color: #9b2c2c; }
  .hit.possible { border-left-color: #a5833f; }
  .hit .kind { font-weight: 400; color: #6a6457; }
  .hit ul { margin: 4px 0 0; padding-left: 18px; }
  .concern { color: #9b2c2c; font-weight: 600; }
  .none { font-style: italic; color: #4a463e; }
  .decision { font-size: 12.5pt; font-weight: 600; }
  .sign { display: flex; gap: 0.5in; margin-top: 40px; }
  .sign div { flex: 1; border-top: 1px solid #23262b; padding-top: 4px; font-size: 9.5pt; color: #4a463e; }
  .foot { margin-top: 28px; font-size: 9pt; color: #6a6457; }
  @media print {
    body { background: #fff; }
    .sheet { margin: 0; padding: 0; border: 0; max-width: none; }
    .note { display: none; }
  }
`;

/** `prepare` may rewrite the check before it is shown (the route hides restricted matters with it). */
export function renderReport(db: DB, id: number, prepare: (k: Row) => Row = (k) => k): { html: string; filename: string } {
  const k = prepare(getCheck(db, id) as Row);
  const hits = (k.results ?? []) as Row[];
  const counts = bandCounts(hits);
  const matter = k.matterId ? (db.prepare("SELECT number, name FROM matters WHERE id = ?").get(k.matterId) as Row | undefined) : undefined;
  const matterText = matter ? [matter.number, matter.name].filter(Boolean).join(" ") : "Not linked to a matter";

  const terms = (k.terms as Row[])
    .map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.kind === "company" ? "Company" : t.kind === "person" ? "Person" : "Not stated")}</td><td>${esc(cap(roleLabel(t.role)) || "Not stated")}</td></tr>`)
    .join("");

  const bands = (["strong", "possible", "weak"] as const)
    .map((b) => {
      const list = hits.filter((h) => h.band === b);
      if (!list.length) return "";
      const items = list
        .map((h) => {
          const concerns = (h.concerns ?? []).map((c: string) => `<li class="concern">${esc(c)}</li>`).join("");
          const reasons = plainReasons(h as any).map((r) => `<li>${esc(r)}</li>`).join("");
          return `<div class="hit ${b}"><h3>${esc(h.name)} <span class="kind">(${h.kind === "company" ? "company" : "person"})</span></h3><ul>${concerns}${reasons}</ul></div>`;
        })
        .join("");
      return `<section class="band"><p class="band-title">${esc(BAND_LABELS[b])}es (${list.length})</p>${items}</section>`;
    })
    .join("");

  const history = (k.decisions as Row[])
    .map((d) => `<tr><td>${esc(fmtStamp(d.decidedAt))}</td><td>${esc(DECISION_LABELS[d.decision] ?? d.decision)}</td><td>${esc(d.decidedByName ?? "Not recorded")}</td><td>${esc(d.note ?? "")}</td></tr>`)
    .join("");

  const decision = k.decision
    ? `<p class="decision">${esc(DECISION_LABELS[k.decision] ?? k.decision)}</p>
       <table class="meta">
         <tr><th>Decided by</th><td>${esc(k.decidedByName ?? "Not recorded")}</td></tr>
         <tr><th>Date</th><td>${esc(fmtStamp(k.decidedAt))}</td></tr>
         ${k.decisionNote ? `<tr><th>Note</th><td>${esc(k.decisionNote)}</td></tr>` : ""}
       </table>`
    : `<p class="decision">Awaiting decision</p><p>No decision had been recorded when this report was produced.</p>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conflict check no. ${k.id}</title><style>${STYLE}</style></head>
<body>
<p class="note">To print or save as PDF, use your browser’s Print command.</p>
<main class="sheet">
  <h1>Conflict of Interest Check</h1>
  <p>Check no. ${k.id}</p>
  <hr class="rule">
  <table class="meta">
    <tr><th>Matter</th><td>${esc(matterText)}</td></tr>
    <tr><th>Run on</th><td>${esc(fmtStamp(k.runAt))}</td></tr>
    <tr><th>Run by</th><td>${esc(k.runByName ?? "Not recorded")}</td></tr>
    <tr><th>Result</th><td>${esc(countsText(counts))}</td></tr>
  </table>

  <h2>Names searched</h2>
  <table class="names"><thead><tr><th>Name</th><th>Type</th><th>Role in the matter</th></tr></thead><tbody>${terms}</tbody></table>
  <p>Each name was compared with every contact and every other name on record (former names, trade names and the like), allowing for nicknames, initials, misspellings and word order, and followed through recorded relationships such as owners, officers and parent companies.</p>

  <h2>What the search found</h2>
  ${bands || `<p class="none">No contacts on record matched these names.</p>`}

  <h2>Decision</h2>
  ${decision}
  ${(k.decisions as Row[]).length > 1 ? `<h2>Decision history</h2><table class="names"><thead><tr><th>Date</th><th>Decision</th><th>By</th><th>Note</th></tr></thead><tbody>${history}</tbody></table>` : ""}

  <div class="sign"><div>Reviewed by</div><div>Date</div></div>
  <p class="foot">Results are as they stood when the check was run on ${esc(fmtStamp(k.runAt))}. Report produced ${esc(fmtStamp(new Date().toISOString()))}.</p>
</main>
</body></html>`;
  return { html, filename: `conflict-check-${k.id}.html` };
}
