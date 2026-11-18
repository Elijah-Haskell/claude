// Client statement: every invoice, payment, void and write-off for one client with a
// running amount due, for a period. Printable from the browser.

import { h, select, fmtDate } from "../dom.js";
import { get } from "../api.js";
import { state, today, loadSetup } from "../state.js";
import { money } from "./format.js";
import { billingPage, statusTag } from "./ui.js";

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
    [clientId ? h("button.btn", { type: "button", id: "st-print", onclick: () => window.print() }, "Print or save as PDF") : null].filter(Boolean),
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
    { "aria-label": "Client", id: "st-client" },
  );
  const from = h("input", { type: "date", value: qs.get("from") ?? "", "aria-label": "From" });
  const to = h("input", { type: "date", value: qs.get("to") ?? now, "aria-label": "Through" });
  const go = () => {
    if (!client.value) return;
    const q = new URLSearchParams();
    if (from.value) q.set("from", from.value);
    if (to.value && to.value !== now) q.set("to", to.value);
    location.hash = `#/billing/statements/${client.value}${q.toString() ? "?" + q : ""}`;
  };
  for (const el of [client, from, to]) el.addEventListener("change", go);
  page.append(
    h(
      "div.card.bl-st-pick.bl-noprint",
      h("label.bl-field", h("span", "Client"), client),
      h("label.bl-field", h("span", "From (optional)"), from),
      h("label.bl-field", h("span", "Through"), to),
    ),
  );
  if (!clientId) {
    page.append(h("p.empty-big", h("span", "Choose a client to see their statement.")));
    return page;
  }

  const range = new URLSearchParams();
  if (from.value) range.set("from", from.value);
  if (to.value) range.set("to", to.value);
  const st = await get(`/billing/clients/${clientId}/statement?${range}`);
  if (ctx && !ctx.isCurrent()) return page;
  const settings = await get("/billing/settings");

  const rows = [];
  if (st.from)
    rows.push(
      h(
        "tr.bl-st-open",
        h("td", fmtDate(st.from, now)),
        h("td", "Amount due at the start of the period"),
        h("td"),
        h("td"),
        h("td.bl-c-money", money(st.opening_balance_cents)),
      ),
    );
  for (const l of st.lines) {
    const charge = l.amount_cents > 0 ? money(l.amount_cents) : "";
    const credit = l.amount_cents < 0 ? money(-l.amount_cents) : "";
    const label = l.invoice_id ? h("a", { href: `#/billing/invoices/${l.invoice_id}` }, l.description) : l.description;
    rows.push(
      h(
        "tr",
        h("td.bl-c-date", fmtDate(l.date, now)),
        h("td", label),
        h("td.bl-c-money", { "data-label": "Charges" }, charge),
        h("td.bl-c-money", { "data-label": "Payments and credits" }, credit),
        h("td.bl-c-money.bl-strong", { "data-label": "Amount due" }, money(l.balance_cents)),
      ),
    );
  }
  const closing = st.closing_balance_cents;
  page.append(
    h(
      "section.card.bl-statement",
      h(
        "header.bl-st-head",
        h("div", h("div.bl-st-firm", settings.firm_name || ""), h("div.muted.small.pre", settings.firm_address || "")),
        h(
          "div.bl-st-meta",
          h("h2", "Statement of account"),
          h("div", st.client.name),
          h("div.muted.small", st.from ? `${fmtDate(st.from, now)} to ${fmtDate(st.to, now)}` : `Through ${fmtDate(st.to, now)}`),
        ),
      ),
      rows.length
        ? h(
            "table.bl-table.bl-st-table",
            h(
              "thead",
              h(
                "tr",
                h("th", "Date"),
                h("th", "Description"),
                h("th.bl-c-money", "Charges"),
                h("th.bl-c-money", "Payments and credits"),
                h("th.bl-c-money", "Amount due"),
              ),
            ),
            h("tbody", rows),
          )
        : h("p.muted", "Nothing in this period."),
      h(
        "div.bl-st-close",
        h("div.bl-total-row.grand", h("span", closing < 0 ? "Credit on account" : "Amount due"), h("span", money(Math.abs(closing)))),
        st.credit_cents && closing >= 0 ? h("p.muted.small", `Includes ${money(st.credit_cents)} of credit not yet applied to an invoice.`) : null,
      ),
      st.open_invoices.length
        ? h(
            "div.bl-st-openinv",
            h("h3", "Invoices with an amount due"),
            h(
              "table.bl-table",
              h("thead", h("tr", h("th", "Invoice"), h("th", "Date"), h("th", "Due"), h("th.bl-c-money", "Amount due"), h("th.bl-noprint", "Status"))),
              h(
                "tbody",
                st.open_invoices.map((i) => {
                  const full = invoices.find((x) => x.id === i.id) ?? { ...i, status: "final", balance_cents: i.balance_cents };
                  return h(
                    "tr",
                    h("td", h("a", { href: `#/billing/invoices/${i.id}` }, `No. ${i.number}`)),
                    h("td", { "data-label": "Date" }, fmtDate(i.issued_on, now)),
                    h("td", { "data-label": "Due" }, h("span" + (i.due_on < now ? ".late-text" : ""), fmtDate(i.due_on, now))),
                    h("td.bl-c-money", { "data-label": "Amount due" }, money(i.balance_cents)),
                    h("td.bl-noprint", statusTag(full)),
                  );
                }),
              ),
            ),
          )
        : null,
      h("p.bl-noprint", h("a.btn.small", { href: `#/billing/payments?client=${clientId}` }, "Record a payment from this client")),
    ),
  );
  return page;
}
