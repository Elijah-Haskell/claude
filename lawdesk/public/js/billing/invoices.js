// Invoices: what clients owe (aging summary), the list of invoices, and starting a new one.

import { h, replace, modal, fmtDate, plural } from "../dom.js";
import { get, post } from "../api.js";
import { today, prefs } from "../state.js";
import { money, hours } from "./format.js";
import { billingPage, allMatters, matterSelect, statusTag, invoiceStatus, figure, fail } from "./ui.js";
import { card, field, button, segmented, emptyState, callout } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { icon } from "../ui/icons.js";

const FILTERS = [
  ["unpaid", "Awaiting payment"],
  ["draft", "Drafts"],
  ["paid", "Paid"],
  ["void", "Void"],
  ["all", "All"],
];

export async function invoicesView(_m, ctx) {
  const now = today();
  let filter = prefs.get("billing.invoices.filter", "unpaid");
  const [invoices, ag, matters] = await Promise.all([get("/billing/invoices"), get("/billing/reports/aging"), allMatters(true)]);
  if (ctx && !ctx.isCurrent()) return h("div");

  const page = billingPage("#/billing/invoices", "Invoices", "What clients owe, and every invoice the firm has issued.", [
    button("Record a payment", { href: "#/billing/payments", icon: "landmark" }),
    button("New invoice", { variant: "primary", icon: "plus", id: "new-invoice", onclick: () => newInvoiceDialog() }),
  ]);

  // ------------------------------------------------------------- aging
  const t = ag.totals;
  const clientTable = ag.rows.length
    ? dataTable({
        columns: [
          {
            key: "client_name",
            label: "Client",
            primary: true,
            render: (r) =>
              h(
                "div.cell-stack",
                h("a.cell-title", { href: `#/billing/statements/${r.client_id}` }, r.client_name),
                r.credit_cents ? h("span.cell-sub", `${money(r.credit_cents)} credit on account`) : null,
              ),
          },
          ...[
            ["current", "Not yet due"],
            ["d1_30", "1–30 days"],
            ["d31_60", "31–60 days"],
            ["d61_90", "61–90 days"],
            ["d90_plus", "Over 90 days"],
          ].map(([k, label]) => ({
            key: k,
            label,
            align: "right",
            className: "nowrap" + (k === "current" ? "" : " bl-age-cell"),
            render: (r) => (r[k] ? h("span" + (k !== "current" ? ".bl-age-late" : ""), money(r[k])) : h("span.muted", "–")),
            sort: (r) => r[k],
            defaultDir: "desc",
          })),
          {
            key: "total",
            label: "Total",
            align: "right",
            className: "nowrap",
            render: (r) => h("strong", money(r.total)),
            sort: (r) => r.total,
            defaultDir: "desc",
          },
        ],
        rows: ag.rows,
        rowKey: (r) => r.client_id,
        rowHref: (r) => `#/billing/statements/${r.client_id}`,
        toolbar: false,
        tableClass: "bl-aging-table",
        label: "Amounts owed by client",
        noun: ["client", "clients"],
        sort: { key: "total", dir: "desc" },
      })
    : null;
  const aging = card({
    className: "bl-aging",
    title: "Owed to the firm",
    subtitle: `As of ${fmtDate(ag.as_of, now)}`,
    icon: "landmark",
    body: [
      h(
        "div.bl-figures",
        { "aria-label": "Amounts owed by age" },
        figure("Total owed", money(t.total), { tone: "total" }),
        figure("Not yet due", money(t.current)),
        figure("1–30 days past due", money(t.d1_30), { tone: t.d1_30 ? "warn" : "" }),
        figure("31–60 days", money(t.d31_60), { tone: t.d31_60 ? "late" : "" }),
        figure("61–90 days", money(t.d61_90), { tone: t.d61_90 ? "late" : "" }),
        figure("Over 90 days", money(t.d90_plus), { tone: t.d90_plus ? "late" : "" }),
      ),
      ag.rows.length ? null : h("p.muted.bl-aging-none", "Nothing is owed right now."),
    ],
    footer: clientTable
      ? h(
          "details.bl-aging-clients",
          h("summary", icon("chevron-right", { size: 15, class: "bl-summary-chev" }), `By client (${plural(ag.rows.length, "client")})`),
          clientTable,
        )
      : null,
  });

  // --------------------------------------------------------------- list
  const matchesFor = (f, inv) => {
    if (f === "draft") return inv.status === "draft";
    if (f === "void") return inv.status === "void";
    if (f === "paid") return inv.status === "final" && inv.balance_cents <= 0;
    if (f === "unpaid") return inv.status === "final" && inv.balance_cents > 0;
    return true;
  };
  const visible = () => invoices.filter((i) => matchesFor(filter, i));
  const seg = segmented(
    FILTERS.map(([f, label]) => ({ value: f, label, count: invoices.filter((i) => matchesFor(f, i)).length })),
    filter,
    (f) => {
      filter = f;
      prefs.set("billing.invoices.filter", f);
      table.setRows(visible());
    },
    { label: "Show" },
  );
  seg.classList.add("bl-seg");
  const matterOf = (i) => matters.find((m) => m.id === i.matter_id);
  const table = dataTable({
    columns: [
      {
        key: "number",
        label: "Number",
        className: "nowrap bl-c-num",
        render: (i) => h("a.cell-title", { href: `#/billing/invoices/${i.id}` }, i.number != null ? `No. ${i.number}` : "Draft"),
        sort: (i) => i.number ?? 1e12,
        defaultDir: "desc",
      },
      {
        key: "client_name",
        label: "Client and matter",
        primary: true,
        render: (i) => {
          const m = matterOf(i);
          return h(
            "div.cell-stack",
            h("span.bl-strong", i.client_name),
            h("span.cell-sub", m?.number ? h("span.matter-num", m.number) : null, " ", m?.name ?? i.matter_name),
          );
        },
      },
      {
        key: "issued_on",
        label: "Date",
        className: "nowrap",
        render: (i) => (i.issued_on ? fmtDate(i.issued_on, now) : h("span.muted", "Not issued")),
        defaultDir: "desc",
      },
      {
        key: "due_on",
        label: "Due",
        className: "nowrap",
        render: (i) =>
          i.due_on && i.status === "final" ? h("span" + (invoiceStatus(i).tone === "late" ? ".late-text" : ""), fmtDate(i.due_on, now)) : h("span.muted", "–"),
        sort: (i) => (i.status === "final" ? i.due_on : null),
      },
      {
        key: "total_cents",
        label: "Total",
        align: "right",
        className: "nowrap",
        render: (i) => money(i.total_cents ?? 0),
        sort: (i) => i.total_cents ?? 0,
        defaultDir: "desc",
      },
      {
        key: "balance_cents",
        label: "Amount due",
        align: "right",
        className: "nowrap",
        render: (i) => (i.status === "final" ? h("strong", money(i.balance_cents)) : h("span.muted", "–")),
        sort: (i) => (i.status === "final" ? i.balance_cents : null),
        defaultDir: "desc",
      },
      { key: "status", label: "Status", className: "nowrap", render: (i) => statusTag(i), sort: (i) => invoiceStatus(i).label },
    ],
    rows: visible(),
    rowHref: (i) => `#/billing/invoices/${i.id}`,
    tableClass: "bl-inv-table",
    label: "Invoices",
    noun: ["invoice", "invoices"],
    sort: { key: "number", dir: "desc" },
    prefsKey: "billing.invoices",
    search: {
      placeholder: "Find by client, matter or number",
      text: (i) => [i.client_name, i.matter_name, matterOf(i)?.number, i.number != null ? String(i.number) : "draft"],
    },
    filters: [seg],
    empty: ({ searching }) =>
      emptyState({
        icon: "receipt",
        title: searching ? "No matches" : filter === "unpaid" ? "No invoices are waiting on payment" : "No invoices here",
        body: searching ? "Try a different word." : "Invoices you create from a matter's unbilled time and expenses appear here.",
        compact: true,
      }),
  });

  page.append(h("div.bl-stack", aging, card({ className: "bl-list-card", flush: true, title: "All invoices", icon: "receipt", body: table })));
  return page;
}

