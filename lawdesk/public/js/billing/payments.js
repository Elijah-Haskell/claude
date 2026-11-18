// Payments: record money received from a client and spread it over their open invoices.
// Whatever isn't applied stays as the client's credit. Also lists payments received.

import { h, replace, toast, select, fmtDate } from "../dom.js";
import { get, post } from "../api.js";
import { state, today, loadSetup } from "../state.js";
import { money, moneyInput, parseMoney, autoApply } from "./format.js";
import { billingPage, moneyField, readMoney, confirmDialog, fail } from "./ui.js";
import { card, field, button, iconButton, pill, callout, emptyState } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { menu } from "../ui/popover.js";
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
    { id: "pay-client", required: true },
  );
  const amount = moneyField(null, { id: "pay-total" });
  const date = h("input", { type: "date", value: now });
  const method = select(
    PAY_METHODS.map((m) => ({ value: m, label: m })),
    "Check",
  );
  const ref = h("input", { maxlength: 200, placeholder: "e.g. check 4417" });
  const note = h("input", { maxlength: 4000 });
  const openBox = h("div.bl-apply");
  const applyActions = h("div.bl-apply-actions");
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
      replace(
        openBox,
        emptyState({ icon: "users", title: "Choose a client", body: "Their invoices with an amount due appear here, oldest first.", compact: true }),
      );
      return drawSummary();
    }
    const cid = Number(client.value);
    const [open, cr] = await Promise.all([get(`/billing/invoices?clientId=${cid}&status=final`), get(`/billing/clients/${cid}/credit`)]);
    const list = open.filter((i) => i.balance_cents > 0).sort((a, b) => (a.due_on < b.due_on ? -1 : a.due_on > b.due_on ? 1 : a.number - b.number));
    const pre = qs.get("invoice");
    const autoBtn = list.length
      ? button("Apply to the oldest first", {
          size: "sm",
          id: "pay-auto",
          onclick: () => {
            const r = autoApply(
              totalCents(),
              inputs.map((x) => x.inv),
            );
            for (const x of inputs) x.input.value = r.allocations[x.inv.id] ? moneyInput(r.allocations[x.inv.id]) : "";
            drawSummary();
          },
        })
      : null;
    const applyInput = (inv) => {
      const input = moneyField(String(inv.id) === pre ? inv.balance_cents : null, {
        "aria-label": `Apply to invoice ${inv.number}`,
        oninput: drawSummary,
        dataset: { invoice: inv.id },
      });
      inputs.push({ inv, input });
      return input;
    };
    replace(
      openBox,
      cr.credit_cents
        ? callout({ tone: "info", body: `This client already has ${money(cr.credit_cents)} of credit on account. You can apply it from an invoice's page.` })
        : null,
      list.length
        ? dataTable({
            columns: [
              {
                key: "number",
                label: "Invoice",
                primary: true,
                render: (inv) =>
                  h("div.cell-stack", h("a.cell-title", { href: `#/billing/invoices/${inv.id}` }, `No. ${inv.number}`), h("span.cell-sub", inv.matter_name)),
              },
              {
                key: "due_on",
                label: "Due",
                className: "nowrap",
                render: (inv) => h("span" + (inv.due_on < now ? ".late-text" : ""), fmtDate(inv.due_on, now)),
              },
              { key: "balance_cents", label: "Amount due", align: "right", className: "nowrap", render: (inv) => money(inv.balance_cents) },
              { key: "apply", label: "Apply", align: "right", className: "bl-c-apply", render: applyInput },
            ],
            rows: list,
            toolbar: false,
            sortable: false,
            tableClass: "bl-apply-table",
            label: "Invoices with an amount due",
          })
        : emptyState({
            icon: "receipt",
            title: "Nothing is owed",
            body: "This client has no invoices waiting on payment. A payment recorded now is kept as credit.",
            compact: true,
          }),
    );
    replace(applyActions, autoBtn);
    if (pre && !amount.value) {
      const p = list.find((i) => String(i.id) === pre);
      if (p) amount.value = moneyInput(p.balance_cents);
    }
    drawSummary();
  }
  client.addEventListener("change", drawOpen);
  amount.addEventListener("input", drawSummary);

  const form = card({
    tag: "form",
    className: "bl-pay-form",
    title: "Record a payment",
    subtitle: "Money received from a client, spread over their open invoices. Anything not applied is kept as credit.",
    icon: "landmark",
    body: [
      h(
        "div.bl-pay-grid",
        field("Client", client, { required: true, className: "bl-pay-client" }),
        field("Amount received", h("span.bl-with-unit.bl-unit-before", h("span.bl-unit", "$"), amount), { required: true }),
        field("Date received", date),
        field("How it was paid", method),
        field("Reference", ref, { optional: true }),
        field("Note", note, { optional: true }),
      ),
      h("div.bl-sub-head", h("h3.bl-sub", "Apply to invoices"), applyActions),
      openBox,
      summary,
      err,
    ],
    footer: h("div.bl-form-foot", button("Record payment", { variant: "primary", type: "submit", id: "pay-submit", icon: "check" })),
  });
  form.addEventListener("submit", async (e) => {
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
  });

  // ------------------------------------------------------------ recent list
  const byName = (id) => contacts.find((c) => c.id === id)?.name ?? "";
  const numberOf = (invoiceId) => invoices.find((i) => i.id === invoiceId)?.number;
  const recent = payments.slice().reverse();
  const voidPayment = async (p) => {
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
  };
  const table = dataTable({
    columns: [
      { key: "received_on", label: "Date", className: "nowrap", render: (p) => fmtDate(p.received_on, now), defaultDir: "desc" },
      {
        key: "client",
        label: "From",
        primary: true,
        sort: (p) => byName(p.client_id),
        render: (p) =>
          h(
            "div.cell-stack",
            h("a.cell-title", { href: `#/billing/statements/${p.client_id}` }, byName(p.client_id)),
            h("span.cell-sub", [p.method, p.reference].filter(Boolean).join(" · ")),
          ),
      },
      {
        key: "applied",
        label: "Applied to",
        sortable: false,
        render: (p) => {
          if (p.voided_on) return h("div.cell-stack", pill("Void", "neutral"), h("span.cell-sub", `${fmtDate(p.voided_on, now)}: ${p.void_reason}`));
          const live = p.allocations.filter((a) => !a.released_on);
          return h(
            "div.cell-stack",
            live.length
              ? h(
                  "span",
                  live.map((a, i) => [
                    i ? ", " : "",
                    h("a", { href: `#/billing/invoices/${a.invoice_id}` }, `No. ${numberOf(a.invoice_id) ?? "?"}`),
                    ` ${money(a.amount_cents)}`,
                  ]),
                )
              : null,
            p.unapplied_cents ? h("span.cell-sub", `${money(p.unapplied_cents)} kept as credit`) : null,
          );
        },
      },
      {
        key: "amount_cents",
        label: "Amount",
        align: "right",
        className: "nowrap",
        render: (p) => h(p.voided_on ? "s.muted" : "strong", money(p.amount_cents)),
        defaultDir: "desc",
      },
      {
        key: "actions",
        label: "",
        phoneLabel: "",
        className: "bl-row-actions-cell",
        render: (p) =>
          p.voided_on
            ? null
            : iconButton("ellipsis", "More actions for this payment", {
                size: "sm",
                "aria-haspopup": "menu",
                onclick: (e) =>
                  menu(e.currentTarget, [{ label: "Void payment", icon: "circle-alert", danger: true, onSelect: () => voidPayment(p) }], "Payment"),
              }),
      },
    ],
    rows: recent,
    tableClass: "bl-paid-table",
    label: "Payments received",
    noun: ["payment", "payments"],
    rowClass: (p) => (p.voided_on ? "bl-voided" : ""),
    search: {
      placeholder: "Search payments",
      text: (p) => [byName(p.client_id), p.method, p.reference, ...p.allocations.map((a) => String(numberOf(a.invoice_id) ?? ""))],
    },
    empty: ({ searching }) =>
      emptyState({
        icon: "landmark",
        title: searching ? "No matches" : "No payments recorded yet",
        body: searching ? "Try a different word." : "Payments you record, and online payments from clients, appear here.",
        compact: true,
      }),
  });
  const list = card({ className: "bl-list-card", flush: true, title: "Payments received", icon: "wallet", body: table });

  page.append(h("div.bl-stack", form, list));
  await drawOpen();
  return page;
}
