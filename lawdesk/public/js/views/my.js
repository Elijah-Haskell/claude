// My tasks: one person's open work in the buckets they act on.

import { h, fmtDate } from "../dom.js";
import { get } from "../api.js";
import { state, today, userName } from "../state.js";
import { quickAdd, taskGroup, taskRow, redraw } from "../tasks.js";
import { todayStrip } from "../cal.js";

export async function myTasksView() {
  const page = h("div.page.my-page");
  if (!state.me) {
    page.append(
      h("h1", "My tasks"),
      h("p.empty", "There are no people set up yet. ", h("a", { href: "#/settings" }, "Add the firm's people in Settings"), " or load the demo with npm run seed."),
    );
    return page;
  }
  const body = h("div.my-body");
  const refresh = () => redraw(body, build);

  async function build() {
    const d = await get(`/my-tasks?userId=${state.me}`);
    const opts = { refresh, showMatter: true };
    const active = d.overdue.length + d.dueToday.length + d.upcoming.length + d.later.length + d.noDate.length;
    const stat = (n, label, tone, target) =>
      h(
        "a.stat" + (tone && n ? "." + tone : ""),
        { href: `#${target}`, onclick: (e) => (e.preventDefault(), document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" })) },
        h("span.stat-n", String(n)),
        h("span.stat-label", label),
      );
    const group = (id, title, tasks, extra = {}) => {
      const g = taskGroup(title, tasks, opts, extra);
      if (g) g.id = id;
      return g;
    };
    return [
      h(
        "div.stats",
        stat(d.overdue.length, "Overdue", "late", "g-overdue"),
        stat(d.dueToday.length, "Due today", "today", "g-today"),
        stat(d.upcoming.length, "Next 7 days", "", "g-upcoming"),
        stat(d.waiting.length, "Waiting", "wait", "g-waiting"),
        stat(d.doneToday.length, "Done today", "good", "g-done"),
      ),
      active === 0 && d.waiting.length === 0
        ? h("div.empty-big", h("p", "Nothing on your list."), h("p.muted", "Add a task above, or apply a checklist to a matter."))
        : null,
      group("g-overdue", "Overdue", d.overdue, { tone: "late" }),
      group("g-today", "Today", d.dueToday, { tone: "today", showEmpty: d.overdue.length === 0, empty: "Nothing else due today." }),
      group("g-upcoming", "Next 7 days", d.upcoming),
      group("g-later", "Later", d.later),
      group("g-nodate", "No due date", d.noDate),
      group("g-waiting", "Waiting on something", d.waiting, {
        tone: "wait",
        aside: h("span.group-note", "These open up by themselves when the tasks before them are done."),
      }),
      d.doneToday.length
        ? h(
            "details.done-today#g-done",
            h("summary", `Done today (${d.doneToday.length})`),
            h("ul.task-list", d.doneToday.map((t) => taskRow(t, opts))),
          )
        : null,
    ];
  }

  await redraw(body, build);
  page.append(
    h("div.page-head", h("h1", "My tasks"), h("p.sub", `${userName(state.me)} · ${fmtDate(today(), today())}`)),
    todayStrip(state.me),
    quickAdd({ onAdded: refresh }),
    body,
  );
  return page;
}
