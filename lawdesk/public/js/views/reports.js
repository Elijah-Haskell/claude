// Reports: a list of reports, and one report with its filters, table, CSV download and
// print view. The filters live in the address (#/reports/tasks?from=...&to=...) so a
// report can be bookmarked or linked from the firm overview.

import { h, select, addDays } from "../dom.js";
import { get } from "../api.js";
import { money, hours, pct, int, longDate } from "../report-format.js";
import { pageHeader, button, pill, sectionTitle, card, emptyState, callout } from "../ui/components.js";
import { icon } from "../ui/icons.js";

const REPORT_ICONS = {
  tasks: "list-checks",
  matters: "briefcase",
  clients: "contact",
  activity: "activity",
  productivity: "users",
  "time-by-matter": "clock",
  revenue: "wallet",
  aging: "receipt",
};

const GROUPS = [
  { title: "Work and matters", keys: ["tasks", "matters", "clients", "activity"] },
  { title: "Time and money", keys: ["productivity", "time-by-matter", "revenue", "aging"] },
];

const loadCatalogue = () => get("/reports");

export async function reportsListView() {
  const cat = await loadCatalogue();
  const byKey = Object.fromEntries(cat.reports.map((r) => [r.key, r]));
  return h(
    "div.page.reports-page",
    pageHeader({
      title: "Reports",
      subtitle: "Each report can be narrowed by dates, person or matter, downloaded for Excel or printed.",
      actions: [button("Firm overview", { icon: "overview", href: "#/overview" })],
    }),
    GROUPS.map((g) =>
      h(
        "section.rp-group",
        sectionTitle(g.title),
        h(
          "ul.rp-cards",
          g.keys
            .map((k) => byKey[k])
            .filter(Boolean)
            .map((r) =>
              h(
                "li",
                h(
                  "a.card.rp-card",
                  { href: `#/reports/${r.key}`, dataset: { report: r.key } },
                  h("span.rp-card-icon", icon(REPORT_ICONS[r.key] || "reports", { size: 18 })),
                  h(
                    "span.rp-card-text",
                    h("h3", r.title),
                    h("p", r.summary),
                    r.needsBilling && !cat.billing ? h("span.rp-card-note", pill("Needs billing to be set up", "warning")) : null,
                  ),
                  icon("chevron-right", { size: 16, class: "rp-card-go" }),
                ),
              ),
            ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- one report

const PRESETS = [
  ["month", "This month"],
  ["last-month", "Last month"],
  ["quarter", "This quarter"],
  ["year", "This year"],
  ["last-year", "Last year"],
  ["12m", "Last 12 months"],
  ["30d", "Last 30 days"],
  ["all", "All dates"],
  ["custom", "Choose dates…"],
];

export function presetRange(key, today) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const first = (yy, mm) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  const lastOf = (yy, mm) => addDays(mm === 12 ? first(yy + 1, 1) : first(yy, mm + 1), -1);
  switch (key) {
    case "month":
      return { from: first(y, m), to: today };
    case "last-month":
      return m === 1 ? { from: first(y - 1, 12), to: lastOf(y - 1, 12) } : { from: first(y, m - 1), to: lastOf(y, m - 1) };
    case "quarter":
      return { from: first(y, Math.floor((m - 1) / 3) * 3 + 1), to: today };
    case "year":
      return { from: `${y}-01-01`, to: today };
    case "last-year":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "12m":
      return { from: m === 12 ? first(y, 1) : first(y - 1, m + 1), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "all":
      return { from: "", to: "" };
    default:
      return null;
  }
}

function presetFor(from, to, today) {
  for (const [k] of PRESETS) {
    const r = presetRange(k, today);
    if (r && r.from === (from || "") && r.to === (to || "")) return k;
  }
  return "custom";
}

function cell(col, v, link) {
  let text;
  switch (col.type) {
    case "cents":
      text = v == null ? "" : money(v);
      break;
    case "minutes":
      text = v == null ? "" : hours(v);
      break;
    case "ratio":
      text = v == null ? "—" : pct(v);
      break;
    case "int":
      text = v == null ? "" : int(v);
      break;
    case "date":
      text = v ? longDate(v) : "";
      break;
    case "links":
      return h("td.links", (v || []).map((l, i) => [i ? h("br") : null, h("a", { href: l.href }, l.label)]));
    default:
      text = v == null ? "" : String(v);
  }
  const numeric = ["cents", "minutes", "ratio", "int"].includes(col.type);
  return h("td" + (numeric ? ".n" : ""), link ? h("a", { href: link }, text) : text);
}

function query(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") p.set(k, String(v));
  return p.toString();
}

export async function reportView([key, qs]) {
  const cat = await loadCatalogue();
  const info = cat.reports.find((r) => r.key === key);
  if (!info) throw new Error("There is no report by that name.");
  const today = cat.today;
  const given = new URLSearchParams(qs || "");
  const allDates = given.get("all") === "1";
  const params = Object.fromEntries(given.entries());
  delete params.all;
  if (!allDates && params.from == null && params.to == null) Object.assign(params, info.defaults);
  const apiQuery = query({ ...params, all: allDates ? "1" : null });
  const r = await get(`/reports/${key}?${apiQuery}`);
  const f = r.filters;

  // ------------------------------------------------------------- filters
  const fromIn = h("input#rp-from", { type: "date", value: f.from ?? "", "aria-label": "From" });
  const toIn = h("input#rp-to", { type: "date", value: f.to ?? "", "aria-label": info.uses.asOf ? "As of" : "To" });
  const custom = h("div.rp-dates", h("label", { for: "rp-from" }, "From", fromIn), h("label", { for: "rp-to" }, "To", toIn));
  const preset = select(
    PRESETS.map(([value, label]) => ({ value, label })),
    presetFor(f.from, f.to, today),
    { id: "rp-preset" },
  );
  const showCustom = () => (custom.hidden = preset.value !== "custom");
  preset.addEventListener("change", () => {
    const rg = presetRange(preset.value, today);
    if (rg) {
      fromIn.value = rg.from;
      toIn.value = rg.to;
    }
    showCustom();
  });
  showCustom();

  const people = select(
    [{ value: "", label: "Everyone" }, ...cat.people.map((p) => ({ value: p.id, label: p.name + (p.active ? "" : " (former)") }))],
    f.userId ?? "",
    { id: "rp-person" },
  );
  const matters = select(
    [{ value: "", label: "All matters" }, ...cat.matters.map((m) => ({ value: m.id, label: (m.number ? m.number + " " : "") + m.name + (m.status === "closed" ? " (closed)" : ""), group: m.status === "closed" ? "Closed" : "Open" }))],
    f.matterId ?? "",
    { id: "rp-matter" },
  );
  const optSelects = (info.options || []).map((o) => ({
    o,
    el: select(o.choices, f.options?.[o.key] ?? o.default, { id: "rp-opt-" + o.key }),
  }));
  const search = info.search ? h("input#rp-q", { type: "search", value: f.options?.q ?? "", placeholder: info.search, "aria-label": info.search }) : null;

  const field = (label, forId, el, cls = "") => h("div.rp-field" + cls, h("label", { for: forId }, label), el);
  const form = h(
    "form.card.rp-filters",
    {
      onsubmit: (e) => {
        e.preventDefault();
        const next = {};
        if (info.uses.dates) {
          if (preset.value === "all") next.all = "1";
          else Object.assign(next, { from: fromIn.value, to: toIn.value });
        } else if (info.uses.asOf) next.to = toIn.value;
        if (info.uses.person) next.userId = people.value;
        if (info.uses.matter) next.matterId = matters.value;
        for (const { o, el } of optSelects) next[o.key] = el.value;
        if (search) next.q = search.value.trim();
        const qstr = query(next);
        location.hash = `#/reports/${key}${qstr ? "?" + qstr : ""}`;
      },
    },
    info.uses.dates ? field(info.periodLabel || "Dates", "rp-preset", h("div.rp-period", preset, custom), ".wide") : null,
    info.uses.asOf ? field("As of", "rp-to", toIn) : null,
    info.uses.person ? field(info.personLabel || "Person", "rp-person", people) : null,
    info.uses.matter ? field("Matter", "rp-matter", matters) : null,
    optSelects.map(({ o, el }) => field(o.label, el.id, el)),
    search ? field("Search", "rp-q", search, ".wide") : null,
    h("div.rp-submit", button("Show report", { variant: "primary", type: "submit" })),
  );

  // ------------------------------------------------------------- table
  const csvHref = `/api/reports/${key}/csv${apiQuery ? "?" + apiQuery : ""}`;
  const actions = r.available
    ? [
        button("Download for Excel", { icon: "file-text", href: csvHref, download: "", id: "rp-csv" }),
        button("Print", { icon: "file", id: "rp-print", onclick: () => window.print() }),
      ]
    : null;

  const describe = [];
  if (info.uses.dates) describe.push(f.from || f.to ? `${info.periodLabel || "Between"} ${f.from ? longDate(f.from) : "the beginning"} and ${f.to ? longDate(f.to) : "today"}` : "All dates");
  if (info.uses.asOf) describe.push(`As of ${longDate(f.to)}`);
  if (f.userId) describe.push(`${info.personLabel || "Person"}: ${cat.people.find((p) => p.id === f.userId)?.name ?? "?"}`);
  if (f.matterId) {
    const m = cat.matters.find((x) => x.id === f.matterId);
    describe.push(`Matter: ${m ? (m.number ? m.number + " " : "") + m.name : "?"}`);
  }
  for (const { o } of optSelects) {
    const v = f.options?.[o.key];
    const ch = o.choices.find((c) => c.value === v);
    if (v && ch) describe.push(`${o.label}: ${ch.label}`);
  }
  if (f.options?.q) describe.push(`Containing “${f.options.q}”`);

  let table;
  if (!r.available) table = card({ body: emptyState({ icon: REPORT_ICONS[key] || "reports", title: "This report isn't available yet", body: r.notes.join(" "), compact: true }) });
  else if (!r.rows.length)
    table = card({ className: "rp-none", body: emptyState({ icon: "search", title: "Nothing matches these filters", body: "Try a wider date range, or everyone and all matters.", compact: true }) });
  else {
    table = h(
      "div.rp-table-wrap",
      { tabindex: "0", role: "region", "aria-label": r.title },
      h(
        "table.report-table#rp-table",
        h("thead", h("tr", r.columns.map((c) => h("th", { scope: "col", class: ["cents", "minutes", "ratio", "int"].includes(c.type) ? "n" : null }, c.label)))),
        h(
          "tbody",
          r.rows.map((row) => h("tr", r.columns.map((c) => cell(c, row[c.key], row._links?.[c.key])))),
        ),
        r.totals
          ? h(
              "tfoot",
              h(
                "tr",
                r.columns.map((c, i) => (i === 0 && r.totals[c.key] == null ? h("td", "Total") : c.type === "links" ? h("td") : cell(c, r.totals[c.key]))),
              ),
            )
          : null,
      ),
    );
  }

  const firm = cat.firmName || "Lawdesk";
  return h(
    "div.page.report-page",
    { dataset: { report: key } },
    h("div.rp-print-head", h("p.rp-firm", firm), h("p", `Printed ${longDate(today)}`)),
    pageHeader({
      breadcrumbs: [{ label: "Reports", href: "#/reports" }, { label: r.title }],
      title: r.title,
      subtitle: info.summary,
      actions,
    }),
    form,
    h("p.rp-applied", describe.join(" · ")),
    r.available && r.notes.length ? callout({ tone: "info", body: h("ul.rp-notes", r.notes.map((n) => h("li", n))) }) : null,
    table,
    r.definitions.length
      ? card({ title: "What the figures mean", icon: "info", className: "rp-defs", body: h("dl.defs", r.definitions.map((d) => [h("dt", d.term), h("dd", d.meaning)])) })
      : null,
  );
}
