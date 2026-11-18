// My tasks: one person's open work in the buckets they act on.

import { h, fmtDate } from "../dom.js";
import { get } from "../api.js";
import { state, today, userName } from "../state.js";
import { quickAdd, taskGroup, taskRow, redraw } from "../tasks.js";
import { todayStrip } from "../cal.js";
import { pageHeader, stat, emptyState, button } from "../ui/components.js";
import { icon } from "../ui/icons.js";

export async function myTasksView() {
  const page = h("div.page.my-page");
  if (!state.me) {
    page.append(
      pageHeader({ title: "My tasks" }),
      emptyState({ icon: "users", title: "No one is set up yet", body: "Add the firm's people in Settings, or load the demo with npm run seed.", action: button("Open Settings", { href: "#/settings", variant: "primary" }) }),
    );
    return page;
  }
  const body = h("div.my-body");
  const refresh = () => redraw(body, build);

  async function build() {
    const d = await get(`/my-tasks?userId=${state.me}`);
    const opts = { refresh, showMatter: true };
    const active = d.overdue.length + d.dueToday.length + d.upcoming.length + d.later.length + d.noDate.length;
    const jump = (target) => () => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    const group = (id, title, tasks, extra = {}) => {
      const g = taskGroup(title, tasks, opts, extra);
      if (g) g.id = id;
      return g;
    };
    return [
      h(
        "div.stats",
        stat({ label: "Overdue", value: d.overdue.length, tone: d.overdue.length ? "danger" : null, icon: "clock", onclick: jump("g-overdue") }),
        stat({ label: "Due today", value: d.dueToday.length, tone: d.dueToday.length ? "warning" : null, icon: "calendar", onclick: jump("g-today") }),
        stat({ label: "Next 7 days", value: d.upcoming.length, icon: "calendar-days", onclick: jump("g-upcoming") }),
        stat({ label: "Waiting", value: d.waiting.length, tone: d.waiting.length ? "neutral" : null, icon: "hourglass", onclick: jump("g-waiting") }),
        stat({ label: "Done today", value: d.doneToday.length, tone: d.doneToday.length ? "success" : null, icon: "circle-check", onclick: jump("g-done") }),
      ),
      active === 0 && d.waiting.length === 0
        ? emptyState({ icon: "circle-check", title: "Nothing on your list", body: "Add a task above, or apply a checklist to a matter." })
        : null,
      group("g-overdue", "Overdue", d.overdue, { tone: "late", icon: "clock" }),
      group("g-today", "Today", d.dueToday, { tone: "today", icon: "calendar", showEmpty: d.overdue.length === 0 && active > 0, empty: "Nothing else due today." }),
      group("g-upcoming", "Next 7 days", d.upcoming, { icon: "calendar-days" }),
      group("g-later", "Later", d.later, { icon: "calendar-clock" }),
      group("g-nodate", "No due date", d.noDate, { icon: "circle-dot" }),
      group("g-waiting", "Waiting on something", d.waiting, {
        tone: "wait",
        icon: "hourglass",
        aside: h("span.group-note", "These open up by themselves when the tasks before them are done."),
      }),
      d.doneToday.length
        ? h(
            "details.done-today#g-done",
            h("summary", icon("chevron-right", { size: 14, class: "summary-chev" }), `Done today`, h("span.count", String(d.doneToday.length))),
            h("ul.task-list", d.doneToday.map((t) => taskRow(t, opts))),
          )
        : null,
    ];
  }

  await redraw(body, build);
  page.append(
    pageHeader({ title: "My tasks", subtitle: `${userName(state.me)} · ${fmtDate(today(), today())}` }),
    todayStrip(state.me),
    quickAdd({ onAdded: refresh }),
    body,
  );
  return page;
}
