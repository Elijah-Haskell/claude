// Firm tasks: everyone's work in one table, filtered by person and status and grouped by
// due date, person or matter. The workload strip shows who is overloaded at a glance.

import { h, select, daysBetween, addDays, plural } from "../dom.js";
import { get } from "../api.js";
import { state, today, users, prefs } from "../state.js";
import { quickAdd, taskParts } from "../tasks.js";
import { pageHeader, avatar, emptyState, loadingBlock } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { icon } from "../ui/icons.js";

function bucket(t, now) {
  if (t.status === "done" || t.status === "skipped") return "Finished";
  if (t.status === "waiting") return "Waiting on something";
  if (!t.due_date) return "No due date";
  const n = daysBetween(now, t.due_date);
  if (n < 0) return "Overdue";
  if (n === 0) return "Today";
  if (n <= 7) return "Next 7 days";
  return "Later";
}
const BUCKETS = ["Overdue", "Today", "Next 7 days", "Later", "No due date", "Waiting on something", "Finished"];
const TONES = { Overdue: "late", Today: "today", "Waiting on something": "wait" };
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

export async function firmTasksView() {
  const f = {
    who: prefs.get("firm.who", ""),
    status: prefs.get("firm.status", "active"),
    group: prefs.get("firm.group", "due"),
  };
  const strip = h("div.workload", { role: "group", "aria-label": "Workload by person" });
  let all = null;
  let parts = new Map();
  const P = (t) => {
    if (!parts.has(t.id)) parts.set(t.id, taskParts(t, { refresh: reload, showMatter: false }));
    return parts.get(t.id);
  };

  async function load() {
    const p = new URLSearchParams({ status: f.status });
    if (f.who === "none") p.set("unassigned", "1");
    else if (f.who) p.set("assigneeId", f.who);
    all = await get(`/firm-tasks?${p}`);
    parts = new Map();
    // The workload strip always counts everyone's active work.
    const active = f.status === "active" && !f.who ? all : await get("/firm-tasks?status=active");
    drawStrip(active.tasks);
  }

  function drawStrip(tasks) {
    const now = today();
    const per = new Map();
    for (const u of users()) per.set(u.id, { id: u.id, name: u.name, role: u.default_role, open: 0, late: 0, week: 0 });
    per.set("none", { id: "none", name: "Unassigned", open: 0, late: 0, week: 0 });
    for (const t of tasks) {
      const p = per.get(t.assignee_id ?? "none");
      if (!p) continue;
      p.open++;
      if (t.status === "open" && t.due_date && t.due_date < now) p.late++;
      if (t.status === "open" && t.due_date && t.due_date >= now && t.due_date <= addDays(now, 7)) p.week++;
    }
    const list = [...per.values()].filter((p) => p.id !== "none" || p.open);
    const max = Math.max(1, ...list.map((p) => p.open));
    strip.replaceChildren(
      ...list.map((p) =>
        h(
          "button.load-card" + (String(f.who) === String(p.id) ? ".on" : ""),
          {
            type: "button",
            "aria-pressed": String(f.who) === String(p.id) ? "true" : "false",
            onclick: () => {
              f.who = String(f.who) === String(p.id) ? "" : String(p.id);
              prefs.set("firm.who", f.who);
              whoSel.value = f.who;
              reload();
            },
          },
          h(
            "span.load-top",
            p.id === "none" ? h("span.avatar.av-sm.empty", "?") : avatar(p.name, { size: "sm" }),
            h("span.load-who", h("span.load-name", p.name), p.role ? h("span.load-role.cap", p.role) : null),
          ),
          h(
            "span.load-nums",
            h("b", String(p.open)),
            " open",
            p.late ? h("span.late-text", ` · ${p.late} late`) : null,
            p.week ? h("span.muted", ` · ${p.week} this week`) : null,
          ),
          h("span.load-bar", h("span.load-fill" + (p.late ? ".has-late" : ""), { style: { width: Math.round((p.open / max) * 100) + "%" } })),
        ),
      ),
    );
  }

  const reload = async () => {
    await load();
    table.setRows(all.tasks);
  };

  const whoSel = select(
    [{ value: "", label: "Everyone" }, { value: "none", label: "Unassigned" }, ...users().map((u) => ({ value: u.id, label: u.id === state.me ? `${u.name} (you)` : u.name }))],
    f.who,
    { "aria-label": "Person", onchange: (e) => ((f.who = e.target.value), prefs.set("firm.who", f.who), reload()) },
  );
  const statusSel = select(
    [
      { value: "active", label: "Not finished" },
      { value: "open", label: "Ready to work" },
      { value: "waiting", label: "Waiting" },
      { value: "done", label: "Done" },
      { value: "skipped", label: "Skipped" },
      { value: "all", label: "All" },
    ],
    f.status,
    { "aria-label": "Status", onchange: (e) => ((f.status = e.target.value), prefs.set("firm.status", f.status), reload()) },
  );
  const groupSel = select(
    [
      { value: "due", label: "Group by due date" },
      { value: "person", label: "Group by person" },
      { value: "matter", label: "Group by matter" },
      { value: "none", label: "No grouping" },
    ],
    f.group,
    { "aria-label": "Group by", onchange: (e) => ((f.group = e.target.value), prefs.set("firm.group", f.group), buildTable()) },
  );

  const holder = h("div.card.flush.table-card");
  let table = null;

  function buildTable() {
    const now = today();
    const groupKey = (t) =>
      f.group === "person"
        ? t.assignee_name || "Unassigned"
        : f.group === "matter"
          ? t.matter_id
            ? `${t.matter_number ? t.matter_number + " · " : ""}${t.matter_name}`
            : "No matter"
          : bucket(t, now);
    const rows = table ? null : all.tasks;
    table = dataTable({
      rows: rows || all.tasks,
      label: "Firm tasks",
      noun: ["task", "tasks"],
      tableClass: "task-table",
      prefsKey: "firm.table",
      sort: { key: "due", dir: "asc" },
      pageSize: 100,
      search: { placeholder: "Search tasks, matters or people", text: (t) => [t.title, t.matter_name, t.matter_number, t.assignee_name] },
      filters: [whoSel, statusSel, groupSel],
      countText: (n, total) => (n === total ? plural(total, "task") : `${n} of ${plural(total, "task")}`) + (all.total > all.tasks.length ? ` (first ${all.tasks.length})` : ""),
      groupBy: f.group === "none" ? null : groupKey,
      groupOrder:
        f.group === "due"
          ? BUCKETS
          : (a, b) => (a === "Unassigned" || a === "No matter" ? 1 : b === "Unassigned" || b === "No matter" ? -1 : a.localeCompare(b)),
      groupTone: (k) => (f.group === "due" ? TONES[k] : null),
      rowClass: (t) => P(t).rowClass,
      rowAttrs: (t) => ({
        id: `task-${t.id}`,
        tabindex: "0",
        dataset: { id: t.id, key: t.id },
        "aria-label": `${t.title}${t.status !== "open" ? ", " + t.status : ""}`,
        onkeydown: (e) => P(t).onKey(e, e.currentTarget),
      }),
      columns: [
        { key: "check", label: "", srLabel: "Done", sortable: false, width: "44px", className: "cell-check", render: (t) => P(t).check },
        {
          key: "title",
          label: "Task",
          primary: true,
          className: "cell-task",
          sort: (t) => t.title.toLowerCase(),
          render: (t) => {
            const p = P(t);
            return [h("div.task-title", p.titleEl), p.meta.length ? h("div.task-meta", p.meta) : null, p.waitBox];
          },
        },
        {
          key: "matter",
          label: "Matter",
          className: "cell-matter",
          sort: (t) => (t.matter_number || "") + (t.matter_name || ""),
          render: (t) => P(t).matterLink,
        },
        { key: "who", label: "Assigned to", className: "cell-who", sort: (t) => t.assignee_name || "", render: (t) => P(t).whoBtn },
        { key: "due", label: "Due", className: "cell-due", sort: (t) => t.due_date || null, render: (t) => P(t).dueBtn },
        {
          key: "priority",
          label: "Priority",
          className: "cell-prio",
          hideOnPhone: true,
          sort: (t) => PRIORITY_RANK[t.priority] ?? 1,
          render: (t) =>
            t.priority === "high"
              ? h("span.prio.prio-h", icon("flag", { size: 12 }), "High")
              : t.priority === "low"
                ? h("span.prio.prio-l", "Low")
                : h("span.prio", "Normal"),
        },
        { key: "more", label: "", srLabel: "Actions", sortable: false, width: "44px", className: "cell-more", render: (t) => P(t).moreBtn },
      ],
      empty: ({ searching }) =>
        searching
          ? emptyState({ icon: "search", title: "No tasks match", body: "Try a different word, or clear the filters.", compact: true })
          : emptyState({ icon: "list-checks", title: "No tasks here", body: "Nothing matches these filters. Pick “Everyone” and “Not finished” to see all open work.", compact: true }),
    });
    holder.replaceChildren(table);
  }

  holder.append(loadingBlock("Loading tasks", "table", 6));
  await load();
  buildTable();
  return h(
    "div.page.firm-page",
    pageHeader({ title: "Firm tasks", subtitle: "Everyone's open work across all matters" }),
    strip,
    quickAdd({ onAdded: reload }),
    holder,
  );
}
