// Settings > Import from Clio: bring a file exported from Clio (or the firm's data straight
// from the Clio API) into Lawdesk, check it, run it, and read the report.

import { h, replace, select, toast, plural } from "../dom.js";
import { get, post } from "../api.js";

const money = (c) => {
  const neg = c < 0;
  const a = Math.abs(c || 0);
  const s = `$${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
};
const hours = (m) => `${((m || 0) / 60).toFixed(2)} h`;
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const STATUS_LABEL = { new: "New", update: "Already imported", problem: "Problem" };

export async function clioImportView(_params, ctx) {
  const page = h("div.page.clio-import");
  const kinds = await get("/clio-import/kinds");
  const kindBy = Object.fromEntries(kinds.map((k) => [k.kind, k]));

  // Messages from the Clio sign-in round trip (?connected=1 or ?error=...).
  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  if (qs.get("connected")) toast("Connected to Clio");
  if (qs.get("error")) toast(qs.get("error"), { error: true });

  // ------------------------------------------------------------ file import
  const fileCard = h("section.card#ci-file");
  let file = null; // { name, text }
  let preview = null;
  let mapping = {};
  let kind = "contacts";
  let dateOrder = "mdy";
  let busy = false;

  const kindSel = select(kinds.map((k) => ({ value: k.kind, label: k.label })), kind, {
    id: "ci-kind",
    onchange: (e) => {
      kind = e.target.value;
      preview = null;
      mapping = {};
      drawFile();
      if (file) readFile();
    },
  });
  const orderSel = select(
    [
      { value: "mdy", label: "Month first (03/09/2026 is March 9)" },
      { value: "dmy", label: "Day first (03/09/2026 is 3 September)" },
    ],
    dateOrder,
    { id: "ci-order", onchange: (e) => ((dateOrder = e.target.value), file && readFile()) },
  );
  const fileInput = h("input#ci-input", {
    type: "file",
    accept: ".csv,text/csv",
    onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      file = { name: f.name, text: await f.text() };
      mapping = {};
      await readFile();
    },
  });

  async function readFile(useMapping = false) {
    if (!file) return;
    try {
      preview = await post("/clio-import/preview", { kind, csv: file.text, mapping: useMapping ? mapping : undefined, dateOrder });
      mapping = { ...preview.mapping };
    } catch (err) {
      preview = null;
      toast(err.message, { error: true });
    }
    drawFile();
  }

  async function run(dryRun) {
    if (busy || !file) return;
    if (!dryRun && !confirm(`Import ${plural(preview.counts.ready, "row")} of ${kindBy[kind].label.toLowerCase()} into Lawdesk?`)) return;
    busy = true;
    drawFile();
    try {
      const report = await post("/clio-import/import", { kind, csv: file.text, mapping, dryRun, fileName: file.name, dateOrder });
      toast(dryRun ? "Trial run finished. Nothing was saved." : "Import finished");
      showReport(report);
      if (!dryRun) {
        await Promise.all([drawRuns(), drawTotals()]);
        await readFile(true);
      }
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      busy = false;
      drawFile();
    }
  }

  function drawFile() {
    const k = kindBy[kind];
    const parts = [
      h("h2", "Import a file exported from Clio"),
      h(
        "p.muted",
        "Import in this order: contacts, then matters, then tasks, calendar, time and expenses. A trial run shows exactly what would happen without saving anything. Importing the same file again updates what is already here instead of adding copies.",
      ),
      h(
        "div.ci-choose",
        h("label", { for: "ci-kind" }, "What is in the file", kindSel),
        h("label", { for: "ci-order" }, "How dates are written", orderSel),
        h("label", { for: "ci-input" }, "The file (CSV)", fileInput),
      ),
      h("p.ci-about", k.about),
    ];
    if (preview) parts.push(mappingStep(), rowsStep());
    replace(fileCard, parts);
  }

  function mappingStep() {
    const first = preview.rows[0];
    const opts = [{ value: "", label: "Not in this file" }, ...preview.headers.map((hd, i) => ({ value: i, label: hd || `Column ${i + 1}` }))];
    const sampleCells = preview.sample;
    const rows = preview.fields.map((f) => {
      const sel = select(opts, mapping[f.key] ?? "", {
        "aria-label": `Column for ${f.label}`,
        onchange: (e) => {
          if (e.target.value === "") delete mapping[f.key];
          else mapping[f.key] = Number(e.target.value);
          readFile(true);
        },
      });
      const col = mapping[f.key];
      return h(
        "tr",
        h("td", { "data-label": "Lawdesk field" }, f.label, f.required ? h("span.ci-needed", " (needed)") : null, f.help ? h("div.muted.small", f.help) : null),
        h("td", { "data-label": "Column in the file" }, sel, preview.guessed[f.key] != null && preview.guessed[f.key] === col ? h("div.muted.small", "Matched by its heading") : null),
        h("td.ci-sample", { "data-label": "First row" }, col != null && sampleCells ? sampleCells[col] || "" : ""),
      );
    });
    return h(
      "div.ci-step#ci-mapping",
      h("h3", "1. Match the columns"),
      h("p.muted", `${file.name}: ${plural(preview.counts.rows, "row")}, ${plural(preview.headers.length, "column")}. Columns are matched by their headings; change any that are wrong.`),
      preview.fileWarnings.length ? h("ul.ci-warn", preview.fileWarnings.slice(0, 5).map((w) => h("li", w))) : null,
      preview.missing.length ? h("p.ci-problem", `Choose a column for: ${preview.missing.join("; ")}`) : null,
      h("table.settings-table.ci-map", h("thead", h("tr", h("th", "Lawdesk field"), h("th", "Column in the file"), h("th", "First row"))), h("tbody", rows)),
      first ? null : h("p.muted", "The file has headings but no rows."),
    );
  }

  function rowsStep() {
    const c = preview.counts;
    const canRun = !preview.missing.length && c.ready > 0 && !busy;
    return h(
      "div.ci-step#ci-rows",
      h("h3", "2. Check the rows"),
      h(
        "p.ci-summary",
        `${plural(c.rows, "row")}: ${c.new} new, ${c.update} already imported (will be updated), `,
        h("span" + (c.problems ? ".ci-problem" : ""), `${c.problems} with problems`),
        c.problems ? " (these rows will be skipped)" : "",
        c.warnings ? `, ${c.warnings} to look at` : "",
        ".",
      ),
      preview.rows.length
        ? h(
            "div.ci-scroll",
            h(
              "table.settings-table.ci-rows",
              h("thead", h("tr", h("th", "Line"), h("th", "Status"), h("th", "Record"), h("th", "Notes"))),
              h(
                "tbody",
                preview.rows.map((r) =>
                  h(
                    "tr.ci-row-" + r.status,
                    h("td", { "data-label": "Line" }, String(r.line)),
                    h("td", { "data-label": "Status" }, h("span.tag.ci-" + r.status, STATUS_LABEL[r.status])),
                    h("td", { "data-label": "Record" }, r.summary),
                    h("td", { "data-label": "Notes" }, [...r.errors, ...r.warnings].map((m, i) => h(i < r.errors.length ? "div.ci-problem" : "div.muted", m))),
                  ),
                ),
              ),
            ),
          )
        : null,
      preview.rows.length < c.rows ? h("p.muted.small", `Showing ${preview.rows.length} of ${c.rows} rows (the first rows and every row with a problem).`) : null,
      h(
        "div.ci-actions",
        h("button.btn#ci-dry", { type: "button", disabled: !canRun, onclick: () => run(true) }, busy ? "Working…" : "Trial run (nothing is saved)"),
        h("button.btn.primary#ci-run", { type: "button", disabled: !canRun, onclick: () => run(false) }, `Import ${plural(c.ready, "row")}`),
      ),
    );
  }

  // ----------------------------------------------------------------- report
  const reportCard = h("section.card#ci-report", { hidden: true });

  function showReport(r) {
    reportCard.hidden = false;
    replace(reportCard, reportView(r));
    reportCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ------------------------------------------------------------------ API
  const apiCard = h("section.card#ci-api");
  let pollTimer = null;

  async function drawApi() {
    clearTimeout(pollTimer);
    let st;
    try {
      st = await get("/clio-import/api/status");
    } catch (err) {
      replace(apiCard, h("h2", "Import directly from Clio"), h("p.error-text", err.message));
      return;
    }
    const parts = [h("h2", "Import directly from Clio")];
    if (!st.configured) {
      parts.push(
        h("p", "Instead of exporting files one by one, Lawdesk can read everything straight from the firm's Clio account: people, contacts, matters, tasks, calendar, and time and expenses."),
        h(
          "p.muted",
          "This needs a one-time set-up by whoever looks after the firm's computers: register Lawdesk as an application in Clio's developer portal, then start Lawdesk with CLIO_CLIENT_ID, CLIO_CLIENT_SECRET and CLIO_TOKEN_KEY set (see docs/clio-import.md).",
        ),
      );
      replace(apiCard, parts);
      return;
    }
    if (!st.encrypted) parts.push(h("p.ci-problem", "CLIO_TOKEN_KEY is not set, so the Clio connection would be stored unencrypted. Ask for it to be set before connecting."));
    if (!st.connected) {
      parts.push(
        h("p", "Connect with a Clio administrator's sign-in. Clio will ask to confirm that Lawdesk may read the firm's data."),
        h("button.btn.primary#ci-connect", { type: "button", onclick: async () => {
          try {
            const { url } = await post("/clio-import/api/connect");
            location.href = url;
          } catch (err) {
            toast(err.message, { error: true });
          }
        } }, "Connect to Clio"),
      );
      replace(apiCard, parts);
      return;
    }
    parts.push(h("p.muted", `Connected to Clio (${st.region.toUpperCase()}) since ${when(st.connectedAt)}.`));
    const job = st.job;
    const act = (path, msg) => async () => {
      try {
        await post(path);
        if (msg) toast(msg);
      } catch (err) {
        toast(err.message, { error: true });
      }
      drawApi();
      drawRuns();
      drawTotals();
    };
    if (job) {
      const label = job.status === "done" ? "Finished" : job.status === "paused" ? "Paused" : job.status === "failed" ? (job.error === "Cancelled" ? "Cancelled" : "Stopped") : job.active ? "Working" : "Interrupted";
      parts.push(
        h("p.ci-summary", h("b", `${label}. `), `Started ${when(job.startedAt)}.`, job.waitingUntil ? ` Waiting for Clio's request limit until ${when(job.waitingUntil)}.` : "", job.error && job.error !== "Cancelled" ? h("span.ci-problem", ` ${job.error}`) : ""),
        h(
          "ol.ci-progress",
          job.resources.map((r, i) =>
            h("li" + (r.done ? ".done" : i === job.step && job.status !== "done" ? ".now" : ""), h("span", r.label), h("span.muted", r.records ? `${r.records.toLocaleString()} read` : r.done ? "none" : "")),
          ),
        ),
      );
      const btns = [];
      if (job.status === "running" && job.active) btns.push(h("button.btn", { type: "button", onclick: act(`/clio-import/api/jobs/${job.id}/pause`, "Paused") }, "Pause"));
      if ((job.status === "paused" || job.status === "failed" || (job.status === "running" && !job.active)) && job.error !== "Cancelled")
        btns.push(h("button.btn.primary", { type: "button", onclick: act(`/clio-import/api/jobs/${job.id}/resume`, "Carrying on") }, "Resume"));
      if (job.status !== "done" && job.error !== "Cancelled")
        btns.push(h("button.btn", { type: "button", onclick: () => confirm("Stop this import? What has come over so far stays.") && act(`/clio-import/api/jobs/${job.id}/cancel`, "Cancelled")() }, "Cancel"));
      if (job.report && job.status !== "running") btns.push(h("button.btn", { type: "button", onclick: () => showReport(job.report) }, "Show report"));
      if (btns.length) parts.push(h("div.ci-actions", btns));
      if (job.status === "running" && job.active && ctx.isCurrent()) pollTimer = setTimeout(drawApi, 2000);
    }
    if (!job || job.status === "done" || job.error === "Cancelled")
      parts.push(h("div.ci-actions", h("button.btn.primary#ci-start", { type: "button", onclick: act("/clio-import/api/jobs", "Import from Clio started") }, job ? "Import from Clio again" : "Start import from Clio")));
    parts.push(
      h("p.muted.small", "Lawdesk keeps to Clio's limit on requests, so a large firm can take a while. You can leave this page; the import carries on, and can be resumed if the server restarts."),
      h("button.btn.small", { type: "button", onclick: () => confirm("Disconnect Lawdesk from Clio?") && act("/clio-import/api/disconnect", "Disconnected")() }, "Disconnect"),
    );
    replace(apiCard, parts);
  }

  // --------------------------------------------------------------- totals
  const totalsCard = h("section.card#ci-totals");
  async function drawTotals() {
    const r = await get("/clio-import/reconciliation");
    const c = r.counts;
    const m = r.money;
    replace(
      totalsCard,
      h("h2", "What has come over from Clio"),
      h("p.muted", "Compare these with Clio's own reports (for example the matter list, the unbilled activity report and the trust listing) before relying on the import."),
      h(
        "div.ci-figures",
        figure("People", c.people),
        figure("Contacts", c.contacts),
        figure("Matters", c.matters),
        figure("Tasks", c.tasks),
        figure("Calendar entries", c.calendar),
      ),
      h(
        "table.settings-table.ci-money",
        h("thead", h("tr", h("th", ""), h("th", "Entries"), h("th", "Hours"), h("th", "Amount"))),
        h(
          "tbody",
          moneyRow("Unbilled time, ready to bill", c.unbilledTimeEntries, hours(m.unbilledTimeMinutes), money(m.unbilledTimeCents)),
          moneyRow("Non-billable time", "", hours(m.nonBillableTimeMinutes), ""),
          moneyRow("Unbilled expenses, ready to bill", c.unbilledExpenseEntries, "", money(m.unbilledExpenseCents)),
          moneyRow("Already billed in Clio (history only)", c.billedTimeEntries + c.billedExpenseEntries, hours(m.billedTimeMinutes), money(m.billedTimeCents + m.billedExpenseCents)),
        ),
      ),
      m.billedSinceImport ? h("p.muted.small", `${plural(m.billedSinceImport, "imported entry", "imported entries")} have since been put on a Lawdesk invoice.`) : null,
      r.trust ? h("p.ci-trust", h("b", `Trust balances from Clio: ${money(r.trust.totalCents)} across ${plural(r.trust.lines, "line")}. `), r.trust.note) : null,
    );
  }

  // ----------------------------------------------------------------- runs
  const runsCard = h("section.card#ci-runs");
  async function drawRuns() {
    const runs = await get("/clio-import/runs");
    replace(
      runsCard,
      h("h2", "Past imports"),
      runs.length
        ? h(
            "table.settings-table.ci-runlist",
            h("thead", h("tr", h("th", "When"), h("th", "What"), h("th", "File"), h("th", "Result"), h("th", ""))),
            h(
              "tbody",
              runs.map((r) =>
                h(
                  "tr",
                  h("td", { "data-label": "When" }, when(r.started_at)),
                  h("td", { "data-label": "What" }, r.source === "api" ? "Everything, from Clio" : kindBy[r.kind]?.label ?? r.kind),
                  h("td", { "data-label": "File" }, r.file_name || ""),
                  h("td", { "data-label": "Result" }, r.dry_run ? "Trial run" : { done: "Done", running: "In progress", paused: "Paused", failed: "Stopped" }[r.status] ?? r.status),
                  h(
                    "td",
                    h("button.btn.small", { type: "button", onclick: async () => showReport((await get(`/clio-import/runs/${r.id}`)).report) }, "Report"),
                  ),
                ),
              ),
            ),
          )
        : h("p.muted", "Nothing imported yet."),
    );
  }

  drawFile();
  page.append(
    h("div.page-head", h("p.ci-crumb", h("a", { href: "#/settings" }, "Settings")), h("h1", "Import from Clio")),
    fileCard,
    reportCard,
    apiCard,
    totalsCard,
    runsCard,
  );
  await Promise.all([drawApi(), drawTotals(), drawRuns()]);
  return page;
}

