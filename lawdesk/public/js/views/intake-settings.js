// Settings for intake:
//   #/settings/intake-forms        the firm's intake forms, their public links, and intake settings
//   #/settings/intake-forms/:id    the form builder (or "new")
//   #/settings/booking             who takes consultations, when, and the public booking link

import { h, select, toast } from "../dom.js";
import { get, post, put, patch, del } from "../api.js";
import { state, users } from "../state.js";
import { intakeOptions } from "./intake.js";

const fail = (err) => toast(err.message || String(err), { error: true });
const absolute = (path) => location.origin + path;

const TYPE_LABELS = { short: "Short text", long: "Paragraph", email: "Email", phone: "Phone", date: "Date", choice: "Choice (pick one)", yesno: "Yes or no" };
const MAP_LABELS = { none: "Nothing (keep as an answer)", name: "Name", email: "Email", phone: "Phone", source: "How they heard about us", summary: "What they need", opposing_party: "Other parties (conflict check)" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function backToSettings() {
  return h("a.back", { href: "#/settings" }, "← Settings");
}

function linkBox(label, url, id) {
  return h(
    "div.share-link",
    h("label.small.muted", { for: id }, label),
    h(
      "div.share-row",
      h("input", { id, readonly: true, value: url, onfocus: (e) => e.target.select() }),
      h(
        "button.btn.small",
        {
          type: "button",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(url);
              toast("Link copied");
            } catch {
              document.getElementById(id)?.select();
              toast("Select the link and copy it");
            }
          },
        },
        "Copy",
      ),
      h("a.btn.small", { href: url, target: "_blank", rel: "noopener" }, "Open"),
    ),
  );
}

// ------------------------------------------------------------- form list

export async function intakeFormsView() {
  const opts = await intakeOptions(true);
  const forms = await get("/intake/forms");
  const s = opts.settings;

  const firm = h("input", { value: s.firmName || "", maxlength: 200, placeholder: s.firmNameShown });
  const owner = select([{ value: "", label: "No one" }, ...users().map((u) => ({ value: u.id, label: u.name }))], s.defaultOwnerId ?? "");
  const firstCall = h("input", { type: "number", min: 0, max: 30, value: s.newLeadTaskDays, class: "num-input" });
  const follow = h("input", { type: "number", min: 1, max: 60, value: s.engagementFollowupDays, class: "num-input" });
  const settingsCard = h(
    "form.card.form-grid",
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
    h("h2", "Intake settings"),
    h("label", "Firm name on public pages", firm),
    h("div.form-row", h("label", "New leads go to", owner), h("label", "First call reminder, business days after a lead arrives", firstCall), h("label", "Follow up on engagement letters after (business days)", follow)),
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Save settings")),
  );

  const list = forms.length
    ? h(
        "ul.plain.form-list",
        forms.map((f) =>
          h(
            "li.card",
            h(
              "div.form-list-head",
              h("h3", h("a", { href: `#/settings/intake-forms/${f.id}` }, f.name)),
              h("span.tag" + (f.active ? ".good" : ""), f.active ? "Accepting answers" : "Turned off"),
            ),
            h("p.small.muted", `${f.practiceArea || "Any practice area"} · ${f.submissions} ${f.submissions === 1 ? "lead" : "leads"} so far`),
            linkBox("Public link (put it on the firm's website or send it):", absolute(f.publicPath), `form-link-${f.id}`),
          ),
        ),
      )
    : h("div.empty-big.card", h("p", "No intake forms yet."), h("p", "Make one per practice area, then put its link on the firm's website."));

  return h(
    "div.page.intake.settings",
    backToSettings(),
    h("div.page-head", h("div", h("h1", "Intake forms"), h("p.sub", "Each form has a public link. Every form sent in becomes a lead, with a conflict check.")), h("a.btn.primary", { href: "#/settings/intake-forms/new" }, "New form")),
    list,
    settingsCard,
  );
}

// ---------------------------------------------------------- form builder

