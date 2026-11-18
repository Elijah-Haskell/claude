// The app shell: left sidebar (built from app.js's NAV), top bar with global search,
// notifications and the user menu, the dismissible demo-data banner, and the phone drawer.
//
// NAV entries: { href, label, icon?, section?, key? }. Unknown sections are added before
// Admin; entries without an icon get a neutral default. Entries sort into a canonical order
// (see ORDER below) so modules merged in any order still land in the same place.

import { h, relDate } from "../dom.js";
import { get } from "../api.js";
import { state, prefs, setMe, today } from "../state.js";
import { icon, hasIcon, DEFAULT_ICON } from "./icons.js";
import { avatar } from "./components.js";
import { menu, popover, closePopover } from "./popover.js";

const SECTIONS = ["Work", "Practice", "Finance", "Admin"];
const ORDER = [
  "#/home", "#/my", "#/firm", "#/calendar",
  "#/matters", "#/contacts", "#/conflicts", "#/documents", "#/intake", "#/email", "#/checklists",
  "#/billing", "#/payments", "#/trust", "#/reports",
  "#/import", "#/settings",
];

let navItems = [];
let routesForSearch = [];
const accountActions = { account: null, signOut: null };
let firmName = "";
const els = {};

/** The sign-in module calls this to wire "My account" and "Sign out" in the user menu. */
export function setAccountActions({ account = null, signOut = null } = {}) {
  accountActions.account = account;
  accountActions.signOut = signOut;
}

export function buildShell({ nav, main, onUserChange, routes = [] }) {
  navItems = nav;
  routesForSearch = routes;
  const collapsed = prefs.get("sidebar.collapsed", "0") === "1";

  els.sideNav = h("nav.side-nav", { "aria-label": "Main" });
  els.firm = h("span.side-firm-name");
  els.sidebar = h(
    "aside.sidebar#sidebar",
    { "aria-label": "Sidebar" },
    h(
      "div.side-head",
      h(
        "a.side-brand",
        { href: "#/home", "aria-label": "Lawdesk home" },
        h("img.side-mark", { src: "brand/lawdesk-mark-on-dark.svg", alt: "", width: 28, height: 28 }),
        h("span.side-brand-text", h("span.side-wordmark", "Lawdesk"), els.firm),
      ),
      h(
        "button.side-close",
        { type: "button", "aria-label": "Close menu", onclick: () => setDrawer(false) },
        icon("x", { size: 18 }),
      ),
    ),
    els.sideNav,
    h(
      "div.side-foot",
      h(
        "button.side-collapse",
        {
          type: "button",
          "aria-label": collapsed ? "Expand sidebar" : "Collapse sidebar",
          title: collapsed ? "Expand sidebar" : "Collapse sidebar",
          onclick: (e) => {
            const on = !document.body.classList.contains("sidebar-collapsed");
            document.body.classList.toggle("sidebar-collapsed", on);
            prefs.set("sidebar.collapsed", on ? "1" : "0");
            e.currentTarget.setAttribute("aria-label", on ? "Expand sidebar" : "Collapse sidebar");
            e.currentTarget.title = on ? "Expand sidebar" : "Collapse sidebar";
          },
        },
        icon("panel-left", { size: 18 }),
        h("span.side-label", "Collapse"),
      ),
    ),
  );
  document.body.classList.toggle("sidebar-collapsed", collapsed);

  els.bellCount = h("span.bell-count", { hidden: true });
  els.bell = h(
    "button.top-icon.bell",
    { type: "button", "aria-label": "Notifications", title: "Notifications", "aria-haspopup": "dialog", onclick: openNotifications },
    icon("bell", { size: 18 }),
    els.bellCount,
  );
  els.userBtn = h("button.user-btn", { type: "button", "aria-haspopup": "menu", "aria-label": "Account menu", onclick: (e) => openUserMenu(e.currentTarget, onUserChange) });
  els.banner = h("div.demo-banner-slot");

  const top = h(
    "header.topbar",
    h(
      "button.top-icon.menu-btn",
      { type: "button", "aria-label": "Open menu", "aria-controls": "sidebar", onclick: () => setDrawer(true) },
      icon("menu", { size: 20 }),
    ),
    h(
      "button.search-trigger",
      { type: "button", onclick: openPalette, "aria-label": "Search matters, contacts and tasks" },
      icon("search", { size: 16 }),
      h("span.search-trigger-text", "Search matters, contacts, tasks…"),
    ),
    h("div.top-spacer"),
    h(
      "button.btn.primary.small.top-new",
      {
        type: "button",
        "aria-haspopup": "menu",
        onclick: (e) =>
          menu(
            e.currentTarget,
            [
              { label: "New task", icon: "square-check-big", onSelect: newTask },
              { label: "New matter", icon: "briefcase", onSelect: () => window.dispatchEvent(new Event("lawdesk:new-matter")) },
            ],
            "Create",
          ),
      },
      icon("plus", { size: 15 }),
      h("span.btn-label", "New"),
    ),
    els.bell,
    els.userBtn,
  );

  const backdrop = h("div.drawer-backdrop", { onclick: () => setDrawer(false) });
  const root = h("div.app-shell", els.sidebar, backdrop, h("div.shell-main", top, els.banner, main));

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      openPalette();
    }
    if (e.key === "Escape" && document.body.classList.contains("drawer-open")) setDrawer(false);
  });
  return root;
}

