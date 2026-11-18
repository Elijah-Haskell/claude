// App shell wiring: navigation, routing and keyboard shortcuts.
//
// To add a screen: add an entry to NAV (it appears in the sidebar under its section) and a
// route to ROUTES. NAV entries: { href, label, icon, section, key? }
//   icon:    a name from ui/icons.js (or an alias such as "billing", "documents"); optional
//   section: "Work" | "Practice" | "Finance" | "Admin" (or a new name); optional
//   key:     letter for the "g then <key>" shortcut; optional

import { h, replace, modal, toast } from "./dom.js";
import { state, loadSetup } from "./state.js";
import { closePopover } from "./ui/popover.js";
import { buildShell, drawNav, drawUser, drawDemoBanner, loadFirm, refreshNotifications } from "./ui/shell.js";
import { emptyState, button } from "./ui/components.js";
import { homeView } from "./views/home.js";
import { checkSignIn, signOut } from "./auth.js";
import { accountView } from "./views/account.js";
import { setAccountActions } from "./ui/shell.js";
import { myTasksView } from "./views/my.js";
import { firmTasksView } from "./views/firm.js";
import { mattersView, newMatterDialog } from "./views/matters.js";
import { matterView } from "./views/matter.js";
import { checklistsView, checklistEditView } from "./views/checklists.js";
import { settingsView } from "./views/settings.js";
import { calendarView } from "./views/calendar.js";
import { deadlinesView } from "./views/deadlines.js";
import { BILLING_ROUTES } from "./billing/routes.js";
import { timerBox } from "./billing/timer.js";
import { overviewView } from "./views/overview.js";
import { reportsListView, reportView } from "./views/reports.js";
import { trustView, trustAccountView, trustLedgerView, trustReconcileView, trustReportsView } from "./views/trust.js";
import { contactsView, contactView } from "./views/contacts.js";
import { conflictsView, checkView, checkHistoryView } from "./views/conflicts.js";
import { documentsSearchView, matterDocumentsView } from "./views/documents.js";
import { templatesSettingsView } from "./views/templates.js";
import { intakeBoardView, intakeListView, intakeReportsView, leadView } from "./views/leads.js";
import { intakeFormsView, intakeFormEditView, bookingSettingsView } from "./views/intake-settings.js";
import { clioImportView } from "./views/clio_import.js";

export const NAV = [
  { href: "#/home", label: "Home", key: "h", icon: "home", section: "Work" },
  { href: "#/my", label: "My tasks", key: "m", icon: "my-tasks", section: "Work" },
  { href: "#/firm", label: "Firm tasks", key: "f", icon: "firm-tasks", section: "Work" },
  { href: "#/matters", label: "Matters", key: "a", icon: "matters", section: "Practice" },
  { href: "#/calendar", label: "Calendar", key: "l", icon: "calendar", section: "Work" },
  { href: "#/intake", label: "Intake", key: "i", icon: "intake", section: "Work" },
  { href: "#/contacts", label: "Contacts", key: "p", icon: "contacts", section: "Practice" },
  { href: "#/conflicts", label: "Conflict check", key: "k", icon: "conflicts", section: "Practice" },
  { href: "#/documents", label: "Documents", key: "e", icon: "documents", section: "Practice" },
  { href: "#/deadlines", label: "Deadlines", key: "d", icon: "deadlines", section: "Practice" },
  { href: "#/checklists", label: "Checklists", key: "c", icon: "checklists", section: "Practice" },
  { href: "#/billing", label: "Billing", key: "b", icon: "billing", section: "Finance" },
  // Trust, reports and the firm overview show to attorneys and administrators only; the
  // server refuses their API routes to staff (roles: ATTORNEYS), so this just hides dead ends.
  { href: "#/trust", label: "Trust", key: "t", icon: "trust", section: "Finance", audience: "attorneys" },
  { href: "#/reports", label: "Reports", key: "r", icon: "reports", section: "Finance", audience: "firm" },
  { href: "#/overview", label: "Firm overview", key: "o", icon: "overview", section: "Admin", audience: "firm" },
  { href: "#/settings", label: "Settings", key: "s", icon: "settings", section: "Admin" },
];

