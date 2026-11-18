// Client trust accounts: list of accounts, account register, client ledgers, the forms for
// every kind of entry, the monthly three-way reconciliation and the printable reports.
// The server enforces every rule; these screens only collect input and explain refusals.

import { h, replace, select, toast, modal, fmtDate, plural } from "../dom.js";
import { get, post, put, patch } from "../api.js";
import { state, today } from "../state.js";
import { pageHeader, card, stat as kitStat, callout, button, emptyState, pill, segmented, field } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { menu } from "../ui/popover.js";
import { icon } from "../ui/icons.js";

// ------------------------------------------------------------------ money

/** 123456 -> "$1,234.56" */
export function fmtMoney(c) {
  const neg = c < 0;
  const a = Math.abs(c);
  const d = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${d}.${String(a % 100).padStart(2, "0")}`;
}

/** "1,234.5" -> 123450 cents, without floating point. null if not an amount. */
export function parseMoney(s) {
  const m = /^\s*\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(String(s ?? ""));
  if (!m) return null;
  return Number(m[1].replace(/,/g, "")) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

const fail = (err) => toast(err.message, { error: true, ms: 12000 });
const kindName = (a) => (a.kind === "iolta" ? "IOLTA" : "Non-IOLTA trust");
const printLink = (path, label, opts = {}) => button(label, { size: "sm", icon: "file-text", href: "/api" + path, target: "_blank", rel: "noopener", ...opts });
const bankLine = (a) => `${a.bank_name}${a.account_last4 ? " ····" + a.account_last4 : ""}`;

/** Page header with trust breadcrumbs; actions sit in div.trust-head-actions. */
function trustHead({ crumbs = null, title, subtitle = null, actions = null, meta = null }) {
  const el = pageHeader({
    breadcrumbs: crumbs ? [{ label: "Trust accounts", href: "#/trust" }, ...crumbs] : null,
    title,
    subtitle,
    meta,
    actions: actions ? [h("div.trust-head-actions", actions)] : null,
  });
  el.querySelector(".breadcrumbs")?.classList.add("trust-crumb");
  return el;
}

const moneyCol = (key, label, get, extra = {}) => ({ key, label, align: "right", className: "trust-n", sortable: false, render: (r) => (get(r) == null ? "" : money(get(r))), ...extra });
const money = (c, cls = "") => h("span.trust-money" + cls, fmtMoney(c));

function amountInput(label = "Amount") {
  return h("input", { inputmode: "decimal", required: true, placeholder: "0.00", "aria-label": label, autocomplete: "off", maxlength: 20 });
}

function readAmount(input) {
  const c = parseMoney(input.value);
  if (c == null || c <= 0) throw new Error("Enter an amount such as 1,250.00");
  return c;
}

function dateInput(value = today()) {
  return h("input", { type: "date", value, required: true });
}

/** The "needs lawyer and accountant review" notice, with the rules it cites. */
function reviewNotice() {
  const el = callout({
    tone: "warning",
    title: "Review before real use.",
    body: [
      " This trust ledger follows Kansas Rule of Professional Conduct 1.15 as read from the Kansas courts' published rule. It has not been checked against the Disciplinary Administrator's Trust Account Handbook. The responsible lawyer and an accountant must review it before it holds real client money. ",
      h("a", { href: "/api/trust/rules/print", target: "_blank", rel: "noopener" }, "Rules this follows"),
      ".",
    ],
  });
  el.classList.add("trust-notice");
  el.setAttribute("role", "note");
  return el;
}

/** A form inside a modal: fields, an error line, Cancel / submit. */
function formDialog(title, fields, submitLabel, onSubmit, opts = {}) {
  const err = h("p.error-text", { role: "alert" });
  const submit = h("button.btn.primary", { type: "submit" }, submitLabel);
  const form = h(
    "form.modal-body.form-grid.trust-form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        submit.disabled = true;
        try {
          await onSubmit();
          dlg.close();
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    fields,
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), submit),
  );
  const dlg = modal(title, form, { wide: !!opts.wide });
  form.querySelector("input, select, textarea")?.focus();
  return dlg;
}

function matterOptions(matters) {
  return [{ value: "", label: "Choose a matter…" }, ...matters.map((m) => ({ value: m.id, label: `${m.client_name ?? "No client"} — ${m.number ? m.number + " " : ""}${m.name}` }))];
}

// ----------------------------------------------------------- accounts list

export async function trustView() {
  const accounts = await get("/trust/accounts");
  const page = h("div.page.trust");
  const newBtn = button("New trust account", { variant: "primary", icon: "plus", onclick: newAccountDialog });
  const total = accounts.filter((a) => !a.closed_on).reduce((s, a) => s + a.balance_cents, 0);
  page.append(
    pageHeader({
      title: "Client trust accounts",
      subtitle: "Money held for clients, kept apart from the firm's own, with a ledger for every client matter.",
      actions: [newBtn],
    }),
    reviewNotice(),
    accounts.length > 1 ? h("div.stats.trust-stats", kitStat({ label: "Held in all open accounts", value: fmtMoney(total), icon: "trust" })) : null,
    card({
      flush: true,
      className: "table-card",
      body: dataTable({
        columns: [
          {
            key: "name",
            label: "Account",
            primary: true,
            sort: (a) => a.name,
            render: (a) => h("div.cell-stack", h("a.cell-title", { href: `#/trust/accounts/${a.id}` }, a.name), h("span.cell-sub", bankLine(a))),
          },
          { key: "kind", label: "Type", sort: (a) => a.kind, render: (a) => h("span.trust-type", kindName(a), a.closed_on ? pill("Closed", "neutral") : null) },
          { key: "balance", label: "Balance", align: "right", className: "trust-n", sort: (a) => a.balance_cents, render: (a) => money(a.balance_cents) },
          { key: "ledgers", label: "Client ledgers", align: "right", sort: (a) => a.client_ledgers, render: (a) => String(a.client_ledgers) },
          {
            key: "rec",
            label: "Last reconciled",
            sort: (a) => a.last_reconciled?.period || "",
            render: (a) =>
              a.last_reconciled
                ? h("div.cell-stack", h("span", a.last_reconciled.period), h("span.cell-sub", `Signed ${fmtDate(a.last_reconciled.signed_on, today())}`))
                : pill("Not yet", "warning"),
          },
        ],
        rows: accounts,
        rowHref: (a) => `#/trust/accounts/${a.id}`,
        toolbar: false,
        tableClass: "trust-table",
        label: "Trust accounts",
        noun: ["account", "accounts"],
        empty: emptyState({
          icon: "trust",
          title: "No trust accounts yet",
          body: "Set up the firm's IOLTA account with New trust account to start recording client money.",
        }),
      }),
    }),
  );
  return page;
}

