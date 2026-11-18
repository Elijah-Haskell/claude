// Invoices: what clients owe (aging summary), the list of invoices, and starting a new one.

import { h, replace, modal, fmtDate, plural } from "../dom.js";
import { get, post } from "../api.js";
import { today, prefs } from "../state.js";
import { money, hours } from "./format.js";
import { billingPage, allMatters, matterSelect, matterLabel, statusTag, invoiceStatus, figure, fail } from "./ui.js";

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
  let q = "";
  const [invoices, ag, matters] = await Promise.all([get("/billing/invoices"), get("/billing/reports/aging"), allMatters(true)]);
  if (ctx && !ctx.isCurrent()) return h("div");

  const page = billingPage("#/billing/invoices", "Invoices", "What clients owe, and every invoice the firm has issued.", [
    h("a.btn", { href: "#/billing/payments" }, "Record a payment"),
    h("button.btn.primary", { type: "button", id: "new-invoice", onclick: () => newInvoiceDialog() }, "New invoice"),
  ]);

  // ------------------------------------------------------------- aging
  const t = ag.totals;
  const aging = h(
    "section.card.bl-aging",
    { "aria-label": "Amounts owed by age" },
    h("div.bl-aging-head", h("h2", "Owed to the firm"), h("span.muted.small", `As of ${fmtDate(ag.as_of, now)}`)),
    h(
      "div.bl-figures",
      figure("Total owed", money(t.total), { tone: "total" }),
      figure("Not yet due", money(t.current)),
      figure("1–30 days past due", money(t.d1_30), { tone: t.d1_30 ? "warn" : "" }),
      figure("31–60 days", money(t.d31_60), { tone: t.d31_60 ? "late" : "" }),
      figure("61–90 days", money(t.d61_90), { tone: t.d61_90 ? "late" : "" }),
      figure("Over 90 days", money(t.d90_plus), { tone: t.d90_plus ? "late" : "" }),
    ),
    ag.rows.length
      ? h(
          "details.bl-aging-clients",
          h("summary", `By client (${plural(ag.rows.length, "client")})`),
          h(
            "table.bl-table.bl-aging-table",
            h(
              "thead",
              h(
                "tr",
                h("th", "Client"),
                h("th.bl-c-money", "Not yet due"),
                h("th.bl-c-money", "1–30"),
                h("th.bl-c-money", "31–60"),
                h("th.bl-c-money", "61–90"),
                h("th.bl-c-money", "90+"),
                h("th.bl-c-money", "Total"),
              ),
            ),
            h(
              "tbody",
              ag.rows.map((r) =>
                h(
                  "tr",
                  h(
                    "td",
                    h("a", { href: `#/billing/statements/${r.client_id}` }, r.client_name),
                    r.credit_cents ? h("div.muted.small", `${money(r.credit_cents)} credit on account`) : null,
                  ),
                  ["current", "d1_30", "d31_60", "d61_90", "d90_plus"].map((k, i) =>
                    h("td.bl-c-money", { "data-label": ["Not yet due", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"][i] }, r[k] ? money(r[k]) : "–"),
                  ),
                  h("td.bl-c-money.bl-strong", { "data-label": "Total" }, money(r.total)),
                ),
              ),
            ),
          ),
        )
      : h("p.muted", "Nothing is owed right now."),
  );

  // --------------------------------------------------------------- list
  const tbody = h("tbody");
  const count = h("p.result-count.muted");
  const matchesFor = (f, inv) => {
    if (f === "draft") return inv.status === "draft";
    if (f === "void") return inv.status === "void";
    if (f === "paid") return inv.status === "final" && inv.balance_cents <= 0;
    if (f === "unpaid") return inv.status === "final" && inv.balance_cents > 0;
    return true;
  };
  const matches = (inv) => matchesFor(filter, inv);
  function draw() {
    const needle = q.trim().toLowerCase();
    const list = invoices
      .filter(matches)
      .filter(
        (i) => !needle || [i.client_name, i.matter_name, i.number != null ? String(i.number) : "draft"].some((x) => x && x.toLowerCase().includes(needle)),
      )
      .sort((a, b) => (b.number ?? 1e12) - (a.number ?? 1e12) || b.id - a.id);
    count.textContent = plural(list.length, "invoice");
    const open = (i) => (location.hash = `#/billing/invoices/${i.id}`);
    replace(
      tbody,
      ...(list.length
        ? list.map((i) =>
            h(
              "tr.bl-click",
              { tabindex: "0", onclick: (e) => !e.target.closest("a") && open(i), onkeydown: (e) => e.key === "Enter" && open(i) },
              h("td.bl-c-num", h("a", { href: `#/billing/invoices/${i.id}` }, i.number != null ? `No. ${i.number}` : "Draft")),
              h(
                "td.bl-c-what",
                h("div.bl-strong", i.client_name),
                h("div.muted.small", matterLabel(matters.find((m) => m.id === i.matter_id) ?? { name: i.matter_name })),
              ),
              h("td.bl-c-date", { "data-label": "Date" }, i.issued_on ? fmtDate(i.issued_on, now) : h("span.muted", "Not issued")),
              h(
                "td.bl-c-date",
                { "data-label": "Due" },
                i.due_on && i.status === "final" ? h("span" + (invoiceStatus(i).tone === "late" ? ".late-text" : ""), fmtDate(i.due_on, now)) : "–",
              ),
              h("td.bl-c-money", { "data-label": "Total" }, money(i.total_cents ?? 0)),
              h("td.bl-c-money.bl-strong", { "data-label": "Amount due" }, i.status === "final" ? money(i.balance_cents) : "–"),
              h("td.bl-c-status", statusTag(i)),
            ),
          )
        : [h("tr", h("td.empty", { colspan: "7" }, filter === "unpaid" ? "No invoices are waiting on payment." : "No invoices here."))]),
    );
  }
  const seg = h(
    "div.segmented.bl-seg",
    { role: "group", "aria-label": "Show" },
    FILTERS.map(([f, label]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": f === filter ? "true" : "false",
          onclick: (e) => {
            filter = f;
            prefs.set("billing.invoices.filter", f);
            seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false"));
            draw();
          },
        },
        label,
        h("span.bl-seg-n", String(invoices.filter((i) => matchesFor(f, i)).length)),
      ),
    ),
  );
  const search = h("input.search", {
    type: "search",
    placeholder: "Find by client, matter or number",
    "aria-label": "Find an invoice",
    oninput: (e) => ((q = e.target.value), draw()),
  });

  page.append(
    aging,
    h(
      "section.card.bl-list-card",
      h("div.bl-list-head", h("h2", "All invoices"), h("div.filters", seg, search)),
      count,
      h(
        "table.bl-table.bl-inv-table",
        h(
          "thead",
          h(
            "tr",
            h("th", "Number"),
            h("th", "Client and matter"),
            h("th", "Date"),
            h("th", "Due"),
            h("th.bl-c-money", "Total"),
            h("th.bl-c-money", "Amount due"),
            h("th", "Status"),
          ),
        ),
        tbody,
      ),
    ),
  );
  draw();
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
  const submit = h("button.btn.primary", { type: "submit" }, "Create draft");

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
          ? h(
              "p.bl-note",
              "This matter already has a draft invoice. ",
              h("a", { href: `#/billing/invoices/${drafts[0].id}`, onclick: () => dlg.close() }, "Open the draft"),
              " or create another.",
            )
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
    h("p.muted", "Everything unbilled on the matter in this period goes onto a draft. You can change, remove or add lines before you finalize it."),
    h("label", "Matter", matter),
    h("div.form-row.bl-two", h("label", "Work from (optional)", from), h("label", "Through", to)),
    preview,
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), submit),
  );
  const dlg = modal("New invoice", form);
  if (matter.value) showPreview();
  matter.focus();
  return dlg;
}

export { fail };