function figure(label, n) {
  return h("div.ci-figure", h("span.ci-figure-n", (n || 0).toLocaleString()), h("span.ci-figure-l", label));
}

function moneyRow(label, n, hrs, amt) {
  return h("tr", h("td", label), h("td", { "data-label": "Entries" }, n === "" ? "" : String(n)), h("td", { "data-label": "Hours" }, hrs), h("td", { "data-label": "Amount" }, amt));
}

/** The reconciliation report for one import. */
export function reportView(r) {
  if (!r) return h("p.muted", "No report was saved for this import.");
  const t = r.totals;
  const types = Object.entries(r.byType);
  const hasMoney = t.timeEntries || t.expenseEntries;
  return [
    h("h2", r.dryRun ? "Trial run: what would happen" : "Import report"),
    h("p.muted", [r.fileName, r.source === "api" ? "Read from Clio" : null, `${plural(r.rowsRead, "record")} read`, r.finishedAt ? `finished ${when(r.finishedAt)}` : "not finished"].filter(Boolean).join(" · ")),
    r.dryRun ? h("p.ci-trust", "Nothing was saved. Choose Import to do this for real.") : null,
    types.length
      ? h(
          "table.settings-table.ci-tally",
          h("thead", h("tr", h("th", ""), h("th", "Added"), h("th", "Updated"), h("th", "Unchanged"), h("th", "Skipped"))),
          h(
            "tbody",
            types.map(([k, v]) =>
              h("tr", h("td", k), h("td", { "data-label": "Added" }, String(v.created)), h("td", { "data-label": "Updated" }, String(v.updated)), h("td", { "data-label": "Unchanged" }, String(v.unchanged)), h("td", { "data-label": "Skipped" }, String(v.skipped))),
            ),
          ),
        )
      : null,
    hasMoney
      ? h(
          "table.settings-table.ci-money",
          h("thead", h("tr", h("th", "Time and expenses in this import"), h("th", "Hours"), h("th", "Amount"))),
          h(
            "tbody",
            h("tr", h("td", "Unbilled time"), h("td", { "data-label": "Hours" }, hours(t.unbilledTimeMinutes)), h("td", { "data-label": "Amount" }, money(t.unbilledTimeCents))),
            h("tr", h("td", "Non-billable time"), h("td", { "data-label": "Hours" }, hours(t.nonBillableTimeMinutes)), h("td", "")),
            h("tr", h("td", "Time already billed in Clio"), h("td", { "data-label": "Hours" }, hours(t.billedTimeMinutes)), h("td", { "data-label": "Amount" }, money(t.billedTimeCents))),
            h("tr", h("td", "Unbilled expenses"), h("td", ""), h("td", { "data-label": "Amount" }, money(t.unbilledExpenseCents))),
            h("tr", h("td", "Non-billable expenses"), h("td", ""), h("td", { "data-label": "Amount" }, money(t.nonBillableExpenseCents))),
            h("tr", h("td", "Expenses already billed in Clio"), h("td", ""), h("td", { "data-label": "Amount" }, money(t.billedExpenseCents))),
            t.clioStatedTotalCents ? h("tr", h("td", "Clio's own totals for these entries"), h("td", ""), h("td", { "data-label": "Amount" }, money(t.clioStatedTotalCents))) : null,
          ),
        )
      : null,
    hasMoney ? h("p.muted.small", "Amounts are hours × the rate from Clio, before Lawdesk's billing increment is applied. Billed entries are kept as history and will not be billed again.") : null,
    r.added && (r.added.people.length || r.added.clients.length || r.added.practiceAreas.length)
      ? h(
          "div.ci-added",
          h("h3", "Added along the way"),
          r.added.people.length ? h("p", h("b", "People: "), r.added.people.join(", "), ". Check their role and rate under Settings.") : null,
          r.added.clients.length ? h("p", h("b", "Clients not in the contacts file: "), r.added.clients.join(", ")) : null,
          r.added.practiceAreas.length ? h("p", h("b", "Practice areas: "), r.added.practiceAreas.join(", ")) : null,
        )
      : null,
    r.trust
      ? h(
          "div.ci-trustbox",
          h("h3", `Trust balances: ${money(r.trust.totalCents)}`),
          h("p.ci-trust", r.trust.note),
          h(
            "table.settings-table",
            h("thead", h("tr", h("th", "Client"), h("th", "Matter"), h("th", "Balance"), h("th", ""))),
            h(
              "tbody",
              r.trust.lines.map((l) =>
                h("tr", h("td", { "data-label": "Client" }, l.client || ""), h("td", { "data-label": "Matter" }, l.matter || ""), h("td", { "data-label": "Balance" }, money(l.balanceCents)), h("td", l.matterId ? h("a", { href: `#/matters/${l.matterId}` }, "Open matter") : h("span.muted", "Matter not found"))),
              ),
            ),
          ),
        )
      : null,
    h(
      "div.ci-skipped",
      h("h3", r.skipped.length ? `Skipped (${r.skipped.length})` : "Nothing was skipped"),
      r.skipped.length
        ? h(
            "div.ci-scroll",
            h(
              "table.settings-table",
              h("thead", h("tr", h("th", "Line"), h("th", "Record"), h("th", "Why"))),
              h("tbody", r.skipped.slice(0, 300).map((s) => h("tr", h("td", { "data-label": "Line" }, s.line ? String(s.line) : ""), h("td", { "data-label": "Record" }, `${s.type}: ${s.ref}`), h("td", { "data-label": "Why" }, s.reason)))),
            ),
          )
        : null,
      r.warnings.length
        ? h(
            "details.ci-warnings",
            h("summary", `${plural(r.warnings.length, "note")} to look at`),
            h("ul", r.warnings.slice(0, 300).map((w) => h("li", [w.line ? `Line ${w.line}` : null, w.ref].filter(Boolean).join(", ") + (w.line || w.ref ? ": " : "") + w.message))),
          )
        : null,
      r.runId && (r.skipped.length || r.warnings.length) ? h("p", h("a", { href: `/api/clio-import/runs/${r.runId}/problems.csv` }, "Download the full list (CSV)")) : null,
      r.truncated ? h("p.muted.small", "The list is very long; only the first 5,000 are kept.") : null,
    ),
  ];
}
