// Matters list and the new-matter form.

import { h, select, relDate, fmtDate, modal, toast } from "../dom.js";
import { get, post } from "../api.js";
import { state, today, users, prefs, loadMatters, loadSetup } from "../state.js";
import { pageHeader, button, segmented, pill, person, emptyState, field } from "../ui/components.js";
import { dataTable } from "../ui/table.js";

export async function mattersView() {
  let status = prefs.get("matters.status", "open");
  let area = prefs.get("matters.area", "");
  let lawyer = prefs.get("matters.lawyer", "");
  let rows = [];
  const now = today();

  const visible = () => rows.filter((m) => (!area || String(m.practice_area_id) === area) && (!lawyer || m.attorney_name === lawyer));

  async function load() {
    rows = await get(`/matters?status=${status}`);
    table.setRows(visible());
  }

  const seg = segmented(
    [
      { value: "open", label: "Open" },
      { value: "closed", label: "Closed" },
      { value: "all", label: "All" },
    ],
    status,
    (v) => {
      status = v;
      prefs.set("matters.status", v);
      load();
    },
    { label: "Show" },
  );
  const areaSel = select([{ value: "", label: "All practice areas" }, ...state.setup.practiceAreas.map((p) => ({ value: p.id, label: p.name }))], area, {
    "aria-label": "Practice area",
    onchange: (e) => ((area = e.target.value), prefs.set("matters.area", area), table.setRows(visible())),
  });
  const attorneys = users().filter((u) => u.default_role === "attorney");
  const lawyerSel = select([{ value: "", label: "Any attorney" }, ...attorneys.map((u) => ({ value: u.name, label: u.name }))], lawyer, {
    "aria-label": "Responsible attorney",
    onchange: (e) => ((lawyer = e.target.value), prefs.set("matters.lawyer", lawyer), table.setRows(visible())),
  });

  const table = dataTable({
    rows: [],
    label: "Matters",
    noun: ["matter", "matters"],
    tableClass: "matters",
    prefsKey: "matters.table",
    sort: { key: "number", dir: "desc" },
    rowClass: () => "matter-row",
    rowHref: (m) => `#/matters/${m.id}`,
    search: { placeholder: "Search by name, number or client", text: (m) => [m.name, m.number, m.client_name, m.practice_area, m.stage_name, m.attorney_name] },
    filters: [seg, areaSel, lawyerSel],
    columns: [
      {
        key: "name",
        label: "Matter",
        primary: true,
        className: "m-name",
        sort: (m) => m.name.toLowerCase(),
        render: (m) =>
          h(
            "div.cell-stack",
            h("a.cell-title", { href: `#/matters/${m.id}` }, m.name),
            h("span.cell-sub", m.client_name || "No client"),
          ),
      },
      { key: "number", label: "Number", className: "cell-num", sort: (m) => m.number || "", render: (m) => (m.number ? h("span.matter-num", m.number) : h("span.muted", "—")) },
      {
        key: "stage",
        label: "Stage",
        sort: (m) => (m.status === "closed" ? "~" : (m.practice_area || "") + (m.stage_name || "")),
        render: (m) =>
          h(
            "div.cell-stack",
            m.status === "closed" ? pill("Closed", "neutral") : m.stage_name ? h("span.stage-pill", m.stage_name) : h("span.muted", "—"),
            m.practice_area ? h("span.cell-sub", m.practice_area) : null,
          ),
      },
      { key: "attorney", label: "Responsible", className: "nowrap", hideOnPhone: true, sort: (m) => m.attorney_name || "", render: (m) => (m.attorney_name ? person(m.attorney_name, null, { size: "xs" }) : h("span.muted", "—")) },
      { key: "open", label: "Open tasks", phoneLabel: "Open", align: "right", sort: (m) => m.open_tasks, render: (m) => h("span.tnum", String(m.open_tasks)) },
      {
        key: "overdue",
        label: "Overdue",
        align: "right",
        defaultDir: "desc",
        sort: (m) => m.overdue_tasks,
        render: (m) => (m.overdue_tasks ? h("span.badge.late", String(m.overdue_tasks)) : h("span.faint", { "aria-label": "None" }, "—")),
      },
      {
        key: "next",
        label: "Next due",
        className: "nowrap",
        sort: (m) => m.next_due || null,
        render: (m) => (m.next_due ? h("span" + (m.next_due < now ? ".late-text" : m.next_due === now ? ".today-text" : ""), relDate(m.next_due, now)) : h("span.muted", "—")),
      },
      { key: "opened", label: "Opened", className: "nowrap", hideOnPhone: true, defaultDir: "desc", sort: (m) => m.opened_on, render: (m) => h("span.muted", fmtDate(m.opened_on, now)) },
    ],
    empty: ({ searching }) =>
      searching
        ? emptyState({ icon: "search", title: "No matters match", body: "Try another name, number or client.", compact: true })
        : emptyState({
            icon: "briefcase",
            title: status === "closed" ? "No closed matters" : "No matters yet",
            body: status === "closed" ? "Closed matters show here." : "Open a matter to track its tasks, dates and people.",
            action: status === "closed" ? null : button("New matter", { variant: "primary", icon: "plus", onclick: newMatterDialog }),
            compact: true,
          }),
  });

  await load();
  return h(
    "div.page.matters-page",
    pageHeader({
      title: "Matters",
      subtitle: "Every client matter, its stage and what's due next",
      actions: [button("New matter", { variant: "primary", icon: "plus", onclick: newMatterDialog })],
    }),
    h("div.card.flush.table-card", table),
  );
}

