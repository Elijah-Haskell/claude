// Firm overview: headline figures, small charts and what needs attention, for the
// attorneys and whoever runs the office. Every tile and list item links to the screen
// where it gets dealt with.

import { h, fmtDate, plural } from "../dom.js";
import { pageHeader, card as kitCard, pill, button, callout, sectionTitle } from "../ui/components.js";
import { icon } from "../ui/icons.js";
import { get } from "../api.js";
import { columnChart, barList, legend } from "../charts.js";
import { money, moneyWhole, moneyShort, hoursShort, hours, int, longDate } from "../report-format.js";

/** Where each item gets fixed. Kept in one place so other screens can take over a link. */
export const FIX = {
  overdueTasks: () => "#/firm",
  personTasks: () => "#/firm",
  matter: (id) => `#/matters/${id}`,
  invoice: (i) => (i.matter_id ? `#/matters/${i.matter_id}` : "#/reports/aging?view=invoice"),
  conflict: (c) => (c.matter_id ? `#/matters/${c.matter_id}` : null),
  report: (key, q = {}) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== ""));
    return `#/reports/${key}${p.toString() ? "?" + p : ""}`;
  },
};

const TILE_ICONS = { "t-overdue": "triangle-alert", "t-opened": "briefcase", "t-unbilled": "clock", "t-owed": "receipt", "t-received": "wallet" };

/** A figure at the top; built like the kit's stat() so it matches Home, plus the overview's ids. */
function tile({ n, label, sub, href, tone, id }) {
  return h(
    "a.stat.stat-v2.ov-tile" + (tone ? "." + tone : ""),
    { href, id, dataset: { tile: id } },
    h("span.stat-top", h("span.stat-icon", icon(TILE_ICONS[id] || "chart-column", { size: 16 })), h("span.stat-label", label)),
    h("span.stat-n", n),
    sub ? h("span.stat-hint.ov-sub", sub) : null,
  );
}

/** The stage charts run full width, one practice area per column. */
function stagesCard(el) {
  el.classList.add("ov-stages");
  return el;
}

function card(title, sub, ic, ...body) {
  return kitCard({ title, subtitle: sub, icon: ic, className: "ov-card", body });
}

function numbers(caption, head, rows) {
  return h(
    "details.ov-numbers",
    h("summary", "See the numbers"),
    h("table.report-table.compact", h("caption.sr-only", caption), h("thead", h("tr", head.map((x, i) => h("th", { class: i ? "n" : null, scope: "col" }, x)))), h("tbody", rows.map((r) => h("tr", r.map((c, i) => (i ? h("td.n", c) : h("th", { scope: "row" }, c))))))),
  );
}

function notSetUp(what) {
  return h("p.empty", `${what} will show here once billing is set up.`);
}

function attention(title, ic, count, items, empty, more) {
  return kitCard({
    title,
    icon: ic,
    className: "ov-attn",
    actions: count == null ? null : count ? pill(String(count), "danger", { dot: false }) : pill("All clear", "success", { dot: false }),
    body: [items.length ? h("ul.ov-list", items) : h("p.ov-clear", icon("circle-check", { size: 16 }), h("span", empty)), more],
  });
}

function item(href, main, side, sub) {
  const inner = [h("span.ov-item-main", main, sub ? h("span.ov-item-sub", sub) : null), side ? h("span.ov-item-side", side) : null];
  return h("li", href ? h("a.ov-item", { href }, inner) : h("div.ov-item", inner));
}

