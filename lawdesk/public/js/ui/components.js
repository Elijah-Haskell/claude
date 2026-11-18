// Lawdesk UI kit: small functions that return DOM nodes styled by app.css.
// Every screen should be built from these (plus dataTable in table.js) so the app looks
// like one product. See docs/design-system.md for the full guide.

import { h, fmtDate } from "../dom.js";
import { icon } from "./icons.js";

/**
 * useStyles("billing") loads public/css/billing.css once. Call it at the top of a module's view so
 * modules don't each edit index.html. Styles must only use the tokens defined in app.css.
 */
export function useStyles(name) {
  const href = `css/${name}.css`;
  if (document.querySelector(`link[data-module-css="${name}"]`)) return;
  document.head.append(h("link", { rel: "stylesheet", href, "data-module-css": name }));
}

/**
 * Turns an engine activity line into readable prose: ISO dates become "Mon Nov 23",
 * "2026-12-03 09:00" becomes "Thu Dec 3 at 9:00 AM", internal ids like "(event #8)" are dropped.
 */
export function activityText(s, today = null) {
  if (!s) return "";
  return String(s)
    .replace(/\s*\((?:event|task|matter) #\d+\)/g, "")
    .replace(/\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?\b/g, (_, d, hh, mm) => {
      const day = fmtDate(d, today);
      if (!hh) return day;
      const hr = Number(hh);
      return `${day} at ${hr % 12 || 12}:${mm} ${hr < 12 ? "AM" : "PM"}`;
    })
    .replace(/\b0 open task\(s\) updated/g, "no open tasks changed")
    .replace(/\b1 (open )?task\(s\)/g, "1 $1task")
    .replace(/task\(s\)/g, "tasks");
}

// ------------------------------------------------------------------- buttons

/**
 * button("Save", { variant: "primary", icon: "plus", size: "sm", onclick })
 * variant: "primary" | "secondary" (default) | "ghost" | "danger"
 * size: "sm" | "md" (default) | "lg". Pass href to get a link styled as a button.
 */
export function button(label, opts = {}) {
  const { variant = "secondary", size = "md", icon: ic = null, iconRight = null, href = null, type = "button", loading = false, ...rest } = opts;
  const cls = ["btn", variant !== "secondary" ? variant : null, size === "sm" ? "small" : size === "lg" ? "large" : null].filter(Boolean).join(".");
  const kids = [ic ? icon(ic, { size: size === "sm" ? 14 : 16 }) : null, label != null ? h("span.btn-label", label) : null, iconRight ? icon(iconRight, { size: 14 }) : null];
  const el = href ? h("a." + cls, { href, ...rest }, kids) : h("button." + cls, { type, ...rest }, kids);
  if (loading) setLoading(el, true);
  return el;
}

/** Square button with only an icon. A label is required for screen readers. */
export function iconButton(name, label, opts = {}) {
  const { size = "md", variant = null, ...rest } = opts;
  return h(
    "button.icon-btn" + (size === "sm" ? ".sm" : "") + (variant ? "." + variant : ""),
    { type: "button", "aria-label": label, title: label, ...rest },
    icon(name, { size: size === "sm" ? 15 : 18 }),
  );
}

/** Show a spinner in a button and block clicks while something runs. */
export function setLoading(btn, on) {
  btn.classList.toggle("is-loading", !!on);
  btn.setAttribute("aria-busy", on ? "true" : "false");
  if ("disabled" in btn) btn.disabled = !!on;
  let sp = btn.querySelector(":scope > .btn-spinner");
  if (on && !sp) btn.prepend(h("span.btn-spinner", { "aria-hidden": "true" }));
  if (!on && sp) sp.remove();
}

/** Run an async action with the button in its loading state. */
export async function withLoading(btn, fn) {
  setLoading(btn, true);
  try {
    return await fn();
  } finally {
    setLoading(btn, false);
  }
}

// --------------------------------------------------------------- page chrome

/**
 * The top of every screen.
 * pageHeader({ title, subtitle, breadcrumbs: [{label, href}], actions: [nodes], meta: [nodes], eyebrow })
 */
export function pageHeader({ title, subtitle = null, breadcrumbs: crumbs = null, actions = null, meta = null, eyebrow = null, className = "" }) {
  return h(
    "div.page-head" + (className ? "." + className : ""),
    h(
      "div.page-head-main",
      crumbs ? breadcrumbs(crumbs) : null,
      eyebrow ? h("div.eyebrow", eyebrow) : null,
      h("h1", title),
      subtitle ? h("p.sub", subtitle) : null,
      meta ? h("div.page-meta", meta) : null,
    ),
    actions ? h("div.head-actions", actions) : null,
  );
}

export function breadcrumbs(items) {
  return h(
    "nav.breadcrumbs",
    { "aria-label": "Breadcrumb" },
    h(
      "ol",
      items.map((it, i) =>
        h(
          "li",
          i ? icon("chevron-right", { size: 14, class: "crumb-sep" }) : null,
          it.href && i < items.length - 1 ? h("a", { href: it.href }, it.label) : h("span", { "aria-current": i === items.length - 1 ? "page" : null }, it.label),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------- cards

/**
 * card({ title, subtitle, icon, actions, body, footer, flush, id, className, tag })
 * flush: no padding in the body (for tables and lists that run edge to edge).
 */
export function card(opts = {}) {
  const { title = null, subtitle = null, icon: ic = null, actions = null, body = null, footer = null, flush = false, id = null, className = "", tag = "section", headingLevel = 2 } = opts;
  const head = title
    ? h(
        "header.card-header",
        h(
          "div.card-heading",
          ic ? h("span.card-icon", icon(ic, { size: 16 })) : null,
          h("div", h(`h${headingLevel}.card-title`, title), subtitle ? h("p.card-subtitle", subtitle) : null),
        ),
        actions ? h("div.card-actions", actions) : null,
      )
    : null;
  return h(
    `${tag}.card.card-v2` + (flush ? ".flush" : "") + (className ? "." + className.split(" ").join(".") : ""),
    { id },
    head,
    body != null ? h("div.card-body", body) : null,
    footer ? h("footer.card-footer", footer) : null,
  );
}

// ------------------------------------------------------- badges, pills, avatars

/**
 * Status pill with consistent colour meaning across the app:
 *   neutral (grey)  · info (blue)  · success (green)  · warning (amber)  · danger (red)  · brand (navy)
 */
export function pill(text, tone = "neutral", opts = {}) {
  return h("span.pill.pill-" + tone + (opts.dot === false ? "" : ".has-dot"), { title: opts.title || null }, text);
}

/** Map common statuses to pill tones so every module colours them the same way. */
export const STATUS_TONES = {
  open: "info",
  active: "info",
  "in progress": "info",
  waiting: "neutral",
  pending: "warning",
  draft: "neutral",
  sent: "info",
  overdue: "danger",
  late: "danger",
  "due today": "warning",
  done: "success",
  paid: "success",
  signed: "success",
  closed: "neutral",
  skipped: "neutral",
  void: "neutral",
  failed: "danger",
  cleared: "success",
  conflict: "danger",
};

export function statusPill(status, label = null) {
  const key = String(status || "").toLowerCase();
  return pill(label || (key ? key[0].toUpperCase() + key.slice(1) : "—"), STATUS_TONES[key] || "neutral");
}

const AVATAR_TONES = 8;

export function initialsOf(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

function hash(s) {
  let x = 0;
  for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x;
}

/** Round initials avatar; the colour is stable per name. size: "xs" | "sm" | "md" | "lg" */
export function avatar(name, opts = {}) {
  const { size = "sm", title = name } = opts;
  if (!name) return h("span.avatar.av-" + size + ".empty", { "aria-hidden": "true" }, "–");
  return h("span.avatar.av-" + size + ".av-t" + (hash(name) % AVATAR_TONES), { title, "aria-hidden": "true" }, initialsOf(name));
}

/** Avatar with name (and optional second line). */
export function person(name, sub = null, opts = {}) {
  return h("span.person", avatar(name, opts), h("span.person-text", h("span.person-name", name || "Unassigned"), sub ? h("span.person-sub", sub) : null));
}

// ------------------------------------------------------------ empty / loading

/**
 * emptyState({ icon: "briefcase", title: "No matters yet", body: "…", action: button(…) })
 * compact: smaller version for inside cards.
 */
export function emptyState({ icon: ic = "inbox", title, body = null, action = null, compact = false }) {
  return h(
    "div.empty-state" + (compact ? ".compact" : ""),
    h("div.empty-art", { "aria-hidden": "true" }, h("span.empty-ring"), h("span.empty-icon", icon(ic, { size: compact ? 20 : 24 }))),
    h("p.empty-title", title),
    body ? h("p.empty-body", body) : null,
    action ? h("div.empty-action", action) : null,
  );
}

/** Grey shimmering placeholder blocks while data loads. */
export function skeleton(kind = "lines", n = 3) {
  if (kind === "table") {
    return h(
      "div.skeleton-table",
      { "aria-hidden": "true" },
      Array.from({ length: n }, () => h("div.sk-row", h("span.sk.sk-w40"), h("span.sk.sk-w20"), h("span.sk.sk-w15"), h("span.sk.sk-w10"))),
    );
  }
  if (kind === "cards") return h("div.skeleton-cards", { "aria-hidden": "true" }, Array.from({ length: n }, () => h("div.sk-card", h("span.sk.sk-w30"), h("span.sk.sk-lg.sk-w20"))));
  return h("div.skeleton-lines", { "aria-hidden": "true" }, Array.from({ length: n }, (_, i) => h("span.sk" + (i === n - 1 ? ".sk-w60" : ""))));
}

/** Screen-reader friendly loading block. */
export function loadingBlock(label = "Loading", kind = "lines", n = 3) {
  return h("div.loading-block", { role: "status", "aria-label": label }, skeleton(kind, n));
}

export function spinner(label = "Loading") {
  return h("span.spinner", { role: "status", "aria-label": label });
}

// ----------------------------------------------------------- tabs, segmented

/**
 * tabs([{ id, label, count?, icon? }], current, onChange) → nav.tabs (role tablist)
 * Panels are the caller's job; give each panel id `tab-panel-<id>`.
 */
export function tabs(items, current, onChange, opts = {}) {
  const el = h(
    "div.tabs",
    { role: "tablist", "aria-label": opts.label || "Sections" },
    items.map((t) =>
      h(
        "button.tab",
        {
          type: "button",
          role: "tab",
          id: `tab-${t.id}`,
          "aria-selected": t.id === current ? "true" : "false",
          "aria-controls": `tab-panel-${t.id}`,
          tabindex: t.id === current ? "0" : "-1",
          dataset: { tab: t.id },
          onclick: () => select(t.id),
        },
        t.icon ? icon(t.icon, { size: 15 }) : null,
        h("span", t.label),
        t.count != null ? h("span.tab-count", String(t.count)) : null,
      ),
    ),
  );
  function select(id, focus = false) {
    for (const b of el.querySelectorAll(".tab")) {
      const on = b.dataset.tab === id;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    onChange(id);
  }
  el.addEventListener("keydown", (e) => {
    const btns = [...el.querySelectorAll(".tab")];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === "ArrowRight") (e.preventDefault(), select(btns[(i + 1) % btns.length].dataset.tab, true));
    if (e.key === "ArrowLeft") (e.preventDefault(), select(btns[(i - 1 + btns.length) % btns.length].dataset.tab, true));
  });
  el.select = select;
  return el;
}

/** segmented([{value, label}], value, onChange) — a small exclusive toggle group. */
export function segmented(options, value, onChange, opts = {}) {
  const el = h(
    "div.segmented",
    { role: "group", "aria-label": opts.label || null },
    options.map((o) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(o.value) === String(value) ? "true" : "false",
          onclick: (e) => {
            el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false"));
            onChange(o.value);
          },
        },
        o.icon ? icon(o.icon, { size: 14 }) : null,
        o.label,
        o.count != null ? h("span.seg-count", String(o.count)) : null,
      ),
    ),
  );
  return el;
}

// ------------------------------------------------------------ data display

/** Summary figure: stat({ label, value, tone: "danger"|"warning"|"success"|"info", icon, hint, href, onclick }) */
export function stat({ label, value, tone = null, icon: ic = null, hint = null, href = null, onclick = null, id = null }) {
  const toneCls = tone ? "." + ({ danger: "late", warning: "today", success: "good", info: "info", neutral: "wait" }[tone] || tone) : "";
  return h(
    (href || onclick ? "a" : "div") + ".stat.stat-v2" + toneCls,
    {
      href: href || (onclick ? "#" : null),
      id,
      // The hash is the router's, so a click handler must stop the "#" navigation.
      onclick: onclick ? (e) => (e.preventDefault(), onclick(e)) : null,
    },
    h("span.stat-top", ic ? h("span.stat-icon", icon(ic, { size: 16 })) : null, h("span.stat-label", label)),
    h("span.stat-n", String(value)),
    hint ? h("span.stat-hint", hint) : null,
  );
}

/** Definition list of label/value pairs: kv([["Client", "Acme"], ["Opened", "Nov 3"]]) */
export function kv(pairs, opts = {}) {
  return h(
    "dl.kv" + (opts.inline ? ".kv-inline" : ""),
    pairs.filter(Boolean).map(([k, v]) => h("div.kv-row", h("dt", k), h("dd", v == null || v === "" ? h("span.muted", "—") : v))),
  );
}

export function progressBar(done, total, opts = {}) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return h(
    "span.progress",
    { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done), "aria-label": opts.label || `${done} of ${total} finished` },
    h("span.progress-bar", h("span.progress-fill" + (pct === 100 ? ".full" : ""), { style: { width: pct + "%" } })),
    opts.text === false ? null : h("span.progress-text", `${done}/${total}`),
  );
}

/** Inline notice: callout({ tone: "info"|"warning"|"danger"|"success", title, body, action }) */
export function callout({ tone = "info", title = null, body = null, action = null, icon: ic = null }) {
  const icons = { info: "info", warning: "triangle-alert", danger: "circle-alert", success: "circle-check" };
  return h(
    "div.callout.callout-" + tone,
    { role: tone === "danger" ? "alert" : null },
    icon(ic || icons[tone] || "info", { size: 16, class: "callout-icon" }),
    h("div.callout-text", title ? h("strong", title) : null, body ? h("span", body) : null),
    action ? h("div.callout-action", action) : null,
  );
}

/** Form field: label + control + hint/error. field("Matter name", input, { hint, required }) */
export function field(label, control, opts = {}) {
  return h(
    "label.field" + (opts.className ? "." + opts.className : ""),
    h("span.field-label", label, opts.required ? h("span.req", { "aria-hidden": "true" }, " *") : null, opts.optional ? h("span.field-optional", " (optional)") : null),
    control,
    opts.hint ? h("span.field-hint", opts.hint) : null,
  );
}

/** A labelled section heading inside a card or page. */
export function sectionTitle(text, aside = null) {
  return h("div.section-title", h("h2", text), aside ? h("div.section-aside", aside) : null);
}