/**
 * Start an invoice: pick the matter and (optionally) a date range; everything unbilled in
 * that range goes onto a draft you can then edit.
 */
export async function newInvoiceDialog(opts = {}) {
  const matters = await allMatters();
  const matter = matterSelect(matters, opts.matterId ?? "", { required: true, id: "ni-matter" }, { openOnly: false });
  const from = h("input", { type: "date", id: "ni-from" });
  const to = h("input", { type: "date", value: today(), id: "ni-to" });
  const preview = h("div.bl-preview", { "aria-live": "polite" });
  const err = h("p.error-text", { role: "alert" });
  const submit = button("Create draft", { variant: "primary", type: "submit" });

  async function showPreview() {
    replace(preview);
    if (!matter.value) return;
    try {
      const range = `${from.value ? `&from=${from.value}` : ""}${to.value ? `&to=${to.value}` : ""}`;
      const [w, exps, drafts, mb] = await Promise.all([
        get(`/billing/reports/unbilled?matterId=${matter.value}${range}`),
        get(`/billing/expenses?matterId=${matter.value}&status=unbilled${range}`),
        get(`/billing/invoices?matterId=${matter.value}&status=draft`),
        get(`/billing/matters/${matter.value}`),
      ]);
      const free = exps.filter((x) => x.billable && !x.invoice_id);
      const freeTime = w.rows.reduce((s, r) => s + r.minutes - r.on_draft_minutes, 0);
      replace(
        preview,
        h(
          "ul.bl-preview-list",
          h("li", h("span", "Unbilled time"), h("strong", `${hours(freeTime)} hours`)),
          h("li", h("span", "Unbilled expenses"), h("strong", money(free.reduce((s, x) => s + x.amount_cents, 0)))),
          mb.method === "flat" ? h("li", h("span", "Flat fee"), h("strong", mb.flat_fee_cents != null ? money(mb.flat_fee_cents) : "–")) : null,
        ),
        mb.method === "flat" ? h("p.muted.small", "This is a flat-fee matter: the fee is billed once and time is listed at no charge.") : null,
        mb.method === "contingency" ? h("p.muted.small", "This is a contingency matter: time is listed at no charge and expenses are billed.") : null,
        drafts.length
          ? callout({
              tone: "warning",
              body: h(
                "span",
                "This matter already has a draft invoice. ",
                h("a", { href: `#/billing/invoices/${drafts[0].id}`, onclick: () => dlg.close() }, "Open the draft"),
                " or create another.",
              ),
            })
          : null,
        w.rows.some((r) => r.running_timers) ? h("p.muted.small", "A timer is running on this matter; that entry will be left off until it is stopped.") : null,
      );
    } catch (ex) {
      replace(preview, h("p.error-text", ex.message));
    }
  }
  for (const el of [matter, from, to]) el.addEventListener("change", showPreview);

  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        if (!matter.value) return (err.textContent = "Choose the matter to bill");
        submit.disabled = true;
        try {
          const inv = await post("/billing/invoices", { matterId: Number(matter.value), from: from.value || null, to: to.value || null });
          dlg.close();
          location.hash = `#/billing/invoices/${inv.id}`;
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    field("Matter", matter, { required: true }),
    h("div.form-row.bl-two", field("Work from", from, { optional: true }), field("Through", to)),
    preview,
    err,
    h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), submit),
  );
  const dlg = modal("New invoice", form, {
    subtitle: "Everything unbilled on the matter in this period goes onto a draft. You can change, remove or add lines before you finalize it.",
  });
  if (matter.value) showPreview();
  matter.focus();
  return dlg;
}

export { fail };
