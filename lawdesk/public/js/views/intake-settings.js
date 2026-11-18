// Settings for intake:
//   #/settings/intake-forms        the firm's intake forms, their public links, and intake settings
//   #/settings/intake-forms/:id    the form builder (or "new")
//   #/settings/booking             who takes consultations, when, and the public booking link

import { h, select, toast } from "../dom.js";
import { get, post, put, patch, del } from "../api.js";
import { state, users } from "../state.js";
import { intakeOptions } from "./leads.js";
import { pageHeader, card, button, iconButton, pill, avatar, emptyState, field, useStyles } from "../ui/components.js";

const fail = (err) => toast(err.message || String(err), { error: true });
const absolute = (path) => location.origin + path;

const TYPE_LABELS = { short: "Short text", long: "Paragraph", email: "Email", phone: "Phone", date: "Date", choice: "Choice (pick one)", yesno: "Yes or no" };
const MAP_LABELS = { none: "Nothing (keep as an answer)", name: "Name", email: "Email", phone: "Phone", source: "How they heard about us", summary: "What they need", opposing_party: "Other parties (conflict check)" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const SETTINGS_CRUMB = { label: "Settings", href: "#/settings" };

function linkBox(label, url, id) {
  return h(
    "div.share-link",
    h("label.field-label", { for: id }, label),
    h(
      "div.share-row",
      h("input.share-input", { id, readonly: true, value: url, onfocus: (e) => e.target.select() }),
      button("Copy", {
        size: "sm",
        icon: "copy",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(url);
            toast("Link copied");
          } catch {
            document.getElementById(id)?.select();
            toast("Select the link and copy it");
          }
        },
      }),
      button("Open", { size: "sm", icon: "external-link", href: url, target: "_blank", rel: "noopener" }),
    ),
  );
}

// ------------------------------------------------------------- form list

export async function intakeFormsView() {
  useStyles("intake");
  const opts = await intakeOptions(true);
  const forms = await get("/intake/forms");
  const s = opts.settings;

  const firm = h("input", { value: s.firmName || "", maxlength: 200, placeholder: s.firmNameShown });
  const owner = select([{ value: "", label: "No one" }, ...users().map((u) => ({ value: u.id, label: u.name }))], s.defaultOwnerId ?? "");
  const firstCall = h("input", { type: "number", min: 0, max: 30, value: s.newLeadTaskDays, class: "num-input" });
  const follow = h("input", { type: "number", min: 1, max: 60, value: s.engagementFollowupDays, class: "num-input" });
  const settingsForm = h(
    "form.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await patch("/intake/settings", {
            firmName: firm.value,
            defaultOwnerId: owner.value ? Number(owner.value) : null,
            newLeadTaskDays: Number(firstCall.value),
            engagementFollowupDays: Number(follow.value),
          });
          await intakeOptions(true);
          toast("Intake settings saved");
        } catch (err) {
          fail(err);
        }
      },
    },
    field("Firm name on public pages", firm, { hint: "Shown at the top of the intake form and the booking page." }),
    h(
      "div.form-row",
      field("New leads go to", owner),
      field("First call reminder", firstCall, { hint: "Business days after a lead arrives" }),
      field("Follow up on engagement letters", follow, { hint: "Business days after the letter is sent" }),
    ),
    h("div.form-actions", button("Save settings", { variant: "primary", type: "submit" })),
  );
  const settingsCard = card({ title: "Intake settings", icon: "settings", className: "intake-settings-card", body: settingsForm });

  const list = forms.length
    ? h(
        "ul.plain.form-list",
        forms.map((f) =>
          card({
            tag: "li",
            headingLevel: 3,
            icon: "clipboard-list",
            title: h("a", { href: `#/settings/intake-forms/${f.id}` }, f.name),
            subtitle: `${f.practiceArea || "Any practice area"} · ${f.submissions} ${f.submissions === 1 ? "lead" : "leads"} so far`,
            actions: [pill(f.active ? "Accepting answers" : "Turned off", f.active ? "success" : "neutral"), button("Edit", { size: "sm", icon: "pencil", href: `#/settings/intake-forms/${f.id}` })],
            body: linkBox("Public link: put it on the firm's website or send it", absolute(f.publicPath), `form-link-${f.id}`),
          }),
        ),
      )
    : card({ body: emptyState({ icon: "clipboard-list", title: "No intake forms yet", body: "Make one per practice area, then put its link on the firm's website.", action: button("New form", { variant: "primary", icon: "plus", href: "#/settings/intake-forms/new" }) }) });

  return h(
    "div.page.intake.settings",
    pageHeader({
      title: "Intake forms",
      breadcrumbs: [SETTINGS_CRUMB, { label: "Intake forms" }],
      subtitle: "Each form has a public link. Every form sent in becomes a lead, with a conflict check.",
      actions: [button("New form", { variant: "primary", icon: "plus", href: "#/settings/intake-forms/new" })],
    }),
    list,
    settingsCard,
  );
}