export const ROUTES = [
  [/^#\/home$/, () => homeView],
  [/^#\/my$/, () => myTasksView],
  [/^#\/firm$/, () => firmTasksView],
  [/^#\/matters$/, () => mattersView],
  // Before the matter page: its "documents" path is a page of its own, not a tab.
  [/^#\/matters\/(\d+)\/documents(?:\/(\d+|trash))?$/, () => matterDocumentsView],
  // #/matters/12 and #/matters/12/tasks (the tab is the second group)
  [/^#\/matters\/(\d+)(?:\/([a-z-]+))?$/, () => matterView],
  [/^#\/documents$/, () => documentsSearchView],
  [/^#\/settings\/templates$/, () => templatesSettingsView],
  [/^#\/checklists$/, () => checklistsView],
  [/^#\/checklists\/(new|\d+)$/, () => checklistEditView],
  [/^#\/settings$/, () => settingsView],
  [/^#\/calendar$/, () => calendarView],
  [/^#\/deadlines(?:\/(\d+))?$/, () => deadlinesView],
  ...BILLING_ROUTES,
  [/^#\/overview$/, () => overviewView],
  [/^#\/reports$/, () => reportsListView],
  [/^#\/reports\/([a-z-]+)(?:\?(.*))?$/, () => reportView],
  [/^#\/trust$/, () => trustView],
  [/^#\/trust\/accounts\/(\d+)$/, () => trustAccountView],
  [/^#\/trust\/accounts\/(\d+)\/reconcile(?:\/(\d{4}-\d{2}))?$/, () => trustReconcileView],
  [/^#\/trust\/accounts\/(\d+)\/reports$/, () => trustReportsView],
  [/^#\/trust\/ledgers\/(\d+)$/, () => trustLedgerView],
  [/^#\/contacts$/, () => contactsView],
  [/^#\/contacts\/(\d+)$/, () => contactView],
  [/^#\/conflicts(?:\?.*)?$/, () => conflictsView],
  [/^#\/conflicts\/history$/, () => checkHistoryView],
  [/^#\/conflicts\/(\d+)$/, () => checkView],
  [/^#\/intake$/, () => intakeBoardView],
  [/^#\/intake\/list$/, () => intakeListView],
  [/^#\/intake\/reports$/, () => intakeReportsView],
  [/^#\/intake\/leads\/(\d+)$/, () => leadView],
  [/^#\/settings\/intake-forms$/, () => intakeFormsView],
  [/^#\/settings\/intake-forms\/(new|\d+)$/, () => intakeFormEditView],
  [/^#\/settings\/booking$/, () => bookingSettingsView],
  [/^#\/settings\/import-clio(?:\?.*)?$/, () => clioImportView],
  [/^#\/account$/, () => accountView],
];

const DEFAULT_ROUTE = "#/home";

const main = h("main#main", { tabindex: "-1" });

let renderSeq = 0;

export async function route() {
  closePopover();
  document.body.classList.remove("drawer-open");
  if (!location.hash || location.hash === "#/" || location.hash === "#") {
    history.replaceState(null, "", DEFAULT_ROUTE);
  }
  const hash = location.hash;
  drawNav();
  const seq = ++renderSeq;
  refreshNotifications();
  for (const [re, view] of ROUTES) {
    const m = re.exec(hash);
    if (!m) continue;
    main.setAttribute("aria-busy", "true");
    try {
      const content = await view()(m.slice(1), { isCurrent: () => seq === renderSeq });
      if (seq !== renderSeq) return;
      replace(main, content);
      main.scrollTop = 0;
      window.scrollTo(0, 0);
    } catch (err) {
      if (seq !== renderSeq) return;
      replace(
        main,
        h(
          "div.page",
          emptyState({
            icon: "circle-alert",
            title: "Couldn't load this page",
            body: err.message || String(err),
            action: button("Go to Home", { href: DEFAULT_ROUTE, variant: "primary" }),
          }),
        ),
      );
    } finally {
      main.removeAttribute("aria-busy");
    }
    return;
  }
  replace(
    main,
    h("div.page", emptyState({ icon: "search", title: "Page not found", body: "That address doesn't match any screen.", action: button("Go to Home", { href: DEFAULT_ROUTE, variant: "primary" }) })),
  );
}

function showHelp() {
  const rows = [
    ["Ctrl K", "Search matters, contacts and tasks"],
    ["n", "Quick-add a task"],
    ["/", "Filter the list on this page"],
    ["j / k", "Next / previous row"],
    ["x or Space", "Mark the task done (again to reopen)"],
    ["d", "Change its due date"],
    ["a", "Change who it's assigned to"],
    ["e", "Rename it"],
    ["m", "More actions"],
    ["Enter", "Open"],
    ["g then a letter", "Go to a page: h Home, m My tasks, f Firm tasks, l Calendar, i Intake, a Matters, p Contacts, k Conflict check, e Documents, d Deadlines, c Checklists, b Billing, t Trust, r Reports, o Firm overview, s Settings"],
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
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
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
    const s = document.querySelector("#main [data-search]");
    if (s) {
      e.preventDefault();
      s.focus();
    }
    return;
  }
  if (e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") {
    const rows = [...document.querySelectorAll("#main .task")].filter((el) => el.offsetParent !== null);
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
  try {
    if (!(await checkSignIn(app))) return;
  } catch (err) {
    replace(app, h("div.page", emptyState({ icon: "circle-alert", title: "Can't reach the server", body: err.message })));
    return;
  }
  setAccountActions({ account: () => (location.hash = "#/account"), signOut });
  // The skip link can't use a plain #main href: the hash is the router's.
  document.querySelector(".skip")?.addEventListener("click", (e) => {
    e.preventDefault();
    main.focus();
  });
  replace(app, buildShell({ nav: NAV, main, routes: ROUTES, topExtras: [timerBox()] }));
  drawNav();
  try {
    await loadSetup();
  } catch (err) {
    replace(main, h("div.page", emptyState({ icon: "circle-alert", title: "Can't reach the server", body: err.message })));
    return;
  }
  drawUser();
  drawDemoBanner();
  loadFirm();
  window.addEventListener("hashchange", route);
  await route();
}

// Settings fires this after changing people, so the user menu stays current.
window.addEventListener("lawdesk:setup", () => (drawUser(), drawDemoBanner()));
window.addEventListener("lawdesk:new-matter", () => newMatterDialog());

window.addEventListener("unhandledrejection", (e) => {
  toast(e.reason?.message || "Something went wrong", { error: true });
});

start();
