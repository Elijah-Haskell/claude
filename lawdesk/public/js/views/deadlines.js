// Court deadline calculator (Kansas state courts, K.S.A. 60-206). Pick a rule from the
// library or enter a period, see the date with every step of the working, its sources and
// the disclaimer, then put it on a matter as a calendar event and a high-priority task.
// The disclaimer and the steps are always shown in full; nothing here folds them away.

import { h, replace, select, toast, fmtDate, daysBetween } from "../dom.js";
import { get, post } from "../api.js";
import { state, today, users, loadMatters } from "../state.js";
import { longDate, matterLabel } from "../cal.js";

const SERVICE = [
  { value: "", label: "Not served, or it doesn't matter for this period" },
  { value: "hand", label: "Handed to the person" },
  { value: "leaving", label: "Left at their office or home" },
  { value: "mail", label: "Mailed" },
  { value: "clerk", label: "Left with the court clerk (no known address)" },
  { value: "fax", label: "Faxed" },
  { value: "electronic", label: "Served electronically" },
];

export async function deadlinesView([matterIdStr]) {
  const page = h("div.page.dl-page");
  const [lib] = await Promise.all([get("/deadlines/rules"), state.matters.length ? null : loadMatters().catch(() => {})]);
  const presetMatter = matterIdStr ? Number(matterIdStr) : null;

  // --------------------------------------------------------------- inputs
  const groups = new Map();
  for (const r of lib.rules) {
    if (!groups.has(r.triggerLabel)) groups.set(r.triggerLabel, []);
    groups.get(r.triggerLabel).push(r);
  }
  const ruleSel = h(
    "select#dl-rule",
    { name: "rule" },
    h("option", { value: "" }, "Choose a deadline…"),
    [...groups].map(([label, rules]) => h("optgroup", { label }, rules.map((r) => h("option", { value: r.id }, `${r.name} (${r.days} days ${r.direction})`)))),
    h("optgroup", { label: "Something else" }, h("option", { value: "custom" }, "Custom period: enter the number of days")),
  );
  const trigger = h("input#dl-trigger", { type: "date", required: true, value: today(), name: "trigger" });
  const triggerTime = h("input", { type: "time", value: "09:00", "aria-label": "Time of the event", name: "triggerTime" });
  const triggerLabel = h("span", "Date of the event");
  const service = select(SERVICE, "", { id: "dl-service", name: "service" });
  const serviceHint = h("p.muted.small.dl-hint");
  const amount = h("input#dl-amount", { type: "number", min: 1, max: 3650, value: 30, name: "amount" });
  const unit = select(
    [
      { value: "days", label: "days" },
      { value: "hours", label: "hours" },
    ],
    "days",
    { "aria-label": "Days or hours", name: "unit" },
  );
  const direction = select(
    [
      { value: "after", label: "after the event" },
      { value: "before", label: "before the event (counted back, e.g. from a hearing)" },
    ],
    "after",
    { "aria-label": "Direction", name: "direction" },
  );
  const customBox = h("fieldset.dl-custom", h("legend", "The period"), h("div.dl-inline", amount, unit, direction));
  const closedDays = [];
  const closedInput = h("input", { type: "date", "aria-label": "Day the clerk's office was closed" });
  const closedChips = h("div.dl-closed-list");
  const ruleInfo = h("div.dl-rule-info");

  const result = h("div.dl-result", { "aria-live": "polite" });
  let lastInput = null;
  let lastRule = null;
  let lastResult = null;

  function drawClosed() {
    replace(closedChips,
      ...closedDays.map((d) =>
        h(
          "span.tag.dl-closed",
          fmtDate(d, today()),
          h("button.icon-btn", { type: "button", "aria-label": `Remove ${d}`, onclick: () => (closedDays.splice(closedDays.indexOf(d), 1), drawClosed(), compute()) }, "×"),
        ),
      ),
    );
  }

  function currentRule() {
    return lib.rules.find((r) => r.id === ruleSel.value) ?? null;
  }

  function syncForm() {
    const r = currentRule();
    const custom = ruleSel.value === "custom";
    customBox.hidden = !custom;
    triggerTime.hidden = !(custom && unit.value === "hours");
    triggerLabel.textContent = r ? `Date: ${r.triggerLabel.toLowerCase()}` : "Date of the event that starts the clock";
    if (r) {
      replace(ruleInfo,
        h("p.dl-cite", h("a", { href: r.url, target: "_blank", rel: "noopener noreferrer" }, r.citation)),
        h("blockquote.dl-quote", `“${r.quote}”`),
        r.notes ? h("p.muted.small", r.notes) : null,
      );
      serviceHint.textContent =
        r.serviceAdjustment === "yes"
          ? "If it was mailed or left with the clerk, 3 days are added (K.S.A. 60-206(d))."
          : r.serviceAdjustment === "uncertain"
            ? "Whether 3 days are added for mail has not been checked for this rule, so none are added (the earlier date is shown)."
            : "How it was served does not change this period.";
    } else {
      replace(ruleInfo);
      serviceHint.textContent = custom ? "Mail or leaving with the clerk adds 3 days to a period that runs from service (K.S.A. 60-206(d))." : "";
    }
  }

  function inputBody() {
    const b = { trigger: trigger.value, serviceMethod: service.value || null, courtClosedDays: closedDays.slice() };
    if (ruleSel.value === "custom") {
      const n = Number(amount.value);
      if (unit.value === "hours") {
        b.hours = n;
        b.trigger = `${trigger.value}T${triggerTime.value || "09:00"}`;
      } else b.days = n;
      b.direction = direction.value;
    } else b.ruleId = ruleSel.value;
    return b;
  }

  let seq = 0;
  async function compute() {
    syncForm();
    if (!ruleSel.value) {
      lastInput = null;
      replace(result, h("div.card.dl-empty", h("p", "Choose a deadline and the date of the event to see the result."), disclaimer(lib.disclaimer)));
      return;
    }
    if (!trigger.value) return;
    const b = inputBody();
    const my = ++seq;
    try {
      const r = await post("/deadlines/compute", b);
      if (my !== seq) return;
      lastInput = b;
      lastRule = r.rule ?? null;
      lastResult = r.result ?? r;
      drawResult(lastResult, r.disclaimer);
    } catch (ex) {
      if (my !== seq) return;
      lastInput = null;
      replace(result, h("div.card", h("p.error-box", ex.message), disclaimer(lib.disclaimer)));
    }
  }

  // --------------------------------------------------------------- result
  function drawResult(r, disc) {
    const n = daysBetween(today(), r.date);
    const rel = n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 0 ? `${n} days from today` : `${-n} days ago`;
    replace(result,
      h(
        "section.card.dl-answer",
        h("p.dl-label", "Last day"),
        h("p.dl-date", longDate(r.date), r.time ? ` at ${fmtClock(r.time)}` : ""),
        h("p.muted", `That is ${rel}.`),
        r.laterDateIfExtended
          ? h(
              "p.dl-note",
              `If the weekend and holiday rule applies again after the 3 added days, the last day would be ${longDate(r.laterDateIfExtended)}. The statute does not say, so the earlier date is shown.`,
            )
          : null,
        r.warnings.length
          ? h("div.dl-warnings", { role: "alert" }, h("h3", "Check these before relying on this date"), h("ul", r.warnings.map((w) => h("li", w))))
          : null,
        disclaimer(disc),
      ),
      addCard(),
      h(
        "section.card.dl-working",
        h("h2", "How this date was worked out"),
        h("ol.dl-steps", r.steps.map((s) => h("li", s))),
        h("h3", "When the last day ends"),
        h("p", r.lastDayEnds),
        h("h3", "Sources"),
        h("ul.dl-sources", r.citations.map((c) => h("li", h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer" }, c.cite)))),
      ),
    );
  }

  // ------------------------------------------------------- add to a matter
  let added = null;
  const matterSel = select(
    [{ value: "", label: "Choose a matter…" }, ...state.matters.map((m) => ({ value: m.id, label: matterLabel(m) }))],
    presetMatter ?? "",
    { id: "dl-matter", name: "matter", onchange: () => pickAssignee() },
  );
  const who = select([{ value: "", label: "The matter's attorney" }, ...users().map((u) => ({ value: u.id, label: u.name }))], "", { id: "dl-who", "aria-label": "Responsible" });
  const titleIn = h("input#dl-title", { maxlength: 300, name: "title" });
  let titleTouched = false;
  titleIn.addEventListener("input", () => (titleTouched = true));

  async function pickAssignee() {
    if (!matterSel.value) return;
    try {
      const m = await get(`/matters/${matterSel.value}`);
      const att = m.roles.find((r) => r.role === "attorney");
      if (att) who.value = String(att.user_id);
    } catch {
      /* leave it */
    }
  }

  function addCard() {
    const r = lastRule;
    if (!titleTouched) titleIn.value = r ? `${r.name} due` : "";
    const btn = h("button.btn.primary#dl-add", { type: "button", onclick: addToMatter }, "Add to the calendar and task list");
    return h(
      "section.card.dl-add",
      h("h2", "Put it on a matter"),
      h("p.muted.small", "Adds a court-deadline event to the calendar and a high-priority task with all of the working above, the sources and the disclaimer."),
      h("div.form-grid", h("label", "Matter", matterSel), h("label", "What is due", titleIn, h("span.muted.small", r ? "" : "For example: Response to motion to compel due")), h("label", "Responsible", who)),
      h("div.form-actions", btn),
      added ? addedNote(added) : null,
    );
  }

  function addedNote(a) {
    return h(
      "div.dl-added",
      { role: "status" },
      h("p", h("strong", "Added. "), a.summary),
      h("p", h("a", { href: `#/matters/${a.event.matterId}` }, "Open the matter"), " · ", h("a", { href: "#/calendar" }, "Open the calendar")),
    );
  }

  async function addToMatter() {
    if (!lastInput) return toast("Work out a date first.", { error: true });
    if (!matterSel.value) return toast("Choose the matter to add it to.", { error: true });
    const title = titleIn.value.trim();
    if (!title) return toast("Say what is due, for example “Response to motion due”.", { error: true });
    try {
      const r = await post("/deadlines/add-to-matter", { ...lastInput, matterId: Number(matterSel.value), title, assigneeId: who.value ? Number(who.value) : null });
      added = r;
      toast(["Added to the calendar and task list", r.summary]);
      drawResult(r.result, r.disclaimer);
    } catch (ex) {
      toast(ex.message, { error: true });
    }
  }

  // --------------------------------------------------------------- wiring
  for (const el of [ruleSel, trigger, triggerTime, service, amount, unit, direction])
    el.addEventListener("change", () => {
      added = null;
      if (el === ruleSel) titleTouched = false;
      compute();
    });
  amount.addEventListener("input", () => compute());
  closedInput.addEventListener("change", () => {
    const d = closedInput.value;
    if (d && !closedDays.includes(d)) closedDays.push(d), closedDays.sort();
    closedInput.value = "";
    added = null;
    drawClosed();
    compute();
  });

  const backTo = presetMatter ? state.matters.find((m) => m.id === presetMatter) : null;
  page.append(
    backTo ? h("a.back", { href: `#/matters/${presetMatter}` }, `← ${matterLabel(backTo)}`) : null,
    h(
      "div.page-head",
      h("div", h("h1", "Court deadline calculator"), h("p.sub", "Kansas state courts, civil cases (K.S.A. 60-206). Not for federal court.")),
    ),
    h(
      "div.dl-grid",
      h(
        "form.card.dl-form.form-grid",
        { onsubmit: (e) => e.preventDefault() },
        h("h2", "What started the clock"),
        h("label", "Deadline", ruleSel),
        ruleInfo,
        customBox,
        h("label", triggerLabel, h("div.dl-inline", trigger, triggerTime)),
        h("label", "How was it served?", service, serviceHint),
        h(
          "fieldset",
          h("legend", "Days the clerk's office was closed (optional)"),
          h("p.muted.small", "For example a weather closure. K.S.A. 60-206(a)(3) extends a last day that falls on one."),
          closedInput,
          closedChips,
        ),
      ),
      result,
    ),
  );
  if (presetMatter) pickAssignee();
  await compute();
  return page;
}

function disclaimer(text) {
  return h("div.dl-disclaimer", { role: "note" }, h("strong", "Verify this date. "), text.replace(/^VERIFY THIS DATE\.\s*/, ""));
}

function fmtClock(hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}