// ---------------------------------------------------------- form builder

export async function intakeFormEditView([id]) {
  useStyles("intake");
  const opts = await intakeOptions();
  const isNew = id === "new";
  const form = isNew
    ? { name: "", practiceAreaId: null, intro: "", thanks: "", ownerId: null, active: true, fields: opts.defaultFields.map((f) => ({ ...f, options: f.options ?? [] })) }
    : await get(`/intake/forms/${id}`);
  let fields = form.fields.map((f) => ({ ...f }));

  const name = h("input", { value: form.name, maxlength: 200, required: true, placeholder: "e.g. Estate planning inquiry" });
  const area = select([{ value: "", label: "Any" }, ...state.setup.practiceAreas.map((p) => ({ value: p.id, label: p.name }))], form.practiceAreaId ?? "");
  const owner = select([{ value: "", label: "Firm default" }, ...users().map((u) => ({ value: u.id, label: u.name }))], form.ownerId ?? "");
  const intro = h("textarea", { rows: 3, maxlength: 4000, value: form.intro || "", placeholder: "Shown at the top of the form" });
  const thanks = h("textarea", { rows: 2, maxlength: 4000, value: form.thanks || "", placeholder: "Shown after someone sends the form" });
  const active = h("input", { type: "checkbox", checked: form.active });
  const qBox = h("ol.q-list");
  const err = h("p.error-text", { role: "alert" });

  function drawQuestions() {
    qBox.replaceChildren(
      ...fields.map((f, i) => {
        const opt = h("textarea", { rows: 3, value: (f.options || []).join("\n"), "aria-label": "Choices, one per line", oninput: (e) => (f.options = e.target.value.split("\n")) });
        const optWrap = h("label.field.q-options", { hidden: f.type !== "choice" }, h("span.field-label", "Choices, one per line"), opt);
        return h(
          "li.q.card.card-v2",
          h(
            "div.q-head",
            h("span.q-n", String(i + 1)),
            h("input.q-label", { value: f.label, maxlength: 300, "aria-label": `Question ${i + 1}`, placeholder: "The question", oninput: (e) => (f.label = e.target.value) }),
            h(
              "span.q-tools",
              iconButton("arrow-up", "Move up", { size: "sm", disabled: i === 0, onclick: () => (([fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]), drawQuestions()) }),
              iconButton("arrow-down", "Move down", { size: "sm", disabled: i === fields.length - 1, onclick: () => (([fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]), drawQuestions()) }),
              iconButton("trash-2", "Remove question", { size: "sm", variant: "danger", onclick: () => (fields.splice(i, 1), drawQuestions()) }),
            ),
          ),
          h(
            "div.form-row",
            field(
              "Answer type",
              select(
                opts.fieldTypes.map((t) => ({ value: t, label: TYPE_LABELS[t] })),
                f.type,
                { onchange: (e) => ((f.type = e.target.value), (optWrap.hidden = f.type !== "choice")) },
              ),
            ),
            field("Fills in on the lead", select(opts.fieldMaps.map((m) => ({ value: m, label: MAP_LABELS[m] })), f.mapsTo || "none", { onchange: (e) => (f.mapsTo = e.target.value) })),
            h("label.check-line.q-req", h("input", { type: "checkbox", checked: !!f.required, onchange: (e) => (f.required = e.target.checked) }), "Required"),
          ),
          field("Help text", h("input", { value: f.help || "", maxlength: 1000, oninput: (e) => (f.help = e.target.value) }), { optional: true, className: "q-help" }),
          optWrap,
        );
      }),
    );
  }

  async function save(e) {
    e.preventDefault();
    err.textContent = "";
    const body = {
      name: name.value,
      practiceAreaId: area.value ? Number(area.value) : null,
      ownerId: owner.value ? Number(owner.value) : null,
      intro: intro.value,
      thanks: thanks.value,
      active: active.checked,
      fields: fields.map((f) => ({ ...f, options: (f.options || []).map((o) => o.trim()).filter(Boolean) })),
    };
    try {
      const saved = isNew ? await post("/intake/forms", body) : await put(`/intake/forms/${id}`, body);
      toast("Form saved");
      if (isNew) location.hash = `#/settings/intake-forms/${saved.id}`;
      else {
        fields = saved.fields.map((f) => ({ ...f }));
        drawQuestions();
      }
    } catch (ex) {
      err.textContent = ex.message;
      fail(ex);
    }
  }

  drawQuestions();
  const page = h(
    "form.page.intake.settings.form-builder",
    { onsubmit: save },
    pageHeader({
      title: isNew ? "New intake form" : form.name,
      breadcrumbs: [SETTINGS_CRUMB, { label: "Intake forms", href: "#/settings/intake-forms" }, { label: isNew ? "New form" : form.name }],
      subtitle: "Questions people answer before the firm calls them.",
      actions: isNew
        ? null
        : [
            button("New link", {
                icon: "rotate-ccw",
                onclick: async () => {
                  if (!confirm("Make a new public link? The current link will stop working.")) return;
                  try {
                    await post(`/intake/forms/${id}/new-link`);
                    location.reload();
                  } catch (ex) {
                    fail(ex);
                  }
                },
            }),
            button("Delete form", {
                variant: "danger",
                icon: "trash-2",
                onclick: async () => {
                  if (!confirm(`Delete “${form.name}”? Its link stops working. Leads it brought in are kept.`)) return;
                  try {
                    await del(`/intake/forms/${id}`);
                    location.hash = "#/settings/intake-forms";
                  } catch (ex) {
                    fail(ex);
                  }
                },
            }),
          ],
    }),
    card({
      title: "About this form",
      icon: "clipboard-list",
      body: h(
        "div.form-grid",
        isNew ? null : linkBox("Public link", absolute(form.publicPath), "form-link"),
        field("Form name", name, { hint: "Shown as the page title" }),
        h("div.form-row", field("Practice area for new leads", area), field("New leads go to", owner), h("label.check-line.q-req", active, "Accepting answers")),
        field("Introduction", intro),
        field("Thank-you message", thanks),
      ),
    }),
    h("div.section-title.intake-q-title", h("h2", "Questions"), h("p.intake-hint", "One question must fill in the Name, and one the Email or Phone. Answers that fill in “Other parties” are checked for conflicts automatically.")),
    qBox,
    h(
      "div.q-add",
      button("Add a question", { icon: "plus", onclick: () => (fields.push({ label: "", type: "short", required: false, help: "", options: [], mapsTo: "none" }), drawQuestions(), qBox.lastElementChild?.querySelector(".q-label")?.focus()) }),
    ),
    h("div.save-bar", err, h("div.save-actions", button("Back", { href: "#/settings/intake-forms" }), button("Save form", { variant: "primary", type: "submit" }))),
  );
  return page;
}

