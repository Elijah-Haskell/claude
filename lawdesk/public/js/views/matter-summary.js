// The matter page's Overview: a calm summary of the case file. Each card here is short,
// read-only and links to the tab (or page) where the work is done, so the Overview never
// repeats a full list from another tab: "Next up" rows are links into the Tasks tab, not
// task rows (`.task` only ever matches the Tasks tab).

import { h, replace, fmtDate, relDate, plural } from "../dom.js";
import { get } from "../api.js";
import { state, today } from "../state.js";
import { card, button, emptyState, pill, avatar } from "../ui/components.js";
import { icon } from "../ui/icons.js";
import { whenText, kindLabel } from "../cal.js";
import { money } from "../billing/format.js";

const finished = (t) => t.status === "done" || t.status === "skipped";
const canSeeTrust = () => ["admin", "attorney"].includes(state.account?.role);

/** One line of a summary list: a link (or button) with a title, a quiet second line and a value on the right. */
function sumRow({ href = null, onclick = null, title, sub = null, value = null, tone = null, lead = null, label = null }) {
  const inner = [
    lead ? h("span.matter-sum-lead", { "aria-hidden": "true" }, lead) : null,
    h("span.matter-sum-text", h("span.matter-sum-title", title), sub ? h("span.matter-sum-sub", sub) : null),
    value != null ? h("span.matter-sum-value" + (tone ? `.tone-${tone}` : ""), value) : null,
  ];
  const attrs = { "aria-label": label || null };
  return h(
    "li",
    href || onclick
      ? h("a.matter-sum-row", { ...attrs, href: href || "#", onclick: onclick ? (e) => (e.preventDefault(), onclick()) : null }, inner)
      : h("div.matter-sum-row", attrs, inner),
  );
}

const viewAll = (label, onclick) => button(label, { variant: "ghost", size: "sm", iconRight: "arrow-right", onclick });

/** "Next up": the first open tasks as compact links into the Tasks tab. */
export function nextUpCard(d, { openTab, focusTask, addTask }) {
  const now = today();
  const open = d.tasks
    .filter((t) => !finished(t))
    .sort((a, b) => (a.status === "waiting") - (b.status === "waiting") || String(a.due_date || "9999").localeCompare(String(b.due_date || "9999")) || a.id - b.id);
  const next = open.slice(0, 5);
  const late = open.filter((t) => t.status === "open" && t.due_date && t.due_date < now).length;
  return card({
    title: "Next up",
    subtitle: open.length ? `${plural(open.length, "open task")}${late ? ` · ${late} overdue` : ""}` : null,
    icon: "list-checks",
    className: "matter-next",
    actions: viewAll("All tasks", () => openTab("tasks")),
    body: next.length
      ? h(
          "ul.matter-sum-list",
          next.map((t) => {
            const lateTask = t.status === "open" && t.due_date && t.due_date < now;
            const due = t.status === "waiting" ? "Waiting" : t.due_date ? relDate(t.due_date, now) : "No date";
            return sumRow({
              href: `#/matters/${d.matter.id}/tasks`,
              onclick: () => (openTab("tasks"), requestAnimationFrame(() => focusTask(t.id))),
              lead: icon(t.status === "waiting" ? "hourglass" : "circle", { size: 15 }),
              title: t.title,
              sub: t.assignee_name ? h("span.matter-sum-who", avatar(t.assignee_name, { size: "xs" }), t.assignee_name) : "Unassigned",
              value: due,
              tone: lateTask ? "danger" : t.due_date === now ? "warning" : null,
              label: `${t.title}, ${due}. Open in the Tasks tab`,
            });
          }),
        )
      : emptyState({
          icon: "circle-check",
          title: "No open tasks",
          body: d.matter.status === "open" ? "Add a task, or apply a checklist from the right." : "This matter is closed.",
          action: d.matter.status === "open" ? button("Add task", { size: "sm", icon: "plus", onclick: addTask }) : null,
          compact: true,
        }),
  });
}

/**
 * A summary card that loads its own data. `load()` returns the body; it is called again by
 * `reload()` (the matter page calls it after a change). The old body stays until the new one is ready.
 */
function loadingCard(opts, load) {
  const body = h("div.matter-sum-body", h("p.muted.small", "Loading…"));
  const el = card({ ...opts, body });
  const run = async () => {
    try {
      replace(body, await load());
    } catch (err) {
      replace(body, h("p.muted.small", `Couldn't load this: ${err.message}`));
    }
  };
  el.reload = run;
  run();
  return el;
}