export function newMatterDialog() {
  const s = state.setup;
  const name = h("input", { name: "name", required: true, maxlength: 300, autocomplete: "off" });
  const number = h("input", { name: "number", maxlength: 60, autocomplete: "off", placeholder: "Optional" });
  const clientSel = select(
    [{ value: "", label: "No client yet" }, { value: "new", label: "+ New client…" }, ...s.contacts.map((c) => ({ value: c.id, label: c.name }))],
    "",
    { name: "client" },
  );
  const newClient = h("div.new-client", { hidden: true }, h("input", { name: "newClientName", placeholder: "Client name", maxlength: 200 }), select([{ value: "company", label: "Company" }, { value: "person", label: "Person" }], "company", { name: "newClientKind", "aria-label": "Client type" }));
  clientSel.addEventListener("change", () => (newClient.hidden = clientSel.value !== "new"));
  const area = select([{ value: "", label: "None" }, ...s.practiceAreas.map((p) => ({ value: p.id, label: p.name }))], s.practiceAreas[0]?.id ?? "", { name: "area" });
  const roleNames = s.roles.length ? s.roles : ["attorney", "paralegal"];
  const roleSels = roleNames.map((r) => {
    const holders = users().filter((u) => u.default_role === r);
    const def = holders.find((u) => u.id === state.me)?.id ?? (holders.length === 1 ? holders[0].id : "");
    return [r, select([{ value: "", label: "—" }, ...users().map((u) => ({ value: u.id, label: u.name }))], def, { "aria-label": r })];
  });
  const dateInputs = s.dateFields.map((f) => [f.key, h("input", { type: "date", "aria-label": f.label }), f.label]);
  const err = h("p.error-text", { role: "alert" });
  const areaHint = h("p.field-hint.area-hint");
  const updateHint = () => {
    const pa = s.practiceAreas.find((p) => String(p.id) === area.value);
    const first = pa?.stages[0];
    const autos = first ? s.automations.filter((a) => a.enabled && a.trigger === "stage_entered" && a.trigger_ref === first.id) : [];
    areaHint.textContent = first
      ? `Starts in “${first.name}”.${autos.length ? " That adds: " + autos.map((a) => a.action_name).join(", ") + "." : ""}`
      : "";
  };
  area.addEventListener("change", updateHint);
  updateHint();

  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const roles = {};
        for (const [r, sel] of roleSels) if (sel.value) roles[r] = Number(sel.value);
        const dates = {};
        for (const [k, inp] of dateInputs) if (inp.value) dates[k] = inp.value;
        try {
          const m = await post("/matters", {
            name: name.value,
            number: number.value || null,
            clientId: clientSel.value && clientSel.value !== "new" ? Number(clientSel.value) : null,
            newClientName: clientSel.value === "new" ? form.newClientName.value : null,
            newClientKind: form.newClientKind.value,
            practiceAreaId: area.value ? Number(area.value) : null,
            roles,
            dates,
          });
          dlg.close();
          toast(`Opened “${m.name}”`);
          await Promise.all([loadMatters(), loadSetup()]);
          location.hash = `#/matters/${m.id}`;
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    field("Matter name", name, { required: true }),
    h("div.form-row", field("Matter number", number, { optional: true }), field("Practice area", area)),
    areaHint,
    field("Client", clientSel),
    newClient,
    h("fieldset", h("legend", "People"), h("div.form-row", roleSels.map(([r, sel]) => h("label.field", h("span.field-label.cap", r), sel)))),
    dateInputs.length ? h("fieldset", h("legend", "Key dates", h("span.field-optional", " (optional)")), h("div.form-row", dateInputs.map(([, inp, label]) => h("label.field", h("span.field-label", label), inp)))) : null,
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Open matter")),
  );
  const dlg = modal("New matter", form, { wide: true, subtitle: "The first stage's checklists are added automatically." });
  name.focus();
}