function newTask() {
  const q = document.getElementById("quick-add");
  if (q) {
    q.focus();
    q.scrollIntoView({ block: "center" });
    return;
  }
  location.hash = "#/my";
  setTimeout(() => document.getElementById("quick-add")?.focus(), 400);
}

function setDrawer(open) {
  document.body.classList.toggle("drawer-open", open);
  if (open) els.sidebar.querySelector(".side-link, .side-close")?.focus();
}

// ------------------------------------------------------------------- sidebar

function sortedSections() {
  const sections = new Map();
  for (const n of navItems) {
    const s = n.section || "More";
    if (!sections.has(s)) sections.set(s, []);
    sections.get(s).push(n);
  }
  const rank = (n) => {
    const i = ORDER.indexOf(n.href);
    return i === -1 ? 500 + navItems.indexOf(n) : i;
  };
  for (const list of sections.values()) list.sort((a, b) => rank(a) - rank(b));
  const names = [...sections.keys()].sort((a, b) => {
    const ia = SECTIONS.indexOf(a) === -1 ? (a === "Admin" ? 99 : 3.5) : SECTIONS.indexOf(a);
    const ib = SECTIONS.indexOf(b) === -1 ? (b === "Admin" ? 99 : 3.5) : SECTIONS.indexOf(b);
    return ia - ib;
  });
  return names.map((n) => [n, sections.get(n)]);
}

