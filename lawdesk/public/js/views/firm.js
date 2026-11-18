// Firm tasks: everyone's work, filtered by person and status, grouped by due date,
// person or matter. The workload strip shows who is overloaded at a glance.

import { h, select, plural, daysBetween, addDays } from "../dom.js";
import { get } from "../api.js";
import { state, today, users, prefs } from "../state.js";
import { quickAdd, taskGroup, redraw } from "../tasks.js";

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

export async function firmTasksView() {
  const f = {
    who: prefs.get("firm.who", ""),
    status: prefs.get("firm.status", "active"),
    group: prefs.get("firm.group", "due"),
    q: "",
  };
  const body = h("div.firm-body");
  const strip = h("div.workload", { "aria-label": "Workload by person" });
  const refresh = () => redraw(body, build);
  let all = null;

  async function load() {
    const p = new URLSearchParams({ status: f.status });
    if (f.who === "none") p.set("unassigned", "1");
    else if (f.who) p.set("assigneeId", f.who);
    all = await get(`/firm-tasks?${p}`);
    // The workload strip always counts everyone's active work.
    const active = f.status === "active" && !f.who ? all : await get("/firm-tasks?status=active");
    drawStrip(active.tasks);
  }

  function drawStrip(tasks) {
    const now = today();
    const per = new Map();
    for (const u of users()) per.set(u.id, { id: u.id, name: u.name, open: 0, late: 0, week: 0 });
    per.set("none", { id: "none", name: "Unassigned", open: 0, late: 0, week: 0 });
    for (const t of tasks) {
      const p = per.get(t.assignee_id ?? "none");
      if (!p) continue;
      p.open++;
      if (t.status === "open" && t.due_date && t.due_date < now) p.late++;
      if (t.status === "open" && t.due_date && t.due_date >= now && t.due_date <= addDays(now, 7)) p.week++;
    }
    strip.replaceChildren(
      ...[...per.values()]
        .filter((p) => p.id !== "none" || p.open)
        .map((p) =>
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
            h("span.load-name", p.name),
            h("span.load-nums", h("b", String(p.open)), " open", p.late ? h("span.late-text", ` · ${p.late} late`) : null, p.week ? ` · ${p.week} this week` : null),
          ),
        ),
    );
  }

  function build() {
    const now = today();
    const q = f.q.trim().toLowerCase();
    const tasks = all.tasks.filter(
      (t) => !q || [t.title, t.matter_name, t.matter_number, t.assignee_name].some((x) => x && x.toLowerCase().includes(q)),
    );
    const opts = { refresh: reload, showMatter: true };
    const groups = new Map();
    const keyOf = (t) =>
      f.group === "person" ? t.assignee_name || "Unassigned" : f.group === "matter" ? (t.matter_id ? `${t.matter_number ? t.matter_number + " · " : ""}${t.matter_name}` : "No matter") : bucket(t, now);
    for (const t of tasks) {
      const k = keyOf(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    let keys = [...groups.keys()];
    if (f.group === "due") keys = BUCKETS.filter((b) => groups.has(b));
    else keys.sort((a, b) => (a === "Unassigned" || a === "No matter" ? 1 : b === "Unassigned" || b === "No matter" ? -1 : a.localeCompare(b)));
    return [
      h("p.result-count.muted", plural(tasks.length, "task"), all.total > all.tasks.length ? ` (showing first ${all.tasks.length})` : ""),
      tasks.length ? null : h("p.empty", "No tasks match."),
      keys.map((k) => taskGroup(k, groups.get(k), opts, { tone: f.group === "due" ? TONES[k] : null })),
    ];
  }

  const reload = async () => {
    await load();
    await refresh();
  };

  const whoSel = select(
    [{ value: "", label: "Everyone" }, { value: "none", label: "Unassigned" }, ...users().map((u) => ({ value: u.id, label: u.id === state.me ? `${u.name} (you)` : u.name }))],
    f.who,
    { "aria-label": "Person", onchange: (e) => (f.who = e.target.value, prefs.set("firm.who", f.who), reload()) },
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
    { "aria-label": "Status", onchange: (e) => (f.status = e.target.value, prefs.set("firm.status", f.status), reload()) },
  );
  const groupSel = select(
    [
      { value: "due", label: "Group by due date" },
      { value: "person", label: "Group by person" },
      { value: "matter", label: "Group by matter" },
    ],
    f.group,
    { "aria-label": "Group by", onchange: (e) => (f.group = e.target.value, prefs.set("firm.group", f.group), refresh()) },
  );
  const search = h("input.search", {
    type: "search",
    placeholder: "Filter by task, matter or person  ( / )",
    "aria-label": "Filter tasks",
    "data-search": "",
    oninput: (e) => {
      f.q = e.target.value;
      refresh();
    },
  });

  await load();
  await refresh();
  return h(
    "div.page",
    h("div.page-head", h("h1", "Firm tasks")),
    strip,
    h("div.filters", whoSel, statusSel, groupSel, search),
    quickAdd({ onAdded: reload }),
    body,
  );
}
