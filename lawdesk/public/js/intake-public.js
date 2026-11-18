// The two pages people outside the firm see: an intake form (/intake/form.html?f=…) and the
// consultation booking page (/intake/book.html?b=…[&lead=…]). No sign-in, no cookies, no
// third-party scripts. All text from the firm or the visitor goes in as text, never as HTML.

import { h } from "./dom.js";
import { icon } from "./ui/icons.js";

const main = document.getElementById("main");
const params = new URLSearchParams(location.search);

async function call(method, path, body) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      headers: body ? { "Content-Type": "application/json", Accept: "application/json", "X-Requested-With": "lawdesk" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("We couldn't reach the firm's server. Please check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error((data && data.error) || "Something went wrong. Please try again."), { status: res.status });
  return data;
}

/** The firm's initials for the header seal: "Reyes & Chen, Attorneys at Law" -> "RC". */
export function monogram(name) {
  const words = String(name || "")
    .split(",")[0]
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !/^(and|of|the|llc|llp|pa|pc|law|firm|office|offices)$/i.test(w));
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function setFirm(name) {
  document.getElementById("firm").textContent = name;
  const m = document.getElementById("monogram");
  if (m) {
    m.textContent = monogram(name);
    m.hidden = !m.textContent;
  }
}

function problem(message) {
  main.replaceChildren(
    h("section.public-card.public-problem", h("span.public-icon.warn", icon("circle-alert", { size: 22 })), h("h1", "This page isn't available"), h("p.lead-in", message), h("p.public-note", "If you were trying to reach the firm, please call or email the office directly.")),
  );
}

/** A short line on what happens to the answers. */
function reassurance(text) {
  return h("div.public-assure", icon("lock", { size: 15 }), h("span", text));
}

/** Hidden from people (and screen readers); bots that fill every field give themselves away. */
function honeypot() {
  return h(
    "div.hp-field",
    { "aria-hidden": "true" },
    h("label", { for: "hp-website" }, "Leave this empty"),
    h("input#hp-website", { name: "website", type: "text", tabindex: "-1", autocomplete: "off" }),
  );
}

function para(text, cls = "p") {
  return text ? String(text).split(/\n{2,}/).map((t) => h(cls, t)) : null;
}

// ------------------------------------------------------------------ form

function inputFor(f) {
  const id = `q-${f.id}`;
  const common = { id, name: id, required: f.required || null, "aria-describedby": f.help ? `${id}-help` : null };
  switch (f.type) {
    case "long":
      return h("textarea", { ...common, rows: 5, maxlength: 8000 });
    case "email":
      return h("input", { ...common, type: "email", autocomplete: "email", maxlength: 200 });
    case "phone":
      return h("input", { ...common, type: "tel", autocomplete: "tel", maxlength: 40 });
    case "date":
      return h("input", { ...common, type: "date" });
    case "choice":
      return h("select", common, h("option", { value: "" }, "Choose one"), f.options.map((o) => h("option", { value: o }, o)));
    case "yesno":
      return h(
        "div.yesno",
        { role: "radiogroup", "aria-labelledby": `${id}-label` },
        ["yes", "no"].map((v) => h("label.check-line", h("input", { type: "radio", name: id, value: v, required: f.required || null }), v === "yes" ? "Yes" : "No")),
      );
    default:
      return h("input", { ...common, type: "text", maxlength: 300, autocomplete: /name/i.test(f.label) ? "name" : null });
  }
}

async function formPage() {
  const token = params.get("f") || "";
  let def;
  try {
    def = await call("GET", `/intake/public/forms/${encodeURIComponent(token)}`);
  } catch (err) {
    setFirm("");
    return problem(err.message);
  }
  setFirm(def.firmName);
  document.title = `${def.title} · ${def.firmName}`;
  const err = h("p.error-box", { role: "alert", hidden: true });
  const send = h("button.btn.primary.public-send", { type: "submit" }, "Send");
  const form = h(
    "form.public-form",
    { novalidate: false },
    def.fields.map((f) =>
      h(
        "div.public-field",
        h("label.public-label", { for: f.type === "yesno" ? null : `q-${f.id}`, id: `q-${f.id}-label` }, f.label, f.required ? h("span.req", { "aria-hidden": "true" }, " *") : null, f.required ? null : h("span.opt", " (optional)")),
        f.help ? h("p.help", { id: `q-${f.id}-help` }, f.help) : null,
        inputFor(f),
      ),
    ),
    honeypot(),
    err,
    h("div.public-actions", reassurance("Your answers go only to the firm, and are checked for conflicts of interest before anyone discusses your matter."), send),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const answers = {};
    for (const f of def.fields) {
      const id = `q-${f.id}`;
      if (f.type === "yesno") answers[f.id] = form.querySelector(`input[name="${id}"]:checked`)?.value ?? "";
      else answers[f.id] = form.elements[id].value;
    }
    send.disabled = true;
    send.textContent = "Sending…";
    try {
      const r = await call("POST", `/intake/public/forms/${encodeURIComponent(token)}`, { stamp: def.stamp, website: form.elements.website.value, answers });
      main.replaceChildren(h("section.public-card.public-done", { tabindex: "-1" }, h("span.public-icon.ok", icon("circle-check", { size: 24 })), h("h1", "Thank you"), para(r.thanks, "p.lead-in"), h("p.public-note", "You can close this page.")));
      main.firstChild.focus();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      send.disabled = false;
      send.textContent = "Send";
      if (ex.status === 400 && /expired/.test(ex.message)) def = await call("GET", `/intake/public/forms/${encodeURIComponent(token)}`).catch(() => def);
    }
  });
  main.replaceChildren(
    h(
      "section.public-card",
      h("div.public-card-head", h("h1", def.title), para(def.intro, "p.lead-in"), h("p.public-note", "Fields marked ", h("span.req", "*"), " are required.")),
      form,
    ),
  );
}

