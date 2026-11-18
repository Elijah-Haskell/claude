// Billing settings: firm details printed on invoices, rates, how each matter is billed,
// payment terms, sales tax (off unless the firm turns it on) and invoice numbering.

import { h, toast, select, modal } from "../dom.js";
import { get, patch, put } from "../api.js";
import { state, users } from "../state.js";
import { money, moneyInput, bpToPercent, percentToBp } from "./format.js";
import { billingPage, allMatters, moneyField, readMoney, fail } from "./ui.js";
import { card, field, button, emptyState } from "../ui/components.js";
import { dataTable } from "../ui/table.js";

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
    return field(label, h("span.bl-with-unit", inp, h("span.bl-unit", "%")));
  });
  const taxGroup = h(
    "div.bl-tax",
    { hidden: !taxOn },
    h("div.bl-tax-fields", taxFields),
    h("p.field-hint", "Applies to new invoices. The firm decides what is taxable."),
  );
  taxBox.addEventListener("change", () => {
    taxGroup.hidden = !taxBox.checked;
    if (!taxBox.checked) {
      save({ taxTimeBp: 0, taxFlatBp: 0, taxExpenseBp: 0 }, "Sales tax turned off");
      taxGroup.querySelectorAll("input").forEach((i) => (i.value = ""));
    }
  });

  const firm = card({
    className: "bl-settings-card",
    title: "Firm and invoices",
    subtitle: "What is printed on invoices, and how time is rounded and billed.",
    icon: "receipt",
    body: h(
      "div.form-grid",
      h("div.form-row", field("Firm name on invoices", firmName), field("Address on invoices", firmAddr)),
      h(
        "div.bl-settings-grid",
        field("Firm hourly rate", h("span.bl-with-unit.bl-unit-before", h("span.bl-unit", "$"), rate), { hint: "Used when no other rate applies." }),
        field("Bill time in", inc, { hint: "Each entry rounds up to this." }),
        field("Payment due (days after invoice)", terms),
        field("First invoice number", first, {
          hint: numbered ? "Numbering has started, so this can't change." : "The first finalized invoice gets this number.",
        }),
      ),
      h("div.bl-tax-box", h("label.check-line", taxBox, h("span", "Charge sales tax on invoices")), taxGroup),
    ),
  });

  // -------------------------------------------------------------- people
  const rateRows = await get("/billing/users/rates");
  const userRates = users().map((u) => ({ u, rate: rateRows.find((r) => r.user_id === u.id)?.rate_cents ?? null }));

  const rateInput = ({ u, rate: cur }) => {
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
    return inp;
  };
  const people = card({
    className: "bl-settings-card",
    title: "Hourly rates by person",
    subtitle: "Leave blank to use the firm rate. A matter can set its own rates below.",
    icon: "users",
    flush: true,
    body: dataTable({
      columns: [
        {
          key: "name",
          label: "Person",
          primary: true,
          render: ({ u }) => h("div.cell-stack", h("span.bl-strong", u.name), u.default_role ? h("span.cell-sub", u.default_role) : null),
        },
        { key: "rate", label: "Standard rate", className: "bl-rate-cell", render: rateInput },
      ],
      rows: userRates,
      rowKey: (r) => r.u.id,
      toolbar: false,
      sortable: false,
      tableClass: "bl-rate-table",
      label: "Hourly rates by person",
    }),
  });

  // -------------------------------------------------------------- matters
  const open = matters.filter((m) => m.status === "open");
  const terms2 = await Promise.all(open.map((m) => get(`/billing/matters/${m.id}`)));
  const controls = new Map(); // matter id -> { method, amt, hint }, made once so the table can redraw
  const controlsFor = (m) => {
    if (controls.has(m.id)) return controls.get(m.id);
    const t = terms2[open.indexOf(m)];
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
    const hint = h("span.field-hint.bl-help");
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
    const c = { method, amt, hint };
    controls.set(m.id, c);
    return c;
  };
  const mattersCard = card({
    className: "bl-settings-card",
    title: "How each matter is billed",
    subtitle: "Hourly, a flat fee or contingency. Open matters only.",
    icon: "briefcase",
    flush: true,
    body: dataTable({
      columns: [
        {
          key: "name",
          label: "Matter",
          primary: true,
          render: (m) =>
            h(
              "div.cell-stack",
              h("a.cell-title", { href: `#/matters/${m.id}` }, m.number ? h("span.matter-num", m.number) : null, " ", m.name),
              h("span.cell-sub", m.client_name || ""),
            ),
          sort: (m) => m.number || m.name,
        },
        { key: "method", label: "Billing", sortable: false, className: "bl-method-cell", render: (m) => controlsFor(m).method },
        {
          key: "amount",
          label: "Rate or fee",
          sortable: false,
          className: "bl-amount-cell",
          render: (m) => h("div.bl-amount-field", controlsFor(m).amt, controlsFor(m).hint),
        },
        {
          key: "rates",
          label: "",
          phoneLabel: "",
          sortable: false,
          className: "bl-row-actions-cell",
          render: (m) => button("Rates by person", { size: "sm", variant: "ghost", icon: "users", onclick: () => matterRates(m) }),
        },
      ],
      rows: open,
      tableClass: "bl-matter-billing",
      label: "How each matter is billed",
      noun: ["matter", "matters"],
      sort: { key: "name", dir: "asc" },
      search: { placeholder: "Find a matter", text: (m) => [m.number, m.name, m.client_name] },
      empty: ({ searching }) =>
        emptyState({
          icon: "briefcase",
          title: searching ? "No matches" : "No open matters",
          body: searching ? "Try a different word." : "Open matters appear here.",
          compact: true,
        }),
    }),
  });

  page.append(h("div.bl-stack.bl-settings", firm, people, mattersCard));
  return page;
}

async function matterRates(m) {
  const rows = await Promise.all(users().map(async (u) => ({ u, r: await get(`/billing/matters/${m.id}/rates/${u.id}`) })));
  const body = h(
    "div.modal-body",
    dataTable({
      columns: [
        { key: "name", label: "Person", primary: true, render: ({ u }) => h("span.bl-strong", u.name) },
        {
          key: "rate",
          label: "Rate on this matter",
          className: "bl-rate-cell",
          render: ({ u, r }) => {
            const note = h("span.field-hint", `${SOURCE[r.source]}: ${money(r.rate_cents)}`);
            const inp = moneyField(r.source === "matter_user" ? r.rate_cents : null, {
              "aria-label": `Rate for ${u.name} on this matter`,
              placeholder: "Usual rate",
            });
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
            return h("div.bl-amount-field", inp, note);
          },
        },
      ],
      rows,
      rowKey: (x) => x.u.id,
      toolbar: false,
      sortable: false,
      tableClass: "bl-rate-table",
      label: "Rates on this matter",
    }),
    h("div.form-actions", button("Done", { variant: "primary", onclick: () => dlg.close() })),
  );
  const dlg = modal(`Rates on ${m.number || m.name}`, body, {
    wide: true,
    subtitle:
      "Set a rate for one person on this matter only. Leave blank to use their usual rate. New time entries use the new rate; existing entries keep theirs.",
  });
}

export { state };
