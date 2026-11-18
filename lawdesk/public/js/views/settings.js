// Settings: people, clients, practice areas and stages, matter date fields, days the
// firm is closed, and automations.

import { h, select, toast, fmtDate, slug } from "../dom.js";
import { get, post, patch, put, del } from "../api.js";
import { state, loadSetup, today } from "../state.js";
import { emailSettingsSection } from "./email-settings.js";
import { paymentSettingsSection, esignSettingsSection } from "./pay-esign.js";
import { accountsSection } from "./accounts.js";
import { pageHeader, avatar, callout, button } from "../ui/components.js";
import { icon } from "../ui/icons.js";

function sectionHead(ic, title, desc = null) {
  return h(
    "header.card-header",
    h("div.card-heading", h("span.card-icon", icon(ic, { size: 16 })), h("div", h("h2.card-title", title), desc ? h("p.card-subtitle", desc) : null)),
  );
}

export async function settingsView() {
  const page = h("div.page.settings");
  let lists = [];

  const fail = (err) => toast(err.message, { error: true });
  async function act(fn, message, redrawPage = true) {
    try {
      await fn();
      if (message) toast(message);
      await reload(redrawPage);
    } catch (err) {
      fail(err);
      await reload(true);
    }
  }
  /** Text edits save without redrawing, so Tab keeps moving through the fields. */
  const edit = (fn) => act(fn, "Saved", false);
  async function reload(redrawPage) {
    [lists] = await Promise.all([get("/checklists"), loadSetup()]);
    window.dispatchEvent(new Event("lawdesk:setup"));
    if (redrawPage) draw();
  }

  const nav = h(
    "nav.settings-nav",
    { "aria-label": "Settings sections" },
    [
      ["s-people", "People"],
      ["s-accounts", "Sign-in and access"],
      ["s-clients", "Clients"],
      ["s-areas", "Practice areas"],
      ["s-dates", "Matter dates"],
      ["s-closed", "Closed days"],
      ["s-auto", "Automatic steps"],
      ["s-email", "Email"],
      ["s-pay", "Online payments"],
      ["s-esign", "Electronic signatures"],
    ].map(([id, label]) =>
      h(
        "a",
        {
          href: `#${id}`,
          onclick: (e) => {
            e.preventDefault();
            nav.querySelectorAll("a").forEach((a) => a.removeAttribute("aria-current"));
            e.currentTarget.setAttribute("aria-current", "true");
            const target = document.getElementById(id);
            (target?.closest(".settings-frame") || target)?.scrollIntoView({ behavior: "smooth", block: "start" });
          },
        },
        icon({ "s-people": "users", "s-accounts": "lock", "s-clients": "contact", "s-areas": "scale", "s-dates": "calendar-days", "s-closed": "calendar-clock", "s-auto": "zap", "s-email": "mail", "s-pay": "wallet", "s-esign": "pencil" }[id] || "settings", { size: 16 }),
        label,
      ),
    ),
    h("a", { href: "#/settings/templates" }, icon("file-text", { size: 16 }), "Document templates"),
  );
  // Intake has its own settings pages.
  nav.append(h("a", { href: "#/settings/intake-forms" }, icon("inbox", { size: 16 }), "Intake forms"), h("a", { href: "#/settings/booking" }, icon("calendar-days", { size: 16 }), "Booking availability"), h("a", { href: "#/settings/import-clio" }, icon("archive", { size: 16 }), "Import from Clio"));
  const body = h("div.settings-body");
  const emailSection = emailSettingsSection(); // loads its own data; kept across redraws

  function draw() {
    const s = state.setup;
    const note = state.account?.role === "admin" ? null : callout({ tone: "info", body: "Only an administrator can change these settings." });
    body.replaceChildren(
      ...[
        note,
        people(s),
        accountsSection(),
        clients(s),
        areas(s),
        dateFields(s),
        closedDays(s),
        automations(s),
        frame("mail", "Email", "How Lawdesk sends email, the reminders it sends, and saved email templates.", emailSection),
        frame("wallet", "Online payments", "Letting clients pay their invoices online.", paymentSettingsSection()),
        frame("pencil", "Electronic signatures", "Sending documents to clients to sign online.", esignSettingsSection()),
      ].filter(Boolean),
    );
  }

  /**
   * The email, payment and e-signature sections are drawn by their own modules, with their own
   * card and heading. This puts them in the same card frame as the rest of Settings unchanged:
   * their own h2 stays the section's heading for screen readers (visually hidden by auth.css),
   * and the frame shows the same title with an icon and a description.
   */
  function frame(ic, title, desc, section) {
    return h(
      "div.card.card-v2.settings-card.settings-frame",
      h(
        "header.card-header",
        { "aria-hidden": "true" },
        h("div.card-heading", h("span.card-icon", icon(ic, { size: 16 })), h("div", h("div.card-title", title), h("p.card-subtitle", desc))),
      ),
      section,
    );
  }

  // ---------------------------------------------------------------- people
  function people(s) {
    const roleList = h("datalist#user-roles", ["attorney", "paralegal", "assistant", ...s.roles].filter((v, i, a) => a.indexOf(v) === i).map((r) => h("option", { value: r })));
    const row = (u) =>
      h(
        "tr" + (u.active ? "" : ".inactive"),
        h("td.person-cell", { "data-label": "Name" }, avatar(u.name, { size: "sm" }), h("input", { value: u.name, "aria-label": "Name", maxlength: 200, onchange: (e) => edit(() => patch(`/users/${u.id}`, { name: e.target.value })) })),
        h("td", { "data-label": "Role" }, h("input", { value: u.default_role || "", list: "user-roles", "aria-label": "Usual role", maxlength: 60, onchange: (e) => edit(() => patch(`/users/${u.id}`, { defaultRole: e.target.value || null })) })),
        h("td", { "data-label": "Email" }, h("input", { type: "email", value: u.email || "", "aria-label": "Email", maxlength: 200, onchange: (e) => edit(() => patch(`/users/${u.id}`, { email: e.target.value || null })) })),
        h(
          "td",
          h(
            "button.btn.small",
            { type: "button", onclick: () => act(() => patch(`/users/${u.id}`, { active: !u.active }), u.active ? `${u.name} deactivated` : `${u.name} reactivated`) },
            u.active ? "Deactivate" : "Reactivate",
          ),
        ),
      );
    const name = h("input", { placeholder: "Name", "aria-label": "New person's name", required: true, maxlength: 200 });
    const role = h("input", { placeholder: "Role, e.g. paralegal", list: "user-roles", "aria-label": "New person's role", maxlength: 60 });
    const email = h("input", { type: "email", placeholder: "Email (optional)", "aria-label": "New person's email", maxlength: 200 });
    return h(
      "section.card.settings-section#s-people",
      sectionHead("users", "People", "The role is used to assign checklist steps (a step for the paralegal goes to the matter's paralegal, or to the only paralegal at the firm)."),
      roleList,
      h("table.settings-table", h("thead", h("tr", h("th", "Name"), h("th", "Usual role"), h("th", "Email"), h("th", ""))), h("tbody", s.allUsers.map(row))),
      h(
        "form.add-row",
        { onsubmit: (e) => (e.preventDefault(), act(() => post("/users", { name: name.value, defaultRole: role.value || null, email: email.value || null }), `Added ${name.value}`)) },
        name,
        role,
        email,
        h("button.btn", { type: "submit" }, "Add person"),
      ),
    );
  }

  // --------------------------------------------------------------- clients
  function clients(s) {
    const name = h("input", { placeholder: "Client name", "aria-label": "Client name", required: true, maxlength: 200 });
    const kind = select([{ value: "company", label: "Company" }, { value: "person", label: "Person" }], "company", { "aria-label": "Type" });
    const email = h("input", { type: "email", placeholder: "Email", "aria-label": "Client email", maxlength: 200 });
    const phone = h("input", { placeholder: "Phone", "aria-label": "Client phone", maxlength: 60 });
    return h(
      "section.card.settings-section#s-clients",
      sectionHead("contact", "Clients"),
      s.contacts.length
        ? h(
            "ul.plain.client-list",
            s.contacts.map((c) =>
              h(
                "li",
                h("span.client-icon", icon(c.kind === "company" ? "building-2" : "user", { size: 15 })),
                h("span.client-name", c.name),
                h("span.muted.small.cap", c.kind),
                h("span.muted.small.client-contact", [c.email, c.phone].filter(Boolean).join(" · ")),
              ),
            ),
          )
        : h("p.muted", "No clients yet."),
      h(
        "form.add-row",
        { onsubmit: (e) => (e.preventDefault(), act(() => post("/contacts", { name: name.value, kind: kind.value, email: email.value || null, phone: phone.value || null }), `Added ${name.value}`)) },
        name,
        kind,
        email,
        phone,
        h("button.btn", { type: "submit" }, "Add client"),
      ),
    );
  }

  // ---------------------------------------------------------- practice areas
  function areas(s) {
    const areaCard = (a) => {
      const move = (i, d) => {
        const ids = a.stages.map((x) => x.id);
        const j = i + d;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        act(() => put(`/practice-areas/${a.id}/stage-order`, { stageIds: ids }));
      };
      const newStage = h("input", { placeholder: "New stage", "aria-label": `New stage for ${a.name}`, required: true, maxlength: 100 });
      return h(
        "div.area",
        h("input.area-name", { value: a.name, "aria-label": "Practice area name", maxlength: 200, onchange: (e) => edit(() => patch(`/practice-areas/${a.id}`, { name: e.target.value })) }),
        h(
          "ol.stage-edit",
          a.stages.map((st, i) =>
            h(
              "li",
              h("span.stage-n", String(i + 1)),
              h("input", { value: st.name, "aria-label": `Stage ${i + 1} name`, maxlength: 100, onchange: (e) => edit(() => patch(`/stages/${st.id}`, { name: e.target.value })) }),
              h("button.icon-btn", { type: "button", "aria-label": `Move ${st.name} up`, disabled: i === 0, onclick: () => move(i, -1) }, icon("arrow-up", { size: 15 })),
              h("button.icon-btn", { type: "button", "aria-label": `Move ${st.name} down`, disabled: i === a.stages.length - 1, onclick: () => move(i, 1) }, icon("arrow-down", { size: 15 })),
              h("button.icon-btn.danger", { type: "button", "aria-label": `Delete stage ${st.name}`, onclick: () => confirm(`Delete the stage “${st.name}”?`) && act(() => del(`/stages/${st.id}`), "Stage deleted") }, icon("x", { size: 16 })),
            ),
          ),
        ),
        h("form.add-row", { onsubmit: (e) => (e.preventDefault(), act(() => post(`/practice-areas/${a.id}/stages`, { name: newStage.value }), "Stage added")) }, newStage, h("button.btn.small", { type: "submit" }, "Add stage")),
      );
    };
    const name = h("input", { placeholder: "Practice area", "aria-label": "New practice area", required: true, maxlength: 200 });
    const stages = h("input", { placeholder: "Stages, separated by commas", "aria-label": "Stages", maxlength: 1000 });
    return h(
      "section.card.settings-section#s-areas",
      sectionHead("scale", "Practice areas and stages", "A new matter starts in the first stage. Matters move through stages from the stage bar on the matter page."),
      h("div.area-grid", s.practiceAreas.map(areaCard)),
      h(
        "form.add-row",
        {
          onsubmit: (e) => {
            e.preventDefault();
            const list = stages.value.split(",").map((x) => x.trim()).filter(Boolean);
            act(() => post("/practice-areas", { name: name.value, stages: list }), `Added ${name.value}`);
          },
        },
        name,
        stages,
        h("button.btn", { type: "submit" }, "Add practice area"),
      ),
    );
  }

  // ------------------------------------------------------------ date fields
  function dateFields(s) {
    const label = h("input", { placeholder: "Label, e.g. Closing date", "aria-label": "New date field label", required: true, maxlength: 100 });
    return h(
      "section.card.settings-section#s-dates",
      sectionHead("calendar-days", "Matter dates", "Dates every matter can have (closing date, filing date). Checklist steps can be due a number of days before or after them, and move when the date changes."),
      h(
        "ul.plain",
        s.dateFields.map((f) =>
          h(
            "li.date-field",
            h("input", { value: f.label, "aria-label": `Label for ${f.key}`, maxlength: 100, onchange: (e) => edit(() => patch(`/date-fields/${encodeURIComponent(f.key)}`, { label: e.target.value })) }),
            h("code", f.key),
            h("button.icon-btn.danger", { type: "button", "aria-label": `Delete ${f.label}`, onclick: () => confirm(`Delete the date field “${f.label}”?`) && act(() => del(`/date-fields/${encodeURIComponent(f.key)}`), "Deleted") }, icon("x", { size: 16 })),
          ),
        ),
      ),
      h("form.add-row", { onsubmit: (e) => (e.preventDefault(), act(() => post("/date-fields", { key: slug(label.value), label: label.value }), `Added ${label.value}`)) }, label, h("button.btn", { type: "submit" }, "Add date field")),
    );
  }

  // ------------------------------------------------------------ closed days
  function closedDays(s) {
    const now = today();
    const upcoming = s.holidays.filter((d) => d.date >= now);
    const past = s.holidays.length - upcoming.length;
    const date = h("input", { type: "date", "aria-label": "Date the firm is closed", required: true });
    const name = h("input", { placeholder: "Name (optional)", "aria-label": "Name", maxlength: 100 });
    return h(
      "section.card.settings-section#s-closed",
      sectionHead("calendar-clock", "Days the firm is closed", "Business-day due dates skip weekends and these days. Adding or removing one re-dates open tasks that count business days."),
      upcoming.length
        ? h(
            "ul.plain.closed-list",
            upcoming.map((d) =>
              h(
                "li",
                h("span", fmtDate(d.date, now)),
                h("span.muted", d.name || ""),
                h("button.icon-btn.danger", { type: "button", "aria-label": `Remove ${d.date}`, onclick: () => act(() => del(`/holidays/${d.date}`), "Removed") }, icon("x", { size: 16 })),
              ),
            ),
          )
        : h("p.muted", "None coming up."),
      past ? h("p.muted.small", `${past} past day(s) not shown.`) : null,
      h("form.add-row", { onsubmit: (e) => (e.preventDefault(), act(() => post("/holidays", { date: date.value, name: name.value || null }), "Added")) }, date, name, h("button.btn", { type: "submit" }, "Add closed day")),
    );
  }

  // ------------------------------------------------------------ automations
  function automations(s) {
    const stageOpts = s.practiceAreas.flatMap((a) => a.stages.map((st) => ({ value: st.id, label: st.name, group: a.name })));
    const listOpts = lists.map((l) => ({ value: l.id, label: l.name }));
    const stageName = (sid) => {
      for (const a of s.practiceAreas) {
        const st = a.stages.find((x) => x.id === sid);
        if (st) return `${a.name}: ${st.name}`;
      }
      return "?";
    };
    const sentence = (a) =>
      a.trigger === "stage_entered"
        ? ["When a matter enters ", h("b", stageName(a.trigger_ref)), a.action === "apply_list" ? [", add checklist ", h("b", a.action_name)] : [", move it to ", h("b", stageName(a.action_ref))]]
        : ["When checklist ", h("b", a.trigger_name), " is finished, ", a.action === "set_stage" ? ["move the matter to ", h("b", stageName(a.action_ref))] : ["add checklist ", h("b", a.action_name)]];

    const s1 = select(stageOpts, "", { "aria-label": "Stage" });
    const l1 = select(listOpts, "", { "aria-label": "Checklist to add" });
    const l2 = select(listOpts, "", { "aria-label": "Checklist" });
    const s2 = select(stageOpts, "", { "aria-label": "Stage to move to" });
    return h(
      "section.card.settings-section#s-auto",
      sectionHead("zap", "Automatic steps"),
      s.automations.length
        ? h(
            "ul.plain.auto-list",
            s.automations.map((a) =>
              h(
                "li" + (a.enabled ? "" : ".off"),
                h(
                  "label.check-line",
                  h("input", { type: "checkbox", checked: !!a.enabled, "aria-label": "On", onchange: (e) => act(() => patch(`/automations/${a.id}`, { enabled: e.target.checked }), e.target.checked ? "Turned on" : "Turned off") }),
                  h("span", sentence(a)),
                ),
                h("button.icon-btn.danger", { type: "button", "aria-label": "Delete this automatic step", onclick: () => confirm("Delete this automatic step?") && act(() => del(`/automations/${a.id}`), "Deleted") }, icon("x", { size: 16 })),
              ),
            ),
          )
        : h("p.muted", "No automatic steps yet."),
      h(
        "form.auto-form",
        { onsubmit: (e) => (e.preventDefault(), act(() => post("/automations", { trigger: "stage_entered", triggerRef: Number(s1.value), action: "apply_list", actionRef: Number(l1.value) }), "Automatic step added")) },
        h("span", "When a matter enters"),
        s1,
        h("span", "add checklist"),
        l1,
        h("button.btn", { type: "submit", disabled: !stageOpts.length || !listOpts.length }, "Add"),
      ),
      h(
        "form.auto-form",
        { onsubmit: (e) => (e.preventDefault(), act(() => post("/automations", { trigger: "list_completed", triggerRef: Number(l2.value), action: "set_stage", actionRef: Number(s2.value) }), "Automatic step added")) },
        h("span", "When checklist"),
        l2,
        h("span", "is finished, move the matter to"),
        s2,
        h("button.btn", { type: "submit", disabled: !stageOpts.length || !listOpts.length }, "Add"),
      ),
    );
  }

  lists = await get("/checklists");
  draw();
  page.append(
    pageHeader({
      title: "Settings",
      subtitle: "Your firm's people, clients, practice areas and the rules that drive tasks.",
      actions: button("Import from Clio", { href: "#/settings/import-clio", icon: "import", id: "settings-import-clio" }),
    }),
    h("div.settings-layout", nav, body),
  );
  return page;
}
