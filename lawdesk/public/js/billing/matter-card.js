// The compact Billing card on the matter page: what is unbilled, what is owed, the last
// invoice, and buttons to start an invoice or log time.

import { h, replace, fmtDate } from "../dom.js";
import { get } from "../api.js";
import { today } from "../state.js";
import { money, hours } from "./format.js";
import { logTimeDialog } from "./ui.js";
import { newInvoiceDialog } from "./invoices.js";
import { card, button, pill, callout, loadingBlock } from "../ui/components.js";
import { icon } from "../ui/icons.js";

const METHOD = { hourly: "Hourly", flat: "Flat fee", contingency: "Contingency" };

export function billingCard(matterId, { onChange } = {}) {
  const el = card({ id: "matter-billing", className: "bl-matter-card", title: "Billing", icon: "billing", body: loadingBlock("Loading billing", "lines", 3) });
  const load = async () => {
    try {
      const [w, invs, terms] = await Promise.all([
        get(`/billing/reports/wip?matterId=${matterId}`),
        get(`/billing/invoices?matterId=${matterId}`),
        get(`/billing/matters/${matterId}`),
      ]);
      draw(w.rows[0], invs, terms);
    } catch (err) {
      put(
        card({
          id: "matter-billing",
          className: "bl-matter-card",
          title: "Billing",
          icon: "billing",
          body: callout({ tone: "danger", title: "Billing didn't load", body: err.message }),
        }),
      );
    }
  };
  // The card is placed once by the matter page, so its contents are swapped in place.
  const put = (next) => replace(el, ...next.childNodes);

  function draw(wip, invs, terms) {
    const now = today();
    const finals = invs.filter((i) => i.status === "final");
    const due = finals.reduce((s, i) => s + i.balance_cents, 0);
    const late = finals.some((i) => i.balance_cents > 0 && i.due_on < now);
    const last = invs.filter((i) => i.status !== "draft").sort((a, b) => b.number - a.number)[0];
    const draft = invs.find((i) => i.status === "draft");
    const row = (label, value, cls = "") => h("div.bl-mc-row" + cls, h("span.bl-mc-label", label), h("span.bl-mc-value", value));
    const unbilledTime = wip ? wip.time_cents + wip.flat_fee_cents : 0;
    const method = METHOD[terms.method] + (terms.method === "flat" && terms.flat_fee_cents != null ? ` · ${money(terms.flat_fee_cents)}` : "");
    put(
      card({
        id: "matter-billing",
        className: "bl-matter-card",
        title: "Billing",
        icon: "billing",
        actions: pill(method, "neutral", { dot: false }),
        body: [
          h(
            "div.bl-mc-rows",
            row("Unbilled time", wip ? `${hours(wip.minutes)} h · ${money(unbilledTime)}` : "None"),
            row("Unbilled expenses", money(wip?.expense_cents ?? 0)),
            row("Amount due", late ? h("span.bl-mc-due", money(due), " ", pill("Past due", "danger")) : money(due), late ? ".late" : due ? ".due" : ""),
          ),
          last
            ? h(
                "p.bl-mc-last",
                icon("receipt", { size: 14 }),
                h(
                  "span",
                  "Last invoice ",
                  h("a", { href: `#/billing/invoices/${last.id}` }, `No. ${last.number}`),
                  ` · ${fmtDate(last.issued_on, now)} · ${money(last.total_cents)}`,
                  last.status === "void" ? " (void)" : "",
                ),
              )
            : h("p.bl-mc-last.muted", icon("receipt", { size: 14 }), h("span", "No invoices yet.")),
          draft ? h("p.bl-mc-last", icon("pencil", { size: 14 }), h("a", { href: `#/billing/invoices/${draft.id}` }, "Open the draft invoice")) : null,
        ],
        footer: h(
          "div.bl-mc-actions",
          button("Log time", {
            size: "sm",
            icon: "clock",
            id: "mc-log-time",
            onclick: () => logTimeDialog({ matterId, onSaved: async () => (await load(), onChange?.()) }),
          }),
          button("Start invoice", { size: "sm", variant: "primary", icon: "plus", id: "mc-start-invoice", onclick: () => newInvoiceDialog({ matterId }) }),
        ),
      }),
    );
  }
  load();
  return el;
}