export async function overviewView() {
  const d = await get("/reports/dashboard");
  const t = d.tiles;
  const today = d.today;
  const month = { from: d.month_start, to: today };

  const tiles = h(
    "div.stats.ov-tiles",
    tile({ id: "t-overdue", n: int(t.overdue_tasks), label: "Overdue tasks", sub: "Across the firm", href: FIX.overdueTasks(), tone: t.overdue_tasks ? "late" : "good" }),
    tile({ id: "t-opened", n: int(t.matters_opened), label: "Matters opened", sub: `Since ${fmtDate(d.month_start, today)}`, href: FIX.report("matters", { status: "all", ...month }) }),
    tile({
      id: "t-unbilled",
      n: moneyWhole(t.unbilled_time_cents),
      label: "Unbilled time",
      sub: t.unbilled_minutes != null ? `${hoursShort(t.unbilled_minutes)} not yet invoiced` : "Billing not set up",
      href: FIX.report("time-by-matter", { all: "1" }),
    }),
    tile({
      id: "t-owed",
      n: moneyWhole(t.outstanding_cents),
      label: "Owed to the firm",
      sub: t.outstanding_invoices != null ? `On ${plural(t.outstanding_invoices, "unpaid invoice")}` : "Billing not set up",
      href: FIX.report("aging"),
    }),
    tile({
      id: "t-received",
      n: moneyWhole(t.received_cents),
      label: "Received this month",
      sub: t.received_cents != null ? `Payments since ${fmtDate(d.month_start, today)}` : "Billing not set up",
      href: FIX.report("revenue", month),
      tone: t.received_cents ? "good" : null,
    }),
  );

  // ---------------------------------------------------------------- charts
  const c = d.charts;
  const collections = c.collections
    ? [
        columnChart({
          label: "Payments received by month for the last 12 months",
          items: c.collections.map((m, i) => ({
            label: m.label,
            sub: i === 0 || m.label === "Jan" ? m.year : null,
            value: m.received_cents,
            title: `${m.label} ${m.year}: ${money(m.received_cents)} received`,
          })),
          format: moneyShort,
          highlightLast: true,
        }),
        numbers(
          "Payments received by month",
          ["Month", "Received", "Billed"],
          c.collections.map((m) => [`${m.label} ${m.year}`, money(m.received_cents), money(m.billed_cents)]),
        ),
        h("p.ov-foot", h("a", { href: FIX.report("revenue", { from: c.collections[0].month + "-01", to: today }) }, "Revenue report")),
      ]
    : [notSetUp("Payments received")];

  const series = [
    { label: "Worked", cls: "bar-soft" },
    { label: "Billed", cls: "bar-strong" },
  ];
  const hoursChart = c.hours
    ? c.hours.people.length
      ? [
          legend(series),
          barList({
            label: "Hours worked and billed by person",
            rows: c.hours.people.map((p) => ({ label: p.name, values: [p.worked, p.billed], href: FIX.report("productivity", { from: c.hours.from, to: c.hours.to, userId: p.user_id }) })),
            series,
            format: hoursShort,
          }),
          numbers("Hours by person", ["Person", "Worked", "Billable", "Billed"], c.hours.people.map((p) => [p.name, hours(p.worked), hours(p.billable), hours(p.billed)])),
          h("p.ov-foot", h("a", { href: FIX.report("productivity", { from: c.hours.from, to: c.hours.to }) }, "Productivity report")),
        ]
      : [h("p.empty", "No time recorded in the last 90 days.")]
    : [notSetUp("Hours")];

  const BUCKETS = [
    ["current", "Not yet due", null],
    ["d1_30", "1–30 days", null],
    ["d31_60", "31–60 days", "warn"],
    ["d61_90", "61–90 days", "late"],
    ["d90_plus", "Over 90 days", "late"],
  ];
  const agingChart = c.aging
    ? c.aging.total
      ? [
          barList({
            label: "Money owed by how late it is",
            rows: BUCKETS.map(([k, l, tone]) => ({ label: l, values: [c.aging[k]], tone, href: FIX.report("aging", { view: "invoice" }) })),
            series: [{ label: "Owed", cls: "bar-mid" }],
            format: moneyShort,
          }),
          numbers("Money owed by age", ["How late", "Owed"], [...BUCKETS.map(([k, l]) => [l, money(c.aging[k])]), ["Total", money(c.aging.total)]]),
          h("p.ov-foot", h("a", { href: FIX.report("aging") }, "Aging report")),
        ]
      : [h("p.empty", "Nothing is owed right now.")]
    : [notSetUp("Money owed")];

  const stageCharts = c.stages.length
    ? [
        ...c.stages.map((a) =>
          h(
            "div.ov-area",
            h("h3", a.name, h("span.ov-area-n", plural(a.total, "open matter"))),
            barList({
              label: `Open ${a.name} matters by stage`,
              rows: a.stages.map((s) => ({ label: s.name, values: [s.count] })),
              series: [{ label: "Matters", cls: "bar-mid" }],
              format: (v) => String(v),
            }),
          ),
        ),
        h("p.ov-foot", h("a", { href: FIX.report("matters") }, "Matter list"), " · ", h("a", { href: "#/matters" }, "Matters")),
      ]
    : [h("p.empty", "No open matters.")];

  const charts = h(
    "div.ov-grid.ov-charts",
    card("Payments received", "By month, last 12 months", "wallet", ...collections),
    card("Hours worked and billed", `By person, ${longDate(c.hours?.from ?? today)} to ${longDate(today)}`, "clock", ...hoursChart),
    card("Money owed, by how late it is", `Days past due, as of ${longDate(today)}`, "receipt", ...agingChart),
    stagesCard(card("Open matters by stage", "For each practice area", "briefcase", ...stageCharts)),
  );

  // ------------------------------------------------------------- attention
  const a = d.attention;
  const overdueCount = a.overdue_by_person.reduce((s, p) => s + p.count, 0);
  const lists = h(
    "div.ov-grid.ov-attn-grid",
    attention(
      "Overdue tasks by person",
      "triangle-alert",
      overdueCount,
      a.overdue_by_person.map((p) => item(FIX.personTasks(p), p.name, plural(p.count, "task"), `Oldest was due ${fmtDate(p.oldest_due, today)} (${plural(p.days_late, "day")} ago)`)),
      "No overdue tasks.",
      null,
    ),
    attention(
      `Matters with no activity in ${d.settings.quiet_days} days`,
      "hourglass",
      a.quiet_matters.total,
      a.quiet_matters.items.map((m) =>
        item(FIX.matter(m.id), [m.number ? h("span.num", m.number) : null, m.name], `${m.days_quiet} days`, [m.client_name, m.last_activity ? `last activity ${fmtDate(m.last_activity, today)}` : "no activity yet"].filter(Boolean).join(" · ")),
      ),
      "Every open matter has had activity recently.",
      a.quiet_matters.total > a.quiet_matters.items.length ? h("p.ov-foot", h("a", { href: FIX.report("matters") }, `See all ${a.quiet_matters.total} in the matter list`)) : null,
    ),
    a.past_due_invoices
      ? attention(
          `Invoices more than ${d.settings.past_due_days} days past due`,
          "receipt",
          a.past_due_invoices.total,
          a.past_due_invoices.items.map((i) =>
            item(FIX.invoice(i), `Invoice ${i.number ?? "#" + i.id} · ${i.client_name}`, money(i.balance_cents), `${i.matter_name} · due ${fmtDate(i.due_on, today)}, ${i.days_past_due} days ago`),
          ),
          "No invoices are that far past due.",
          a.past_due_invoices.total ? h("p.ov-foot", `${money(a.past_due_invoices.balance_cents)} in all · `, h("a", { href: FIX.report("aging", { view: "invoice" }) }, "Aging by invoice")) : null,
        )
      : attention(`Invoices more than ${d.settings.past_due_days} days past due`, "receipt", null, [], "Billing is not set up yet.", null),
    a.undecided_conflicts
      ? attention(
          "Conflict checks without a decision",
          "scale",
          a.undecided_conflicts.total,
          a.undecided_conflicts.items.map((k) =>
            item(
              FIX.conflict(k),
              k.names.length ? k.names.join(", ") : "Conflict check",
              plural(k.hit_count, "possible match", "possible matches"),
              [k.matter_name ? `${k.matter_number ? k.matter_number + " " : ""}${k.matter_name}` : "No matter yet", `run ${fmtDate(k.run_on, today)}${k.run_by ? " by " + k.run_by : ""}`].join(" · "),
            ),
          ),
          "Every conflict check has a decision.",
          null,
        )
      : attention("Conflict checks without a decision", "scale", null, [], "Conflict checking is not set up yet.", null),
  );

  const defs = h(
    "details.card.ov-defs",
    h("summary", h("h2", "How these figures are worked out")),
    h(
      "dl.defs",
      [
        ["Overdue tasks", "Open tasks whose due date has passed, on open matters (or on no matter). Tasks waiting on an earlier task are not counted."],
        ["Matters opened", `Matters with an open date from ${longDate(d.month_start)} to today, whether or not they are still open.`],
        ["Unbilled time", "Billable time not yet on a finalized invoice (time on a draft invoice still counts), at each entry's rate after rounding up to the billing increment. Time on flat-fee and contingency matters counts as $0."],
        ["Owed to the firm", "Unpaid balances on finalized invoices as of today: invoice totals less payments, credit applied and write-offs. Unused client credit is not subtracted."],
        ["Received this month", "Payments received from clients this month that have not been voided, whichever invoices they paid."],
        ["Payments received chart", "The same figure for each of the last 12 months; the darker bar is this month so far."],
        ["Hours worked and billed", `For the last ${d.settings.hours_window_days} days. Worked: all time recorded, billable or not. Billed: hours on finalized invoices for work in that period, as charged (rounded up to the billing increment).`],
        ["Money owed, by how late it is", "Each unpaid balance is placed by how many days it is past the invoice's due date."],
        ["Open matters by stage", "Open matters counted by the stage they are in now."],
        [`No activity in ${d.settings.quiet_days} days`, `Open matters with nothing written to their history (task changes, stage moves, billing entries…) in the last ${d.settings.quiet_days} days. A matter with no history counts from its open date.`],
        [`More than ${d.settings.past_due_days} days past due`, `Invoices with a balance whose due date was more than ${d.settings.past_due_days} days ago.`],
        ["Conflict checks without a decision", "Conflict searches that were run but have not been marked cleared, waived or declined."],
      ].map(([k, v]) => [h("dt", k), h("dd", v)]),
    ),
  );

  return h(
    "div.page.overview-page",
    pageHeader({
      title: "Firm overview",
      subtitle: `The whole firm as of ${longDate(today)}. Every figure links to the list behind it.`,
      actions: [button("All reports", { icon: "reports", href: "#/reports" })],
    }),
    d.errors?.length
      ? callout({ tone: "danger", title: "Some figures could not be worked out and are left out.", body: h("ul.ov-errors", d.errors.map((e) => h("li", e))) })
      : null,
    tiles,
    sectionTitle("Needs attention"),
    lists,
    sectionTitle("At a glance"),
    charts,
    defs,
  );
}