function newAccountDialog() {
  const name = h("input", { required: true, maxlength: 200, value: "IOLTA trust account" });
  const bank = h("input", { required: true, maxlength: 200 });
  const last4 = h("input", { maxlength: 4, inputmode: "numeric", pattern: "\\d{4}", placeholder: "1234" });
  const kind = select([{ value: "iolta", label: "IOLTA (pooled; interest goes to the Kansas Bar Foundation)" }, { value: "non_iolta", label: "Non-IOLTA (interest belongs to the client)" }], "iolta");
  const limit = h("input", { inputmode: "decimal", placeholder: "e.g. 100.00", maxlength: 20 });
  const opened = dateInput();
  const kansas = h("input", { type: "checkbox", required: true });
  const cleared = h("input", { type: "checkbox", checked: true });
  formDialog(
    "New trust account",
    [
      h("label", "Account name", name),
      h("label", "Bank", bank),
      h("div.form-row", h("label", "Last four digits", last4), h("label", "Opened on", opened), h("label", "Firm funds for bank charges, up to", limit)),
      h("label", "Type", kind),
      h("label.trust-check", kansas, h("span", "This is a separate trust account maintained at a bank in Kansas (KRPC 1.15(a)).")),
      h("label.trust-check", cleared, h("span", "Only allow payments from deposits the bank has cleared (recommended).")),
      h("p.muted.small", "Only the last four digits of the account number are stored. The limit is the most firm money the lawyer considers reasonably sufficient to cover bank charges (KRPC 1.15(d)(1)(i)); no firm money can be deposited until it is set."),
    ],
    "Set up account",
    async () => {
      const lim = limit.value.trim() ? parseMoney(limit.value) : null;
      if (limit.value.trim() && lim == null) throw new Error("Enter the bank-charge limit as an amount, such as 100.00");
      const a = await post("/trust/accounts", {
        name: name.value,
        bankName: bank.value,
        accountLast4: last4.value || null,
        kind: kind.value,
        inKansas: kansas.checked,
        requireCleared: cleared.checked,
        firmFundsLimitCents: lim,
        openedOn: opened.value,
      });
      toast(`Set up ${a.name}`);
      location.hash = `#/trust/accounts/${a.id}`;
    },
    { wide: true },
  );
}

// ------------------------------------------------------------ one account

export async function trustAccountView([id]) {
  const page = h("div.page.trust");
  let tab = "register";
  let data;

  async function load() {
    const [account, journal, ledgers, matters] = await Promise.all([
      get(`/trust/accounts/${id}`),
      get(`/trust/accounts/${id}/journal`),
      get(`/trust/accounts/${id}/ledgers?all=1`),
      get("/matters?status=all"),
    ]);
    data = { account, journal, ledgers, matters };
    draw();
  }
  const reload = () => load().catch(fail);

  function draw() {
    const { account: a } = data;
    const open = !a.closed_on;
    const more = open
      ? [
          { label: "Earned fees to operating", icon: "arrow-right", onSelect: () => feeDialog(data, reload) },
          { label: "Transfer between clients", icon: "arrow-up-down", onSelect: () => transferDialog(data, reload) },
          "-",
          { label: "Bank charge", icon: "receipt", onSelect: () => bankFeeDialog(data, reload) },
          { label: "Firm funds for bank charges", icon: "wallet", onSelect: () => firmFundsDialog(data, reload) },
          a.kind === "non_iolta" ? { label: "Interest", icon: "plus", onSelect: () => interestDialog(data, reload) } : null,
        ].filter(Boolean)
      : [];
    const actions = open
      ? h(
          "div.trust-actions",
          button("Record deposit", { variant: "primary", icon: "plus", onclick: () => depositDialog(data, reload) }),
          button("Record payment", { icon: "arrow-right", onclick: () => paymentDialog(data, reload) }),
          button("More entries", { iconRight: "chevron-down", "aria-haspopup": "menu", onclick: (e) => menu(e.currentTarget, more, "More trust entries") }),
        )
      : null;
    const limitHint = a.firm_funds_limit_cents == null ? "No limit set" : `Limit ${fmtMoney(a.firm_funds_limit_cents)}`;
    const uncleared = a.balance_cents - a.cleared_balance_cents;
    replace(
      page,
      trustHead({
        crumbs: [{ label: a.name }],
        title: a.name,
        meta: [h("span", kindName(a)), h("span", bankLine(a)), a.closed_on ? pill(`Closed ${fmtDate(a.closed_on, today())}`, "neutral") : pill("Open", "info")],
        actions: [
          button("Reconcile a month", { icon: "circle-check", href: `#/trust/accounts/${a.id}/reconcile` }),
          button("Reports", { icon: "reports", href: `#/trust/accounts/${a.id}/reports` }),
          button("Account settings", { icon: "settings", variant: "ghost", onclick: () => settingsDialog(a, reload) }),
        ],
      }),
      h(
        "div.stats.trust-stats",
        kitStat({ label: "Balance per books", value: fmtMoney(a.balance_cents), icon: "trust" }),
        kitStat({ label: "Cleared at the bank", value: fmtMoney(a.cleared_balance_cents), icon: "landmark", hint: uncleared ? `${fmtMoney(uncleared)} not cleared yet` : "Everything has cleared" }),
        kitStat({ label: "Firm funds for bank charges", value: fmtMoney(a.firm_balance_cents), icon: "wallet", hint: limitHint }),
        kitStat({
          label: "Reconciled and locked through",
          value: a.locked_through ? fmtDate(a.locked_through, today()) : "Not yet",
          icon: "lock",
          tone: a.locked_through ? null : "warning",
          hint: a.locked_through ? null : "No month signed off yet",
        }),
      ),
      h(
        "div.trust-toolbar",
        segmented(
          [
            { value: "register", label: "Register", count: data.journal.length },
            { value: "ledgers", label: "Client ledgers", count: data.ledgers.length },
          ],
          tab,
          (v) => ((tab = v), draw()),
          { label: "Show" },
        ),
        actions,
      ),
      card({ flush: true, className: "table-card", body: tab === "register" ? register(data, reload) : ledgerList(data) }),
    );
  }

  await load();
  return page;
}

