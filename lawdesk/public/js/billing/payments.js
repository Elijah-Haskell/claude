// Payments: record money received from a client and spread it over their open invoices.
// Whatever isn't applied stays as the client's credit. Also lists payments received.

import { h, replace, toast, select, fmtDate } from "../dom.js";
import { get, post } from "../api.js";
import { state, today, loadSetup } from "../state.js";
import { money, moneyInput, parseMoney, autoApply } from "./format.js";
import { billingPage, moneyField, readMoney, confirmDialog, fail } from "./ui.js";
import { PAY_METHODS } from "./invoice.js";

function hashQuery() {
  const i = location.hash.indexOf("?");
  return new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : "");
}

export async function paymentsView(_m, ctx) {
  const now = today();
  if (!state.setup.contacts.length) await loadSetup();
  const qs = hashQuery();
  const [invoices, payments] = await Promise.all([get("/billing/invoices?status=final"), get("/billing/payments")]);
  if (ctx && !ctx.isCurrent()) return h("div");
  const page = billingPage("#/billing/payments", "Payments", "Record money received and apply it to a client's invoices.");

  const owing = new Set(invoices.filter((i) => i.balance_cents > 0).map((i) => i.client_id));
  const contacts = state.setup.contacts;
  const preClient = qs.get("client") ?? (qs.get("invoice") ? invoices.find((i) => String(i.id) === qs.get("invoice"))?.client_id : "") ?? "";
  const client = select(
    [
      { value: "", label: "Choose a client…" },
      ...contacts.filter((c) => owing.has(c.id)).map((c) => ({ value: c.id, label: c.name, group: "Clients with amounts due" })),
      ...contacts.filter((c) => !owing.has(c.id)).map((c) => ({ value: c.id, label: c.name, group: "Other clients" })),
    ],
    preClient,
    { id: "pay-client", required: true, "aria-label": "Client" },
  );
  const amount = moneyField(null, { id: "pay-total", "aria-label": "Amount received" });
  const date = h("input", { type: "date", value: now, "aria-label": "Date received" });
  const method = select(
    PAY_METHODS.map((m) => ({ value: m, label: m })),
    "Check",
    { "aria-label": "How it was paid" },
  );
  const ref = h("input", { maxlength: 200, placeholder: "e.g. check 4417", "aria-label": "Reference" });
  const note = h("input", { maxlength: 4000, placeholder: "Optional", "aria-label": "Note" });
  const openBox = h("div.bl-apply");
  const summary = h("div.bl-apply-summary", { "aria-live": "polite" });
  const err = h("p.error-text", { role: "alert" });
  let inputs = []; // [{inv, input}]

  const totalCents = () => parseMoney(amount.value) ?? 0;
  function drawSummary() {
    const applied = inputs.reduce((s, x) => s + (parseMoney(x.input.value) ?? 0), 0);
    const left = totalCents() - applied;
    replace(
      summary,
      h("div.bl-total-row", h("span", "Received"), h("span", money(totalCents()))),
      h("div.bl-total-row", h("span", "Applied to invoices"), h("span", money(applied))),
      h(
        "div.bl-total-row.grand" + (left < 0 ? ".bad" : ""),
        h("span", left < 0 ? "Applied is more than received" : "Kept as client credit"),
        h("span", money(Math.abs(left))),
      ),
    );
  }

  async function drawOpen() {
    inputs = [];
    if (!client.value) {
      replace(openBox, h("p.muted", "Choose a client to see what they owe."));
      return drawSummary();
    }
    const cid = Number(client.value);
    const [open, cr] = await Promise.all([get(`/billing/invoices?clientId=${cid}&status=final`), get(`/billing/clients/${cid}/credit`)]);
    const list = open.filter((i) => i.balance_cents > 0).sort((a, b) => (a.due_on < b.due_on ? -1 : a.due_on > b.due_on ? 1 : a.number - b.number));
    const pre = qs.get("invoice");
    replace(
      openBox,
      cr.credit_cents
        ? h("p.bl-note", `This client already has ${money(cr.credit_cents)} of credit on account. You can apply it from an invoice's page.`)
        : null,
      list.length
        ? h(
            "table.bl-table.bl-apply-table",
            h("thead", h("tr", h("th", "Invoice"), h("th", "Due"), h("th.bl-c-money", "Amount due"), h("th.bl-c-money", "Apply"))),
            h(
              "tbody",
              list.map((inv) => {
                const input = moneyField(String(inv.id) === pre ? inv.balance_cents : null, {
                  "aria-label": `Apply to invoice ${inv.number}`,
                  oninput: drawSummary,
                  dataset: { invoice: inv.id },
                });
                inputs.push({ inv, input });
                return h(
                  "tr",
                  h("td", h("a", { href: `#/billing/invoices/${inv.id}` }, `No. ${inv.number}`), h("div.muted.small", inv.matter_name)),
                  h("td", { "data-label": "Due" }, h("span" + (inv.due_on < now ? ".late-text" : ""), fmtDate(inv.due_on, now))),
                  h("td.bl-c-money", { "data-label": "Amount due" }, money(inv.balance_cents)),
                  h("td.bl-c-money.bl-c-apply", input),
                );
              }),
            ),
          )
        : h("p.muted", "This client has no invoices waiting on payment. A payment recorded now is kept as credit."),
      list.length
        ? h(
            "button.btn.small",
            {
              type: "button",
              id: "pay-auto",
              onclick: () => {
                const r = autoApply(
                  totalCents(),
                  inputs.map((x) => x.inv),
                );
                for (const x of inputs) x.input.value = r.allocations[x.inv.id] ? moneyInput(r.allocations[x.inv.id]) : "";
                drawSummary();
              },
            },
            "Apply to the oldest first",
          )
        : null,
    );
    if (pre && !amount.value) {
      const p = list.find((i) => String(i.id) === pre);
      if (p) amount.value = moneyInput(p.balance_cents);
    }
    drawSummary();
  }
  client.addEventListener("change", drawOpen);
  amount.addEventListener("input", drawSummary);

  const form = h(
    "form.card.bl-pay-form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        try {
          if (!client.value) throw new Error("Choose the client who paid");
          const cents = readMoney(amount, "Amount received");
          if (cents <= 0) throw new Error("Amount received: type the amount");
          const allocations = [];
          for (const x of inputs) {
            const v = x.input.value.trim() ? readMoney(x.input, `Invoice ${x.inv.number}`) : 0;
            if (v > x.inv.balance_cents) throw new Error(`Invoice ${x.inv.number}: only ${money(x.inv.balance_cents)} is due`);
            if (v > 0) allocations.push({ invoiceId: x.inv.id, amountCents: v });
          }
          const applied = allocations.reduce((s, a) => s + a.amountCents, 0);
          if (applied > cents) throw new Error("More is applied to invoices than was received");
          const clientName = contacts.find((c) => c.id === Number(client.value))?.name ?? "the client";
          const ok = await confirmDialog(
            "Record this payment?",
            [
              h(
                "dl.bl-confirm-facts",
                h("dt", "From"),
                h("dd", clientName),
                h("dt", "Received"),
                h("dd", `${money(cents)} on ${fmtDate(date.value || now, now)}`),
                ...allocations.flatMap((a) => [h("dt", `Invoice ${inputs.find((x) => x.inv.id === a.invoiceId).inv.number}`), h("dd", money(a.amountCents))]),
                cents - applied ? [h("dt", "Kept as credit"), h("dd", money(cents - applied))] : null,
              ),
            ],
            { confirmLabel: "Record payment" },
          );
          if (!ok) return;
          await post("/billing/payments", {
            clientId: Number(client.value),
            amountCents: cents,
            receivedOn: date.value || now,
            method: method.value,
            reference: ref.value || null,
            note: note.value || null,
            allocations,
          });
          toast(`Payment of ${money(cents)} recorded`);
          history.replaceState(null, "", "#/billing/payments");
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h("h2", "Record a payment"),
    h(
      "div.bl-pay-grid",
      h("label.bl-field", h("span", "Client"), client),
      h("label.bl-field", h("span", "Amount received"), amount),
      h("label.bl-field", h("span", "Date received"), date),
      h("label.bl-field", h("span", "How it was paid"), method),
      h("label.bl-field", h("span", "Reference"), ref),
      h("label.bl-field", h("span", "Note"), note),
    ),
    h("h3.bl-sub", "Apply to invoices"),
    openBox,
    summary,
    err,
    h("div.form-actions", h("button.btn.primary", { type: "submit", id: "pay-submit" }, "Record payment")),
  );

  // ------------------------------------------------------------ recent list
  const byName = (id) => contacts.find((c) => c.id === id)?.name ?? "";
  const numberOf = (invoiceId) => invoices.find((i) => i.id === invoiceId)?.number;
  const recent = payments.slice().reverse();
  const list = h(
    "section.card.bl-list-card",
    h("h2", "Payments received"),
    recent.length
      ? h(
          "table.bl-table.bl-paid-table",
          h("thead", h("tr", h("th", "Date"), h("th", "From"), h("th", "Applied to"), h("th.bl-c-money", "Amount"), h("th", h("span.sr-only", "Actions")))),
          h(
            "tbody",
            recent.map((p) => {
              const live = p.allocations.filter((a) => !a.released_on);
              return h(
                "tr" + (p.voided_on ? ".bl-voided" : ""),
                h("td.bl-c-date", fmtDate(p.received_on, now)),
                h(
                  "td",
                  h("a", { href: `#/billing/statements/${p.client_id}` }, byName(p.client_id)),
                  h("div.muted.small", [p.method, p.reference].filter(Boolean).join(" · ")),
                ),
                h(
                  "td",
                  { "data-label": "Applied to" },
                  p.voided_on
                    ? h("span", `Voided ${fmtDate(p.voided_on, now)}: ${p.void_reason}`)
                    : [
                        live.map((a, i) => [
                          i ? ", " : "",
                          h("a", { href: `#/billing/invoices/${a.invoice_id}` }, `No. ${numberOf(a.invoice_id) ?? "?"}`),
                          ` ${money(a.amount_cents)}`,
                        ]),
                        p.unapplied_cents ? h("div.muted.small", `${money(p.unapplied_cents)} kept as credit`) : null,
                      ],
                ),
                h("td.bl-c-money", { "data-label": "Amount" }, money(p.amount_cents)),
                h(
                  "td.bl-c-actions",
                  p.voided_on
                    ? null
                    : h(
                        "button.btn.small.danger-text",
                        {
                          type: "button",
                          onclick: async () => {
                            const reason = await confirmDialog(
                              "Void this payment?",
                              [
                                `Use this for a returned check or a payment entered by mistake. The ${money(p.amount_cents)} is taken off the invoices it paid, so they are owed again.`,
                                "This can't be undone.",
                              ],
                              { confirmLabel: "Void payment", danger: true, reasonLabel: "Reason" },
                            );
                            if (!reason) return;
                            try {
                              await post(`/billing/payments/${p.id}/void`, { reason });
                              toast("Payment voided");
                              window.dispatchEvent(new HashChangeEvent("hashchange"));
                            } catch (ex) {
                              fail(ex);
                            }
                          },
                        },
                        "Void",
                      ),
                ),
              );
            }),
          ),
        )
      : h("p.muted", "No payments recorded yet."),
  );

  page.append(form, list);
  await drawOpen();
  return page;
}
