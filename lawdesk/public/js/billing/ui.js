// Pieces shared by the billing screens: the sub-navigation, matter pickers, status words
// and the "Log time" dialog (also used from the matter page and the task ⋯ menu).

import { h, select, modal, toast, fmtDate } from "../dom.js";
import { get, post, patch } from "../api.js";
import { state, today } from "../state.js";
import { money, hours, parseHours, parseMoney, moneyInput } from "./format.js";
import { startTimer } from "./timer.js";
import { pageHeader, field, button, pill, statusPill } from "../ui/components.js";
import { icon } from "../ui/icons.js";

export const SUBNAV = [
  ["#/billing/time", "Time", "clock"],
  ["#/billing/expenses", "Expenses", "wallet"],
  ["#/billing/invoices", "Invoices", "receipt"],
  ["#/billing/payments", "Payments", "landmark"],
  ["#/billing/statements", "Statements", "file-text"],
  ["#/billing/settings", "Billing settings", "settings"],
];

/** The tab strip under the page title. `current` is one of the SUBNAV hrefs. */
export function subnav(current) {
  return h(
    "nav.tabs.bl-subnav",
    { "aria-label": "Billing" },
    SUBNAV.map(([href, label, ic]) => h("a.tab", { href, "aria-current": href === current ? "page" : null }, icon(ic, { size: 15 }), h("span", label))),
  );
}

/** The top of every billing screen: header (with up to one primary action) and the billing tabs. */
export function billingPage(current, title, sub, actions = []) {
  return h("div.page.bl-page", pageHeader({ title, subtitle: sub, eyebrow: "Billing", actions: actions.length ? actions : null }), subnav(current));
}

export const fail = (err) => toast(err.message || String(err), { error: true });

/** Matter label used everywhere in billing: "D-1004 · Supply agreement review". */
export function matterLabel(m) {
  if (!m) return "";
  const name = m.name ?? m.matter_name ?? "";
  const num = m.number ?? m.matter_number;
  return num ? `${num} · ${name}` : name;
}

let matterCache = null;

/** All matters (open first), cached for the page's life. */
export async function allMatters(fresh = false) {
  if (!matterCache || fresh) matterCache = await get("/matters?status=all");
  return matterCache;
}

export function matterSelect(matters, value, attrs = {}, { blank = "Choose a matter…", openOnly = true } = {}) {
  const list = matters.filter((m) => !openOnly || m.status === "open" || m.id === Number(value));
  return select(
    [
      { value: "", label: blank },
      ...list.map((m) => ({
        value: m.id,
        label: matterLabel(m) + (m.client_name ? ` (${m.client_name})` : ""),
        group: m.status === "closed" ? "Closed matters" : null,
      })),
    ],
    value ?? "",
    attrs,
  );
}

/** Words for an invoice's state, plus a CSS tone. */
export function invoiceStatus(inv, now = today()) {
  if (inv.status === "draft") return { label: "Draft", tone: "draft" };
  if (inv.status === "void") return { label: "Void", tone: "void" };
  if (inv.balance_cents <= 0) return { label: "Paid", tone: "paid" };
  if (inv.due_on && inv.due_on < now) return { label: "Past due", tone: "late" };
  const total = inv.total_cents ?? 0;
  if (inv.balance_cents < total) return { label: "Partly paid", tone: "partial" };
  return { label: "Awaiting payment", tone: "open" };
}

// Invoice states mapped onto the shared status colours (STATUS_TONES in ui/components.js).
const TONE_STATUS = { draft: "draft", void: "void", paid: "paid", late: "overdue", partial: "in progress", open: "sent" };

export function statusTag(inv) {
  const s = invoiceStatus(inv);
  const el = statusPill(TONE_STATUS[s.tone] || "draft", s.label);
  el.classList.add("bl-status");
  return el;
}

export function invoiceTitle(inv) {
  return inv.number != null ? `Invoice ${inv.number}` : "Draft invoice";
}

/** A summary figure: big number, small label. */
export function figure(label, value, opts = {}) {
  return h(
    `div.bl-figure${opts.tone ? "." + opts.tone : ""}`,
    h("span.bl-figure-label", label),
    h("span.bl-figure-value", value),
    opts.note ? h("span.bl-figure-note", opts.note) : null,
  );
}

export { money, hours, fmtDate };

/** Text field for an amount of money. */
export function moneyField(cents, attrs = {}) {
  return h("input.bl-money", { inputmode: "decimal", autocomplete: "off", value: moneyInput(cents), placeholder: "0.00", ...attrs });
}

/** Reads a money field; throws a friendly message when it can't. */
export function readMoney(input, what, { allowBlank = false } = {}) {
  const v = input.value.trim();
  if (v === "" && allowBlank) return null;
  const c = parseMoney(v);
  if (c == null) throw new Error(`${what}: type an amount such as 125.00`);
  return c;
}