/** Date cell with the entry number underneath. */
const dateCell = (r) => h("div.cell-stack", h("span.nowrap", fmtDate(r.date, today())), h("span.cell-sub", `Entry ${r.id}`));

function register({ account: a, journal }, reload) {
  const who = (r) => (r.lines.length === 1 ? r.lines[0].label : r.lines.map((l) => `${l.label} ${fmtMoney(l.amount_cents)}`).join("; "));
  return dataTable({
    columns: [
      { key: "date", label: "Date", className: "nowrap", render: dateCell },
      {
        key: "type",
        label: "Type",
        primary: true,
        render: (r) => h("div.cell-stack", h("span.trust-kind", r.kind_label), r.reversed_by_id != null ? h("span.cell-sub", `Reversed by entry ${r.reversed_by_id}`) : null),
      },
      { key: "ledger", label: "Client ledger", render: who },
      { key: "details", label: "Details", render: (r) => r.description || h("span.faint", "—") },
      { key: "bank", label: "Bank", render: (r) => clearedCell(r, a.locked_through && r.date <= a.locked_through, reload) },
      moneyCol("in", "In", (r) => (r.amount_cents > 0 ? r.amount_cents : null)),
      moneyCol("out", "Out", (r) => (r.amount_cents < 0 ? -r.amount_cents : null)),
      moneyCol("balance", "Balance", (r) => r.balance_cents, { className: "trust-n trust-bal" }),
      {
        key: "actions",
        label: "",
        phoneLabel: "",
        render: (r) => (r.kind !== "reversal" && r.reversed_by_id == null && !a.closed_on ? button("Reverse", { size: "sm", variant: "ghost", icon: "rotate-ccw", onclick: () => reverseDialog(r, reload) }) : null),
      },
    ],
    rows: [...journal].reverse(),
    rowClass: (r) => (r.reversed_by_id != null || r.kind === "reversal" ? "trust-reversed" : ""),
    sortable: false,
    search: { placeholder: "Search entries", text: (r) => [r.kind_label, r.description, who(r), String(r.id), fmtMoney(Math.abs(r.amount_cents))] },
    tableClass: "trust-table trust-register",
    label: "Trust register",
    noun: ["entry", "entries"],
    empty: emptyState({ icon: "trust", title: "No entries yet", body: "Record the first deposit to start the register.", compact: true }),
  });
}

function clearedCell(r, locked, reload) {
  if (r.amount_cents === 0) return h("span.muted", "No bank effect");
  if (r.cleared_on) {
    return h(
      "span.trust-cleared",
      pill(`Cleared ${fmtDate(r.cleared_on, today())}`, "success"),
      locked || r.kind === "bank_fee" || r.kind === "interest" ? null : h("button.link-btn", { type: "button", onclick: () => setCleared(r.id, null, reload) }, "Undo"),
    );
  }
  return h("span.trust-uncleared", pill("Not cleared", "warning"), h("button.link-btn", { type: "button", onclick: () => clearDialog(r, reload) }, "Mark cleared"));
}

async function setCleared(id, clearedOn, reload) {
  try {
    await put(`/trust/entries/${id}/cleared`, { clearedOn });
    toast(clearedOn ? "Marked cleared" : "Marked not cleared");
    reload();
  } catch (err) {
    fail(err);
  }
}

function clearDialog(r, reload) {
  const d = dateInput(today() < r.date ? r.date : today());
  formDialog("Mark cleared", [h("p", `${r.kind_label} of ${fmtMoney(Math.abs(r.amount_cents))} on ${fmtDate(r.date, today())}.`), h("label", "Date the bank shows it cleared", d)], "Mark cleared", async () => {
    await put(`/trust/entries/${r.id}/cleared`, { clearedOn: d.value });
    toast("Marked cleared");
    reload();
  });
}

function ledgerList({ ledgers }) {
  return dataTable({
    columns: [
      {
        key: "label",
        label: "Client and matter",
        primary: true,
        sort: (l) => l.label,
        render: (l) => h("div.cell-stack", h("a.cell-title", { href: `#/trust/ledgers/${l.id}` }, l.label), l.matter_status === "closed" ? h("span.cell-sub", pill("Matter closed", "neutral")) : null),
      },
      moneyCol("balance", "Balance", (l) => l.balance_cents, { sortable: true, sort: (l) => l.balance_cents }),
      { key: "held", label: "On hold", align: "right", className: "trust-n", sort: (l) => l.held_cents, render: (l) => (l.held_cents ? money(l.held_cents) : h("span.faint", "—")) },
      moneyCol("available", "Available to pay out", (l) => l.available_cents, { sortable: true, sort: (l) => l.available_cents, phoneLabel: "Available" }),
      { key: "last", label: "Last activity", className: "nowrap", sort: (l) => l.last_activity || "", render: (l) => (l.last_activity ? fmtDate(l.last_activity, today()) : h("span.faint", "—")) },
    ],
    rows: ledgers,
    rowHref: (l) => `#/trust/ledgers/${l.id}`,
    search: ledgers.length > 8 ? { placeholder: "Search clients and matters", text: (l) => [l.label] } : null,
    toolbar: ledgers.length > 8,
    tableClass: "trust-table",
    label: "Client ledgers",
    noun: ["ledger", "ledgers"],
    empty: emptyState({ icon: "trust", title: "No ledgers yet", body: "A client ledger starts with the first deposit for that matter.", compact: true }),
  });
}

