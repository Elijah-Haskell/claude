// Expenses: costs paid for a matter (filing fees, couriers, copies) to pass on to the client.

import { h, replace, toast, modal, fmtDate } from "../dom.js";
import { get, post, patch, del } from "../api.js";
import { today, prefs } from "../state.js";
import { money, moneyInput } from "./format.js";
import { billingPage, allMatters, matterSelect, matterLabel, moneyField, readMoney, confirmDialog, fail } from "./ui.js";
import { card, field, button, iconButton, pill, segmented, emptyState } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { menu } from "../ui/popover.js";
import { icon } from "../ui/icons.js";

export async function expensesView(_m, ctx) {
  const now = today();
  const matters = await allMatters(true);
  let status = prefs.get("billing.expenses.status", "unbilled");
  let matterFilter = "";
  const page = billingPage("#/billing/expenses", "Expenses", "Costs paid on a client's behalf, billed on their next invoice.");

  const matterOf = (id) => matters.find((m) => m.id === id);

  // ------------------------------------------------------------------ add
  const matter = matterSelect(matters, prefs.get("billing.lastMatter", ""), { id: "qe-matter" });
  const date = h("input", { type: "date", value: now, id: "qe-date" });
  const desc = h("input.bl-desc", { maxlength: 4000, placeholder: "e.g. Courier to the county recorder", id: "qe-desc" });
  const amount = moneyField(null, { id: "qe-amount" });
  const billable = h("input", { type: "checkbox", checked: true });
  const note = h("input", { maxlength: 4000, placeholder: "e.g. receipt in the file" });
  const err = h("p.error-text", { role: "alert" });
  const add = card({
    tag: "form",
    className: "bl-quick",
    title: "Add an expense",
    subtitle: "Filing fees, couriers, copies: anything paid on a client's behalf.",
    icon: "plus",
    body: [
      h(
        "div.bl-quick-row.bl-exp-row",
        field("Matter", matter, { className: "bl-q-matter" }),
        field("Date", date, { className: "bl-q-date" }),
        field("Description", desc, { className: "bl-q-desc" }),
        field("Amount", h("span.bl-with-unit.bl-unit-before", h("span.bl-unit", "$"), amount), { className: "bl-q-hours" }),
        field("Receipt note", note, { className: "bl-q-note", optional: true }),
      ),
      err,
    ],
    footer: h(
      "div.bl-quick-foot",
      h("label.check-line", billable, h("span", "Bill to the client")),
      h("div.bl-quick-buttons", button("Add expense", { variant: "primary", type: "submit", icon: "plus" })),
    ),
  });
  add.setAttribute("aria-label", "Add an expense");
  add.addEventListener("submit", async (e) => {
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
  });

  // ----------------------------------------------------------------- list
  const filterMatter = matterSelect(
    matters,
    "",
    { "aria-label": "Show matter", onchange: (e) => ((matterFilter = e.target.value), load()) },
    { blank: "All matters", openOnly: false },
  );
  const seg = segmented(
    [
      { value: "unbilled", label: "Not yet billed" },
      { value: "billed", label: "Billed" },
      { value: "all", label: "All" },
    ],
    status,
    (s) => {
      status = s;
      prefs.set("billing.expenses.status", s);
      load();
    },
    { label: "Show" },
  );
  const statusOf = (x) =>
    x.invoice_status === "final"
      ? pill(`Billed on invoice ${x.invoice_number}`, "success")
      : x.invoice_id
        ? pill("On a draft invoice", "info")
        : x.billable
          ? pill("Not yet billed", "warning")
          : pill("Not billable", "neutral");
  const table = dataTable({
    columns: [
      { key: "date", label: "Date", className: "nowrap", render: (x) => fmtDate(x.date, now), sort: (x) => x.date, defaultDir: "desc" },
      {
        key: "description",
        label: "Expense",
        primary: true,
        sort: (x) => x.description || "",
        render: (x) =>
          h(
            "div.cell-stack",
            h("span.cell-title", x.description || h("span.muted", "No description")),
            h("span.cell-sub", h("a", { href: `#/matters/${x.matter_id}` }, matterLabel(matterOf(x.matter_id) ?? { name: x.matter_name }))),
            x.receipt_note ? h("span.cell-sub.bl-receipt", icon("file-text", { size: 13 }), " ", x.receipt_note) : null,
          ),
      },
      { key: "status", label: "Status", render: statusOf, sort: (x) => (x.invoice_status === "final" ? 2 : x.invoice_id ? 1 : 0) },
      { key: "amount", label: "Amount", align: "right", className: "nowrap bl-money-cell", render: (x) => money(x.amount_cents), sort: (x) => x.amount_cents },
      {
        key: "actions",
        label: "",
        phoneLabel: "",
        className: "bl-row-actions-cell",
        render: (x) =>
          x.invoice_id
            ? h("span.bl-locked", { title: "On an invoice, so it can't be changed here" }, icon("lock", { size: 14 }))
            : iconButton("ellipsis", `More actions for ${x.description || "this expense"}`, {
                size: "sm",
                "aria-haspopup": "menu",
                onclick: (e) =>
                  menu(
                    e.currentTarget,
                    [
                      { label: "Edit", icon: "pencil", onSelect: () => editExpense(x) },
                      "-",
                      { label: "Delete", icon: "trash-2", danger: true, onSelect: () => deleteExpense(x) },
                    ],
                    "Expense",
                  ),
              }),
      },
    ],
    rows: [],
    tableClass: "bl-exp-table",
    label: "Expenses",
    noun: ["expense", "expenses"],
    sort: { key: "date", dir: "desc" },
    search: { placeholder: "Search expenses", text: (x) => [x.description, x.matter_name, x.receipt_note, matterOf(x.matter_id)?.number] },
    filters: [seg, filterMatter],
    empty: ({ searching }) =>
      emptyState({
        icon: "wallet",
        title: searching ? "No matches" : status === "unbilled" ? "No expenses waiting to be billed" : "No expenses",
        body: searching ? "Try a different word." : "Expenses you add above appear here until they go on an invoice.",
        compact: true,
      }),
  });
  const totalBox = h("div.bl-card-total");

  async function load() {
    const rows = await get(`/billing/expenses?status=${status}${matterFilter ? `&matterId=${matterFilter}` : ""}`);
    if (ctx && !ctx.isCurrent()) return;
    table.setRows(rows);
    const sum = rows.filter((x) => x.billable).reduce((s, x) => s + x.amount_cents, 0);
    replace(totalBox, rows.length ? [h("span", "Total billable"), h("strong", money(sum))] : "");
    totalBox.parentElement && (totalBox.parentElement.hidden = !rows.length);
  }

  async function deleteExpense(x) {
    const ok = await confirmDialog("Delete this expense?", [`${money(x.amount_cents)}: ${x.description || "no description"}.`, "This can't be undone."], {
      confirmLabel: "Delete expense",
      danger: true,
    });
    if (!ok) return;
    await del(`/billing/expenses/${x.id}`).then(() => toast("Expense deleted"), fail);
    load();
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
      field("Matter", m, { required: true }),
      h("div.form-row.bl-two", field("Date", d), field("Amount", amt)),
      field("Description", ds),
      field("Receipt note", n, { optional: true }),
      h("label.check-line", b, h("span", "Bill to the client")),
      er,
      h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), button("Save changes", { variant: "primary", type: "submit" })),
    );
    const dlg = modal("Edit expense", form);
  }

  page.append(h("div.bl-stack", add, card({ className: "bl-list-card", flush: true, title: "Expenses", icon: "wallet", body: table, footer: totalBox })));
  await load();
  return page;
}

export { moneyInput };
