// Matters list and the new-matter form.

import { h, select, relDate, modal, toast, plural } from "../dom.js";
import { get, post } from "../api.js";
import { state, today, users, prefs, loadMatters, loadSetup } from "../state.js";

export async function mattersView() {
  let status = prefs.get("matters.status", "open");
  let q = "";
  let rows = [];
  const tbody = h("tbody");
  const count = h("p.result-count.muted");

  async function load() {
    rows = await get(`/matters?status=${status}`);
    draw();
  }

  function draw() {
    const now = today();
    const needle = q.trim().toLowerCase();
    const list = rows.filter((m) => !needle || [m.name, m.number, m.client_name, m.practice_area, m.stage_name].some((x) => x && x.toLowerCase().includes(needle)));
    count.textContent = plural(list.length, "matter");
    tbody.replaceChildren(
      ...list.map((m) =>
        h(
          "tr.matter-row",
          {
            tabindex: "0",
            onclick: (e) => {
              if (!e.target.closest("a")) location.hash = `#/matters/${m.id}`;
            },
            onkeydown: (e) => {
              if (e.key === "Enter") location.hash = `#/matters/${m.id}`;
              if (e.key === "j" || e.key === "ArrowDown") (e.preventDefault(), e.currentTarget.nextElementSibling?.focus());
              if (e.key === "k" || e.key === "ArrowUp") (e.preventDefault(), e.currentTarget.previousElementSibling?.focus());
            },
          },
          h("td.m-name", { "data-label": "Matter" }, h("a", { href: `#/matters/${m.id}` }, m.number ? h("span.num", m.number) : null, m.name), h("div.muted.small", m.client_name || "No client")),
          h("td", { "data-label": "Stage" }, m.status === "closed" ? h("span.tag", "Closed") : m.stage_name ? h("span.stage-pill", m.stage_name) : h("span.muted", "—"), m.practice_area ? h("div.muted.small", m.practice_area) : null),
          h("td.num-cell", { "data-label": "Open tasks" }, String(m.open_tasks)),
          h("td.num-cell", { "data-label": "Overdue" }, m.overdue_tasks ? h("span.badge.late", String(m.overdue_tasks)) : h("span.muted", "0")),
          h("td", { "data-label": "Next due" }, m.next_due ? h("span" + (m.next_due < now ? ".late-text" : ""), relDate(m.next_due, now)) : h("span.muted", "—")),
        ),
      ),
    );
  }

  const seg = h(
    "div.segmented",
    { role: "group", "aria-label": "Show" },
    ["open", "closed", "all"].map((s) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": s === status ? "true" : "false",
          onclick: (e) => {
            status = s;
            prefs.set("matters.status", s);
            seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false"));
            load();
          },
        },
        s[0].toUpperCase() + s.slice(1),
      ),
    ),
  );

  await load();
  return h(
    "div.page",
    h("div.page-head", h("h1", "Matters"), h("button.btn.primary", { type: "button", onclick: newMatterDialog }, "New matter")),
    h(
      "div.filters",
      seg,
      h("input.search", {
        type: "search",
        placeholder: "Search matters",
        "aria-label": "Search matters",
        "data-search": "",
        oninput: (e) => ((q = e.target.value), draw()),
      }),
    ),
    count,
    h(
      "table.matters",
      h("thead", h("tr", h("th", "Matter"), h("th", "Stage"), h("th.num-cell", "Open"), h("th.num-cell", "Overdue"), h("th", "Next due"))),
      tbody,
    ),
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
  const areaHint = h("p.muted.small");
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
    h("label", "Matter name", name),
    h("label", "Matter number", number),
    h("label", "Client", clientSel),
    newClient,
    h("label", "Practice area", area),
    areaHint,
    h("fieldset", h("legend", "People"), roleSels.map(([r, sel]) => h("label.inline", h("span.cap", r), sel))),
    dateInputs.length ? h("fieldset", h("legend", "Key dates (optional)"), dateInputs.map(([, inp, label]) => h("label.inline", h("span", label), inp))) : null,
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Open matter")),
  );
  const dlg = modal("New matter", form, { wide: true });
  name.focus();
}
