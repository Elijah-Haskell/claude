// Tiny DOM helpers. All text goes in through textContent or attributes, never innerHTML,
// so names and titles typed by users can't inject markup.

/**
 * h("button.primary", { onclick, type: "button" }, "Save")
 * The tag may carry .classes and a #id. Attributes starting with "on" become listeners;
 * `class`, `dataset`, `style` (object) and boolean attributes are handled; null/false are skipped.
 */
export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement((m && m[1]) || "div");
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === ".") el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value" || k === "checked" || k === "selected" || k === "disabled" || k === "indeterminate") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === "") continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

/** <select> from [{value,label,group?}]; `value` is preselected. */
export function select(options, value, attrs = {}) {
  const el = h("select", attrs);
  const groups = new Map();
  for (const o of options) {
    const opt = h("option", { value: o.value == null ? "" : String(o.value) }, o.label);
    if (String(o.value ?? "") === String(value ?? "")) opt.selected = true;
    if (o.disabled) opt.disabled = true;
    if (o.group) {
      if (!groups.has(o.group)) {
        const g = h("optgroup", { label: o.group });
        groups.set(o.group, g);
        el.append(g);
      }
      groups.get(o.group).append(opt);
    } else el.append(opt);
  }
  return el;
}

// ------------------------------------------------------------------- dates

const DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function toUTC(iso) {
  return Date.parse(iso + "T00:00:00Z");
}

export function addDays(iso, n) {
  return new Date(toUTC(iso) + n * DAY).toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / DAY);
}

export function weekday(iso) {
  return new Date(toUTC(iso)).getUTCDay();
}

/** "Fri Nov 20" (adds the year when it isn't this year's). */
export function fmtDate(iso, today) {
  if (!iso) return "";
  const d = new Date(toUTC(iso));
  const base = `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return today && today.slice(0, 4) !== iso.slice(0, 4) ? `${base}, ${d.getUTCFullYear()}` : base;
}

/** Short, relative label for a due date: "Today", "Tomorrow", "3 days late", "Fri Nov 20". */
export function relDate(iso, today) {
  if (!iso) return "No date";
  const n = daysBetween(today, iso);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n < 0) return `${-n} days late`;
  if (n < 7) return WEEKDAYS[weekday(iso)] + " " + MONTHS[new Date(toUTC(iso)).getUTCMonth()] + " " + new Date(toUTC(iso)).getUTCDate();
  return fmtDate(iso, today);
}

export function fmtTime(isoStamp) {
  const d = new Date(isoStamp);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function plural(n, word, many = word + "s") {
  return `${n} ${n === 1 ? word : many}`;
}

export function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

// --------------------------------------------------------------- feedback

let toastBox;

/** Show a short message at the bottom; optional action button (e.g. Undo). */
export function toast(message, opts = {}) {
  if (!toastBox) {
    toastBox = h("div.toasts", { role: "status", "aria-live": "polite" });
    document.body.append(toastBox);
  }
  const lines = Array.isArray(message) ? message : [message];
  const t = h(
    "div.toast" + (opts.error ? ".error" : ""),
    h("div.toast-body", lines.map((l, i) => h(i === 0 ? "div.toast-main" : "div.toast-sub", l))),
    opts.action
      ? h("button.toast-action", { type: "button", onclick: () => (opts.action.run(), close()) }, opts.action.label)
      : null,
    h("button.toast-close", { type: "button", "aria-label": "Dismiss", onclick: () => close() }, "×"),
  );
  const close = () => t.remove();
  toastBox.append(t);
  while (toastBox.children.length > 4) toastBox.firstChild.remove();
  setTimeout(close, opts.ms ?? (opts.error ? 9000 : 6000));
  return t;
}

/** Simple modal dialog built on <dialog>. Resolves when closed. */
export function modal(title, body, { wide = false } = {}) {
  const dlg = h(
    "dialog.modal" + (wide ? ".wide" : ""),
    { "aria-label": title },
    h("div.modal-head", h("h2", title), h("button.icon-btn", { type: "button", "aria-label": "Close", onclick: () => dlg.close() }, "×")),
    body,
  );
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}
