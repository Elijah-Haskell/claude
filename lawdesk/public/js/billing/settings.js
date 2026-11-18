// Billing settings: firm details printed on invoices, rates, how each matter is billed,
// payment terms, sales tax (off unless the firm turns it on) and invoice numbering.

import { h, toast, select, modal } from "../dom.js";
import { get, patch, put } from "../api.js";
import { state, users } from "../state.js";
import { money, moneyInput, bpToPercent, percentToBp } from "./format.js";
import { billingPage, allMatters, matterLabel, moneyField, readMoney, fail } from "./ui.js";

const SOURCE = { matter_user: "Set for this matter", matter: "Matter rate", user: "Their standard rate", firm: "Firm rate" };

export async function billingSettingsView(_m, ctx) {
  const [s, invoices, matters] = await Promise.all([get("/billing/settings"), get("/billing/invoices"), allMatters(true)]);
  if (ctx && !ctx.isCurrent()) return h("div");
  const page = billingPage("#/billing/settings", "Billing settings", "Rates, terms and what is printed on invoices.");
  const numbered = invoices.some((i) => i.number != null);

  const save = async (body, msg = "Saved") => {
    try {
      await patch("/billing/settings", body);
      toast(msg);
    } catch (ex) {
      fail(ex);
    }
  };

  // --------------------------------------------------------------- firm
  const firmName = h("input", { value: s.firm_name, maxlength: 200, id: "bs-firm" });
  const firmAddr = h("textarea", { rows: 3, maxlength: 1000 }, s.firm_address);
  firmName.addEventListener("change", () => save({ firmName: firmName.value }, "Firm name saved"));
  firmAddr.addEventListener("change", () => save({ firmAddress: firmAddr.value }, "Address saved"));

  const rate = moneyField(s.default_rate_cents, { id: "bs-rate" });
  rate.addEventListener("change", () => {
    try {
      save({ defaultRateCents: readMoney(rate, "Firm rate") }, "Firm rate saved");
    } catch (ex) {
      fail(ex);
    }
  });
  const inc = select(
    [
      [6, "Tenths of an hour (6 minutes)"],
      [15, "Quarter hours (15 minutes)"],
      [1, "Exact minutes"],
      [10, "10 minutes"],
      [30, "Half hours"],
    ].map(([v, l]) => ({ value: v, label: l })),
    s.increment_minutes,
  );
  inc.addEventListener("change", () => save({ incrementMinutes: Number(inc.value) }, "Billing increment saved"));
  const terms = h("input", { type: "number", min: 0, max: 3650, value: s.payment_terms_days, id: "bs-terms" });
  terms.addEventListener("change", () => save({ paymentTermsDays: Number(terms.value) }, "Payment terms saved"));
  const first = h("input", { type: "number", min: 1, value: s.first_invoice_number, disabled: numbered, id: "bs-first" });
  first.addEventListener("change", () => save({ firstInvoiceNumber: Number(first.value) }, "Starting number saved"));

  const taxOn = s.tax_time_bp || s.tax_expense_bp || s.tax_flat_bp;
  const taxBox = h("input", { type: "checkbox", checked: !!taxOn, id: "bs-tax" });
  const taxFields = [
    ["taxTimeBp", "On time", s.tax_time_bp],
    ["taxFlatBp", "On flat fees", s.tax_flat_bp],
    ["taxExpenseBp", "On expenses", s.tax_expense_bp],
  ].map(([key, label, bp]) => {
    const inp = h("input.bl-pct", { inputmode: "decimal", value: bp ? bpToPercent(bp) : "", placeholder: "0" });
    inp.addEventListener("change", () => {
      const v = percentToBp(inp.value);
      if (v == null || v > 10000) return fail(new Error("Tax: type a percent such as 6.5"));
      save({ [key]: v }, "Tax rate saved");
    });
    return h("label.bl-field", h("span", label), h("span.bl-with-unit", inp, h("span.muted", "%")));
  });
  const taxGroup = h("div.bl-tax-fields", { hidden: !taxOn }, taxFields, h("p.muted.small", "Applies to new invoices. The firm decides what is taxable."));
  taxBox.addEventListener("change", () => {
    taxGroup.hidden = !taxBox.checked;
    if (!taxBox.checked) {
      save({ taxTimeBp: 0, taxFlatBp: 0, taxExpenseBp: 0 }, "Sales tax turned off");
      taxGroup.querySelectorAll("input").forEach((i) => (i.value = ""));
    }
  });

  const firm = h(
    "section.card.bl-settings-card",
    h("h2", "Firm and invoices"),
    h("label.bl-field", h("span", "Firm name on invoices"), firmName),
    h("label.bl-field", h("span", "Address on invoices"), firmAddr),
    h(
      "div.bl-settings-grid",
      h("label.bl-field", h("span", "Firm hourly rate"), rate, h("span.bl-help", "Used when no other rate applies.")),
      h("label.bl-field", h("span", "Bill time in"), inc, h("span.bl-help", "Each entry rounds up to this.")),
      h("label.bl-field", h("span", "Payment due (days after invoice)"), terms),
      h(
        "label.bl-field",
        h("span", "First invoice number"),
        first,
        h("span.bl-help", numbered ? "Numbering has started, so this can't change." : "The first finalized invoice gets this number."),
      ),
    ),
    h("label.check-line", taxBox, " Charge sales tax on invoices"),
    taxGroup,
  );

  // -------------------------------------------------------------- people
  const rateRows = await get("/billing/users/rates");
  const userRates = users().map((u) => ({ u, rate: rateRows.find((r) => r.user_id === u.id)?.rate_cents ?? null }));
  const people = h(
    "section.card.bl-settings-card",
    h("h2", "Hourly rates by person"),
    h("p.muted.small", "Leave blank to use the firm rate. A matter can set its own rates below."),
    h(
      "table.settings-table.bl-rate-table",
      h("thead", h("tr", h("th", "Person"), h("th", "Standard rate"))),
      h(
        "tbody",
        userRates.map(({ u, rate: cur }) => {
          const inp = moneyField(cur, {
            "aria-label": `Rate for ${u.name}`,
            placeholder: `Firm rate (${money(s.default_rate_cents)})`,
            dataset: { user: u.id },
          });
          inp.addEventListener("change", async () => {
            try {
              const v = inp.value.trim() ? readMoney(inp, "Rate") : null;
              await put(`/billing/users/${u.id}/rate`, { rateCents: v });
              toast(v == null ? `${u.name} now uses the firm rate` : `${u.name}: ${money(v)} an hour`);
            } catch (ex) {
              fail(ex);
            }
          });
          return h("tr", h("td", u.name, u.default_role ? h("span.muted.small", ` · ${u.default_role}`) : null), h("td", inp));
        }),
      ),
    ),
  );

  // -------------------------------------------------------------- matters
  const open = matters.filter((m) => m.status === "open");
  const terms2 = await Promise.all(open.map((m) => get(`/billing/matters/${m.id}`)));
  const mattersCard = h(
    "section.card.bl-settings-card",
    h("h2", "How each matter is billed"),
    h(
      "table.settings-table.bl-matter-billing",
      h("thead", h("tr", h("th", "Matter"), h("th", "Billing"), h("th", "Rate or fee"), h("th", h("span.sr-only", "Rates")))),
      h(
        "tbody",
        open.map((m, i) => {
          const t = terms2[i];
          const method = select(
            [
              { value: "hourly", label: "Hourly" },
              { value: "flat", label: "Flat fee" },
              { value: "contingency", label: "Contingency" },
            ],
            t.method,
            { "aria-label": `Billing for ${m.name}` },
          );
          const amt = moneyField(t.method === "flat" ? t.flat_fee_cents : t.rate_cents, { "aria-label": `Rate or fee for ${m.name}` });
          const hint = h("span.bl-help");
          const sync = () => {
            amt.hidden = method.value === "contingency";
            amt.placeholder = method.value === "flat" ? "Fee amount" : "Usual rates";
            hint.textContent =
              method.value === "hourly"
                ? "Blank uses each person's rate"
                : method.value === "flat"
                  ? "Billed once; time is not charged"
                  : "Time is not charged; expenses are";
          };
          const send = async () => {
            try {
              const v = amt.value.trim() ? readMoney(amt, "Amount") : null;
              const body =
                method.value === "flat"
                  ? { method: "flat", flatFeeCents: v }
                  : method.value === "hourly"
                    ? { method: "hourly", rateCents: v }
                    : { method: "contingency" };
              if (method.value === "flat" && v == null) {
                amt.focus();
                return toast("Type the flat fee for this matter", { error: true });
              }
              await put(`/billing/matters/${m.id}`, body);
              toast(`${m.number || m.name}: billing saved`);
            } catch (ex) {
              fail(ex);
            }
          };
          method.addEventListener("change", () => {
            amt.value = "";
            sync();
            if (method.value !== "flat") send();
            else amt.focus();
          });
          amt.addEventListener("change", send);
          sync();
          return h(
            "tr",
            h("td", h("a", { href: `#/matters/${m.id}` }, matterLabel(m)), h("div.muted.small", m.client_name || "")),
            h("td", { "data-label": "Billing" }, method),
            h("td", { "data-label": "Rate or fee" }, amt, hint),
            h("td", h("button.btn.small", { type: "button", onclick: () => matterRates(m) }, "Rates by person")),
          );
        }),
      ),
    ),
  );

  page.append(h("div.bl-settings", firm, people, mattersCard));
  return page;
}

