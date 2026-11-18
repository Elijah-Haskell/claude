// One matter: stage bar, people in roles, key dates, checklists and every task,
// with dependencies shown and the activity log.

import { h, select, fmtDate, fmtTime, modal, toast, plural, replace } from "../dom.js";
import { get, post, put, patch } from "../api.js";
import { state, today, users, prefs, loadMatters, loadSetup } from "../state.js";
import { quickAdd, taskRow, effectLines, redraw } from "../tasks.js";
import { upcomingCard } from "../cal.js";
import { billingCard } from "../billing/matter-card.js";
import { communicationsCard } from "./communications.js";
import { matterConflictCards } from "./parties.js";
import { matterDocumentsCard } from "./documents.js";
import { matterPaymentsCard, matterSignaturesCard } from "./pay-esign.js";

export async function matterView([idStr]) {
  const id = Number(idStr);
  const page = h("div.page.matter-page");
  let d = null;
  let lists = [];
  let hideDone = prefs.get("matter.hideDone", "0") === "1";
  let showAllActivity = false;
  const expanded = new Set(); // finished checklists the user has opened

  const head = h("div");
  const stageBar = h("div");
  const tasksBox = h("div.matter-tasks");
  const aside = h("aside.matter-aside");
  const activityBox = h("section.card.activity");
  const [partiesCard, conflictCard] = matterConflictCards(id, { onChange: () => refresh() });
  const docsCard = matterDocumentsCard(id);

  const refresh = async () => {
    d = await get(`/matters/${id}`);
    drawHead();
    drawStages();
    drawAside();
    drawActivity();
    await redraw(tasksBox, buildTasks);
    loadMatters().catch(() => {});
  };

  const fail = (err) => toast(err.message, { error: true });
  const report = (title, effects) => toast([title, ...effectLines(effects)]);

  // ---------------------------------------------------------------- header
  function drawHead() {
    const m = d.matter;
    head.replaceChildren(
      h("a.back", { href: "#/matters" }, "← Matters"),
      h(
        "div.page-head",
        h(
          "div",
          h("h1", m.number ? h("span.num", m.number) : null, m.name),
          h(
            "p.sub",
            [m.client_name || "No client", m.practice_area, `opened ${fmtDate(m.opened_on, today())}`, m.status === "closed" ? `closed ${fmtDate(m.closed_on, today())}` : null]
              .filter(Boolean)
              .join(" · "),
          ),
        ),
        h(
          "div.head-actions",
          m.status === "closed" ? h("span.tag", "Closed") : null,
          h("a.btn", { href: `#/deadlines/${id}` }, "Court deadline"),
          h("button.btn", { type: "button", onclick: editDetails }, "Edit details"),
          m.status === "open"
            ? h("button.btn", { type: "button", onclick: () => closeMatter() }, "Close matter")
            : h("button.btn", { type: "button", onclick: () => post(`/matters/${id}/reopen`).then(refresh, fail) }, "Reopen"),
        ),
      ),
    );
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
      h("label", "Matter name", name),
      h("label", "Matter number", number),
      h("label", "Client", client),
      h("label", "Description", desc),
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Save")),
    );
    const dlg = modal("Edit matter", form);
  }

  // ---------------------------------------------------------------- stages
  function drawStages() {
    if (!d.stages.length) return stageBar.replaceChildren();
    const curIdx = d.stages.findIndex((s) => s.id === d.matter.stage_id);
    stageBar.replaceChildren(
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
              h("span.stage-n", String(i + 1)),
              h("span.stage-name", s.name),
            ),
          );
        }),
      ),
    );
  }

  // ----------------------------------------------------------------- tasks
  function buildTasks() {
    const byId = new Map(d.tasks.map((t) => [t.id, t]));
    const opts = { refresh, showMatter: false, byId, showDeps: true, showRole: true, showDescription: true };
    const finished = (t) => t.status === "done" || t.status === "skipped";
    const visible = d.tasks.filter((t) => !hideDone || !finished(t));
    const groups = d.checklists.map((a) => ({ app: a, tasks: visible.filter((t) => t.application_id === a.id).sort((x, y) => (x.template_position ?? 999) - (y.template_position ?? 999) || x.id - y.id) }));
    const other = visible.filter((t) => !t.application_id || !d.checklists.some((a) => a.id === t.application_id));
    const doneCount = d.tasks.filter(finished).length;
    return [
      h(
        "div.tasks-toolbar",
        h("h2", "Tasks"),
        h("span.muted", `${plural(d.tasks.length - doneCount, "open task")}, ${doneCount} finished`),
        h(
          "label.toggle",
          h("input", {
            type: "checkbox",
            checked: hideDone,
            onchange: (e) => {
              hideDone = e.target.checked;
              prefs.set("matter.hideDone", hideDone ? "1" : "0");
              redraw(tasksBox, buildTasks);
            },
          }),
          " Hide finished",
        ),
        h("button.btn.small", { type: "button", onclick: addTaskDialog }, "Add task with details…"),
      ),
      groups.map(({ app, tasks }) => {
        const title = h(
          "h3.group-title",
          h("span", app.name),
          progress(app.finished, app.total),
          h("span.muted.small", app.completed_on ? `finished ${fmtDate(app.completed_on, today())}` : `added ${fmtDate(app.applied_on, today())}`),
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
            h("h3.group-title", h("span", groups.length ? "Other tasks" : "Tasks"), h("span.count", String(other.length))),
            other.length ? h("ul.task-list", other.map((t) => taskRow(t, opts))) : h("p.empty", "No tasks yet. Add one above or apply a checklist."),
          )
        : null,
    ];
  }

  function progress(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return h(
      "span.progress",
      { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done), "aria-label": `${done} of ${total} finished` },
      h("span.progress-bar", h("span.progress-fill", { style: { width: pct + "%" } })),
      h("span.progress-text", `${done}/${total}`),
    );
  }

  function addTaskDialog() {
    const title = h("input", { required: true, maxlength: 300 });
    const who = select([{ value: "", label: "Unassigned" }, ...users().map((u) => ({ value: u.id, label: u.name }))], state.me ?? "");
    const due = h("input", { type: "date" });
    const prio = select(["normal", "high", "low"].map((p) => ({ value: p, label: p })), "normal");
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
      h("label", "What needs doing", title),
      h("div.form-row", h("label", "Assigned to", who), h("label", "Due", due), h("label", "Priority", prio)),
      h("label", "Notes", desc),
      open.length
        ? h(
            "fieldset.dep-pick",
            h("legend", "Can't start until these are done (optional)"),
            deps.map(([tid, c]) => h("label.check-line", c, " ", d.tasks.find((t) => t.id === tid).title)),
          )
        : null,
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Add task")),
    );
    const dlg = modal("Add task", form, { wide: true });
    title.focus();
  }

  // ------------------------------------------------------------------ aside
  function drawAside() {
    const m = d.matter;
    const roleNames = [...new Set([...state.setup.roles, ...d.roles.map((r) => r.role)])];
    const people = h(
      "section.card",
      h("h2", "People"),
      roleNames.map((role) => {
        const cur = d.roles.find((r) => r.role === role);
        return h(
          "label.field-line",
          h("span.cap", role),
          select([{ value: "", label: "—" }, ...users().map((u) => ({ value: u.id, label: u.name }))], cur?.user_id ?? "", {
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
      h("p.muted.small", "Changing a person here moves their open tasks for that role."),
    );

    const dates = h(
      "section.card",
      h("h2", "Key dates"),
      d.dates.length
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
            return h("label.field-line", h("span", f.label, hanging ? h("span.muted.small", ` · ${plural(hanging, "task")}`) : null), inp);
          })
        : h("p.muted", "No date fields yet. Add them in Settings."),
    );

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
    const checklists = h(
      "section.card",
      h("h2", "Checklists"),
      d.checklists.length
        ? h(
            "ul.plain",
            d.checklists.map((a) => h("li.check-prog", h("span", a.name, a.completed_on ? h("span.tag.good", "Done") : null), progress(a.finished, a.total))),
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
            h("button.btn", { type: "submit" }, "Add"),
          )
        : null,
    );

    const client = state.setup.contacts.find((c) => c.id === m.client_id);
    replace(
      aside,
      upcomingCard(id),
      people,
      partiesCard,
      conflictCard,
      docsCard,
      billingCard(id),
      dates,
      checklists,
      matterSignaturesCard({ id, client_name: m.client_name, client_email: client?.email ?? null }),
      matterPaymentsCard(id),
      m.description ? h("section.card", h("h2", "About"), h("p.pre", m.description)) : null,
    );
  }

  function drawActivity() {
    const items = showAllActivity ? d.activity : d.activity.slice(0, 12);
    replace(activityBox, 
      h("h2", "Activity"),
      h(
        "ol.activity-list",
        items.map((a) => h("li", h("span.act-time", fmtTime(a.at)), h("span.act-who", a.user_name || "Automatic"), h("span.act-what", a.detail))),
      ),
      d.activity.length > items.length
        ? h("button.btn.small", { type: "button", onclick: () => ((showAllActivity = true), drawActivity()) }, `Show all ${d.activity.length}`)
        : null,
    );
  }

  [d, lists] = await Promise.all([get(`/matters/${id}`), get("/checklists")]);
  if (!state.setup.contacts.length) await loadSetup();
  drawHead();
  drawStages();
  drawAside();
  drawActivity();
  await redraw(tasksBox, buildTasks);
  const matterRow = { id, name: d.matter.name, number: d.matter.number, client_name: d.matter.client_name };
  page.append(
    head,
    stageBar,
    h(
      "div.matter-grid",
      h("div.matter-main", d.matter.status === "open" ? quickAdd({ matter: matterRow, onAdded: refresh }) : null, tasksBox),
      aside,
      communicationsCard(id, { onChange: () => refresh().catch(() => {}) }),
      activityBox,
    ),
  );
  return page;
}
