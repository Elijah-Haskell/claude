// Client statement: every invoice, payment, void and write-off for one client with a
// running amount due, for a period. Printable from the browser.

import { h, select, fmtDate } from "../dom.js";
import { get } from "../api.js";
import { state, today, loadSetup } from "../state.js";
import { money } from "./format.js";
import { billingPage, statusTag } from "./ui.js";
import { card, field, button, emptyState } from "../ui/components.js";
import { dataTable } from "../ui/table.js";

function hashQuery() {
  const i = location.hash.indexOf("?");
  return new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : "");
}

export async function statementView([clientId], ctx) {
  const now = today();
  if (!state.setup.contacts.length) await loadSetup();
  const qs = hashQuery();
  const page = billingPage(
    "#/billing/statements",
    "Client statement",
    "A client's invoices and payments, with the running amount due.",
    [clientId ? button("Print or save as PDF", { id: "st-print", icon: "file-text", onclick: () => window.print() }) : null].filter(Boolean),
  );

  const invoices = await get("/billing/invoices");
  const billed = new Set(invoices.filter((i) => i.status !== "draft").map((i) => i.client_id));
  const contacts = state.setup.contacts;
  const client = select(
    [
      { value: "", label: "Choose a client…" },
      ...contacts.filter((c) => billed.has(c.id)).map((c) => ({ value: c.id, label: c.name, group: "Clients with invoices" })),
      ...contacts.filter((c) => !billed.has(c.id)).map((c) => ({ value: c.id, label: c.name, group: "Other clients" })),
    ],
    clientId ?? "",
    { id: "st-client" },
  );
  const from = h("input", { type: "date", value: qs.get("from") ?? "" });
  const to = h("input", { type: "date", value: qs.get("to") ?? now });
  const go = () => {
    if (!client.value) return;
    const q = new URLSearchParams();
    if (from.value) q.set("from", from.value);
    if (to.value && to.value !== now) q.set("to", to.value);
    location.hash = `#/billing/statements/${client.value}${q.toString() ? "?" + q : ""}`;
  };
  for (const el of [client, from, to]) el.addEventListener("change", go);
  const stack = h("div.bl-stack");
  page.append(stack);
  stack.append(
    card({
      className: "bl-st-pick-card bl-noprint",
      body: h("div.bl-st-pick", field("Client", client), field("From", from, { optional: true }), field("Through", to)),
    }),
  );
  if (!clientId) {
    stack.append(
      card({
        body: emptyState({
          icon: "file-text",
          title: "Choose a client to see their statement",
          body: "A statement lists every invoice, payment and credit for the period, with the running amount due. Print it or save it as a PDF to send.",
        }),
      }),
    );
    return page;
  }

  const range = new URLSearchParams();
  if (from.value) range.set("from", from.value);
  if (to.value) range.set("to", to.value);
  const st = await get(`/billing/clients/${clientId}/statement?${range}`);
  if (ctx && !ctx.isCurrent()) return page;
  const settings = await get("/billing/settings");

  const lines = [];
  if (st.from)
    lines.push({ key: "open", date: st.from, description: "Amount due at the start of the period", balance_cents: st.opening_balance_cents, opening: true });
  st.lines.forEach((l, i) => lines.push({ key: i, ...l }));
  const closing = st.closing_balance_cents;
  const table = dataTable({
    columns: [
      { key: "date", label: "Date", className: "nowrap", render: (l) => fmtDate(l.date, now) },
      {
        key: "description",
        label: "Description",
        primary: true,
        render: (l) =>
          l.invoice_id ? h("a", { href: `#/billing/invoices/${l.invoice_id}` }, l.description) : l.opening ? h("em", l.description) : l.description,
      },
      { key: "charge", label: "Charges", align: "right", className: "nowrap", render: (l) => (l.amount_cents > 0 ? money(l.amount_cents) : "") },
      { key: "credit", label: "Payments and credits", align: "right", className: "nowrap", render: (l) => (l.amount_cents < 0 ? money(-l.amount_cents) : "") },
      { key: "balance_cents", label: "Amount due", align: "right", className: "nowrap", render: (l) => h("strong", money(l.balance_cents)) },
    ],
    rows: lines,
    rowKey: (l) => l.key,
    rowClass: (l) => (l.opening ? "bl-st-open" : ""),
    toolbar: false,
    sortable: false,
    pageSize: 10000,
    tableClass: "bl-st-table",
    label: "Statement lines",
    empty: emptyState({
      icon: "file-text",
      title: "Nothing in this period",
      body: "Pick an earlier start date to see older invoices and payments.",
      compact: true,
    }),
  });

  const openTable = st.open_invoices.length
    ? dataTable({
        columns: [
          { key: "number", label: "Invoice", className: "nowrap", render: (i) => h("a", { href: `#/billing/invoices/${i.id}` }, `No. ${i.number}`) },
          { key: "issued_on", label: "Date", className: "nowrap", render: (i) => fmtDate(i.issued_on, now) },
          { key: "due_on", label: "Due", className: "nowrap", render: (i) => h("span" + (i.due_on < now ? ".late-text" : ""), fmtDate(i.due_on, now)) },
          { key: "balance_cents", label: "Amount due", align: "right", className: "nowrap", render: (i) => money(i.balance_cents) },
          {
            key: "status",
            label: "Status",
            className: "bl-noprint",
            render: (i) => statusTag(invoices.find((x) => x.id === i.id) ?? { ...i, status: "final", balance_cents: i.balance_cents }),
          },
        ],
        rows: st.open_invoices,
        toolbar: false,
        sortable: false,
        pageSize: 10000,
        tableClass: "bl-st-open-table",
        label: "Invoices with an amount due",
      })
    : null;

  stack.append(
    h(
      "section.card.card-v2.bl-statement",
      h(
        "header.bl-st-head",
        h("div.bl-st-from", h("div.bl-st-firm", settings.firm_name || ""), h("div.bl-st-addr.pre", settings.firm_address || "")),
        h(
          "div.bl-st-meta",
          h("h2", "Statement of account"),
          h("div.bl-st-client", st.client.name),
          h("div.bl-st-period", st.from ? `${fmtDate(st.from, now)} to ${fmtDate(st.to, now)}` : `Through ${fmtDate(st.to, now)}`),
        ),
      ),
      table,
      h(
        "div.bl-st-close",
        h("div.bl-total-row.grand", h("span", closing < 0 ? "Credit on account" : "Amount due"), h("span", money(Math.abs(closing)))),
        st.credit_cents && closing >= 0 ? h("p.bl-card-note", `Includes ${money(st.credit_cents)} of credit not yet applied to an invoice.`) : null,
      ),
      openTable ? h("div.bl-st-openinv", h("h3", "Invoices with an amount due"), openTable) : null,
      h(
        "footer.card-footer.bl-noprint",
        button("Record a payment from this client", { size: "sm", icon: "plus", href: `#/billing/payments?client=${clientId}` }),
      ),
    ),
  );
  return page;
}
