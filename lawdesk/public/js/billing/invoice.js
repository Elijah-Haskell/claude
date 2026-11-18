// One invoice. A draft can be changed freely: lines, write-downs, discount, dates, notes.
// Finalizing gives it the next number and locks it; after that it can only be paid,
// written off or voided, each with a confirmation.

import { h, replace, modal, toast, select, fmtDate, addDays } from "../dom.js";
import { get, post, patch, del } from "../api.js";
import { today, users, state } from "../state.js";
import { money, hours, moneyInput, bpToPercent, percentToBp } from "./format.js";
import { matterLabel, statusTag, invoiceTitle, moneyField, readMoney, readHours, confirmDialog, fail, subnav } from "./ui.js";
import { pageHeader, card, field, button, iconButton, callout, kv, emptyState } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { menu } from "../ui/popover.js";
import { icon } from "../ui/icons.js";

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

    const more = [];
    const actions = [button("Print or save as PDF", { href: printHref, target: "_blank", rel: "noopener", id: "inv-print", icon: "external-link" })];
    if (isDraft()) {
      more.push({ label: "Delete draft", icon: "trash-2", danger: true, onSelect: deleteDraft });
      actions.push(button("Finalize invoice", { variant: "primary", icon: "check", id: "inv-finalize", onclick: finalize, disabled: inv.lines.length === 0 }));
    } else if (inv.status === "final") {
      if (inv.balance_cents > 0 && credit > 0)
        more.push({ label: `Use ${money(Math.min(credit, inv.balance_cents))} credit`, icon: "wallet", onSelect: applyCredit });
      if (inv.balance_cents > 0) more.push({ label: "Write off amount due", icon: "archive", onSelect: writeOff });
      if (more.length) more.push("-");
      more.push({ label: "Void invoice", icon: "circle-alert", danger: true, onSelect: voidInvoice });
      if (inv.balance_cents > 0) actions.push(button("Record payment", { variant: "primary", icon: "plus", id: "inv-pay", onclick: recordPayment }));
    }
    if (more.length)
      actions.splice(
        1,
        0,
        iconButton("ellipsis", "More invoice actions", {
          id: "inv-more",
          variant: "bordered",
          "aria-haspopup": "menu",
          onclick: (e) => menu(e.currentTarget, more, "Invoice actions"),
        }),
      );

    let banner = null;
    if (isDraft()) {
      banner = callout({
        tone: "info",
        title: "Draft",
        body: "Nothing has been sent and no invoice number is used until you finalize it. Its time and expenses stay off other invoices while it exists.",
      });
      banner.classList.add("bl-banner");
    } else if (inv.status === "void") {
      banner = callout({
        tone: "warning",
        title: `Voided ${fmtDate(inv.voided_on, now)}`,
        body: `${inv.void_reason}. Its work went back to unbilled; any payments became client credit.`,
      });
      banner.classList.add("bl-banner", "void");
    }

    replace(
      page,
      pageHeader({
        breadcrumbs: [{ label: "Billing", href: "#/billing" }, { label: "Invoices", href: "#/billing/invoices" }, { label: invoiceTitle(inv) }],
        title: invoiceTitle(inv),
        meta: [
          statusTag(inv),
          h("span.bl-meta-item", icon("building-2", { size: 14 }), inv.client?.name ?? ""),
          h("a.bl-meta-item", { href: `#/matters/${inv.matter_id}` }, icon("briefcase", { size: 14 }), matterLabel(inv.matter)),
        ],
        actions,
      }),
      subnav("#/billing/invoices"),
      banner,
      h(
        "div.bl-inv-grid",
        h(
          "div.bl-inv-main",
          linesCard("Professional services", fees, true),
          exps.length || isDraft() ? linesCard("Expenses", exps, false) : null,
          isDraft() ? h("div.bl-add-line", button("Add a line", { icon: "plus", id: "inv-add-line", onclick: () => lineDialog(null) })) : null,
        ),
        h("aside.bl-inv-aside", totalsCard(t), isDraft() ? detailsCard() : infoCard(), inv.status !== "draft" ? paymentsCard() : null),
      ),
    );
  }

  // ---------------------------------------------------------------- lines
  function linesCard(title, lines, withTime) {
    const sum = lines.reduce((s, l) => s + l.net_cents, 0);
    const describe = (l) => {
      const notes = [];
      if (l.no_charge_note) notes.push(h("span.bl-line-note", l.no_charge_note));
      if (l.writedown_cents)
        notes.push(
          h(
            "span.bl-line-note.wd",
            l.writedown_cents === l.amount_cents ? "No charge" : `Written down ${money(l.writedown_cents)}`,
            l.writedown_reason ? `: ${l.writedown_reason}` : "",
          ),
        );
      return h(
        "div.cell-stack",
        h("span.pre.bl-line-desc", l.description || h("span.muted", "No description")),
        notes,
        isDraft()
          ? h(
              "div.bl-line-actions",
              button("Edit", { size: "sm", variant: "ghost", onclick: () => lineDialog(l) }),
              button("Write down", { size: "sm", variant: "ghost", onclick: () => writeDownDialog(l) }),
              button("Remove", { size: "sm", variant: "ghost", class: "danger-text", onclick: () => removeLine(l) }),
            )
          : null,
      );
    };
    const columns = [
      { key: "date", label: "Date", className: "nowrap bl-c-date", render: (l) => (l.date ? fmtDate(l.date, now) : h("span.muted", "–")) },
      withTime ? { key: "user_name", label: "By", className: "nowrap", render: (l) => l.user_name || h("span.muted", "–") } : null,
      { key: "description", label: "Description", primary: true, render: describe },
      withTime
        ? { key: "minutes", label: "Hours", align: "right", className: "nowrap", render: (l) => (l.minutes != null ? hours(l.minutes) : h("span.muted", "–")) }
        : null,
      withTime
        ? {
            key: "rate_cents",
            label: "Rate",
            align: "right",
            className: "nowrap",
            render: (l) => (l.rate_cents != null ? money(l.rate_cents) : h("span.muted", "–")),
          }
        : null,
      {
        key: "net_cents",
        label: "Amount",
        align: "right",
        className: "nowrap",
        render: (l) => h("div.bl-amount", l.writedown_cents ? h("span.bl-was", money(l.amount_cents)) : null, h("strong", money(l.net_cents))),
      },
    ].filter(Boolean);
    return card({
      className: "bl-lines",
      flush: true,
      title,
      icon: withTime ? "clock" : "wallet",
      actions: lines.length ? h("span.bl-card-sum", money(sum)) : null,
      body: dataTable({
        columns,
        rows: lines,
        toolbar: false,
        sortable: false,
        pageSize: 1000,
        tableClass: "bl-line-table" + (withTime ? " with-time" : ""),
        label: title,
        rowClass: (l) => (l.writedown_cents ? "bl-wd" : ""),
        rowAttrs: (l) => ({ "data-line": String(l.id) }),
        empty: emptyState({
          icon: withTime ? "clock" : "wallet",
          title: withTime ? "No services on this invoice" : "No expenses on this invoice",
          body: isDraft() ? "Use Add a line to put a charge on this draft." : null,
          compact: true,
        }),
      }),
    });
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
    const timeBox = h("div.form-row.bl-two", field("Hours", hrs), field("Hourly rate", rate));
    const amountBox = field("Amount", amount);
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
      field("Type of line", kind),
      h("div.form-row.bl-two", field("Date", date), !l ? field("Done by", who) : h("span")),
      field("Description", desc),
      timeBox,
      amountBox,
      l && l.minutes != null && !noCharge ? h("p.field-hint", `Hours are billed in ${settings.increment_minutes}-minute steps.`) : null,
      err,
      h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), button(l ? "Save line" : "Add line", { variant: "primary", type: "submit" })),
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
    const after = h("p.bl-wd-after", { "aria-live": "polite" });
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
      h("div.bl-wd-line", h("span", l.description || "This line"), h("strong", money(l.amount_cents))),
      field("Write down by", amount),
      h("label.check-line", all, h("span", "Don't charge for this line at all")),
      field("Reason", reason, { required: true, hint: "Kept on the invoice record." }),
      after,
      err,
      h(
        "div.form-actions",
        l.writedown_cents ? button("Remove write-down", { onclick: () => send({ amountCents: 0 }) }) : null,
        button("Cancel", { onclick: () => dlg.close() }),
        button("Write down", { variant: "primary", type: "submit" }),
      ),
    );
    update();
    const dlg = modal("Write down a line", form, { subtitle: "Reduce what the client is charged for this line." });
    amount.focus();
  }

  async function removeLine(l) {
    const src = l.source_time_id ? " The time entry goes back to unbilled." : l.source_expense_id ? " The expense goes back to unbilled." : "";
    const ok = await confirmDialog("Remove this line?", [`“${l.description || "This line"}” comes off the draft.${src}`], {
      confirmLabel: "Remove line",
      danger: true,
    });
    if (!ok) return;
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
    return card({
      className: "bl-totals",
      title: "Totals",
      icon: "receipt",
      body: [
        row("Services and expenses", money(t.subtotal_cents)),
        t.discount_cents ? row(discountLabel, `-${money(t.discount_cents)}`) : null,
        t.tax_cents ? row("Sales tax", money(t.tax_cents)) : null,
        row("Invoice total", money(t.total_cents), ".grand"),
        inv.status === "final" || inv.paid_cents ? row("Payments received", inv.paid_cents ? `-${money(inv.paid_cents)}` : money(0)) : null,
        inv.written_off_cents ? row("Written off", `-${money(inv.written_off_cents)}`) : null,
        inv.status === "final" ? row("Amount due", money(inv.balance_cents), ".due" + (inv.balance_cents > 0 && inv.due_on < now ? ".late" : "")) : null,
        inv.status === "final" && credit > 0 ? h("p.bl-card-note", `${inv.client?.name ?? "The client"} has ${money(credit)} of unused credit.`) : null,
      ],
    });
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
    const dUnit = h("span.muted.bl-unit", inv.discount_kind === "percent" ? "%" : "");
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
    return card({
      className: "bl-details",
      title: "Invoice details",
      icon: "pencil",
      body: h(
        "div.form-grid",
        field("Invoice date", issued, { hint: inv.issued_on ? null : "Left blank, it is dated the day you finalize." }),
        field("Due date", due, {
          hint: inv.due_on
            ? null
            : `Left blank, it is due ${settings.payment_terms_days} days after the invoice date (${fmtDate(termsDue, now)} if dated ${inv.issued_on ? fmtDate(inv.issued_on, now) : "today"}).`,
        }),
        h("div.field", h("span.field-label", "Discount"), h("div.bl-discount", dKind, dValue, dUnit)),
        field("Note to the client", notes, { optional: true }),
        inv.period_from || inv.period_to
          ? h(
              "p.field-hint",
              `Work ${inv.period_from ? `from ${fmtDate(inv.period_from, now)} ` : ""}${inv.period_to ? `through ${fmtDate(inv.period_to, now)}` : ""}.`,
            )
          : null,
        err,
      ),
    });
  }

  function infoCard() {
    return card({
      className: "bl-details",
      title: "Invoice details",
      icon: "file-text",
      body: [
        kv([
          inv.issued_on ? ["Invoice date", fmtDate(inv.issued_on, now)] : null,
          inv.due_on ? ["Due date", fmtDate(inv.due_on, now)] : null,
          inv.client?.name ? ["Billed to", inv.client.name] : null,
          inv.period_to ? ["Work through", fmtDate(inv.period_to, now)] : null,
        ]),
        inv.notes ? h("div.bl-info-note", h("span.field-label", "Note to the client"), h("p.pre", inv.notes)) : null,
      ],
    });
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
    return card({
      className: "bl-payments",
      title: "Payments",
      icon: "landmark",
      flush: !!items.length,
      body: items.length
        ? h(
            "ul.bl-pay-list",
            items.map((p) =>
              h(
                "li" + (p.released ? ".released" : ""),
                h(
                  "span.cell-stack",
                  h("span", p.what),
                  h("span.cell-sub", fmtDate(p.date, now), p.released ? ` · taken back ${fmtDate(p.released, now)}` : ""),
                ),
                h("strong.bl-pay-amt", money(p.amount)),
              ),
            ),
          )
        : emptyState({
            icon: "landmark",
            title: "No payments yet",
            body: inv.status === "final" ? "Payments you record against this invoice appear here." : null,
            compact: true,
          }),
    });
  }

  // -------------------------------------------------------------- actions
  async function deleteDraft() {
    const ok = await confirmDialog("Delete this draft?", ["Its time and expenses go back to unbilled. No invoice number is used."], {
      confirmLabel: "Delete draft",
      danger: true,
    });
    if (!ok) return;
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
      h("div.form-row.bl-two", field("Amount received", amount), field("Date received", date)),
      h("div.form-row.bl-two", field("How it was paid", method), field("Reference", ref, { optional: true })),
      h("p.field-hint", "Anything over the amount due is kept as credit for the client. To spread one payment over several invoices, use Payments."),
      err,
      h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), button("Record payment", { variant: "primary", type: "submit" })),
    );
    const dlg = modal("Record a payment", form, { subtitle: `Invoice ${inv.number}: ${money(inv.balance_cents)} due` });
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
            const ok = await confirmDialog(`Write off ${money(cents)}?`, [`On invoice ${inv.number}. This can't be undone.`], {
              confirmLabel: "Write off",
              danger: true,
            });
            if (!ok) return;
            await post(`/billing/invoices/${id}/write-off`, { amountCents: cents, reason: reason.value });
            dlg.close();
            toast(`${money(cents)} written off`);
            load();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      field("Amount to write off", amount),
      field("Reason", reason, { required: true }),
      err,
      h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), button("Write off", { variant: "primary", type: "submit" })),
    );
    const dlg = modal("Write off amount due", form, {
      subtitle: "Use this when the firm won't collect part or all of what is owed. The invoice itself doesn't change.",
    });
  }

  await load();
  return page;
}

export const PAY_METHODS = ["Check", "Bank transfer", "Credit card", "Cash", "Other"];
