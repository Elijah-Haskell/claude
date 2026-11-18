// The compact Billing card on the matter page: what is unbilled, what is owed, the last
// invoice, and buttons to start an invoice or log time.

import { h, replace, fmtDate } from "../dom.js";
import { get } from "../api.js";
import { today } from "../state.js";
import { money, hours } from "./format.js";
import { logTimeDialog } from "./ui.js";
import { newInvoiceDialog } from "./invoices.js";

const METHOD = { hourly: "Hourly", flat: "Flat fee", contingency: "Contingency" };

export function billingCard(matterId, { onChange } = {}) {
  const card = h("section.card.bl-matter-card", { id: "matter-billing" }, h("h2", "Billing"), h("p.muted.small", "Loading…"));
  const load = async () => {
    try {
      const [w, invs, terms] = await Promise.all([
        get(`/billing/reports/wip?matterId=${matterId}`),
        get(`/billing/invoices?matterId=${matterId}`),
        get(`/billing/matters/${matterId}`),
      ]);
      draw(w.rows[0], invs, terms);
    } catch (err) {
      replace(card, h("h2", "Billing"), h("p.error-text", err.message));
    }
  };
  function draw(wip, invs, terms) {
    const now = today();
    const finals = invs.filter((i) => i.status === "final");
    const due = finals.reduce((s, i) => s + i.balance_cents, 0);
    const late = finals.some((i) => i.balance_cents > 0 && i.due_on < now);
    const last = invs.filter((i) => i.status !== "draft").sort((a, b) => b.number - a.number)[0];
    const draft = invs.find((i) => i.status === "draft");
    const row = (label, value, cls = "") => h("div.bl-mc-row" + cls, h("span", label), h("span", value));
    const unbilledTime = wip ? wip.time_cents + wip.flat_fee_cents : 0;
    replace(
      card,
      h(
        "h2",
        "Billing",
        h("span.bl-mc-method", METHOD[terms.method] + (terms.method === "flat" && terms.flat_fee_cents != null ? ` · ${money(terms.flat_fee_cents)}` : "")),
      ),
      row("Unbilled time", wip ? `${hours(wip.minutes)} h · ${money(unbilledTime)}` : "None"),
      row("Unbilled expenses", money(wip?.expense_cents ?? 0)),
      row("Amount due", money(due), late ? ".late" : due ? ".due" : ""),
      last
        ? h(
            "div.bl-mc-last",
            "Last invoice ",
            h("a", { href: `#/billing/invoices/${last.id}` }, `No. ${last.number}`),
            ` · ${fmtDate(last.issued_on, now)} · ${money(last.total_cents)}`,
            last.status === "void" ? " (void)" : "",
          )
        : h("div.bl-mc-last.muted", "No invoices yet."),
      draft ? h("div.bl-mc-last", h("a", { href: `#/billing/invoices/${draft.id}` }, "Open the draft invoice")) : null,
      h(
        "div.bl-mc-actions",
        h(
          "button.btn.small",
          { type: "button", id: "mc-log-time", onclick: () => logTimeDialog({ matterId, onSaved: async () => (await load(), onChange?.()) }) },
          "Log time",
        ),
        h("button.btn.small.primary", { type: "button", id: "mc-start-invoice", onclick: () => newInvoiceDialog({ matterId }) }, "Start invoice"),
      ),
    );
  }
  load();
  return card;
}