// --------------------------------------------------------------- booking

async function bookPage() {
  const token = params.get("b") || "";
  const lead = params.get("lead") || "";
  let person = "";
  let data;
  let chosen = null;

  async function load() {
    const q = new URLSearchParams();
    if (lead) q.set("lead", lead);
    if (person) q.set("person", person);
    data = await call("GET", `/intake/public/booking/${encodeURIComponent(token)}?${q}`);
  }
  try {
    await load();
  } catch (err) {
    setFirm("");
    return problem(err.message);
  }
  setFirm(data.firmName);
  document.title = `Book a consultation · ${data.firmName}`;

  const slotsBox = h("div.slot-days");
  const detailsBox = h("div");
  const err = h("p.error-box", { role: "alert", hidden: true });

  function drawSlots() {
    chosen = null;
    detailsBox.replaceChildren();
    if (!data.days.length) {
      slotsBox.replaceChildren(h("p.public-note", "There are no open times in the next few weeks. Please call the firm to arrange a time."));
      return;
    }
    const many = !person && data.people.length > 1;
    slotsBox.replaceChildren(
      ...data.days.map((d) =>
        h(
          "div.slot-day",
          h("h2", icon("calendar", { size: 15 }), d.label),
          h(
            "div.slot-grid",
            d.slots.map((s) =>
              h(
                "button.slot",
                {
                  type: "button",
                  "aria-pressed": "false",
                  "aria-label": `${d.label}, ${s.time}${many ? ", with " + s.userName : ""}`,
                  onclick: (e) => {
                    slotsBox.querySelectorAll(".slot").forEach((b) => b.setAttribute("aria-pressed", "false"));
                    e.currentTarget.setAttribute("aria-pressed", "true");
                    chosen = { ...s, dayLabel: d.label };
                    drawDetails();
                  },
                },
                s.time,
                many ? h("span.slot-who", s.userName) : null,
              ),
            ),
          ),
        ),
      ),
    );
  }

  function drawDetails() {
    const fields = data.personal
      ? [h("div.public-field", h("label.public-label", { for: "b-notes" }, "Anything we should know before we talk?", h("span.opt", " (optional)")), h("textarea#b-notes", { name: "summary", rows: 3, maxlength: 4000 }))]
      : [
          h("div.public-field", h("label.public-label", { for: "b-name" }, "Your name", h("span.req", " *")), h("input#b-name", { name: "name", required: true, autocomplete: "name", maxlength: 200 })),
          h("div.public-field", h("label.public-label", { for: "b-email" }, "Email"), h("input#b-email", { name: "email", type: "email", autocomplete: "email", maxlength: 200 })),
          h("div.public-field", h("label.public-label", { for: "b-phone" }, "Phone"), h("p.help", "Give an email address or a phone number, or both."), h("input#b-phone", { name: "phone", type: "tel", autocomplete: "tel", maxlength: 40 })),
          h("div.public-field", h("label.public-label", { for: "b-summary" }, "Briefly, what is it about?", h("span.opt", " (optional)")), h("textarea#b-summary", { name: "summary", rows: 3, maxlength: 4000 })),
          h(
            "div.public-field",
            h("label.public-label", { for: "b-opposing" }, "Other people or businesses involved", h("span.opt", " (optional)")),
            h("p.help", "We check these names for conflicts of interest before we meet."),
            h("textarea#b-opposing", { name: "opposing", rows: 2, maxlength: 4000 }),
          ),
        ];
    const send = h("button.btn.primary.public-send", { type: "submit" }, "Book this time");
    const form = h(
      "form.public-form.public-confirm",
      h("h2", "Your consultation"),
      h("div.chosen", icon("calendar-clock", { size: 18 }), h("span", `${chosen.dayLabel} at ${chosen.time}, with ${chosen.userName}`)),
      fields,
      honeypot(),
      err,
      h("div.public-actions", reassurance("The firm checks for conflicts of interest before the meeting."), send),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const v = (n) => form.elements[n]?.value ?? "";
      send.disabled = true;
      send.textContent = "Booking…";
      try {
        const r = await call("POST", `/intake/public/booking/${encodeURIComponent(token)}`, {
          stamp: data.stamp,
          website: v("website"),
          lead: lead || null,
          userId: chosen.userId,
          start: chosen.start,
          name: v("name"),
          email: v("email"),
          phone: v("phone"),
          summary: v("summary"),
          opposing: v("opposing"),
        });
        main.replaceChildren(
          h(
            "section.public-card.public-done",
            { tabindex: "-1" },
            h("span.public-icon.ok", icon("circle-check", { size: 24 })),
            h("h1", "You're booked"),
            r.when
              ? h(
                  "dl.booked",
                  h("dt", "When"),
                  h("dd", `${r.when} (Central time)`),
                  h("dt", "With"),
                  h("dd", r.userName),
                  h("dt", "Length"),
                  h("dd", `About ${r.minutes} minutes`),
                  r.location ? [h("dt", "Where"), h("dd", r.location)] : null,
                )
              : null,
            h("p.lead-in", `Thank you. ${r.firmName} will confirm by email or phone. If you need to change the time, please call the firm.`),
          ),
        );
        main.firstChild.focus();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        send.disabled = false;
        send.textContent = "Book this time";
        if (ex.status === 409) {
          await load().catch(() => {});
          drawSlots();
          detailsBox.prepend(err);
        }
      }
    });
    detailsBox.replaceChildren(form);
    form.scrollIntoView({ block: "start" });
    form.querySelector("input, textarea")?.focus({ preventScroll: true });
  }

  const who =
    data.people.length > 1
      ? h(
          "div.public-field.who-pick",
          h("label.public-label", { for: "b-person" }, "Meet with"),
          h(
            "select#b-person",
            {
              onchange: async (e) => {
                person = e.target.value;
                try {
                  await load();
                } catch (ex) {
                  return problem(ex.message);
                }
                drawSlots();
              },
            },
            h("option", { value: "" }, "Anyone available"),
            data.people.map((p) => h("option", { value: String(p.id) }, `${p.name} (${p.minutes} minutes)`)),
          ),
        )
      : null;

  drawSlots();
  main.replaceChildren(
    h(
      "section.public-card",
      h("div.public-card-head", h("h1", "Book a consultation"), para(data.intro, "p.lead-in"), h("p.public-note", `Choose a time below. ${data.timeZoneNote}`)),
      who,
      slotsBox,
      detailsBox,
    ),
  );
}

(document.body.dataset.page === "book" ? bookPage : formPage)().catch((e) => problem(e.message || String(e)));