// ------------------------------------------------------------------- forms

function depositDialog({ account: a, matters }, reload) {
  const m = select(matterOptions(matters), "", { required: true });
  const amt = amountInput();
  const d = dateInput();
  const from = h("input", { required: true, maxlength: 200, placeholder: "Who paid it" });
  const how = select([{ value: "deposit_slip", label: "Deposit slip (check or cash at the bank)" }, { value: "eft", label: "Electronic transfer" }, { value: "wire", label: "Wire" }], "deposit_slip");
  const ref = h("input", { maxlength: 100, placeholder: "Payor's check number or reference" });
  const memo = h("input", { maxlength: 500, placeholder: "e.g. Retainer for costs" });
  const clearedNow = h("input", { type: "checkbox" });
  formDialog(
    `Record deposit to ${a.name}`,
    [
      h("label", "Client matter", m),
      h("div.form-row", h("label", "Amount", amt), h("label", "Date deposited", d), h("label", "Method", how)),
      h("label", "Received from", from),
      h("label", "Reference", ref),
      h("label", "Memo", memo),
      h("label.trust-check", clearedNow, h("span", "The bank already shows these funds as collected (cleared) on this date")),
      h("p.muted.small", "Remember to notify the client that the funds were received (KRPC 1.15(b)). Lawdesk does not send that notice."),
    ],
    "Record deposit",
    async () => {
      if (!m.value) throw new Error("Choose the client matter");
      await post(`/trust/accounts/${a.id}/deposits`, { matterId: Number(m.value), amountCents: readAmount(amt), date: d.value, party: from.value, method: how.value, reference: ref.value || null, memo: memo.value, clearedOn: clearedNow.checked ? d.value : null });
      toast("Deposit recorded");
      reload();
    },
    { wide: true },
  );
}

function paymentDialog({ account: a, matters, ledgers }, reload) {
  const withMoney = new Set(ledgers.filter((l) => l.kind === "client" && l.balance_cents > 0).map((l) => l.matter_id));
  const m = select(matterOptions(matters.filter((x) => withMoney.has(x.id))), "", { required: true });
  const avail = h("p.muted.small");
  m.addEventListener("change", () => {
    const l = ledgers.find((x) => x.matter_id === Number(m.value));
    avail.textContent = l ? `Balance ${fmtMoney(l.balance_cents)}; available to pay out ${fmtMoney(l.available_cents)}.` : "";
  });
  const amt = amountInput();
  const d = dateInput();
  const payee = h("input", { required: true, maxlength: 200 });
  const how = select([{ value: "check", label: "Check" }, { value: "eft", label: "Electronic transfer" }, { value: "wire", label: "Wire" }], "check");
  const num = h("input", { inputmode: "numeric", maxlength: 20, value: "" });
  const numLabel = h("label", "Check number", num);
  how.addEventListener("change", () => (numLabel.hidden = how.value !== "check"));
  const memo = h("input", { required: true, maxlength: 500, placeholder: "What it is for" });
  formDialog(
    `Record payment from ${a.name}`,
    [h("label", "Client matter", m), avail, h("div.form-row", h("label", "Amount", amt), h("label", "Date", d), h("label", "Paid by", how)), numLabel, h("label", "Payee", payee), h("label", "For", memo)],
    "Record payment",
    async () => {
      if (!m.value) throw new Error("Choose the client matter");
      await post(`/trust/accounts/${a.id}/disbursements`, { matterId: Number(m.value), amountCents: readAmount(amt), date: d.value, party: payee.value, method: how.value, checkNumber: how.value === "check" ? num.value : null, memo: memo.value });
      toast("Payment recorded");
      reload();
    },
    { wide: true },
  );
}

function feeDialog({ account: a, ledgers }, reload) {
  const clientLedgers = ledgers.filter((l) => l.kind === "client" && l.balance_cents > 0);
  const m = select([{ value: "", label: "Choose a matter…" }, ...clientLedgers.map((l) => ({ value: l.matter_id, label: l.label }))], "", { required: true });
  const inv = select([{ value: "", label: "Choose the matter first" }], "", { required: true });
  const info = h("p.muted.small");
  const amt = amountInput();
  const d = dateInput();
  let invoices = [];
  m.addEventListener("change", async () => {
    invoices = m.value ? (await get(`/billing/invoices?matterId=${m.value}&status=final`).catch(() => [])) : [];
    inv.replaceChildren(...select([{ value: "", label: invoices.length ? "Choose an invoice…" : "No finalized invoices" }, ...invoices.map((i) => ({ value: i.id, label: `Invoice ${i.number} · ${fmtMoney(i.total_cents)} · issued ${i.issued_on}` }))], "").children);
    const l = clientLedgers.find((x) => x.matter_id === Number(m.value));
    info.textContent = l ? `Available in trust for this matter: ${fmtMoney(l.available_cents)}.` : "";
  });
  formDialog(
    "Move earned fees to operating",
    [
      h("p.muted.small", "Earned fees can leave trust only against a finalized invoice, for no more than is still owed on it. Lawdesk records the payment on the invoice at the same time."),
      h("label", "Client matter", m),
      info,
      h("label", "Invoice", inv),
      h("div.form-row", h("label", "Amount", amt), h("label", "Date", d)),
    ],
    "Move to operating",
    async () => {
      if (!inv.value) throw new Error("Choose a finalized invoice");
      await post(`/trust/accounts/${a.id}/fee-transfers`, { invoiceId: Number(inv.value), amountCents: readAmount(amt), date: d.value });
      toast("Earned fees moved; payment recorded on the invoice");
      reload();
    },
    { wide: true },
  );
}