export function readHours(input) {
  const m = parseHours(input.value);
  if (m == null) throw new Error("Hours: type them as 1.5 or 1:30");
  if (m > 24 * 60) throw new Error("Hours: one entry can't be more than 24 hours");
  return m;
}

/**
 * Log time on a matter. opts: { matterId, taskId, taskTitle, description, entry (to edit), onSaved }
 * Saving creates the entry; "Start timer" creates it with the hours typed so far and starts the clock.
 */
export async function logTimeDialog(opts = {}) {
  const matters = await allMatters();
  const e = opts.entry || null;
  const matter = matterSelect(matters, e?.matter_id ?? opts.matterId ?? "", { required: true, "aria-label": "Matter" });
  const date = h("input", { type: "date", value: e?.date ?? today(), required: true });
  const hrs = h("input.bl-hours", {
    inputmode: "decimal",
    autocomplete: "off",
    placeholder: "1.5 or 1:30",
    value: e ? hours(e.minutes) : "",
    "aria-describedby": "lt-hours-help",
  });
  const desc = h(
    "textarea",
    { rows: 3, maxlength: 4000, placeholder: "What was done, as the client should read it" },
    e?.description ?? opts.description ?? "",
  );
  const billable = h("input", { type: "checkbox", checked: e ? !!e.billable : true });
  const err = h("p.error-text", { role: "alert" });
  const taskId = e ? e.task_id : (opts.taskId ?? null);

  const read = () => {
    if (!matter.value) throw new Error("Choose the matter this time is for");
    return {
      matterId: Number(matter.value),
      date: date.value,
      description: desc.value,
      billable: billable.checked,
      taskId,
    };
  };
  const save = async (andTimer) => {
    err.textContent = "";
    try {
      const body = read();
      if (andTimer) {
        body.minutes = hrs.value.trim() ? readHours(hrs) : 0;
        await startTimer(body);
        toast("Timer started");
      } else {
        body.minutes = readHours(hrs);
        if (e) await patch(`/billing/time/${e.id}`, body);
        else await post("/billing/time", body);
        toast(e ? "Time entry saved" : `Logged ${hours(body.minutes)} hours`);
      }
      dlg.close();
      window.dispatchEvent(new CustomEvent("lawdesk:time-changed"));
      await opts.onSaved?.();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
  const form = h(
    "form.modal-body.form-grid.bl-form",
    { onsubmit: (ev) => (ev.preventDefault(), save(false)) },
    opts.taskTitle ? h("p.bl-linked", icon("square-check-big", { size: 15 }), h("span", "For the task: ", h("strong", opts.taskTitle))) : null,
    field("Matter", matter, { required: true }),
    h(
      "div.form-row.bl-two",
      field("Date", date),
      h("label.field", h("span.field-label", "Hours"), hrs, h("span.field-hint#lt-hours-help", "Type 1.5 or 1:30")),
    ),
    field("Description", desc),
    h("label.check-line", billable, h("span", "Billable to the client")),
    err,
    h(
      "div.form-actions",
      button("Cancel", { onclick: () => dlg.close() }),
      !e ? button("Start timer instead", { icon: "clock", onclick: () => save(true) }) : null,
      button(e ? "Save changes" : "Save time", { variant: "primary", type: "submit" }),
    ),
  );
  const dlg = modal(e ? "Edit time entry" : "Log time", form, { subtitle: e ? null : "Record time spent on a matter." });
  (matter.value ? hrs : matter).focus();
  return dlg;
}

/** Confirmation dialog for something that can't be undone. Resolves true/false. */
export function confirmDialog(title, lines, { confirmLabel = "Confirm", danger = false, reasonLabel = null } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const reason = reasonLabel ? h("textarea", { rows: 2, maxlength: 1000 }) : null;
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.modal-body.bl-confirm",
      {
        onsubmit: (ev) => {
          ev.preventDefault();
          if (reason && !reason.value.trim()) {
            err.textContent = "Please give a reason. It is kept with the record.";
            return;
          }
          ok = true;
          dlg.close();
        },
      },
      lines.map((l) => (typeof l === "string" ? h("p", l) : l)),
      reason ? field(reasonLabel, reason, { required: true, className: "bl-reason" }) : null,
      err,
      h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), button(confirmLabel, { variant: danger ? "danger" : "primary", type: "submit" })),
    );
    const dlg = modal(title, form);
    dlg.addEventListener("close", () => resolve(ok ? (reason ? reason.value.trim() : true) : false));
    (reason || form.querySelector("button[type=submit]")).focus();
  });
}

export function userName(id) {
  return state.setup?.allUsers?.find((u) => u.id === id)?.name ?? "";
}

export { moneyInput, parseMoney, pill };
