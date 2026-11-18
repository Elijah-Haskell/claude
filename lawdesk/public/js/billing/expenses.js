// Expenses: costs paid for a matter (filing fees, couriers, copies) to pass on to the client.

import { h, replace, toast, modal, fmtDate } from "../dom.js";
import { get, post, patch, del } from "../api.js";
import { today, prefs } from "../state.js";
import { money, moneyInput } from "./format.js";
import { billingPage, allMatters, matterSelect, matterLabel, moneyField, readMoney, fail } from "./ui.js";

export async function expensesView(_m, ctx) {
  const now = today();
  const matters = await allMatters(true);
  let status = prefs.get("billing.expenses.status", "unbilled");
  let matterFilter = "";
  const page = billingPage("#/billing/expenses", "Expenses", "Costs paid on a client's behalf, billed on their next invoice.");

  const matterOf = (id) => matters.find((m) => m.id === id);

  // ------------------------------------------------------------------ add
  const matter = matterSelect(matters, prefs.get("billing.lastMatter", ""), { "aria-label": "Matter", id: "qe-matter" });
  const date = h("input", { type: "date", value: now, "aria-label": "Date", id: "qe-date" });
  const desc = h("input.bl-desc", { maxlength: 4000, placeholder: "e.g. Courier to the county recorder", "aria-label": "Description", id: "qe-desc" });
  const amount = moneyField(null, { "aria-label": "Amount", id: "qe-amount" });
  const billable = h("input", { type: "checkbox", checked: true });
  const note = h("input", { maxlength: 4000, placeholder: "Optional, e.g. receipt in the file", "aria-label": "Receipt note" });
  const err = h("p.error-text", { role: "alert" });
  const add = h(
    "form.card.bl-quick",
    {
      "aria-label": "Add an expense",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        try {
          if (!matter.value) throw new Error("Choose the matter this expense is for");
          const costCents = readMoney(amount, "Amount");
          await post("/billing/expenses", {
            matterId: Number(matter.value),
            date: date.value || now,
            description: desc.value,
            costCents,
            billable: billable.checked,
            receiptNote: note.value || null,
          });
          prefs.set("billing.lastMatter", matter.value);
          toast(`Expense of ${money(costCents)} added`);
          desc.value = "";
          amount.value = "";
          note.value = "";
          await load();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h("h2", "Add an expense"),
    h(
      "div.bl-quick-row.bl-exp-row",
      h("label.bl-q-matter", h("span", "Matter"), matter),
      h("label.bl-q-date", h("span", "Date"), date),
      h("label.bl-q-desc", h("span", "Description"), desc),
      h("label.bl-q-hours", h("span", "Amount"), amount),
    ),
    h(
      "div.bl-quick-foot",
      h("label.check-line", billable, " Bill to the client"),
      h("label.bl-inline-note", h("span.muted.small", "Receipt note"), note),
      h("div.bl-quick-buttons", h("button.btn.primary", { type: "submit" }, "Add expense")),
    ),
    err,
  );

  // ----------------------------------------------------------------- list
  const tbody = h("tbody");
  const foot = h("tfoot");
  const filterMatter = matterSelect(
    matters,
    "",
    { "aria-label": "Show matter", onchange: (e) => ((matterFilter = e.target.value), load()) },
    { blank: "All matters", openOnly: false },
  );
  const seg = h(
    "div.segmented",
    { role: "group", "aria-label": "Show" },
    [
      ["unbilled", "Not yet billed"],
      ["billed", "Billed"],
      ["all", "All"],
    ].map(([s, label]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": s === status ? "true" : "false",
          onclick: (e) => {
            status = s;
            prefs.set("billing.expenses.status", s);
            seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false"));
            load();
          },
        },
        label,
      ),
    ),
  );

  async function load() {
    const rows = await get(`/billing/expenses?status=${status}${matterFilter ? `&matterId=${matterFilter}` : ""}`);
    if (ctx && !ctx.isCurrent()) return;
    rows.reverse();
    replace(
      tbody,
      ...(rows.length
        ? rows.map((x) =>
            h(
              "tr",
              h("td.bl-c-date", { "data-label": "Date" }, fmtDate(x.date, now)),
              h(
                "td.bl-c-what",
                h("div", x.description || h("span.muted", "No description")),
                h("a.small", { href: `#/matters/${x.matter_id}` }, matterLabel(matterOf(x.matter_id) ?? { name: x.matter_name })),
                x.receipt_note ? h("div.muted.small", x.receipt_note) : null,
              ),
              h(
                "td.bl-c-status",
                { "data-label": "Status" },
                x.invoice_status === "final"
                  ? `Billed on invoice ${x.invoice_number}`
                  : x.invoice_id
                    ? "On a draft invoice"
                    : x.billable
                      ? "Not yet billed"
                      : "Not billable",
              ),
              h("td.bl-c-money", { "data-label": "Amount" }, money(x.amount_cents)),
              h(
                "td.bl-c-actions",
                x.invoice_id
                  ? null
                  : [
                      h("button.btn.small", { type: "button", onclick: () => editExpense(x) }, "Edit"),
                      h(
                        "button.btn.small.danger-text",
                        {
                          type: "button",
                          onclick: async () => {
                            if (!confirm(`Delete the ${money(x.amount_cents)} expense? This can't be undone.`)) return;
                            await del(`/billing/expenses/${x.id}`).then(() => toast("Expense deleted"), fail);
                            load();
                          },
                        },
                        "Delete",
                      ),
                    ],
              ),
            ),
          )
        : [h("tr", h("td.empty", { colspan: "5" }, status === "unbilled" ? "No expenses waiting to be billed." : "No expenses."))]),
    );
    const sum = rows.filter((x) => x.billable).reduce((s, x) => s + x.amount_cents, 0);
    replace(foot, rows.length ? h("tr", h("td", { colspan: "3" }, "Total billable"), h("td.bl-c-money", money(sum)), h("td")) : "");
  }

  function editExpense(x) {
    const m = matterSelect(matters, x.matter_id, { required: true });
    const d = h("input", { type: "date", value: x.date, required: true });
    const ds = h("input", { value: x.description, maxlength: 4000 });
    const amt = moneyField(x.cost_cents);
    const b = h("input", { type: "checkbox", checked: !!x.billable });
    const n = h("input", { value: x.receipt_note || "", maxlength: 4000 });
    const er = h("p.error-text", { role: "alert" });
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await patch(`/billing/expenses/${x.id}`, {
              matterId: Number(m.value),
              date: d.value,
              description: ds.value,
              costCents: readMoney(amt, "Amount"),
              billable: b.checked,
              receiptNote: n.value || null,
            });
            dlg.close();
            toast("Expense saved");
            load();
          } catch (ex) {
            er.textContent = ex.message;
          }
        },
      },
      h("label", "Matter", m),
      h("div.form-row.bl-two", h("label", "Date", d), h("label", "Amount", amt)),
      h("label", "Description", ds),
      h("label", "Receipt note", n),
      h("label.check-line", b, " Bill to the client"),
      er,
      h(
        "div.form-actions",
        h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"),
        h("button.btn.primary", { type: "submit" }, "Save changes"),
      ),
    );
    const dlg = modal("Edit expense", form);
  }

  page.append(
    add,
    h(
      "section.card.bl-list-card",
      h("div.bl-list-head", h("h2", "Expenses"), h("div.filters", seg, filterMatter)),
      h(
        "table.bl-table.bl-exp-table",
        h("thead", h("tr", h("th", "Date"), h("th", "Description"), h("th", "Status"), h("th.bl-c-money", "Amount"), h("th", h("span.sr-only", "Actions")))),
        tbody,
        foot,
      ),
    ),
  );
  await load();
  return page;
}

export { moneyInput };