function transferDialog({ account: a, matters, ledgers }, reload) {
  const withMoney = new Set(ledgers.filter((l) => l.kind === "client" && l.balance_cents > 0).map((l) => l.matter_id));
  const from = select(matterOptions(matters.filter((x) => withMoney.has(x.id))), "", { required: true });
  const to = select(matterOptions(matters.filter((x) => x.client_id)), "", { required: true });
  const amt = amountInput();
  const d = dateInput();
  const memo = h("input", { required: true, maxlength: 500, placeholder: "e.g. Client's written instruction dated 10/3" });
  formDialog(
    "Transfer between client ledgers",
    [h("label", "From", from), h("label", "To", to), h("div.form-row", h("label", "Amount", amt), h("label", "Date", d)), h("label", "Reason", memo)],
    "Transfer",
    async () => {
      await post(`/trust/accounts/${a.id}/ledger-transfers`, { fromMatterId: Number(from.value), toMatterId: Number(to.value), amountCents: readAmount(amt), date: d.value, memo: memo.value });
      toast("Transfer recorded");
      reload();
    },
    { wide: true },
  );
}

function bankFeeDialog({ account: a }, reload) {
  const amt = amountInput();
  const d = dateInput();
  const memo = h("input", { required: true, maxlength: 500, placeholder: "As shown on the statement, e.g. Monthly service charge" });
  formDialog(
    "Record a bank charge",
    [h("p.muted.small", `Paid from the firm's bank-charge funds (now ${fmtMoney(a.firm_balance_cents)}). Bank charges are never taken from client money.`), h("div.form-row", h("label", "Amount", amt), h("label", "Date", d)), h("label", "Description", memo)],
    "Record charge",
    async () => {
      await post(`/trust/accounts/${a.id}/bank-fees`, { amountCents: readAmount(amt), date: d.value, memo: memo.value });
      toast("Bank charge recorded");
      reload();
    },
  );
}

function firmFundsDialog({ account: a }, reload) {
  const dir = select([{ value: "in", label: "Deposit firm money for bank charges" }, { value: "out", label: "Withdraw firm money" }], "in");
  const amt = amountInput();
  const d = dateInput();
  const memo = h("input", { maxlength: 500 });
  formDialog(
    "Firm funds for bank charges",
    [
      h("p.muted.small", `The only firm money allowed in trust is enough to cover bank charges (KRPC 1.15(d)(1)(i)). Now ${fmtMoney(a.firm_balance_cents)}; limit ${a.firm_funds_limit_cents == null ? "not set" : fmtMoney(a.firm_funds_limit_cents)}.`),
      h("label", "What", dir),
      h("div.form-row", h("label", "Amount", amt), h("label", "Date", d)),
      h("label", "Memo", memo),
    ],
    "Record",
    async () => {
      await post(`/trust/accounts/${a.id}/${dir.value === "in" ? "firm-deposits" : "firm-withdrawals"}`, { amountCents: readAmount(amt), date: d.value, memo: memo.value });
      toast("Recorded");
      reload();
    },
  );
}

function interestDialog({ account: a, matters }, reload) {
  const m = select(matterOptions(matters), "", { required: true });
  const amt = amountInput();
  const d = dateInput();
  formDialog("Record interest", [h("p.muted.small", "Interest on a non-IOLTA account belongs to the client whose money earned it."), h("label", "Client matter", m), h("div.form-row", h("label", "Amount", amt), h("label", "Date", d))], "Record interest", async () => {
    await post(`/trust/accounts/${a.id}/interest`, { matterId: Number(m.value), amountCents: readAmount(amt), date: d.value });
    toast("Interest recorded");
    reload();
  });
}

function reverseDialog(r, reload) {
  const reason = h("textarea", { required: true, maxlength: 500, rows: 3, placeholder: "e.g. Check 1005 voided: wrong payee" });
  const d = dateInput(today() < r.date ? r.date : today());
  formDialog(
    "Reverse an entry",
    [
      h("p", `${r.kind_label} of ${fmtMoney(Math.abs(r.amount_cents))} on ${fmtDate(r.date, today())} (entry ${r.id}).`),
      h("p.muted.small", "Trust entries are never edited or deleted. A reversal adds an equal and opposite entry; both stay in the register. Reversing an earned-fee transfer also voids the payment it recorded on the invoice."),
      h("label", "Reason", reason),
      h("label", "Date of the reversal", d),
    ],
    "Reverse entry",
    async () => {
      await post(`/trust/entries/${r.id}/reverse`, { reason: reason.value, date: d.value });
      toast("Entry reversed");
      reload();
    },
  );
}

function settingsDialog(a, reload) {
  const name = h("input", { required: true, maxlength: 200, value: a.name });
  const bank = h("input", { required: true, maxlength: 200, value: a.bank_name });
  const limit = h("input", { inputmode: "decimal", maxlength: 20, value: a.firm_funds_limit_cents == null ? "" : (a.firm_funds_limit_cents / 100).toFixed(2) });
  const cleared = h("input", { type: "checkbox", checked: !!a.require_cleared });
  formDialog(
    "Account settings",
    [
      h("label", "Account name", name),
      h("label", "Bank", bank),
      h("label", "Firm funds for bank charges, up to", limit),
      h("label.trust-check", cleared, h("span", "Only allow payments from deposits the bank has cleared")),
      h("p.muted.small", `Type (${kindName(a)}) and opening date (${a.opened_on}) can't be changed.`),
    ],
    "Save",
    async () => {
      const lim = limit.value.trim() ? parseMoney(limit.value) : null;
      if (limit.value.trim() && lim == null) throw new Error("Enter the limit as an amount, such as 100.00");
      await patch(`/trust/accounts/${a.id}`, { name: name.value, bankName: bank.value, firmFundsLimitCents: lim, requireCleared: cleared.checked });
      toast("Saved");
      reload();
    },
  );
}