/** Money: unbilled work, what the client owes (and whether any of it is late), trust held. */
export function moneyCard(matterId, { openTab }) {
  return loadingCard(
    { title: "Money", icon: "billing", className: "matter-money", actions: viewAll("Billing", () => openTab("billing")) },
    async () => {
      const now = today();
      const [w, invs, trust] = await Promise.all([
        get(`/billing/reports/wip?matterId=${matterId}`),
        get(`/billing/invoices?matterId=${matterId}`),
        canSeeTrust() ? get(`/trust/matters/${matterId}/ledgers`).catch(() => null) : null,
      ]);
      const wip = w.rows[0];
      const finals = invs.filter((i) => i.status === "final" && i.balance_cents > 0);
      const owed = finals.reduce((s, i) => s + i.balance_cents, 0);
      const late = finals.filter((i) => i.due_on < now);
      const unbilled = wip ? wip.total_cents : 0;
      const ledgers = Array.isArray(trust) ? trust : trust?.ledgers;
      const held = Array.isArray(ledgers) && ledgers.length ? ledgers.reduce((s, l) => s + (l.balance_cents ?? 0), 0) : null;
      const goBilling = () => openTab("billing");
      return h(
        "ul.matter-sum-list",
        sumRow({
          onclick: goBilling,
          href: `#/matters/${matterId}/billing`,
          title: "Unbilled work",
          sub: wip ? `${plural(Math.round((wip.minutes / 60) * 10) / 10, "hour")} of time${wip.expense_cents ? ` and ${money(wip.expense_cents)} of expenses` : ""}` : "Nothing waiting to be billed",
          value: money(unbilled),
        }),
        sumRow({
          onclick: goBilling,
          href: `#/matters/${matterId}/billing`,
          title: "Owed by the client",
          sub: finals.length ? `${plural(finals.length, "unpaid invoice")}${late.length ? `, ${late.length} past due` : ""}` : "No unpaid invoices",
          value: money(owed),
          tone: late.length ? "danger" : owed ? "warning" : null,
        }),
        held != null ? sumRow({ href: "#/trust", title: "Held in trust", sub: "Client funds for this matter", value: money(held) }) : null,
      );
    },
  );
}

/** The next few calendar events on this matter. */
export function eventsCard(matterId, { openTab }) {
  return loadingCard({ title: "Coming up", icon: "calendar", className: "matter-events", actions: viewAll("Calendar", () => openTab("calendar")) }, async () => {
    const now = today();
    const end = new Date(Date.parse(now + "T00:00:00Z") + 365 * 864e5).toISOString().slice(0, 10);
    const d = await get(`/calendar/agenda?scope=firm&matter=${matterId}&from=${now}&to=${end}&tasks=0`);
    const items = d.items.slice(0, 3);
    if (!items.length) return emptyState({ icon: "calendar", title: "Nothing on the calendar", body: "Hearings, meetings and deadlines for this matter appear here.", compact: true });
    return h(
      "ul.matter-sum-list",
      items.map((i) =>
        sumRow({
          onclick: () => openTab("calendar"),
          href: `#/matters/${matterId}/calendar`,
          title: i.title,
          sub: `${relDate(i.date, now)} · ${whenText(i)}`,
          value: i.kind && i.kind !== "meeting" ? pill(kindLabel(i.kind), i.kind === "court_deadline" ? "warning" : "neutral", { dot: false }) : null,
        }),
      ),
    );
  });
}

/** The latest documents, each a link to the document. */
export function latestDocsCard(matterId, { openTab }) {
  return loadingCard({ title: "Latest documents", icon: "documents", className: "matter-docs", actions: viewAll("Documents", () => openTab("files")) }, async () => {
    const { documents } = await get(`/matters/${matterId}/documents`);
    if (!documents.length) return emptyState({ icon: "documents", title: "No documents yet", body: "Upload files or create one from a template in the Documents tab.", compact: true });
    const recent = documents.slice().sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)).slice(0, 3);
    return h(
      "ul.matter-sum-list",
      recent.map((doc) =>
        sumRow({
          href: `#/matters/${matterId}/documents/${doc.id}`,
          lead: icon("file-text", { size: 15 }),
          title: doc.name,
          sub: [doc.folder || null, `updated ${fmtDate(String(doc.updatedAt).slice(0, 10), today())}`].filter(Boolean).join(" · "),
        }),
      ),
      documents.length > recent.length ? h("p.matter-sum-more", h("a", { href: `#/matters/${matterId}/documents` }, `All ${plural(documents.length, "document")}`)) : null,
    );
  });
}
