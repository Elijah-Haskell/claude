// One matter, laid out as a case file: header with the key facts, the stage bar, then
// tabs (Overview, Tasks, Activity, plus any a module registers) beside a right rail with
// people, key dates and checklists. Modules add Overview cards and tabs through
// ui/matter-slots.js.

import { h, select, fmtDate, fmtTime, modal, toast, plural, relDate, daysBetween } from "../dom.js";
import { get, post, put, patch } from "../api.js";
import { state, today, users, prefs, loadMatters, loadSetup } from "../state.js";
import { quickAdd, taskRow, effectLines, redraw } from "../tasks.js";
import { icon } from "../ui/icons.js";
import { breadcrumbs, button, card, pill, person, avatar, emptyState, tabs as tabBar, progressBar, field, activityText } from "../ui/components.js";
import { menu } from "../ui/popover.js";
import { matterTabs, matterCards } from "../ui/matter-slots.js";
import { ago } from "./home.js";
import { upcomingCard } from "../cal.js";
import { billingCard } from "../billing/matter-card.js";
import { communicationsCard } from "./communications.js";
import { matterConflictCards } from "./parties.js";
import { matterDocumentsCard } from "./documents.js";
import { matterPaymentsCard, matterSignaturesCard } from "./pay-esign.js";

const BUILT_IN_TABS = [
  { id: "overview", label: "Overview", icon: "layout-grid", order: 0 },
  { id: "tasks", label: "Tasks", icon: "list-checks", order: 10 },
  { id: "activity", label: "Activity", icon: "activity", order: 90 },
];