// ----------------------------------------------------------- availability

export async function bookingSettingsView() {
  useStyles("intake");
  const [opts, people] = await Promise.all([intakeOptions(true), get("/intake/availability")]);
  const s = opts.settings;
  const notice = h("input", { type: "number", min: 0, max: 336, value: s.minNoticeHours, class: "num-input" });
  const ahead = h("input", { type: "number", min: 1, max: 90, value: s.daysAhead, class: "num-input" });
  const intro = h("textarea", { rows: 2, maxlength: 2000, value: s.bookingIntro || "", placeholder: "Shown on the booking page, e.g. what to bring" });
  const bookingUrl = absolute(`/intake/book.html?b=${encodeURIComponent(s.bookingToken)}`);

  const general = h(
    "form.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await patch("/intake/settings", { minNoticeHours: Number(notice.value), daysAhead: Number(ahead.value), bookingIntro: intro.value });
          await intakeOptions(true);
          toast("Booking settings saved");
        } catch (err) {
          fail(err);
        }
      },
    },
    linkBox("Public booking link", bookingUrl, "booking-link"),
    h("div.form-row.two", field("Least notice, in hours", notice), field("Show this many days ahead", ahead)),
    field("Note on the booking page", intro),
    h(
      "div.form-actions",
      button("New link", {
          variant: "ghost",
          icon: "rotate-ccw",
          onclick: async () => {
            if (!confirm("Make a new booking link? The current link, and links already sent to leads, will stop working.")) return;
            try {
              await patch("/intake/settings", { newBookingLink: true });
              location.reload();
            } catch (err) {
              fail(err);
            }
          },
      }),
      button("Save", { variant: "primary", type: "submit" }),
    ),
  );

  function personCard(p) {
    let windows = p.windows.map((w) => ({ ...w }));
    const takes = h("input", { type: "checkbox", checked: p.takesConsultations });
    const len = h("input", { type: "number", min: 10, max: 240, step: 5, value: p.consultMinutes, class: "num-input" });
    const loc = h("input", { value: p.location || "", maxlength: 300, placeholder: "e.g. Main office, or by phone" });
    const rows = h("ul.plain.window-list");
    function drawRows() {
      rows.replaceChildren(
        ...windows.map((w, i) =>
          h(
            "li.window-row",
            select(WEEKDAYS.map((d, n) => ({ value: n, label: d })), w.weekday, { "aria-label": "Day", onchange: (e) => (w.weekday = Number(e.target.value)) }),
            h("input", { type: "time", value: w.start, "aria-label": "From", step: 300, onchange: (e) => (w.start = e.target.value) }),
            h("span.window-to", "to"),
            h("input", { type: "time", value: w.end, "aria-label": "Until", step: 300, onchange: (e) => (w.end = e.target.value) }),
            iconButton("x", "Remove these hours", { size: "sm", variant: "danger", onclick: () => (windows.splice(i, 1), drawRows()) }),
          ),
        ),
      );
      if (!windows.length) rows.append(h("li.window-empty", "No hours set. Add the times this person can meet new clients."));
    }
    drawRows();
    return h(
      "form.card.card-v2.form-grid.person-hours" + (p.takesConsultations ? ".is-on" : ""),
      {
        dataset: { user: String(p.userId) },
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const saved = await put(`/intake/availability/${p.userId}`, { takesConsultations: takes.checked, consultMinutes: Number(len.value), location: loc.value, windows });
            windows = saved.windows.map((w) => ({ ...w }));
            drawRows();
            toast(`Saved ${p.name}'s consultation hours`);
          } catch (err) {
            fail(err);
          }
        },
      },
      h("div.form-list-head", h("div.person-hours-who", avatar(p.name, { size: "sm" }), h("h2", p.name)), h("label.check-line", takes, "Takes consultations")),
      h("div.form-row.two", field("Length (minutes)", len), field("Where", loc)),
      h("div.field-label", "Weekly hours, Central time"),
      rows,
      h(
        "div.form-actions",
        button("Add hours", { size: "sm", variant: "ghost", icon: "plus", onclick: () => (windows.push({ weekday: 1, start: "09:00", end: "12:00" }), drawRows()) }),
        button("Same hours Mon–Fri", {
          size: "sm",
          variant: "ghost",
          title: "Copy the first window to Monday through Friday",
          onclick: () => {
            const w = windows[0] ?? { start: "09:00", end: "12:00" };
            windows = [1, 2, 3, 4, 5].map((d) => ({ weekday: d, start: w.start, end: w.end }));
            drawRows();
          },
        }),
        button("Save", { size: "sm", variant: "primary", type: "submit" }),
      ),
    );
  }

  return h(
    "div.page.intake.settings",
    pageHeader({
      title: "Booking availability",
      breadcrumbs: [SETTINGS_CRUMB, { label: "Booking availability" }],
      subtitle: "When people can book a consultation online. Times already on someone's calendar are never offered.",
      actions: [button("Open booking page", { icon: "external-link", href: bookingUrl, target: "_blank", rel: "noopener" })],
    }),
    card({ title: "Booking page", icon: "calendar", body: general }),
    h("div.section-title.intake-q-title", h("h2", "Who takes consultations"), h("p.intake-hint", "Only people who take consultations, with hours set, are offered on the booking page.")),
    h("div.hours-grid", people.map(personCard)),
  );
}

