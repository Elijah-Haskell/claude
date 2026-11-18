// Home: the signed-in person's day at a glance. Their overdue / today / this-week work,
// the next tasks to do, matters that moved recently, their calendar for the next two weeks,
// the firm's coming court dates, and what happened around the firm.

import { h, fmtDate, fmtTime, relDate, addDays, daysBetween, plural } from "../dom.js";
import { get } from "../api.js";
import { state, today, userName } from "../state.js";
import { taskRow, redraw } from "../tasks.js";
import { icon } from "../ui/icons.js";
import { pageHeader, card, stat, button, emptyState, avatar, pill, loadingBlock, activityText } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { kindLabel } from "../cal.js";

function greeting() {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/Chicago" }).format(new Date()));
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function longDate(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

export async function homeView() {
  const page = h("div.page.home-page");
  if (!state.me) {
    page.append(
      pageHeader({ title: "Home" }),
      emptyState({ icon: "users", title: "No one is set up yet", body: "Add the firm's people in Settings, or load the demo with npm run seed.", action: button("Open Settings", { href: "#/settings", variant: "primary" }) }),
    );
    return page;
  }
  const now = today();
  const first = (userName(state.me) || "").split(/\s+/)[0];

  const statsBox = h("div.stats.home-stats");
  const tasksBox = h("div");
  const mattersBox = h("div");
  const agendaBox = h("div");
  const courtBox = h("div");
  const activityBox = h("div");

  const [my, matters, activity] = await Promise.all([
    get(`/my-tasks?userId=${state.me}`),
    get("/matters?status=open"),
    get("/activity?limit=120").catch(() => []),
  ]);

  // ---------------------------------------------------------------- stats
  const weekEnd = addDays(now, 7);
  const thisWeek = my.upcoming.filter((t) => t.due_date <= weekEnd).length;
  const openedThisMonth = matters.filter((m) => m.opened_on && m.opened_on.slice(0, 7) === now.slice(0, 7)).length;
  const firmOverdue = matters.reduce((n, m) => n + (m.overdue_tasks || 0), 0);
  statsBox.append(
    stat({ label: "Overdue", value: my.overdue.length, tone: my.overdue.length ? "danger" : null, icon: "clock", hint: my.overdue.length ? "Needs attention" : "Nothing late", href: "#/my" }),
    stat({ label: "Due today", value: my.dueToday.length, tone: my.dueToday.length ? "warning" : null, icon: "calendar", hint: my.waiting.length ? `${my.waiting.length} more waiting on others` : "On your list", href: "#/my" }),
    stat({ label: "This week", value: thisWeek, icon: "calendar-days", hint: `Through ${fmtDate(weekEnd, now)}`, href: "#/my" }),
    stat({ label: "Open matters", value: matters.length, icon: "briefcase", hint: openedThisMonth ? `${openedThisMonth} opened this month` : firmOverdue ? `${plural(firmOverdue, "overdue task")} firm-wide` : "Firm-wide", href: "#/matters" }),
  );

  // ------------------------------------------------------- my next tasks
  const refresh = async () => {
    const d = await get(`/my-tasks?userId=${state.me}`);
    await redraw(tasksBox, () => buildTasks(d));
  };
  function buildTasks(d) {
    const next = [...d.overdue, ...d.dueToday, ...d.upcoming, ...d.later, ...d.noDate].slice(0, 7);
    const remaining = d.overdue.length + d.dueToday.length + d.upcoming.length + d.later.length + d.noDate.length - next.length;
    return card({
      title: "My next tasks",
      subtitle: next.length ? "Overdue first, then by due date" : null,
      icon: "square-check-big",
      flush: true,
      actions: button("View all", { href: "#/my", variant: "ghost", size: "sm", iconRight: "arrow-right" }),
      body: next.length
        ? h("ul.task-list.flush-list", next.map((t) => taskRow(t, { refresh, showMatter: true })))
        : emptyState({ icon: "circle-check", title: "You're all caught up", body: "Nothing is assigned to you right now.", compact: true, action: button("Add a task", { href: "#/my", size: "sm" }) }),
      footer: remaining > 0 ? h("a.card-footer-link", { href: "#/my" }, `${plural(remaining, "more task")} on your list`, icon("arrow-right", { size: 14 })) : null,
    });
  }
  await redraw(tasksBox, () => buildTasks(my));

  // ----------------------------------------------------- recent matters
  const touched = new Map();
  for (const a of activity) if (a.matter_id && !touched.has(a.matter_id)) touched.set(a.matter_id, a.at);
  const recent = matters
    .slice()
    .sort((a, b) => String(touched.get(b.id) || b.opened_on).localeCompare(String(touched.get(a.id) || a.opened_on)))
    .slice(0, 6);
  mattersBox.append(
    card({
      title: "Recent matters",
      subtitle: "Where work happened most recently",
      icon: "briefcase",
      flush: true,
      actions: button("All matters", { href: "#/matters", variant: "ghost", size: "sm", iconRight: "arrow-right" }),
      body: dataTable({
        toolbar: false,
        sortable: false,
        rows: recent,
        label: "Recent matters",
        noun: ["matter", "matters"],
        tableClass: "compact",
        rowHref: (m) => `#/matters/${m.id}`,
        columns: [
          {
            key: "name",
            label: "Matter",
            primary: true,
            render: (m) => h("div.cell-stack", h("a.cell-title", { href: `#/matters/${m.id}` }, m.name), h("span.cell-sub", [m.number, m.client_name].filter(Boolean).join(" · "))),
          },
          { key: "stage", label: "Stage", render: (m) => (m.stage_name ? pill(m.stage_name, "brand") : h("span.muted", "—")) },
          {
            key: "next",
            label: "Next due",
            render: (m) => (m.next_due ? h("span" + (m.next_due < now ? ".late-text" : ""), relDate(m.next_due, now)) : h("span.muted", "—")),
          },
          { key: "touched", label: "Last activity", hideOnPhone: true, render: (m) => h("span.muted", touched.get(m.id) ? ago(touched.get(m.id)) : `Opened ${fmtDate(m.opened_on, now)}`) },
        ],
        empty: emptyState({ icon: "briefcase", title: "No open matters", body: "Open a matter to start tracking its work.", compact: true }),
      }),
    }),
  );

  // ----------------------------------------------------------- agenda
  agendaBox.append(loadingBlock("Loading calendar", "lines", 3));
  loadAgenda(agendaBox, now, my);
  loadCourtDates(courtBox, now);

  // --------------------------------------------------------- activity
  const feed = activity
    .slice()
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 6);
  activityBox.append(
    card({
      title: "Recent activity",
      icon: "activity",
      body: feed.length
        ? h(
            "ol.feed",
            feed.map((a) =>
              h(
                "li.feed-item",
                a.user_name ? avatar(a.user_name, { size: "xs" }) : h("span.feed-auto", { title: "Automatic" }, icon("zap", { size: 12 })),
                h(
                  "div.feed-text",
                  h("p", h("strong", a.user_name || "Automatic"), " ", lowerFirst(activityText(a.detail, today()))),
                  h("p.feed-meta", a.matter_name ? h("a", { href: `#/matters/${a.matter_id}` }, a.matter_name) : null, a.matter_name ? " · " : null, ago(a.at)),
                ),
              ),
            ),
          )
        : emptyState({ icon: "activity", title: "No activity yet", compact: true }),
    }),
  );

  page.append(
    pageHeader({
      title: `${greeting()}, ${first}`,
      subtitle: longDate(now),
      className: "home-head",
      actions: [
        button("New matter", { icon: "briefcase", onclick: () => window.dispatchEvent(new Event("lawdesk:new-matter")) }),
        button("My tasks", { href: "#/my", variant: "primary", icon: "square-check-big" }),
      ],
    }),
    statsBox,
    h("div.home-grid", h("div.home-main", tasksBox, mattersBox), h("div.home-side", agendaBox, courtBox, activityBox)),
  );
  return page;
}

async function loadAgenda(box, now, my) {
  const to = addDays(now, 13);
  let items = null;
  try {
    const a = await get(`/calendar/agenda?from=${now}&to=${to}&tasks=0&user=${state.me}`);
    items = (a.items || []).filter((x) => x.type !== "task");
  } catch {
    items = null;
  }
  if (items === null) {
    // No calendar module: show the next dated tasks instead, so the card is still useful.
    const dated = [...my.dueToday, ...my.upcoming, ...my.later].slice(0, 5);
    box.replaceChildren(
      card({
        title: "Coming up",
        icon: "calendar-days",
        className: "home-agenda",
        body: dated.length ? agendaList(dated.map((t) => ({ date: t.due_date, title: t.title, sub: t.matter_name, href: t.matter_id ? `#/matters/${t.matter_id}` : "#/my" })), now) : emptyState({ icon: "calendar", title: "Nothing scheduled", compact: true }),
      }),
    );
    return;
  }
  const todays = items.filter((x) => x.date === now);
  const later = items.filter((x) => x.date !== now);
  const row = (ev) => ({
    date: ev.date,
    title: ev.title,
    time: ev.allDay ? "All day" : timeOf(ev.start),
    sub: [ev.matter?.number, ev.location].filter(Boolean).join(" · ") || null,
    kind: ev.kind,
    conflict: ev.conflict,
    href: ev.matter ? `#/matters/${ev.matter.id}` : "#/calendar",
  });
  box.replaceChildren(
    card({
      title: "Your calendar",
      subtitle: "The next two weeks",
      icon: "calendar-days",
      className: "home-agenda",
      actions: button("Calendar", { href: "#/calendar", variant: "ghost", size: "sm", iconRight: "arrow-right" }),
      body: items.length
        ? [
            h(
              "div.agenda-section",
              h("h3.agenda-heading", "Today"),
              todays.length ? agendaList(todays.map(row), now) : h("p.muted.small", "Nothing on your calendar today."),
            ),
            later.length ? h("div.agenda-section", h("h3.agenda-heading", "Coming up"), agendaList(later.slice(0, Math.max(3, 6 - todays.length)).map(row), now)) : null,
          ]
        : emptyState({ icon: "calendar", title: "Nothing on your calendar", body: "Hearings, meetings and deadlines for the next two weeks show here.", compact: true }),
    }),
  );
}

const COURT_KINDS = new Set(["hearing", "court_deadline", "statute_of_limitations"]);

/** The firm's next hearings, court deadlines and limitation dates, whoever is attending. */
async function loadCourtDates(box, now) {
  let items;
  try {
    const a = await get(`/calendar/agenda?from=${now}&to=${addDays(now, 45)}&tasks=0&scope=firm`);
    items = (a.items || []).filter((x) => x.type === "event" && COURT_KINDS.has(x.kind));
  } catch {
    return; // No calendar: leave the space empty rather than show an error on Home.
  }
  box.replaceChildren(
    card({
      title: "Court dates",
      subtitle: "Hearings and deadlines, firm-wide",
      icon: "court",
      className: "home-agenda home-court",
      actions: button("Calculator", { href: "#/deadlines", variant: "ghost", size: "sm", iconRight: "arrow-right" }),
      body: items.length
        ? agendaList(
            items.slice(0, 5).map((ev) => ({
              date: ev.date,
              title: ev.title,
              time: ev.allDay ? null : timeOf(ev.start),
              sub: ev.matter?.number || null,
              kind: ev.kind,
              tag: kindLabel(ev.kind),
              href: ev.matter ? `#/matters/${ev.matter.id}` : "#/calendar",
            })),
            now,
          )
        : emptyState({ icon: "court", title: "No court dates coming up", body: "Hearings and court deadlines added to the calendar, or from the deadline calculator, show here.", compact: true }),
      footer: items.length > 5 ? h("a.card-footer-link", { href: "#/calendar" }, `${plural(items.length - 5, "more court date")} in the calendar`, icon("arrow-right", { size: 14 })) : null,
    }),
  );
}

function agendaList(items, now) {
  return h(
    "ol.agenda",
    items.map((it) => {
      const d = new Date(it.date + "T12:00:00Z");
      const n = daysBetween(now, it.date);
      const day = n === 0 ? "Today" : n === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: n < 7 ? "long" : "short", timeZone: "UTC" });
      return h(
        "li",
        h(
          "a.agenda-item",
          { href: it.href, title: it.title },
          h(
            "span.agenda-date" + (n === 0 ? ".is-today" : ""),
            h("span.agenda-mon", d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })),
            h("span.agenda-day", String(d.getUTCDate())),
          ),
          h(
            "span.agenda-text",
            h(
              "span.agenda-title",
              it.kind ? h("span.cal-kdot.k-" + it.kind, { "aria-hidden": "true" }) : null,
              h("span.agenda-title-text", it.title),
            ),
            h(
              "span.agenda-sub",
              [day, it.time, it.sub].filter(Boolean).join(" · "),
              it.conflict ? [" · ", h("span.late-text", "Double-booked")] : null,
              it.tag ? [" · ", it.tag] : null,
            ),
          ),
        ),
      );
    }),
  );
}

function timeOf(stamp) {
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
}

function lowerFirst(s) {
  s = String(s || "");
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/** "5m ago", "3h ago", "Yesterday", "Nov 12" */
export function ago(stamp) {
  const t = new Date(stamp).getTime();
  if (Number.isNaN(t)) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2 * 86400) return "Yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return fmtTime(stamp).replace(/,.*$/, "");
}