async function matterRates(m) {
  const rows = await Promise.all(users().map(async (u) => ({ u, r: await get(`/billing/matters/${m.id}/rates/${u.id}`) })));
  const body = h(
    "div.modal-body",
    h(
      "p.muted",
      "Set a rate for one person on this matter only. Leave blank to use their usual rate. New time entries use the new rate; existing entries keep theirs.",
    ),
    h(
      "table.settings-table",
      h("thead", h("tr", h("th", "Person"), h("th", "Rate on this matter"))),
      h(
        "tbody",
        rows.map(({ u, r }) => {
          const note = h("span.bl-help", `${SOURCE[r.source]}: ${money(r.rate_cents)}`);
          const inp = moneyField(r.source === "matter_user" ? r.rate_cents : null, { "aria-label": `Rate for ${u.name} on this matter` });
          inp.addEventListener("change", async () => {
            try {
              const v = inp.value.trim() ? readMoney(inp, "Rate") : null;
              await put(`/billing/matters/${m.id}/rates/${u.id}`, { rateCents: v });
              const now = await get(`/billing/matters/${m.id}/rates/${u.id}`);
              note.textContent = `${SOURCE[now.source]}: ${money(now.rate_cents)}`;
              toast("Rate saved");
            } catch (ex) {
              fail(ex);
            }
          });
          return h("tr", h("td", u.name), h("td", inp, note));
        }),
      ),
    ),
    h("div.form-actions", h("button.btn.primary", { type: "button", onclick: () => dlg.close() }, "Done")),
  );
  const dlg = modal(`Rates on ${m.number || m.name}`, body, { wide: true });
}

export { state };