export async function intakeFormEditView([id]) {
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
        const optWrap = h("label.q-options", { hidden: f.type !== "choice" }, "Choices, one per line", opt);
        return h(
          "li.q.card",
          h(
            "div.q-head",
            h("span.q-n", String(i + 1)),
            h("input.q-label", { value: f.label, maxlength: 300, "aria-label": `Question ${i + 1}`, placeholder: "The question", oninput: (e) => (f.label = e.target.value) }),
            h(
              "span.q-tools",
              h("button.icon-btn", { type: "button", "aria-label": "Move up", title: "Move up", disabled: i === 0, onclick: () => (([fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]), drawQuestions()) }, "↑"),
              h("button.icon-btn", { type: "button", "aria-label": "Move down", title: "Move down", disabled: i === fields.length - 1, onclick: () => (([fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]), drawQuestions()) }, "↓"),
              h("button.icon-btn.danger", { type: "button", "aria-label": "Remove question", title: "Remove", onclick: () => (fields.splice(i, 1), drawQuestions()) }, "×"),
            ),
          ),
          h(
            "div.form-row",
            h(
              "label",
              "Answer type",
              select(
                opts.fieldTypes.map((t) => ({ value: t, label: TYPE_LABELS[t] })),
                f.type,
                { onchange: (e) => ((f.type = e.target.value), (optWrap.hidden = f.type !== "choice")) },
              ),
            ),
            h("label", "Fills in on the lead", select(opts.fieldMaps.map((m) => ({ value: m, label: MAP_LABELS[m] })), f.mapsTo || "none", { onchange: (e) => (f.mapsTo = e.target.value) })),
            h("label.check-line.q-req", h("input", { type: "checkbox", checked: !!f.required, onchange: (e) => (f.required = e.target.checked) }), "Required"),
          ),
          h("label.q-help", "Help text (optional)", h("input", { value: f.help || "", maxlength: 1000, oninput: (e) => (f.help = e.target.value) })),
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
    h("a.back", { href: "#/settings/intake-forms" }, "← Intake forms"),
    h(
      "div.page-head",
      h("div", h("h1", isNew ? "New intake form" : form.name), h("p.sub", "Questions people answer before the firm calls them.")),
      isNew
        ? null
        : h(
            "div.head-actions",
            h(
              "button.btn",
              {
                type: "button",
                onclick: async () => {
                  if (!confirm("Make a new public link? The current link will stop working.")) return;
                  try {
                    await post(`/intake/forms/${id}/new-link`);
                    location.reload();
                  } catch (ex) {
                    fail(ex);
                  }
                },
              },
              "New link",
            ),
            h(
              "button.btn.danger-text",
              {
                type: "button",
                onclick: async () => {
                  if (!confirm(`Delete “${form.name}”? Its link stops working. Leads it brought in are kept.`)) return;
                  try {
                    await del(`/intake/forms/${id}`);
                    location.hash = "#/settings/intake-forms";
                  } catch (ex) {
                    fail(ex);
                  }
                },
              },
              "Delete form",
            ),
          ),
    ),
    isNew ? null : linkBox("Public link:", absolute(form.publicPath), "form-link"),
    h(
      "section.card.form-grid",
      h("h2", "About this form"),
      h("label", "Form name (shown as the page title)", name),
      h("div.form-row", h("label", "Practice area for new leads", area), h("label", "New leads go to", owner), h("label.check-line.q-req", active, "Accepting answers")),
      h("label", "Introduction", intro),
      h("label", "Thank-you message", thanks),
    ),
    h("h2.report-h", "Questions"),
    h("p.small.muted", "One question must fill in the Name, and one the Email or Phone. Answers that fill in “Other parties” are checked for conflicts automatically."),
    qBox,
    h(
      "div.q-add",
      h("button.btn", { type: "button", onclick: () => (fields.push({ label: "", type: "short", required: false, help: "", options: [], mapsTo: "none" }), drawQuestions(), qBox.lastElementChild?.querySelector(".q-label")?.focus()) }, "Add a question"),
    ),
    h("div.save-bar", err, h("div.save-actions", h("a.btn", { href: "#/settings/intake-forms" }, "Back"), h("button.btn.primary", { type: "submit" }, "Save form"))),
  );
  return page;
}

// ----------------------------------------------------------- availability

export async function bookingSettingsView() {
  const [opts, people] = await Promise.all([intakeOptions(true), get("/intake/availability")]);
  const s = opts.settings;
  const notice = h("input", { type: "number", min: 0, max: 336, value: s.minNoticeHours, class: "num-input" });
  const ahead = h("input", { type: "number", min: 1, max: 90, value: s.daysAhead, class: "num-input" });
  const intro = h("textarea", { rows: 2, maxlength: 2000, value: s.bookingIntro || "", placeholder: "Shown on the booking page, e.g. what to bring" });
  const bookingUrl = absolute(`/intake/book.html?b=${encodeURIComponent(s.bookingToken)}`);

  const general = h(
    "form.card.form-grid",
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
    h("h2", "Booking page"),
    linkBox("Public booking link:", bookingUrl, "booking-link"),
    h("div.form-row.two", h("label", "Least notice, in hours", notice), h("label", "Show this many days ahead", ahead)),
    h("label", "Note on the booking page", intro),
    h(
      "div.form-actions",
      h(
        "button.btn",
        {
          type: "button",
          onclick: async () => {
            if (!confirm("Make a new booking link? The current link, and links already sent to leads, will stop working.")) return;
            try {
              await patch("/intake/settings", { newBookingLink: true });
              location.reload();
            } catch (err) {
              fail(err);
            }
          },
        },
        "New link",
      ),
      h("button.btn.primary", { type: "submit" }, "Save"),
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
            h("span.muted", "to"),
            h("input", { type: "time", value: w.end, "aria-label": "Until", step: 300, onchange: (e) => (w.end = e.target.value) }),
            h("button.icon-btn.danger", { type: "button", "aria-label": "Remove", title: "Remove", onclick: () => (windows.splice(i, 1), drawRows()) }, "×"),
          ),
        ),
      );
      if (!windows.length) rows.append(h("li.empty.small", "No hours set."));
    }
    drawRows();
    return h(
      "form.card.form-grid.person-hours",
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
      h("div.form-list-head", h("h2", p.name), h("label.check-line", takes, "Takes consultations")),
      h("div.form-row.two", h("label", "Consultation length (minutes)", len), h("label", "Where", loc)),
      h("div.small.muted", "Weekly hours, Central time:"),
      rows,
      h(
        "div.form-actions",
        h("button.btn.small", { type: "button", onclick: () => (windows.push({ weekday: 1, start: "09:00", end: "12:00" }), drawRows()) }, "Add hours"),
        h(
          "button.btn.small",
          { type: "button", title: "Copy the first window to Monday through Friday", onclick: () => {
            const w = windows[0] ?? { start: "09:00", end: "12:00" };
            windows = [1, 2, 3, 4, 5].map((d) => ({ weekday: d, start: w.start, end: w.end }));
            drawRows();
          } },
          "Same hours Mon–Fri",
        ),
        h("button.btn.primary.small", { type: "submit" }, "Save"),
      ),
    );
  }

  return h(
    "div.page.intake.settings",
    backToSettings(),
    h("div.page-head", h("div", h("h1", "Booking availability"), h("p.sub", "When people can book a consultation online. Times already on someone's calendar are never offered."))),
    general,
    h("h2.report-h", "Who takes consultations"),
    h("div.hours-grid", people.map(personCard)),
  );
}