// ---------------------------------------------------------- client ledger

export async function trustLedgerView([id]) {
  const page = h("div.page.trust");
  async function load() {
    const l = await get(`/trust/ledgers/${id}`);
    const holds = l.holds.map((x) =>
      h(
        "li.trust-hold",
        h(
          "div.trust-hold-text",
          h("div", h("strong", fmtMoney(x.amount_cents)), ` held since ${fmtDate(x.placed_on, today())}`),
          h("div.trust-hold-why", x.reason),
          x.released_on ? h("div.trust-hold-why", `Released ${fmtDate(x.released_on, today())}: ${x.release_reason}`) : null,
        ),
        x.released_on ? pill("Released", "neutral") : button("Release", { size: "sm", onclick: () => releaseDialog(x, reload) }),
      ),
    );
    replace(
      page,
      trustHead({
        crumbs: [{ label: l.account.name, href: `#/trust/accounts/${l.account.id}` }, { label: l.label }],
        title: l.label,
        subtitle: l.retention.note,
        actions: [
          printLink(`/trust/ledgers/${l.id}/print`, "Print ledger statement", { size: "md" }),
          l.kind === "client" ? button("Hold disputed funds", { icon: "hourglass", onclick: () => holdDialog(l, reload) }) : null,
        ],
      }),
      h(
        "div.stats.trust-stats",
        kitStat({ label: "Balance", value: fmtMoney(l.balance_cents), icon: "trust" }),
        kitStat({ label: "Cleared", value: fmtMoney(l.cleared_cents), icon: "circle-check" }),
        kitStat({ label: "On hold as disputed", value: fmtMoney(l.held_cents), icon: "hourglass", tone: l.held_cents ? "warning" : null }),
        kitStat({ label: "Available to pay out", value: fmtMoney(l.available_cents), icon: "wallet" }),
      ),
      l.holds.length
        ? card({
            title: "Holds on disputed funds",
            icon: "hourglass",
            body: h("ul.plain.trust-holds", holds),
            footer: "KRPC 1.15(d)(1)(ii): the disputed portion shall not be withdrawn until the dispute is finally resolved.",
            className: "trust-gap",
          })
        : null,
      card({
        title: "Ledger",
        icon: "list-checks",
        flush: true,
        className: "table-card",
        body: dataTable({
          columns: [
            { key: "date", label: "Date", className: "nowrap", render: dateCell },
            { key: "type", label: "Type", primary: true, render: (r) => r.kind_label },
            { key: "details", label: "Details", render: (r) => r.description || h("span.faint", "—") },
            moneyCol("in", "In", (r) => (r.amount_cents > 0 ? r.amount_cents : null)),
            moneyCol("out", "Out", (r) => (r.amount_cents < 0 ? -r.amount_cents : null)),
            moneyCol("balance", "Balance", (r) => r.balance_cents, { className: "trust-n trust-bal" }),
          ],
          rows: [...l.entries].reverse(),
          rowClass: (r) => (r.kind === "reversal" ? "trust-reversed" : ""),
          sortable: false,
          toolbar: false,
          tableClass: "trust-table",
          label: "Ledger entries",
          noun: ["entry", "entries"],
          empty: emptyState({ icon: "trust", title: "No activity", body: "Deposits, payments and transfers for this matter appear here.", compact: true }),
        }),
      }),
    );
  }
  const reload = () => load().catch(fail);
  await load();
  return page;
}

function holdDialog(l, reload) {
  const amt = amountInput();
  const reason = h("textarea", { required: true, rows: 3, maxlength: 500, placeholder: "Who disputes what" });
  formDialog("Hold disputed funds", [h("p.muted.small", "Held money stays in trust and can't be paid out or moved to operating until the hold is released."), h("label", "Amount", amt), h("label", "Reason", reason)], "Place hold", async () => {
    await post(`/trust/ledgers/${l.id}/holds`, { amountCents: readAmount(amt), reason: reason.value });
    toast("Hold placed");
    reload();
  });
}

function releaseDialog(x, reload) {
  const reason = h("textarea", { required: true, rows: 3, maxlength: 500, placeholder: "How the dispute was resolved" });
  formDialog("Release hold", [h("p", `${fmtMoney(x.amount_cents)}: ${x.reason}`), h("label", "Resolution", reason)], "Release", async () => {
    await post(`/trust/holds/${x.id}/release`, { reason: reason.value });
    toast("Hold released");
    reload();
  });
}

// ---------------------------------------------------- monthly reconciliation

const stepTitle = (n, text) => [h("span.trust-step", { "aria-hidden": "true" }, String(n)), h("span.visually-hidden", `Step ${n}: `), text];