export async function matterView([idStr, tabArg]) {
  const id = Number(idStr);
  const page = h("div.page.matter-page");
  let d = null;
  let lists = [];
  let hideDone = prefs.get("matter.hideDone", "0") === "1";
  let showAllActivity = false;
  const expanded = new Set(); // finished checklists the user has opened

  const allTabs = [...BUILT_IN_TABS, ...matterTabs].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  let current = allTabs.some((t) => t.id === tabArg) ? tabArg : "overview";

  const head = h("div.matter-header");
  const stageBar = h("div.stage-wrap");
  const tabsSlot = h("div.tabs-slot");
  const overviewBox = h("div.overview");
  const tasksBox = h("div.matter-tasks");
  const activityBox = h("div.activity-panel");
  const aside = h("aside.matter-aside", { "aria-label": "Matter details" });
  const panels = new Map();
  // Module cards keep their own state, so each is made once and moved into place on redraw.
  const [partiesCard, conflictCard] = matterConflictCards(id, { onChange: () => refresh() });
  const moduleCards = {
    upcoming: upcomingCard(id),
    docs: matterDocumentsCard(id),
    billing: billingCard(id),
    comms: communicationsCard(id, { onChange: () => refresh().catch(() => {}) }),
    payments: matterPaymentsCard(id),
    signatures: null,
  };

  const ctx = () => ({ matterId: id, matter: d.matter, data: d, refresh, openTab });

  const refresh = async () => {
    d = await get(`/matters/${id}`);
    drawAll();
    await redraw(tasksBox, buildTasks);
    loadMatters().catch(() => {});
  };

  const fail = (err) => toast(err.message, { error: true });
  const report = (title, effects) => toast([title, ...effectLines(effects)]);
  const finished = (t) => t.status === "done" || t.status === "skipped";

  function drawAll() {
    drawHead();
    drawStages();
    drawTabs();
    drawAside();
    drawOverview();
    drawActivity();
  }

  // ---------------------------------------------------------------- header
  function drawHead() {
    const m = d.matter;
    const now = today();
    const attorney = d.roles.find((r) => r.role === "attorney");
    const nextDate = d.dates.filter((f) => f.value && f.value >= now).sort((a, b) => a.value.localeCompare(b.value))[0];
    const open = d.tasks.filter((t) => !finished(t));
    const late = open.filter((t) => t.status === "open" && t.due_date && t.due_date < now).length;
    head.replaceChildren(
      breadcrumbs([{ label: "Matters", href: "#/matters" }, { label: m.number || m.name }]),
      h(
        "div.matter-title-row",
        h(
          "div.matter-title-block",
          h("div.matter-icon", { "aria-hidden": "true" }, icon("briefcase", { size: 22 })),
          h(
            "div",
            h(
              "div.matter-eyebrow",
              m.number ? h("span.matter-num", m.number) : null,
              m.practice_area ? h("span", m.practice_area) : null,
              m.status === "closed" ? pill("Closed", "neutral") : pill("Open", "success"),
            ),
            h("h1", m.name),
            h(
              "p.matter-client",
              icon(clientKind(m) === "company" ? "building-2" : "user", { size: 15 }),
              h("span", m.client_name || "No client"),
            ),
          ),
        ),
        h(
          "div.head-actions",
          m.status === "open" ? button("Add task", { icon: "plus", onclick: addTaskDialog }) : null,
          button("Edit details", { icon: "pencil", onclick: editDetails }),
          h(
            "button.icon-btn.bordered",
            {
              type: "button",
              "aria-label": "More matter actions",
              title: "More",
              "aria-haspopup": "menu",
              onclick: (e) =>
                menu(
                  e.currentTarget,
                  [
                    m.status === "open"
                      ? { label: "Close matter", icon: "archive", onSelect: () => closeMatter() }
                      : { label: "Reopen matter", icon: "rotate-ccw", onSelect: () => post(`/matters/${id}/reopen`).then(refresh, fail) },
                    { label: "Work out a court deadline", icon: "calendar-clock", href: `#/deadlines/${id}` },
                    { label: "Copy matter link", icon: "copy", onSelect: () => navigator.clipboard?.writeText(location.href).then(() => toast("Link copied"), () => {}) },
                  ],
                  "Matter actions",
                ),
            },
            icon("ellipsis", { size: 18 }),
          ),
        ),
      ),
      h(
        "dl.matter-facts",
        fact("Client", m.client_name || "—"),
        fact("Responsible attorney", attorney ? person(attorney.name, null, { size: "xs" }) : h("span.muted", "Not set")),
        fact("Opened", fmtDate(m.opened_on, now), m.status === "closed" && m.closed_on ? `Closed ${fmtDate(m.closed_on, now)}` : `${plural(daysBetween(m.opened_on, now), "day")} ago`),
        fact("Next key date", nextDate ? fmtDate(nextDate.value, now) : h("span.muted", "None set"), nextDate ? `${nextDate.label} · ${relDate(nextDate.value, now)}` : null),
        fact("Open tasks", h("span.tnum", String(open.length)), late ? h("span.late-text", `${late} overdue`) : open.length ? "None overdue" : null),
      ),
    );
  }

  function fact(label, value, sub = null) {
    return h("div.fact", h("dt", label), h("dd", h("span.fact-value", value), sub ? h("span.fact-sub", sub) : null));
  }

  function clientKind(m) {
    return state.setup.contacts.find((c) => c.id === m.client_id)?.kind || "company";
  }

  async function closeMatter() {
    try {
      await post(`/matters/${id}/close`);
      toast("Matter closed");
      refresh();
    } catch (err) {
      fail(err);
    }
  }

  function editDetails() {
    const m = d.matter;
    const name = h("input", { value: m.name, required: true, maxlength: 300 });
    const number = h("input", { value: m.number || "", maxlength: 60 });
    const client = select([{ value: "", label: "No client" }, ...state.setup.contacts.map((c) => ({ value: c.id, label: c.name }))], m.client_id ?? "");
    const desc = h("textarea", { rows: 4, maxlength: 5000 }, m.description || "");
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await patch(`/matters/${id}`, { name: name.value, number: number.value || null, clientId: client.value ? Number(client.value) : null, description: desc.value || null });
            dlg.close();
            toast("Saved");
            refresh();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      field("Matter name", name, { required: true }),
      h("div.form-row", field("Matter number", number), field("Client", client)),
      field("Description", desc, { optional: true }),
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Save changes")),
    );
    const dlg = modal("Edit matter", form);
  }

  // ---------------------------------------------------------------- stages
  function drawStages() {
    if (!d.stages.length) return stageBar.replaceChildren();
    const curIdx = d.stages.findIndex((s) => s.id === d.matter.stage_id);
    stageBar.replaceChildren(
      h(
        "div.stage-card",
        h("div.stage-label", h("span", "Stage"), h("span.stage-count", curIdx >= 0 ? `${curIdx + 1} of ${d.stages.length}` : "")),
        h(
          "ol.stage-bar",
          { "aria-label": "Stage" },
          d.stages.map((s, i) => {
            const autos = state.setup.automations.filter((a) => a.enabled && a.trigger === "stage_entered" && a.trigger_ref === s.id);
            return h(
              "li",
              h(
                "button.stage" + (i < curIdx ? ".past" : i === curIdx ? ".current" : ""),
                {
                  type: "button",
                  "aria-current": i === curIdx ? "step" : null,
                  disabled: d.matter.status === "closed",
                  title: i === curIdx ? "Current stage" : `Move to ${s.name}${autos.length ? ` (adds ${autos.map((a) => a.action_name).join(", ")})` : ""}`,
                  onclick: async () => {
                    if (i === curIdx) return;
                    try {
                      const r = await post(`/matters/${id}/stage`, { stageId: s.id });
                      report(`Moved to “${s.name}”`, r);
                      refresh();
                    } catch (err) {
                      fail(err);
                    }
                  },
                },
                h("span.stage-n", i < curIdx ? icon("check", { size: 12, strokeWidth: 3 }) : String(i + 1)),
                h("span.stage-name", s.name),
              ),
            );
          }),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ tabs
  function counts(tid) {
    if (tid === "tasks") return d.tasks.filter((t) => !finished(t)).length;
    if (tid === "activity") return null;
    const t = matterTabs.find((x) => x.id === tid);
    try {
      return t?.count ? t.count(ctx()) : null;
    } catch {
      return null;
    }
  }

  function drawTabs() {
    tabsSlot.replaceChildren(
      tabBar(
        allTabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon, count: counts(t.id) })),
        current,
        (tid) => openTab(tid, false),
        { label: "Matter sections" },
      ),
    );
  }

  function openTab(tid, redrawBar = true) {
    current = tid;
    history.replaceState(null, "", tid === "overview" ? `#/matters/${id}` : `#/matters/${id}/${tid}`);
    for (const [pid, panel] of panels) panel.hidden = pid !== tid;
    if (redrawBar) drawTabs();
    const ext = matterTabs.find((t) => t.id === tid);
    if (ext) renderExt(ext);
  }

  async function renderExt(t) {
    const panel = panels.get(t.id);
    if (!panel || panel.dataset.loaded === "1") return;
    panel.dataset.loaded = "1";
    panel.replaceChildren(h("div.card", h("p.muted", "Loading…")));
    try {
      panel.replaceChildren((await t.render(ctx())) || emptyState({ icon: t.icon || "inbox", title: `No ${t.label.toLowerCase()} yet`, compact: true }));
    } catch (err) {
      panel.replaceChildren(emptyState({ icon: "circle-alert", title: `Couldn't load ${t.label}`, body: err.message, compact: true }));
    }
  }

  // -------------------------------------------------------------- overview
  function drawOverview() {
    const open = d.tasks
      .filter((t) => !finished(t))
      .sort((a, b) => (a.status === "waiting") - (b.status === "waiting") || String(a.due_date || "9999").localeCompare(String(b.due_date || "9999")) || a.id - b.id);
    const next = open.slice(0, 5);
    const nextCard = card({
      title: "Next up",
      subtitle: open.length ? `${plural(open.length, "open task")} on this matter` : null,
      icon: "list-checks",
      flush: true,
      actions: button("All tasks", { variant: "ghost", size: "sm", iconRight: "arrow-right", onclick: () => openTab("tasks") }),
      body: next.length
        ? h(
            "ul.task-list.flush-list",
            next.map((t) => {
              const row = taskRow(t, { refresh, showMatter: false, byId: new Map(d.tasks.map((x) => [x.id, x])) });
              row.removeAttribute("id"); // the Tasks tab holds the canonical row
              return row;
            }),
          )
        : emptyState({ icon: "circle-check", title: "No open tasks", body: d.matter.status === "open" ? "Add a task or apply a checklist from the right." : "This matter is closed.", compact: true }),
    });

    const recent = d.activity.slice(0, 5);
    const actCard = card({
      title: "Recent activity",
      icon: "activity",
      actions: button("View all", { variant: "ghost", size: "sm", iconRight: "arrow-right", onclick: () => openTab("activity") }),
      body: recent.length ? timeline(recent) : emptyState({ icon: "activity", title: "No activity yet", compact: true }),
    });

    const about = card({
      title: "About this matter",
      icon: "file-text",
      actions: button("Edit", { variant: "ghost", size: "sm", onclick: editDetails }),
      body: d.matter.description ? h("p.pre.about-text", d.matter.description) : h("p.muted", "No description yet."),
    });

    const extSlot = h("div.overview-cards");
    if (!moduleCards.signatures) {
      const client = state.setup.contacts.find((c) => c.id === d.matter.client_id);
      moduleCards.signatures = matterSignaturesCard({ id, client_name: d.matter.client_name, client_email: client?.email ?? null });
    }
    const mc = moduleCards;
    overviewBox.replaceChildren(
      h("div.overview-grid", nextCard, about, actCard),
      h("div.overview-modules", mc.upcoming, mc.docs, mc.billing, mc.comms, mc.signatures, mc.payments),
      extSlot,
    );
    // Module cards drop in below, two to a row on wide screens.
    for (const c of matterCards) {
      const holder = h("div.overview-card-slot");
      extSlot.append(holder);
      Promise.resolve()
        .then(() => c.render(ctx()))
        .then((node) => (node ? holder.replaceChildren(node) : holder.remove()))
        .catch(() => holder.remove());
    }
  }

  // ----------------------------------------------------------------- tasks
  function buildTasks() {
    const byId = new Map(d.tasks.map((t) => [t.id, t]));
    const opts = { refresh, showMatter: false, byId, showDeps: true, showRole: true, showDescription: true };
    const visible = d.tasks.filter((t) => !hideDone || !finished(t));
    const groups = d.checklists.map((a) => ({ app: a, tasks: visible.filter((t) => t.application_id === a.id).sort((x, y) => (x.template_position ?? 999) - (y.template_position ?? 999) || x.id - y.id) }));
    const other = visible.filter((t) => !t.application_id || !d.checklists.some((a) => a.id === t.application_id));
    const doneCount = d.tasks.filter(finished).length;
    return [
      h(
        "div.tasks-toolbar",
        h("div.tasks-toolbar-text", h("h2", "Tasks"), h("span.muted", `${plural(d.tasks.length - doneCount, "open task")} · ${doneCount} finished`)),
        h(
          "label.toggle",
          h("input", {
            type: "checkbox",
            role: "switch",
            checked: hideDone,
            onchange: (e) => {
              hideDone = e.target.checked;
              prefs.set("matter.hideDone", hideDone ? "1" : "0");
              redraw(tasksBox, buildTasks);
            },
          }),
          h("span.toggle-track", { "aria-hidden": "true" }),
          "Hide finished",
        ),
        d.matter.status === "open" ? button("Add task with details", { size: "sm", icon: "plus", onclick: addTaskDialog }) : null,
      ),
      groups.map(({ app, tasks }) => {
        const title = h(
          "h3.group-title",
          icon("clipboard-list", { size: 15, class: "group-icon" }),
          h("span", app.name),
          progressBar(app.finished, app.total),
          h("span.muted.small.group-when", app.completed_on ? `finished ${fmtDate(app.completed_on, today())}` : `added ${fmtDate(app.applied_on, today())}`),
        );
        const list = tasks.length ? h("ul.task-list", tasks.map((t) => taskRow(t, opts))) : h("p.empty", "All finished.");
        if (!app.completed_on) return h("section.task-group.checklist-group", title, list);
        // A finished checklist folds away; open it to see or reopen its tasks.
        const det = h("details.task-group.checklist-group.finished-list", { open: expanded.has(app.id) || null }, h("summary", title), list);
        det.addEventListener("toggle", () => (det.open ? expanded.add(app.id) : expanded.delete(app.id)));
        return det;
      }),
      other.length || !groups.length
        ? h(
            "section.task-group",
            h("h3.group-title", icon("list-todo", { size: 15, class: "group-icon" }), h("span", groups.length ? "Other tasks" : "Tasks"), h("span.count", String(other.length))),
            other.length ? h("ul.task-list", other.map((t) => taskRow(t, opts))) : emptyState({ icon: "list-checks", title: "No tasks yet", body: "Add one above or apply a checklist.", compact: true }),
          )
        : null,
    ];
  }

  function addTaskDialog() {
    const title = h("input", { required: true, maxlength: 300 });
    const who = select([{ value: "", label: "Unassigned" }, ...users().map((u) => ({ value: u.id, label: u.name }))], state.me ?? "");
    const due = h("input", { type: "date" });
    const prio = select(["normal", "high", "low"].map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) })), "normal");
    const desc = h("textarea", { rows: 3, maxlength: 5000 });
    const open = d.tasks.filter((t) => t.status === "open" || t.status === "waiting");
    const deps = open.map((t) => [t.id, h("input", { type: "checkbox", value: t.id })]);
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const r = await post("/tasks", {
              matterId: id,
              title: title.value,
              assigneeId: who.value ? Number(who.value) : null,
              dueDate: due.value || null,
              priority: prio.value,
              description: desc.value || null,
              dependsOn: deps.filter(([, c]) => c.checked).map(([tid]) => tid),
            });
            dlg.close();
            toast(`Added “${r.task.title}”${r.task.status === "waiting" ? " (waiting on the tasks you picked)" : ""}`);
            refresh();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      field("What needs doing", title, { required: true }),
      h("div.form-row", field("Assigned to", who), field("Due", due), field("Priority", prio)),
      field("Notes", desc, { optional: true }),
      open.length
        ? h(
            "fieldset.dep-pick",
            h("legend", "Can't start until these are done", h("span.field-optional", " (optional)")),
            h("div.dep-pick-list", deps.map(([tid, c]) => h("label.check-line", c, h("span", d.tasks.find((t) => t.id === tid).title)))),
          )
        : null,
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Add task")),
    );
    const dlg = modal("Add task", form, { wide: true, subtitle: d.matter.number ? `${d.matter.number} · ${d.matter.name}` : d.matter.name });
    title.focus();
  }

  // ------------------------------------------------------------------ aside
  function drawAside() {
    const m = d.matter;
    const roleNames = [...new Set([...state.setup.roles, ...d.roles.map((r) => r.role)])];
    const people = card({
      title: "People",
      icon: "users",
      className: "rail-card",
      headingLevel: 2,
      body: [
        roleNames.map((role) => {
          const cur = d.roles.find((r) => r.role === role);
          return h(
            "label.field-line",
            h("span.field-line-label", cur ? avatar(cur.name, { size: "xs" }) : h("span.avatar.av-xs.empty", "–"), h("span.cap", role)),
            select([{ value: "", label: "—" }, ...users().map((u) => ({ value: u.id, label: u.name }))], cur?.user_id ?? "", {
              "aria-label": role,
              onchange: async (e) => {
                try {
                  const r = await put(`/matters/${id}/roles/${encodeURIComponent(role)}`, { userId: e.target.value ? Number(e.target.value) : null });
                  const ev = r.events.find((x) => x.kind === "role_changed");
                  toast(ev ? ev.detail : "Saved");
                  refresh();
                } catch (err) {
                  fail(err);
                }
              },
            }),
          );
        }),
        h("p.rail-note", "Changing a person here moves their open tasks for that role."),
      ],
    });

    const dates = card({
      title: "Key dates",
      icon: "calendar-days",
      className: "rail-card",
      body: d.dates.length
        ? d.dates.map((f) => {
            const hanging = d.tasks.filter((t) => t.anchor === `field:${f.key}` && (t.status === "open" || t.status === "waiting")).length;
            const inp = h("input", {
              type: "date",
              value: f.value || "",
              "aria-label": f.label,
              onchange: async (e) => {
                try {
                  const r = await put(`/matters/${id}/dates/${encodeURIComponent(f.key)}`, { value: e.target.value || null });
                  report(e.target.value ? `${f.label}: ${fmtDate(e.target.value, today())}` : `${f.label} cleared`, r);
                  refresh();
                } catch (err) {
                  fail(err);
                }
              },
            });
            return h("label.field-line", h("span.field-line-label", h("span", f.label), hanging ? h("span.mini-count", { title: `${plural(hanging, "task")} follow this date` }, String(hanging)) : null), inp);
          })
        : h("p.muted", "No date fields yet. Add them in Settings."),
    });

    const listSel = select(
      [
        { value: "", label: "Choose a checklist…" },
        ...lists
          .slice()
          .sort((a, b) => (b.practice_area_id === m.practice_area_id) - (a.practice_area_id === m.practice_area_id) || a.name.localeCompare(b.name))
          .map((l) => ({ value: l.id, label: `${l.name} (${l.items.length})`, group: l.practice_area_id === m.practice_area_id && m.practice_area_id ? m.practice_area : l.practice_area || "Any practice area" })),
      ],
      "",
      { "aria-label": "Checklist to add" },
    );
    const checklists = card({
      title: "Checklists",
      icon: "clipboard-list",
      className: "rail-card",
      body: [
        d.checklists.length
          ? h(
              "ul.plain.check-progs",
              d.checklists.map((a) =>
                h(
                  "li.check-prog",
                  h("span.check-prog-name", a.name, a.completed_on ? h("span.tag.good", "Done") : null),
                  progressBar(a.finished, a.total),
                ),
              ),
            )
          : h("p.muted", "None yet."),
        m.status === "open"
          ? h(
              "form.apply",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  if (!listSel.value) return;
                  const l = lists.find((x) => String(x.id) === listSel.value);
                  if (d.checklists.some((a) => a.list_id === l.id && !a.completed_on) && !confirm(`“${l.name}” is already on this matter. Add it again?`)) return;
                  try {
                    const r = await post(`/matters/${id}/checklists`, { listId: l.id });
                    report(`Added “${l.name}” (${plural(r.added, "task")})`, r);
                    refresh();
                  } catch (err) {
                    fail(err);
                  }
                },
              },
              listSel,
              h("button.btn", { type: "submit" }, "Apply"),
            )
          : null,
      ],
    });

    aside.replaceChildren(people, partiesCard, conflictCard, dates, checklists);
  }

  // -------------------------------------------------------------- activity
  function timeline(items) {
    return h(
      "ol.timeline",
      items.map((a) =>
        h(
          "li.tl-item",
          h("span.tl-dot" + (a.user_name ? "" : ".auto"), { "aria-hidden": "true" }, a.user_name ? null : icon("zap", { size: 10 })),
          h(
            "div.tl-body",
            h("p.tl-text", h("strong", a.user_name || "Automatic"), " · ", activityText(a.detail, today())),
            h("p.tl-time", { title: fmtTime(a.at) }, ago(a.at)),
          ),
        ),
      ),
    );
  }

  function drawActivity() {
    const items = showAllActivity ? d.activity : d.activity.slice(0, 25);
    activityBox.replaceChildren(
      card({
        title: "Activity",
        subtitle: "Every change on this matter, newest first",
        icon: "activity",
        className: "activity",
        body: [
          d.activity.length ? timeline(items) : emptyState({ icon: "activity", title: "No activity yet", compact: true }),
          d.activity.length > items.length
            ? h("div.more-row", button(`Show all ${d.activity.length}`, { size: "sm", variant: "ghost", onclick: () => ((showAllActivity = true), drawActivity()) }))
            : null,
        ],
      }),
    );
  }

  // ------------------------------------------------------------------ build
  [d, lists] = await Promise.all([get(`/matters/${id}`), get("/checklists")]);
  if (!state.setup.contacts.length) await loadSetup();
  const matterRow = { id, name: d.matter.name, number: d.matter.number, client_name: d.matter.client_name };

  panels.set("overview", h("div.tab-panel", { role: "tabpanel", id: "tab-panel-overview", "aria-labelledby": "tab-overview" }, overviewBox));
  panels.set(
    "tasks",
    h(
      "div.tab-panel",
      { role: "tabpanel", id: "tab-panel-tasks", "aria-labelledby": "tab-tasks" },
      d.matter.status === "open" ? quickAdd({ matter: matterRow, onAdded: refresh }) : null,
      h("div.card.tasks-card", tasksBox),
    ),
  );
  panels.set("activity", h("div.tab-panel", { role: "tabpanel", id: "tab-panel-activity", "aria-labelledby": "tab-activity" }, activityBox));
  for (const t of matterTabs) panels.set(t.id, h("div.tab-panel", { role: "tabpanel", id: `tab-panel-${t.id}`, "aria-labelledby": `tab-${t.id}` }));

  drawAll();
  await redraw(tasksBox, buildTasks);
  for (const [pid, panel] of panels) panel.hidden = pid !== current;
  const ext = matterTabs.find((t) => t.id === current);
  if (ext) renderExt(ext);

  page.append(head, stageBar, tabsSlot, h("div.matter-grid", h("div.matter-main", [...panels.values()]), aside));
  return page;
}
