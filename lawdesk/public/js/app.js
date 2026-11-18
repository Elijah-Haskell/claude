// App shell: navigation, the "working as" picker, routing and keyboard shortcuts.

import { h, replace, select, modal, toast } from "./dom.js";
import { state, loadSetup, setMe } from "./state.js";
import { closePopover } from "./tasks.js";
import { myTasksView } from "./views/my.js";
import { firmTasksView } from "./views/firm.js";
import { mattersView } from "./views/matters.js";
import { matterView } from "./views/matter.js";
import { checklistsView, checklistEditView } from "./views/checklists.js";
import { settingsView } from "./views/settings.js";
import { trustView, trustAccountView, trustLedgerView, trustReconcileView, trustReportsView } from "./views/trust.js";

const NAV = [
  { href: "#/my", label: "My tasks", key: "m" },
  { href: "#/firm", label: "Firm tasks", key: "f" },
  { href: "#/matters", label: "Matters", key: "a" },
  { href: "#/checklists", label: "Checklists", key: "c" },
  // Trust: limit to admins and attorneys once sign-in lands.
  { href: "#/trust", label: "Trust", key: "t", section: "Finance", icon: "trust" },
  { href: "#/settings", label: "Settings", key: "s" },
];

const ROUTES = [
  [/^#\/my$/, () => myTasksView],
  [/^#\/firm$/, () => firmTasksView],
  [/^#\/matters$/, () => mattersView],
  [/^#\/matters\/(\d+)$/, () => matterView],
  [/^#\/checklists$/, () => checklistsView],
  [/^#\/checklists\/(new|\d+)$/, () => checklistEditView],
  [/^#\/settings$/, () => settingsView],
  [/^#\/trust$/, () => trustView],
  [/^#\/trust\/accounts\/(\d+)$/, () => trustAccountView],
  [/^#\/trust\/accounts\/(\d+)\/reconcile(?:\/(\d{4}-\d{2}))?$/, () => trustReconcileView],
  [/^#\/trust\/accounts\/(\d+)\/reports$/, () => trustReportsView],
  [/^#\/trust\/ledgers\/(\d+)$/, () => trustLedgerView],
];

const main = h("main#main", { tabindex: "-1" });
const nav = h("nav.nav", { "aria-label": "Main" });
const whoBox = h("div.who-box");

function drawNav() {
  const cur = location.hash.split("/").slice(0, 2).join("/");
  replace(
    nav,
    NAV.map((n) => h("a.nav-link", { href: n.href, "aria-current": cur === n.href ? "page" : null, title: null }, n.label)),
  );
}

function drawWho() {
  const users = state.setup?.users ?? [];
  const sel = select(
    users.map((u) => ({ value: u.id, label: u.name })),
    state.me,
    {
      id: "working-as",
      "aria-label": "User",
      onchange: (e) => {
        setMe(Number(e.target.value));
        route();
      },
    },
  );
  replace(whoBox, h("label.who-label", { for: "working-as" }, "User"), sel);
}

let renderSeq = 0;

export async function route() {
  closePopover();
  if (!location.hash || location.hash === "#/" || location.hash === "#") {
    history.replaceState(null, "", "#/my");
  }
  const hash = location.hash;
  drawNav();
  const seq = ++renderSeq;
  for (const [re, view] of ROUTES) {
    const m = re.exec(hash);
    if (!m) continue;
    try {
      const content = await view()(m.slice(1), { isCurrent: () => seq === renderSeq });
      if (seq !== renderSeq) return;
      replace(main, content);
    } catch (err) {
      if (seq !== renderSeq) return;
      replace(main, h("div.page", h("h1", "Couldn't load this page"), h("p.error-text", err.message || String(err)), h("p", h("a", { href: "#/my" }, "Go to My tasks"))));
    }
    return;
  }
  replace(main, h("div.page", h("h1", "Page not found"), h("p", h("a", { href: "#/my" }, "Go to My tasks"))));
}

function showHelp() {
  const rows = [
    ["n", "Quick-add a task"],
    ["/", "Search (matters, firm tasks)"],
    ["j / k", "Next / previous task"],
    ["x or Space", "Mark the task done (again to reopen)"],
    ["d", "Change its due date"],
    ["a", "Change who it's assigned to"],
    ["e", "Rename it"],
    ["m", "More actions"],
    ["Enter", "Open the task's matter"],
    ["g then m / f / a / c / s", "Go to My tasks, Firm tasks, Matters, Checklists, Settings"],
    ["?", "This list"],
  ];
  modal(
    "Keyboard shortcuts",
    h(
      "div.modal-body",
      h("table.shortcuts", h("tbody", rows.map(([k, v]) => h("tr", h("td", h("kbd", k)), h("td", v))))),
      h("p.muted", "When adding a task you can type a date such as Friday, tomorrow or 11/20."),
    ),
  );
}

let gPending = false;

function typingIn(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (typingIn(e.target) || document.querySelector("dialog[open]")) return;
  if (gPending) {
    gPending = false;
    const n = NAV.find((x) => x.key === e.key);
    if (n) {
      e.preventDefault();
      location.hash = n.href;
    }
    return;
  }
  if (e.key === "g") {
    gPending = true;
    setTimeout(() => (gPending = false), 1200);
    return;
  }
  if (e.key === "?") {
    e.preventDefault();
    showHelp();
    return;
  }
  if (e.key === "n") {
    const q = document.getElementById("quick-add");
    if (q) {
      e.preventDefault();
      q.focus();
    }
    return;
  }
  if (e.key === "/") {
    const s = document.querySelector("[data-search]");
    if (s) {
      e.preventDefault();
      s.focus();
    }
    return;
  }
  if (e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") {
    const rows = [...document.querySelectorAll("#main .task")];
    if (!rows.length) return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !(e.target && e.target.classList?.contains("task"))) return;
    e.preventDefault();
    const i = rows.indexOf(document.activeElement);
    const next = e.key === "j" || e.key === "ArrowDown" ? rows[i + 1] || rows[i === -1 ? 0 : i] : rows[i - 1] || rows[0];
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  }
});

async function start() {
  const app = document.getElementById("app");
  // The skip link can't use a plain #main href: the hash is the router's.
  document.querySelector(".skip")?.addEventListener("click", (e) => {
    e.preventDefault();
    main.focus();
  });
  replace(
    app,
    h(
      "header.top",
      h("a.brand", { href: "#/my" }, h("span.brand-mark", { "aria-hidden": "true" }, "L"), "Lawdesk"),
      nav,
      whoBox,
      h("button.icon-btn.help-btn", { type: "button", "aria-label": "Keyboard shortcuts", title: "Keyboard shortcuts (?)", onclick: showHelp }, "?"),
    ),
    main,
  );
  try {
    await loadSetup();
  } catch (err) {
    replace(main, h("div.page", h("h1", "Can't reach the server"), h("p.error-text", err.message)));
    return;
  }
  drawWho();
  window.addEventListener("hashchange", route);
  await route();
}

// Settings fires this after changing people, so the "Working as" list stays current.
window.addEventListener("lawdesk:setup", drawWho);

window.addEventListener("unhandledrejection", (e) => {
  toast(e.reason?.message || "Something went wrong", { error: true });
});

start();
