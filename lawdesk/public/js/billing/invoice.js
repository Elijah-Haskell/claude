// One invoice. A draft can be changed freely: lines, write-downs, discount, dates, notes.
// Finalizing gives it the next number and locks it; after that it can only be paid,
// written off or voided, each with a confirmation.

import { h, replace, modal, toast, select, fmtDate, addDays } from "../dom.js";
import { get, post, patch, del } from "../api.js";
import { today, users, state } from "../state.js";
import { money, hours, moneyInput, bpToPercent, percentToBp } from "./format.js";
import { matterLabel, statusTag, invoiceTitle, moneyField, readMoney, readHours, confirmDialog, fail, subnav } from "./ui.js";

export async function invoiceView([idStr], ctx) {
  const id = Number(idStr);
  const page = h("div.page.bl-page.bl-invoice-page");
  let inv = null;
  let settings = null;
  let credit = 0;

  async function load() {
    [inv, settings] = await Promise.all([get(`/billing/invoices/${id}`), get("/billing/settings")]);
    credit = inv.status === "final" ? (await get(`/billing/clients/${inv.client_id}/credit`)).credit_cents : 0;
    if (ctx && !ctx.isCurrent()) return;
    draw();
  }

  const now = today();
  const isDraft = () => inv.status === "draft";

  function draw() {
    const t = inv.totals;
    const fees = inv.lines.filter((l) => l.kind !== "expense");
    const exps = inv.lines.filter((l) => l.kind === "expense");
    const printHref = `/api/billing/invoices/${id}/print`;

    const actions = [h("a.btn", { href: printHref, target: "_blank", rel: "noopener", id: "inv-print" }, "Print or save as PDF")];
    if (isDraft()) {
      actions.push(
        h("button.btn.danger-text", { type: "button", onclick: deleteDraft }, "Delete draft"),
        h("button.btn.primary", { type: "button", id: "inv-finalize", onclick: finalize, disabled: inv.lines.length === 0 }, "Finalize invoice"),
      );
    } else if (inv.status === "final") {
      if (inv.balance_cents > 0 && credit > 0)
        actions.push(h("button.btn", { type: "button", onclick: applyCredit }, `Use ${money(Math.min(credit, inv.balance_cents))} credit`));
      if (inv.balance_cents > 0) actions.push(h("button.btn", { type: "button", onclick: writeOff }, "Write off"));
      actions.push(h("button.btn.danger-text", { type: "button", id: "inv-void", onclick: voidInvoice }, "Void invoice"));
      if (inv.balance_cents > 0) actions.push(h("button.btn.primary", { type: "button", id: "inv-pay", onclick: recordPayment }, "Record payment"));
    }

    const banner = isDraft()
      ? h(
          "div.bl-banner",
          h("strong", "Draft. "),
          "Nothing has been sent and no invoice number is used until you finalize it. Its time and expenses stay off other invoices while it exists.",
        )
      : inv.status === "void"
        ? h(
            "div.bl-banner.void",
            h("strong", `Voided ${fmtDate(inv.voided_on, now)}. `),
            inv.void_reason,
            ". Its work went back to unbilled; any payments became client credit.",
          )
        : null;

    replace(
      page,
      h("a.back", { href: "#/billing/invoices" }, "← Invoices"),
      h(
        "div.page-head.bl-head",
        h(
          "div",
          h("h1", invoiceTitle(inv), isDraft() ? null : [" ", statusTag(inv)]),
          h("p.sub", inv.client?.name ?? "", " · ", h("a", { href: `#/matters/${inv.matter_id}` }, matterLabel(inv.matter))),
        ),
        h("div.head-actions", actions),
      ),
      subnav("#/billing/invoices"),
      banner,
      h(
        "div.bl-inv-grid",
        h(
          "div.bl-inv-main",
          linesCard("Professional services", fees, true),
          exps.length || isDraft() ? linesCard("Expenses", exps, false) : null,
          isDraft() ? h("div.bl-add-line", h("button.btn", { type: "button", id: "inv-add-line", onclick: () => lineDialog(null) }, "Add a line")) : null,
        ),
        h("aside.bl-inv-aside", totalsCard(t), isDraft() ? detailsCard() : infoCard(), inv.status !== "draft" ? paymentsCard() : null),
      ),
    );
  }

  // ---------------------------------------------------------------- lines
  function linesCard(title, lines, withTime) {
    const rows = lines.map((l) => {
      const notes = [];
      if (l.no_charge_note) notes.push(h("div.bl-line-note", l.no_charge_note));
      if (l.writedown_cents)
        notes.push(
          h(
            "div.bl-line-note.wd",
            l.writedown_cents === l.amount_cents ? "No charge" : `Written down ${money(l.writedown_cents)}`,
            l.writedown_reason ? `: ${l.writedown_reason}` : "",
          ),
        );
      return h(
        "tr" + (l.writedown_cents ? ".bl-wd" : ""),
        { dataset: { line: l.id } },
        h("td.bl-c-date", { "data-label": "Date" }, l.date ? fmtDate(l.date, now) : "–"),
        withTime ? h("td.bl-c-by", { "data-label": "By" }, l.user_name || "–") : null,
        h(
          "td.bl-c-what",
          h("div.pre", l.description || h("span.muted", "No description")),
          notes,
          isDraft()
            ? h(
                "div.bl-line-actions",
                h("button.bl-link", { type: "button", onclick: () => lineDialog(l) }, "Edit"),
                h("button.bl-link", { type: "button", onclick: () => writeDownDialog(l) }, "Write down"),
                h("button.bl-link.danger", { type: "button", onclick: () => removeLine(l) }, "Remove"),
              )
            : null,
        ),
        withTime ? h("td.bl-c-num", { "data-label": "Hours" }, l.minutes != null ? hours(l.minutes) : "–") : null,
        withTime ? h("td.bl-c-money", { "data-label": "Rate" }, l.rate_cents != null ? money(l.rate_cents) : "–") : null,
        h(
          "td.bl-c-money",
          { "data-label": "Amount" },
          l.writedown_cents ? h("div.bl-was", money(l.amount_cents)) : null,
          h("div.bl-strong", money(l.net_cents)),
        ),
      );
    });
    const sum = lines.reduce((s, l) => s + l.net_cents, 0);
    return h(
      "section.card.bl-lines",
      h("div.bl-list-head", h("h2", title), lines.length ? h("span.muted", money(sum)) : null),
      lines.length
        ? h(
            "table.bl-table.bl-line-table" + (withTime ? ".with-time" : ""),
            h(
              "thead",
              h(
                "tr",
                h("th", "Date"),
                withTime ? h("th", "By") : null,
                h("th", "Description"),
                withTime ? h("th.bl-c-num", "Hours") : null,
                withTime ? h("th.bl-c-money", "Rate") : null,
                h("th.bl-c-money", "Amount"),
              ),
            ),
            h("tbody", rows),
          )
        : h("p.empty", withTime ? "No services on this invoice." : "No expenses on this invoice."),
    );
  }

  function lineDialog(l) {
    const kind = select(
      [
        { value: "time", label: "Time (hours at a rate)" },
        { value: "flat", label: "Fixed charge" },
        { value: "expense", label: "Expense" },
      ],
      l?.kind ?? "time",
      { disabled: !!l },
    );
    const date = h("input", { type: "date", value: l ? (l.date ?? "") : (inv.period_to ?? now) });
    const who = select([{ value: "", label: "—" }, ...users().map((u) => ({ value: u.id, label: u.name }))], l ? (l.user_id ?? "") : (state.me ?? ""));
    const desc = h("textarea", { rows: 3, maxlength: 4000 }, l?.description ?? "");
    const hrs = h("input.bl-hours", { inputmode: "decimal", value: l?.minutes != null ? hours(l.minutes) : "", placeholder: "1.5 or 1:30" });
    const rate = moneyField(l?.rate_cents ?? null);
    const amount = moneyField(l?.amount_cents ?? null);
    const timeBox = h("div.form-row.bl-two", h("label", "Hours", hrs), h("label", "Hourly rate", rate));
    const amountBox = h("label", "Amount", amount);
    const err = h("p.error-text", { role: "alert" });
    const noCharge = l && l.no_charge_note;
    const sync = () => {
      const k = kind.value;
      timeBox.hidden = k !== "time" || !!noCharge;
      amountBox.hidden = k === "time" && !noCharge;
    };
    kind.addEventListener("change", sync);
    const fillRate = async () => {
      if (l || !who.value || rate.value) return;
      try {
        const r = await get(`/billing/matters/${inv.matter_id}/rates/${who.value}`);
        if (!rate.value) rate.value = moneyInput(r.rate_cents);
      } catch {
        /* leave it blank */
      }
    };
    who.addEventListener("change", () => ((rate.value = ""), fillRate()));
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const k = kind.value;
            const body = { date: date.value || null, description: desc.value };
            if (k === "time" && !noCharge) Object.assign(body, { minutes: readHours(hrs), rateCents: readMoney(rate, "Hourly rate") });
            else body.amountCents = readMoney(amount, "Amount");
            if (l) await patch(`/billing/invoices/${id}/lines/${l.id}`, body);
            else await post(`/billing/invoices/${id}/lines`, { kind: k, userId: who.value ? Number(who.value) : null, ...body });
            dlg.close();
            toast(l ? "Line updated" : "Line added");
            load();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("label", "Type of line", kind),
      h("div.form-row.bl-two", h("label", "Date", date), !l ? h("label", "Done by", who) : h("span")),
      h("label", "Description", desc),
      timeBox,
      amountBox,
      l && l.minutes != null && !noCharge ? h("p.muted.small", `Hours are billed in ${settings.increment_minutes}-minute steps.`) : null,
      err,
      h(
        "div.form-actions",
        h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"),
        h("button.btn.primary", { type: "submit" }, l ? "Save line" : "Add line"),
      ),
    );
    sync();
    fillRate();
    const dlg = modal(l ? "Edit line" : "Add a line", form);
  }

  function writeDownDialog(l) {
    const amount = moneyField(l.writedown_cents || null, { id: "wd-amount" });
    const all = h("input", { type: "checkbox", checked: l.writedown_cents > 0 && l.writedown_cents === l.amount_cents });
    const reason = h("textarea", { rows: 2, maxlength: 1000, id: "wd-reason" }, l.writedown_reason ?? "");
    const err = h("p.error-text", { role: "alert" });
    const after = h("p.bl-wd-after");
    const update = () => {
      amount.disabled = all.checked;
      let wd = 0;
      try {
        wd = all.checked ? l.amount_cents : amount.value.trim() ? readMoney(amount, "Write-down") : 0;
      } catch {
        wd = 0;
      }
      after.textContent = `The client will be charged ${money(Math.max(0, l.amount_cents - wd))} for this line.`;
    };
    amount.addEventListener("input", update);
    all.addEventListener("change", update);
    const send = async (body) => {
      try {
        await post(`/billing/invoices/${id}/lines/${l.id}/write-down`, body);
        dlg.close();
        toast(body.amountCents === 0 ? "Write-down removed" : "Line written down");
        load();
      } catch (ex) {
        err.textContent = ex.message;
      }
    };
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: (e) => {
          e.preventDefault();
          try {
            if (!reason.value.trim()) throw new Error("Give a reason. It is kept with the invoice for the firm's records.");
            if (all.checked) return send({ all: true, reason: reason.value });
            const cents = readMoney(amount, "Write-down");
            if (cents > l.amount_cents) throw new Error(`The write-down can't be more than the line's ${money(l.amount_cents)}`);
            send({ amountCents: cents, reason: reason.value });
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("p", h("strong", l.description || "This line"), h("span.muted", ` — ${money(l.amount_cents)}`)),
      h("label", "Write down by", amount),
      h("label.check-line", all, " Don't charge for this line at all"),
      h("label", "Reason (kept on the invoice record)", reason),
      after,
      err,
      h(
        "div.form-actions",
        l.writedown_cents ? h("button.btn", { type: "button", onclick: () => send({ amountCents: 0 }) }, "Remove write-down") : null,
        h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"),
        h("button.btn.primary", { type: "submit" }, "Write down"),
      ),
    );
    update();
    const dlg = modal("Write down a line", form);
    amount.focus();
  }

  async function removeLine(l) {
    const src = l.source_time_id ? " The time entry goes back to unbilled." : l.source_expense_id ? " The expense goes back to unbilled." : "";
    if (!confirm(`Remove “${l.description || "this line"}” from the draft?${src}`)) return;
    try {
      await del(`/billing/invoices/${id}/lines/${l.id}`);
      toast("Line removed");
      load();
    } catch (ex) {
      fail(ex);
    }
  }

  // --------------------------------------------------------------- totals
  function totalsCard(t) {
    const row = (label, value, cls = "") => h("div.bl-total-row" + cls, h("span", label), h("span", value));
    const discountLabel = inv.discount_kind === "percent" ? `Discount (${bpToPercent(inv.discount_value)}%)` : "Discount";
    return h(
      "section.card.bl-totals",
      h("h2", "Totals"),
      row("Services and expenses", money(t.subtotal_cents)),
      t.discount_cents ? row(discountLabel, `-${money(t.discount_cents)}`) : null,
      t.tax_cents ? row("Sales tax", money(t.tax_cents)) : null,
      row("Invoice total", money(t.total_cents), ".grand"),
      inv.status === "final" || inv.paid_cents ? row("Payments received", inv.paid_cents ? `-${money(inv.paid_cents)}` : money(0)) : null,
      inv.written_off_cents ? row("Written off", `-${money(inv.written_off_cents)}`) : null,
      inv.status === "final" ? row("Amount due", money(inv.balance_cents), ".due") : null,
      inv.status === "final" && credit > 0 ? h("p.muted.small", `${inv.client?.name ?? "The client"} has ${money(credit)} of unused credit.`) : null,
    );
  }

  function detailsCard() {
    const issued = h("input", { type: "date", value: inv.issued_on ?? "", "aria-label": "Invoice date" });
    const due = h("input", { type: "date", value: inv.due_on ?? "", "aria-label": "Due date" });
    const dKind = select(
      [
        { value: "none", label: "No discount" },
        { value: "percent", label: "Percent off" },
        { value: "fixed", label: "Amount off" },
      ],
      inv.discount_kind,
      { "aria-label": "Discount", id: "inv-discount-kind" },
    );
    const dValue = h("input.bl-money", {
      inputmode: "decimal",
      id: "inv-discount-value",
      "aria-label": "Discount amount",
      value: inv.discount_kind === "percent" ? bpToPercent(inv.discount_value) : inv.discount_kind === "fixed" ? moneyInput(inv.discount_value) : "",
      placeholder: inv.discount_kind === "percent" ? "10" : "0.00",
    });
    const dUnit = h("span.muted", inv.discount_kind === "percent" ? "%" : "");
    const notes = h("textarea", { rows: 3, maxlength: 4000, placeholder: "Printed at the bottom of the invoice" }, inv.notes ?? "");
    const err = h("p.error-text", { role: "alert" });
    const save = async (body, msg = "Saved") => {
      err.textContent = "";
      try {
        await patch(`/billing/invoices/${id}`, body);
        toast(msg);
        load();
      } catch (ex) {
        err.textContent = ex.message;
      }
    };
    issued.addEventListener("change", () => save({ issuedOn: issued.value || null }, "Invoice date saved"));
    due.addEventListener("change", () => save({ dueOn: due.value || null }, "Due date saved"));
    notes.addEventListener("change", () => save({ notes: notes.value || null }, "Notes saved"));
    const saveDiscount = () => {
      const k = dKind.value;
      if (k === "none") return save({ discountKind: "none" }, "Discount removed");
      let v;
      if (k === "percent") {
        v = percentToBp(dValue.value);
        if (v == null || v > 10000) return (err.textContent = "Discount: type a percent from 0 to 100");
      } else {
        try {
          v = readMoney(dValue, "Discount");
        } catch (ex) {
          return (err.textContent = ex.message);
        }
      }
      return save({ discountKind: k, discountValue: v }, "Discount saved");
    };
    dKind.addEventListener("change", () => {
      dValue.value = "";
      dUnit.textContent = dKind.value === "percent" ? "%" : "";
      dValue.hidden = dKind.value === "none";
      if (dKind.value === "none") saveDiscount();
      else dValue.focus();
    });
    dValue.addEventListener("change", saveDiscount);
    dValue.hidden = inv.discount_kind === "none";
    const termsDue = addDays(inv.issued_on || now, settings.payment_terms_days);
    return h(
      "section.card.bl-details",
      h("h2", "Invoice details"),
      h("label.bl-field", h("span", "Invoice date"), issued, h("span.bl-help", inv.issued_on ? "" : "Left blank, it is dated the day you finalize.")),
      h(
        "label.bl-field",
        h("span", "Due date"),
        due,
        h(
          "span.bl-help",
          inv.due_on
            ? ""
            : `Left blank, it is due ${settings.payment_terms_days} days after the invoice date (${fmtDate(termsDue, now)} if dated ${inv.issued_on ? fmtDate(inv.issued_on, now) : "today"}).`,
        ),
      ),
      h("div.bl-field", h("span", "Discount"), h("div.bl-discount", dKind, dValue, dUnit)),
      h("label.bl-field", h("span", "Note to the client"), notes),
      inv.period_from || inv.period_to
        ? h(
            "p.muted.small",
            `Work ${inv.period_from ? `from ${fmtDate(inv.period_from, now)} ` : ""}${inv.period_to ? `through ${fmtDate(inv.period_to, now)}` : ""}.`,
          )
        : null,
      err,
    );
  }

  function infoCard() {
    const line = (label, value) => (value ? h("div.bl-info-row", h("span.muted", label), h("span", value)) : null);
    return h(
      "section.card.bl-details",
      h("h2", "Invoice details"),
      line("Invoice date", inv.issued_on ? fmtDate(inv.issued_on, now) : null),
      line("Due date", inv.due_on ? fmtDate(inv.due_on, now) : null),
      line("Billed to", inv.client?.name),
      line("Work through", inv.period_to ? fmtDate(inv.period_to, now) : null),
      inv.notes ? h("div.bl-info-note", h("span.muted", "Note to the client"), h("p.pre", inv.notes)) : null,
    );
  }

  function paymentsCard() {
    const items = [
      ...inv.payments.map((p) => ({
        date: p.applied_on,
        what: [p.method, p.reference].filter(Boolean).join(" ") || "Payment",
        amount: p.amount_cents,
        released: p.released_on,
      })),
      ...inv.writeoffs.map((w) => ({ date: w.written_on, what: `Written off: ${w.reason}`, amount: w.amount_cents })),
    ].sort((a, b) => (a.date < b.date ? -1 : 1));
    return h(
      "section.card.bl-payments",
      h("h2", "Payments"),
      items.length
        ? h(
            "ul.bl-pay-list",
            items.map((p) =>
              h(
                "li" + (p.released ? ".released" : ""),
                h("span.muted", fmtDate(p.date, now)),
                h("span", p.what, p.released ? h("span.muted.small", ` (taken back ${fmtDate(p.released, now)})`) : null),
                h("span.bl-strong", money(p.amount)),
              ),
            ),
          )
        : h("p.muted", "No payments yet."),
    );
  }

  // -------------------------------------------------------------- actions
  async function deleteDraft() {
    if (!confirm("Delete this draft? Its time and expenses go back to unbilled. No invoice number is used.")) return;
    try {
      await del(`/billing/invoices/${id}`);
      toast("Draft deleted");
      location.hash = "#/billing/invoices";
    } catch (ex) {
      fail(ex);
    }
  }

  async function finalize() {
    const all = await get("/billing/invoices");
    const max = all.reduce((m, i) => (i.number != null && i.number > m ? i.number : m), 0);
    const next = max ? max + 1 : settings.first_invoice_number;
    const issued = inv.issued_on ?? now;
    const due = inv.due_on ?? addDays(issued, settings.payment_terms_days);
    const ok = await confirmDialog(
      "Finalize this invoice?",
      [
        h(
          "dl.bl-confirm-facts",
          h("dt", "Invoice number"),
          h("dd", String(next)),
          h("dt", "Client"),
          h("dd", inv.client?.name ?? ""),
          h("dt", "Dated"),
          h("dd", fmtDate(issued, now)),
          h("dt", "Due"),
          h("dd", fmtDate(due, now)),
          h("dt", "Total"),
          h("dd", h("strong", money(inv.totals.total_cents))),
        ),
        "Once finalized, the invoice can't be changed. If something turns out to be wrong you can void it; it stays on record with its number.",
      ],
      { confirmLabel: "Finalize invoice" },
    );
    if (!ok) return;
    try {
      const r = await post(`/billing/invoices/${id}/finalize`);
      toast(`Invoice ${r.number} finalized for ${money(r.totals.total_cents)}`);
      load();
    } catch (ex) {
      fail(ex);
    }
  }

  async function voidInvoice() {
    const reason = await confirmDialog(
      `Void invoice ${inv.number}?`,
      [
        `The invoice stays on record, marked void, and keeps its number. Its time and expenses go back to unbilled so they can be billed again.`,
        inv.paid_cents ? `The ${money(inv.paid_cents)} already paid on it becomes credit for ${inv.client?.name ?? "the client"}.` : null,
        "This can't be undone.",
      ].filter(Boolean),
      { confirmLabel: "Void invoice", danger: true, reasonLabel: "Reason for voiding" },
    );
    if (!reason) return;
    try {
      await post(`/billing/invoices/${id}/void`, { reason });
      toast(`Invoice ${inv.number} voided`);
      load();
    } catch (ex) {
      fail(ex);
    }
  }

  function recordPayment() {
    const amount = moneyField(inv.balance_cents, { id: "pay-amount" });
    const date = h("input", { type: "date", value: now });
    const method = select(
      PAY_METHODS.map((m) => ({ value: m, label: m })),
      "Check",
    );
    const ref = h("input", { maxlength: 200, placeholder: "e.g. check number" });
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const cents = readMoney(amount, "Amount");
            if (cents <= 0) throw new Error("Amount: type the amount received");
            await post(`/billing/invoices/${id}/payments`, {
              amountCents: cents,
              receivedOn: date.value || now,
              method: method.value,
              reference: ref.value || null,
            });
            dlg.close();
            toast(cents > inv.balance_cents ? `Payment recorded; ${money(cents - inv.balance_cents)} kept as credit` : `Payment of ${money(cents)} recorded`);
            load();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("p", `Amount due on invoice ${inv.number}: `, h("strong", money(inv.balance_cents))),
      h("div.form-row.bl-two", h("label", "Amount received", amount), h("label", "Date received", date)),
      h("div.form-row.bl-two", h("label", "How it was paid", method), h("label", "Reference", ref)),
      h("p.muted.small", "Anything over the amount due is kept as credit for the client. To spread one payment over several invoices, use Payments."),
      err,
      h(
        "div.form-actions",
        h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"),
        h("button.btn.primary", { type: "submit" }, "Record payment"),
      ),
    );
    const dlg = modal("Record a payment", form);
    amount.focus();
    amount.select();
  }

  async function applyCredit() {
    const amt = Math.min(credit, inv.balance_cents);
    const ok = await confirmDialog(
      "Use the client's credit?",
      [`Apply ${money(amt)} of ${inv.client?.name ?? "the client"}'s credit to invoice ${inv.number}.`],
      { confirmLabel: "Apply credit" },
    );
    if (!ok) return;
    try {
      await post(`/billing/invoices/${id}/apply-credit`, { amountCents: amt });
      toast(`${money(amt)} of credit applied`);
      load();
    } catch (ex) {
      fail(ex);
    }
  }

  function writeOff() {
    const amount = moneyField(inv.balance_cents);
    const reason = h("textarea", { rows: 2, maxlength: 1000 });
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const cents = readMoney(amount, "Amount");
            if (!reason.value.trim()) throw new Error("Give a reason. It is kept with the invoice.");
            if (!confirm(`Write off ${money(cents)} of invoice ${inv.number}? This can't be undone.`)) return;
            await post(`/billing/invoices/${id}/write-off`, { amountCents: cents, reason: reason.value });
            dlg.close();
            toast(`${money(cents)} written off`);
            load();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("p", "Use this when the firm won't collect part or all of what is owed. The invoice itself doesn't change."),
      h("label", "Amount to write off", amount),
      h("label", "Reason", reason),
      err,
      h(
        "div.form-actions",
        h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"),
        h("button.btn.primary", { type: "submit" }, "Write off"),
      ),
    );
    const dlg = modal("Write off amount due", form);
  }

  await load();
  return page;
}

export const PAY_METHODS = ["Check", "Bank transfer", "Credit card", "Cash", "Other"];