function lastMonth(t) {
  const [y, m] = t.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export async function trustReconcileView([id, periodArg]) {
  const page = h("div.page.trust");
  const account = await get(`/trust/accounts/${id}`);
  let period = periodArg || (account.locked_through ? nextMonth(account.locked_through.slice(0, 7)) : lastMonth(today()));
  let statementCents = null;

  const monthIn = h("input", { type: "month", value: period, "aria-label": "Month", required: true });
  const stmtIn = h("input", { inputmode: "decimal", placeholder: "0.00", "aria-label": "Statement ending balance", maxlength: 20 });
  const notes = h("textarea", { rows: 2, maxlength: 2000, "aria-label": "Notes" });
  const body = h("div.trust-recon");

  async function load() {
    const q = statementCents == null ? "" : `?statement=${statementCents}`;
    const r = await get(`/trust/accounts/${id}/reconcile/${period}${q}`);
    if (statementCents == null && r.saved) {
      statementCents = r.saved.statement_balance_cents;
      stmtIn.value = (statementCents / 100).toFixed(2);
      notes.value = r.saved.notes || "";
    }
    draw(r);
  }
  const reload = () => load().catch(fail);

  function draw(r) {
    const p = r.preview;
    const signed = r.saved?.status === "signed";
    const end = p.period_end;
    const items = r.journal.filter((t) => !t.cleared_on || t.cleared_on > end || t.cleared_on >= `${period}-01`);
    const tick = (t) => {
      const isCleared = t.cleared_on && t.cleared_on <= end;
      const cb = h("input", {
        type: "checkbox",
        checked: !!isCleared,
        disabled: signed || t.kind === "bank_fee" || t.kind === "interest" || (account.locked_through && t.cleared_on && t.cleared_on <= account.locked_through),
        "aria-label": `Entry ${t.id} cleared`,
        onchange: async (e) => {
          try {
            await put(`/trust/entries/${t.id}/cleared`, { clearedOn: e.target.checked ? (t.date > end ? t.date : end) : null });
            reload();
          } catch (err) {
            fail(err);
            reload();
          }
        },
      });
      return cb;
    };
    const col = (ic, title, cents, rows) => h("div.trust-col", h("h3", icon(ic, { size: 16 }), title), h("div.trust-col-lines", rows), h("div.trust-col-total", h("span", "Total"), money(cents)));
    const line = (label, c) => h("div.trust-line", h("span", label), money(c));
    const diff = (label, c) => h("div.trust-line" + (c ? ".trust-bad" : ".trust-ok"), h("span", label), money(c));
    const signBtn = button("Sign off and lock", {
        variant: "primary",
        icon: "lock",
        disabled: !p.balanced || signed,
        onclick: async () => {
          const me = state.setup?.users.find((u) => u.id === state.me)?.name ?? "the selected user";
          if (!confirm(`Sign the ${period} reconciliation as ${me}? Once signed, the month is locked: nothing can be added or changed in it.`)) return;
          try {
            await put(`/trust/accounts/${id}/reconcile/${period}`, { statementBalanceCents: statementCents, notes: notes.value });
            await post(`/trust/accounts/${id}/reconcile/${period}/sign`);
            toast(`${period} reconciliation signed and locked`);
            reload();
          } catch (err) {
            fail(err);
          }
        },
      });
    const verdict = callout({
      tone: p.balanced ? "success" : "danger",
      title: p.balanced ? "Balanced." : "Does not balance.",
      body: p.balanced ? " All three agree to the cent." : " " + (p.problems.join(" ") || "Check the entries ticked above and the statement balance."),
    });
    verdict.classList.add("trust-verdict", p.balanced ? "trust-ok" : "trust-bad");
    verdict.setAttribute("role", "status");
    replace(
      body,
      signed
        ? callout({
            tone: "success",
            title: `Signed by ${r.saved.signed_by_name} on ${fmtDate(r.saved.signed_on, today())}.`,
            body: " This month is locked.",
            action: printLink(`/trust/accounts/${id}/reconciliations/${period}/print`, "Print report"),
          })
        : r.unsignedBefore
          ? callout({
              tone: "warning",
              title: `The ${r.unsignedBefore} reconciliation hasn't been signed yet.`,
              body: " Months are signed in order.",
              action: button(`Go to ${r.unsignedBefore}`, { size: "sm", onclick: () => go(r.unsignedBefore) }),
            })
          : null,
      card({
        title: stepTitle(2, "Tick what cleared the bank"),
        subtitle: `Tick each entry that appears on the ${period} statement. Anything left unticked is listed as outstanding.`,
        flush: true,
        className: "table-card",
        body: dataTable({
          columns: [
            { key: "cleared", label: "Cleared", phoneLabel: "Cleared", render: tick, className: "trust-tick" },
            { key: "date", label: "Date", className: "nowrap", render: dateCell },
            { key: "type", label: "Type", primary: true, render: (t) => t.kind_label },
            { key: "details", label: "Details", render: (t) => t.description || h("span.faint", "—") },
            moneyCol("amount", "Amount", (t) => t.amount_cents),
          ],
          rows: items,
          sortable: false,
          toolbar: false,
          pageSize: 500,
          tableClass: "trust-table",
          label: "Entries to tick",
          noun: ["entry", "entries"],
          empty: emptyState({ icon: "circle-check", title: "No entries through this month", compact: true }),
        }),
      }),
      card({
        title: stepTitle(3, "Compare the three balances"),
        subtitle: statementCents == null ? "Enter the statement's ending balance in step 1 to compare." : `As of ${fmtDate(end, today())}.`,
        body: [
          h(
            "div.trust-three",
            col("landmark", "Bank", p.adjusted_bank_cents, [
              line("Statement ending balance", p.statement_balance_cents),
              line("Plus deposits in transit", p.deposits_in_transit_cents),
              line("Less outstanding checks and payments", -p.outstanding_payments_cents),
            ]),
            col("file-text", "Trust journal", p.journal_cents, [line(`Balance at ${fmtDate(end, today())}`, p.journal_cents)]),
            col("users", "Client ledgers", p.ledgers_cents, p.ledgers.length ? p.ledgers.map((g) => line(g.label, g.balance_cents)) : [h("div.trust-line.muted", "No client money held")]),
          ),
          h("div.trust-diffs", diff("Bank minus journal", p.bank_vs_journal_cents), diff("Journal minus ledgers", p.journal_vs_ledgers_cents)),
          verdict,
          signed ? null : h("div.form-grid.trust-notes", field("Notes", notes, { optional: true })),
        ],
        footer: signed
          ? null
          : h(
              "div.trust-recon-actions",
              button("Save draft", {
                disabled: statementCents == null,
                onclick: async () => {
                  try {
                    await put(`/trust/accounts/${id}/reconcile/${period}`, { statementBalanceCents: statementCents, notes: notes.value });
                    toast("Draft saved");
                    reload();
                  } catch (err) {
                    fail(err);
                  }
                },
              }),
              signBtn,
            ),
      }),
    );
  }

  function go(p) {
    period = p;
    monthIn.value = p;
    statementCents = null;
    stmtIn.value = "";
    notes.value = "";
    history.replaceState(null, "", `#/trust/accounts/${id}/reconcile/${p}`);
    reload();
  }

  monthIn.addEventListener("change", () => monthIn.value && go(monthIn.value));
  stmtIn.addEventListener("change", () => {
    const c = stmtIn.value.trim() === "" ? null : parseMoney(stmtIn.value.replace(/^-/, ""));
    if (stmtIn.value.trim() && c == null) return toast("Enter the balance as an amount, such as 12,345.67", { error: true });
    statementCents = c;
    reload();
  });

  page.append(
    trustHead({
      crumbs: [{ label: account.name, href: `#/trust/accounts/${id}` }, { label: "Reconcile" }],
      title: "Monthly three-way reconciliation",
      subtitle: "The bank statement, the trust journal and the total of the client ledgers must agree to the cent.",
      actions: [printLink(`/trust/accounts/${id}/reconciliations/print`, "Reconciliation history", { size: "md" })],
    }),
    card({
      title: stepTitle(1, "Month and bank statement"),
      subtitle: "Choose the month, then type the ending balance from that month's bank statement.",
      body: h("div.form-row.trust-step1", field("Month", monthIn), field("Statement ending balance", stmtIn, { hint: "For example 12,345.67" })),
    }),
    body,
  );
  await load();
  return page;
}

function nextMonth(p) {
  const [y, m] = p.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// ----------------------------------------------------------------- reports

export async function trustReportsView([id]) {
  const [a, recs, ledgers, rules] = await Promise.all([get(`/trust/accounts/${id}`), get(`/trust/accounts/${id}/reconciliations`), get(`/trust/accounts/${id}/ledgers?all=1`), get("/trust/rules")]);
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const date = (value, label) => h("input", { type: "date", value, "aria-label": label });
  const lFrom = date(monthStart, "Ledger statement from");
  const lTo = date(t, "Ledger statement to");
  const jFrom = date(monthStart, "Journal from");
  const jTo = date(t, "Journal to");
  const asOf = date(t, "As of");
  const months = h("input", { type: "number", min: 1, max: 240, value: 12, "aria-label": "Months without activity" });
  const ledgerSel = select(ledgers.map((l) => ({ value: l.id, label: l.label })), ledgers[0]?.id ?? "", { "aria-label": "Client ledger" });
  const open = (path) => window.open("/api" + path, "_blank", "noopener");
  const report = (ic, title, text, controls, onclick) =>
    h(
      "div.trust-report",
      h("span.trust-report-icon", icon(ic, { size: 18 })),
      h("div.trust-report-main", h("h3", title), h("p", text), controls.length ? h("div.trust-report-row", controls) : null),
      h("div.trust-report-go", button("Open printable report", { size: "sm", iconRight: "external-link", onclick })),
    );
  const retention = rules.rules.find((r) => r.id === "retention");
  return h(
    "div.page.trust",
    trustHead({
      crumbs: [{ label: a.name, href: `#/trust/accounts/${id}` }, { label: "Reports" }],
      title: "Trust reports",
      subtitle: "Printable records for the client, the file, an accountant or the Disciplinary Administrator. Each opens in a new tab.",
    }),
    card({
      title: "Reports",
      icon: "reports",
      flush: true,
      body: h(
        "div.trust-reports",
        report("users", "Client ledger statement", "Every entry on one client matter's ledger with a running balance, for the client or the file.", [field("Client ledger", ledgerSel), field("From", lFrom), field("To", lTo)], () =>
          open(`/trust/ledgers/${ledgerSel.value}/print?from=${lFrom.value}&to=${lTo.value}`),
        ),
        report("file-text", "Trust journal", "Every entry in the account for a period, with a running balance.", [field("From", jFrom), field("To", jTo)], () => open(`/trust/accounts/${id}/journal/print?from=${jFrom.value}&to=${jTo.value}`)),
        report("landmark", "Client balances", "Every client ledger holding money on a date.", [field("As of", asOf)], () => open(`/trust/accounts/${id}/balances/print?asOf=${asOf.value}`)),
        report("hourglass", "Inactive balances", "Ledgers holding money with no activity for a number of months.", [field("Months without activity", months)], () => open(`/trust/accounts/${id}/inactive/print?months=${months.value}`)),
        report("circle-check", "Reconciliation history", `${plural(recs.length, "reconciliation")} on file.`, [], () => open(`/trust/accounts/${id}/reconciliations/print`)),
      ),
    }),
    h(
      "div.grid-2.trust-gap",
      card({
        title: "Record keeping",
        icon: "archive",
        body: [
          h("p.trust-first", `Trust records are kept for ${rules.retentionYears} years after the representation ends, as KRPC 1.15(a) requires:`),
          h("blockquote.trust-quote", `“${retention.quote}”`),
          h("p.trust-small", "Lawdesk never deletes a trust entry, ledger, account or signed reconciliation. Each ledger shows its keep-until date once its matter is closed."),
        ],
      }),
      card({
        title: "Rules this follows, and what has not been verified",
        icon: "scale",
        body: [reviewNotice(), h("ul.trust-gaps", rules.gaps.map((g) => h("li", h("strong", g.id + ". "), g.what, " ", h("span.muted", g.whatTheAppDoes))))],
      }),
    ),
  );
}