export function drawNav() {
  const cur = location.hash.split("/").slice(0, 2).join("/").split("?")[0];
  els.sideNav.replaceChildren(
    ...sortedSections().map(([name, items]) =>
      h(
        "div.side-section",
        h("div.side-section-title", name),
        h(
          "ul",
          items.map((n) =>
            h(
              "li",
              h(
                "a.side-link.nav-link",
                {
                  href: n.href,
                  "aria-current": cur === n.href ? "page" : null,
                  title: n.label,
                  onclick: () => setDrawer(false),
                },
                icon(n.icon && hasIcon(n.icon) ? n.icon : DEFAULT_ICON, { size: 18 }),
                h("span.side-label", n.label),
                n.badge ? h("span.side-badge", String(n.badge)) : null,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export async function loadFirm() {
  try {
    const s = await get("/billing/settings");
    firmName = (s && (s.firm_name || s.firmName)) || "";
  } catch {
    firmName = "";
  }
  els.firm.textContent = firmName || "Practice management";
}

// ------------------------------------------------------------------ user menu

export function drawUser() {
  const me = (state.setup?.users ?? []).find((u) => u.id === state.me);
  els.userBtn.replaceChildren(
    avatar(me?.name || null, { size: "sm" }),
    h("span.user-btn-text", h("span.user-btn-name", me?.name || "Choose user"), me?.default_role ? h("span.user-btn-role.cap", me.default_role) : null),
    icon("chevron-down", { size: 14, class: "user-btn-chev" }),
  );
}

function openUserMenu(anchor, onUserChange) {
  const users = state.setup?.users ?? [];
  const me = users.find((u) => u.id === state.me);
  const el = menu(
    anchor,
    [
      { heading: "Working as" },
      ...users.map((u) => ({
        label: u.name,
        hint: u.default_role || null,
        avatar: avatar(u.name, { size: "xs" }),
        current: u.id === state.me,
        onSelect: () => {
          if (u.id === state.me) return;
          setMe(u.id);
          drawUser();
          onUserChange?.();
        },
      })),
      "-",
      { label: "My account", icon: "circle-user", disabled: !accountActions.account, hint: accountActions.account ? null : "Soon", onSelect: () => accountActions.account?.() },
      { label: "Settings", icon: "settings", href: "#/settings" },
      "-",
      { label: "Sign out", icon: "log-out", disabled: !accountActions.signOut, onSelect: () => accountActions.signOut?.() },
    ],
    "Account",
  );
  if (me) {
    el.querySelector(".menu-list")?.prepend(
      h("div.menu-profile", avatar(me.name, { size: "md" }), h("div", h("div.menu-profile-name", me.name), h("div.menu-profile-sub", [me.default_role, me.email].filter(Boolean).join(" · ")))),
      h("div.menu-sep", { role: "separator" }),
    );
  }
}

// ------------------------------------------------------------- notifications

let notif = { items: [], loadedFor: null };

const seenKey = () => `notif.seen.${state.me}`;
function seen() {
  try {
    return new Set(JSON.parse(prefs.get(seenKey(), "[]")));
  } catch {
    return new Set();
  }
}

export async function refreshNotifications() {
  if (!state.me) return;
  const now = today();
  const items = [];
  try {
    const d = await get(`/my-tasks?userId=${state.me}`);
    for (const t of d.overdue) items.push({ key: `late-${t.id}-${t.due_date}`, tone: "danger", icon: "clock", title: t.title, sub: `${relDate(t.due_date, now)}${t.matter_name ? " · " + t.matter_name : ""}`, href: t.matter_id ? `#/matters/${t.matter_id}/tasks` : "#/my" });
    for (const t of d.dueToday) items.push({ key: `today-${t.id}-${t.due_date}`, tone: "warning", icon: "calendar", title: t.title, sub: `Due today${t.matter_name ? " · " + t.matter_name : ""}`, href: t.matter_id ? `#/matters/${t.matter_id}/tasks` : "#/my" });
  } catch {
    /* the bell stays quiet if tasks can't load */
  }
  try {
    const a = await get(`/calendar/agenda?from=${now}&to=${now}&tasks=0&user=${state.me}`);
    for (const ev of (a.items || []).filter((x) => x.type !== "task")) {
      items.push({ key: `ev-${ev.eventId}-${ev.occurrence || ev.start}`, tone: "info", icon: "calendar-clock", title: ev.title, sub: `Today${ev.allDay ? "" : " · " + timeOf(ev.start)}${ev.location ? " · " + ev.location : ""}`, href: "#/calendar" });
    }
  } catch {
    /* no calendar module, or it failed: skip events */
  }
  notif = { items, loadedFor: state.me };
  const s = seen();
  const unseen = items.filter((i) => !s.has(i.key)).length;
  els.bellCount.hidden = unseen === 0;
  els.bellCount.textContent = unseen > 9 ? "9+" : String(unseen);
  els.bell.setAttribute("aria-label", unseen ? `Notifications, ${unseen} new` : "Notifications");
}

function timeOf(stamp) {
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

async function openNotifications(e) {
  const anchor = e.currentTarget;
  if (notif.loadedFor !== state.me) await refreshNotifications();
  const s = seen();
  const markAll = () => {
    prefs.set(seenKey(), JSON.stringify(notif.items.map((i) => i.key)));
    refreshNotifications();
  };
  const list = notif.items.length
    ? h(
        "ul.notif-list",
        notif.items.map((i) =>
          h(
            "li",
            h(
              "a.notif-item" + (s.has(i.key) ? "" : ".unread"),
              { href: i.href, onclick: () => closePopover() },
              h("span.notif-icon.tone-" + i.tone, icon(i.icon, { size: 15 })),
              h("span.notif-text", h("span.notif-title", i.title), h("span.notif-sub", i.sub)),
            ),
          ),
        ),
      )
    : h("div.notif-empty", icon("circle-check", { size: 22 }), h("p", "You're all caught up"), h("p.muted.small", "Overdue and due-today tasks show up here."));
  popover(
    anchor,
    h(
      "div.notif",
      h(
        "div.notif-head",
        h("strong", "Notifications"),
        notif.items.length ? h("button.btn.ghost.small", { type: "button", onclick: () => (markAll(), closePopover()) }, "Mark all as read") : null,
      ),
      list,
      h("div.notif-foot", h("a", { href: "#/my", onclick: () => closePopover() }, "Open My tasks", icon("arrow-right", { size: 14 }))),
    ),
    "Notifications",
    { className: "notif-pop", focus: false },
  );
}

// ---------------------------------------------------------------- demo banner

export function drawDemoBanner() {
  const demo = (state.setup?.contacts ?? []).some((c) => /fictional demo data/i.test(c.notes || ""));
  if (!demo || prefs.get("demoBanner.dismissed") === "1") return els.banner.replaceChildren();
  els.banner.replaceChildren(
    h(
      "div.demo-banner",
      { role: "note" },
      icon("info", { size: 15 }),
      h("span", h("strong", "Demo data. "), "Every client, matter and person here is fictional. Don't enter real client information until sign-in is set up."),
      h(
        "button.icon-btn.sm",
        {
          type: "button",
          "aria-label": "Dismiss",
          onclick: () => {
            prefs.set("demoBanner.dismissed", "1");
            els.banner.replaceChildren();
          },
        },
        icon("x", { size: 15 }),
      ),
    ),
  );
}

// ------------------------------------------------------------- search palette

let paletteData = null;

async function loadPaletteData() {
  const [matters, contacts, tasks] = await Promise.allSettled([get("/matters?status=all"), get("/contacts"), get("/firm-tasks?status=active")]);
  paletteData = {
    matters: matters.status === "fulfilled" ? matters.value : [],
    contacts: contacts.status === "fulfilled" ? contacts.value : [],
    tasks: tasks.status === "fulfilled" ? tasks.value.tasks : [],
    at: Date.now(),
  };
}

function contactHref(c) {
  if (routesForSearch.some(([re]) => re.test(`#/contacts/${c.id}`))) return `#/contacts/${c.id}`;
  const m = (paletteData?.matters || []).filter((x) => x.client_id === c.id).sort((a, b) => (b.opened_on || "").localeCompare(a.opened_on || ""))[0];
  return m ? `#/matters/${m.id}` : "#/settings";
}

function openPalette() {
  if (document.querySelector("dialog.palette[open]")) return;
  closePopover();
  const input = h("input.palette-input", {
    type: "search",
    placeholder: "Search matters, contacts, tasks…",
    "aria-label": "Search",
    autocomplete: "off",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "palette-results",
  });
  const results = h("div.palette-results#palette-results", { role: "listbox", "aria-label": "Results" });
  let flat = [];
  let active = 0;

  const go = (item) => {
    dlg.close();
    if (item) location.hash = item.href;
  };

  function score(text, words) {
    const t = String(text || "").toLowerCase();
    return words.every((w) => t.includes(w));
  }

  function draw() {
    const q = input.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const groups = [];
    const pages = navItems.filter((n) => !words.length || score(n.label, words)).slice(0, words.length ? 4 : 6);
    if (pages.length) groups.push(["Go to", pages.map((n) => ({ icon: n.icon || DEFAULT_ICON, title: n.label, sub: null, href: n.href }))]);
    if (paletteData) {
      const pick = (list, text, n) => (words.length ? list.filter((x) => score(text(x), words)) : list).slice(0, n);
      const ms = pick(paletteData.matters, (m) => [m.number, m.name, m.client_name, m.practice_area].join(" "), words.length ? 6 : 4);
      if (ms.length) groups.push(["Matters", ms.map((m) => ({ icon: "briefcase", title: m.name, sub: [m.number, m.client_name, m.status === "closed" ? "Closed" : m.stage_name].filter(Boolean).join(" · "), href: `#/matters/${m.id}` }))]);
      const cs = words.length ? pick(paletteData.contacts, (c) => [c.name, c.email, c.phone].join(" "), 5) : [];
      if (cs.length) groups.push(["Contacts", cs.map((c) => ({ icon: c.kind === "company" ? "building-2" : "user", title: c.name, sub: [c.kind === "company" ? "Company" : "Person", c.email].filter(Boolean).join(" · "), href: contactHref(c) }))]);
      const ts = words.length ? pick(paletteData.tasks, (t) => [t.title, t.matter_name, t.matter_number, t.assignee_name].join(" "), 6) : [];
      if (ts.length) groups.push(["Tasks", ts.map((t) => ({ icon: "square-check-big", title: t.title, sub: [t.matter_number || t.matter_name, t.assignee_name, t.due_date ? relDate(t.due_date, today()) : null].filter(Boolean).join(" · "), href: t.matter_id ? `#/matters/${t.matter_id}/tasks` : "#/firm" }))]);
    }
    flat = groups.flatMap(([, items]) => items);
    active = Math.min(active, Math.max(flat.length - 1, 0));
    let i = 0;
    results.replaceChildren(
      ...(groups.length
        ? groups.map(([name, items]) =>
            h(
              "div.palette-group",
              h("div.palette-group-title", name),
              items.map((it) => {
                const idx = i++;
                return h(
                  "a.palette-item" + (idx === active ? ".active" : ""),
                  {
                    href: it.href,
                    role: "option",
                    id: `pal-${idx}`,
                    "aria-selected": idx === active ? "true" : "false",
                    onclick: (e) => (e.preventDefault(), go(it)),
                    onmousemove: () => {
                      if (active !== idx) (active = idx), mark();
                    },
                  },
                  h("span.palette-icon", icon(it.icon, { size: 16 })),
                  h("span.palette-text", h("span.palette-title", it.title), it.sub ? h("span.palette-sub", it.sub) : null),
                  icon("arrow-right", { size: 14, class: "palette-go" }),
                );
              }),
            ),
          )
        : [h("div.palette-empty", paletteData ? `No results for “${input.value.trim()}”` : "Loading…")]),
    );
    input.setAttribute("aria-activedescendant", flat.length ? `pal-${active}` : "");
  }
  function mark() {
    results.querySelectorAll(".palette-item").forEach((el, idx) => {
      el.classList.toggle("active", idx === active);
      el.setAttribute("aria-selected", idx === active ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", `pal-${active}`);
    results.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => ((active = 0), draw()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") (e.preventDefault(), (active = Math.min(active + 1, flat.length - 1)), mark());
    if (e.key === "ArrowUp") (e.preventDefault(), (active = Math.max(active - 1, 0)), mark());
    if (e.key === "Enter") (e.preventDefault(), go(flat[active]));
  });

  const dlg = h(
    "dialog.palette",
    { "aria-label": "Search" },
    h("div.palette-head", icon("search", { size: 18 }), input, h("button.palette-esc", { type: "button", onclick: () => dlg.close(), "aria-label": "Close search" }, "Esc")),
    results,
  );
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  input.focus();
  draw();
  if (!paletteData || Date.now() - paletteData.at > 30_000) loadPaletteData().then(draw, draw);
}
