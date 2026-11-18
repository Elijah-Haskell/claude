// Calendar pieces shared by the Calendar screen, My tasks ("Today's calendar") and the matter
// page ("Upcoming"): time formatting, plain-English repeat rules and the event dialogs.

import { h, replace, select, modal, toast, addDays, weekday, fmtDate, plural } from "./dom.js";
import { get, post, patch, del } from "./api.js";
import { state, today, users, userName, loadMatters } from "./state.js";
import { card, button, pill, loadingBlock } from "./ui/components.js";

export const FIRM_TZ = "America/Chicago";

export const KINDS = [
  { value: "meeting", label: "Meeting" },
  { value: "hearing", label: "Hearing" },
  { value: "court_deadline", label: "Court deadline" },
  { value: "statute_of_limitations", label: "Statute of limitations" },
  { value: "reminder", label: "Reminder" },
  { value: "other", label: "Other" },
];
export const kindLabel = (k) => KINDS.find((x) => x.value === k)?.label ?? "Event";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const RR_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const ORD = { 1: "First", 2: "Second", 3: "Third", 4: "Fourth", 5: "Fifth", "-1": "Last" };

export const dayName = (iso) => DAY_NAMES[weekday(iso)];
export const monthName = (m) => MONTH_NAMES[m];

/** "Tuesday, November 24, 2026" */
export function longDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${DAY_NAMES[weekday(iso)]}, ${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

/** "9:00 AM" for a UTC instant, in the firm's zone (or the one given). */
export function clock(instant, tz = FIRM_TZ) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(instant));
}

/** Local wall time "2026-11-24T09:00" for a UTC instant in a zone. */
export function localStamp(instant, tz = FIRM_TZ) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Minutes after local midnight. */
export function minutesOfDay(instant, tz = FIRM_TZ) {
  const t = localStamp(instant, tz).slice(11);
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

/** "9:00 – 9:45 AM", "All day", "Mon Nov 30 – Wed Dec 2". */
export function whenText(item, tz = FIRM_TZ) {
  if (item.type === "task") return "Task due";
  if (item.allDay) return item.start === item.end ? "All day" : `${fmtDate(item.start, today())} – ${fmtDate(item.end, today())}`;
  if (item.start === item.end) return clock(item.start, tz);
  return `${clock(item.start, tz)} – ${clock(item.end, tz)}`;
}

export function reminderText(m) {
  if (m === 0) return "at the start";
  if (m % 10080 === 0) return `${plural(m / 10080, "week")} before`;
  if (m % 1440 === 0) return `${plural(m / 1440, "day")} before`;
  if (m % 60 === 0) return `${plural(m / 60, "hour")} before`;
  return `${m} minutes before`;
}
const REMINDER_CHOICES = [0, 15, 60, 1440, 10080];

// ------------------------------------------------------------ repeat rules

function parseRule(rrule) {
  const out = {};
  for (const part of String(rrule || "").replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = part.split("=");
    if (k && v) out[k.toUpperCase()] = v.toUpperCase();
  }
  return out;
}

/** Repeat choices that make sense for a first date, in plain English. */
export function repeatChoices(date) {
  const wd = weekday(date);
  const dname = DAY_NAMES[wd];
  const dom = Number(date.slice(8, 10));
  const nth = Math.ceil(dom / 7);
  const isLast = addDays(date, 7).slice(5, 7) !== date.slice(5, 7);
  const code = RR_DAYS[wd];
  const out = [
    { key: "none", label: "Does not repeat", rrule: "" },
    { key: "daily", label: "Every day", rrule: "FREQ=DAILY" },
  ];
  if (wd >= 1 && wd <= 5) out.push({ key: "weekdays", label: "Every weekday (Monday to Friday)", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" });
  out.push({ key: "weekly", label: `Every week on ${dname}`, rrule: `FREQ=WEEKLY;BYDAY=${code}` });
  out.push({ key: "biweekly", label: `Every other week on ${dname}`, rrule: `FREQ=WEEKLY;INTERVAL=2;BYDAY=${code}` });
  if (nth <= 4) out.push({ key: "monthly-nth", label: `${ORD[nth]} ${dname} of each month`, rrule: `FREQ=MONTHLY;BYDAY=${nth}${code}` });
  if (isLast) out.push({ key: "monthly-last", label: `Last ${dname} of each month`, rrule: `FREQ=MONTHLY;BYDAY=-1${code}` });
  out.push({
    key: "monthly-day",
    label: `Monthly on the ${ordinal(dom)}${dom > 28 ? " (skips months without one)" : ""}`,
    rrule: "FREQ=MONTHLY",
  });
  out.push({ key: "yearly", label: `Every year on ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${dom}`, rrule: "FREQ=YEARLY" });
  return out;
}

function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return n + s;
}

/** Split a stored rule into the repeat pattern (without COUNT/UNTIL/WKST) and its end. */
export function splitRule(rrule) {
  const p = parseRule(rrule);
  const ends = p.COUNT ? { type: "count", count: Number(p.COUNT) } : p.UNTIL ? { type: "until", date: `${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}` } : { type: "never" };
  const core = ["FREQ", "INTERVAL", "BYDAY"]
    .filter((k) => p[k] && !(k === "INTERVAL" && p[k] === "1"))
    .map((k) => `${k}=${p[k]}`)
    .join(";");
  return { core, ends };
}

/** Plain-English description of a stored rule, e.g. "Second Tuesday of each month, 10 times". */
export function describeRule(rrule, firstDate) {
  if (!rrule) return "Does not repeat";
  const { core, ends } = splitRule(rrule);
  const match = firstDate ? repeatChoices(firstDate).find((c) => c.rrule === core) : null;
  let text = match ? match.label : null;
  if (!text) {
    const p = parseRule(core);
    const n = Number(p.INTERVAL || 1);
    const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[p.FREQ] || "period";
    text = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
    if (p.BYDAY) {
      const days = p.BYDAY.split(",").map((d) => {
        const m = /^(-?\d)?([A-Z]{2})$/.exec(d);
        if (!m) return d;
        const name = DAY_NAMES[RR_DAYS.indexOf(m[2])];
        return m[1] ? `${ORD[m[1]]?.toLowerCase() ?? m[1]} ${name}` : name;
      });
      text += ` on ${days.join(", ")}`;
    }
  }
  if (ends.type === "count") text += `, ${ends.count} times`;
  if (ends.type === "until") text += `, until ${fmtDate(ends.date, today())}`;
  return text;
}

// ------------------------------------------------------------ small parts

export function matterLabel(m) {
  return m ? `${m.number ? m.number + " " : ""}${m.name}` : "";
}

function matterOptions() {
  return [{ value: "", label: "No matter" }, ...state.matters.map((m) => ({ value: m.id, label: matterLabel(m) }))];
}

function busyText(b) {
  return `${userName(b.userId) ?? "Someone"} already has “${b.title}” ${clock(b.start)} – ${clock(b.end)}`;
}

export function conflictLines(conflicts) {
  const seen = new Set();
  const out = [];
  for (const c of conflicts || []) {
    const k = `${c.userId}/${c.a.eventId}/${c.b.eventId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`${c.userName}: “${c.a.title}” and “${c.b.title}” overlap on ${fmtDate(localStamp(c.b.start).slice(0, 10), today())}`);
    if (out.length >= 3) break;
  }
  return out;
}

function reportSaved(title, conflicts) {
  const lines = conflictLines(conflicts);
  if (lines.length) toast([`${title}. Double-booked:`, ...lines], { error: true, ms: 12000 });
  else toast(title);
}

// ------------------------------------------------------------ event dialog

/**
 * New or edit-series dialog. `event` is a full event from GET /calendar/events/:id, or null.
 * `preset` fills a new one: { date, matterId, attendees, allDay, time }.
 */
export async function eventDialog(event, preset = {}, onSaved = () => {}) {
  if (!state.matters.length) await loadMatters().catch(() => {});
  const isNew = !event;
  const startLocal = event && !event.allDay ? event.startLocal : null;
  const endLocal = event && !event.allDay ? event.endLocal : null;
  const firstDate = event ? (event.allDay ? event.start : startLocal.slice(0, 10)) : preset.date || today();

  const title = h("input", { required: true, maxlength: 500, value: event?.title ?? preset.title ?? "", name: "title" });
  const kind = select(KINDS, event?.kind ?? preset.kind ?? "meeting", { name: "kind" });
  const matter = select(matterOptions(), event?.matterId ?? preset.matterId ?? "", { name: "matter" });
  const allDay = h("input", { type: "checkbox", checked: event ? event.allDay : !!preset.allDay, name: "allDay" });
  const date = h("input", { type: "date", required: true, value: firstDate, name: "date" });
  const t0 = preset.time ?? "09:00";
  const startTime = h("input", { type: "time", value: startLocal ? startLocal.slice(11, 16) : t0, name: "startTime", step: 300 });
  const endTime = h("input", {
    type: "time",
    name: "endTime",
    step: 300,
    value: endLocal ? endLocal.slice(11, 16) : `${String(Math.min(23, Number(t0.slice(0, 2)) + 1)).padStart(2, "0")}:${t0.slice(3, 5)}`,
  });
  const endDate = h("input", { type: "date", value: event?.allDay ? event.end : firstDate, name: "endDate" });
  const location = h("input", { maxlength: 1000, value: event?.location ?? "", name: "location" });
  const notes = h("textarea", { rows: 3, maxlength: 10000, name: "notes" }, event?.notes ?? "");
  const tzNote = event && event.timeZone !== FIRM_TZ ? h("p.muted.small", `Times are in ${event.timeZone.replace("_", " ")}.`) : null;

  const chosen = new Set(event?.attendees ?? preset.attendees ?? (state.me ? [state.me] : []));
  const attendeeBoxes = users().map((u) =>
    h("label.check-line", h("input", { type: "checkbox", value: u.id, checked: chosen.has(u.id), onchange: () => clearWarning() }), " ", u.name),
  );
  const reminderSet = new Set(event?.reminders ?? preset.reminders ?? [15]);
  const reminderBoxes = REMINDER_CHOICES.map((m) => h("label.check-line", h("input", { type: "checkbox", value: m, checked: reminderSet.has(m) }), " ", reminderText(m)));
  for (const m of reminderSet) if (!REMINDER_CHOICES.includes(m)) reminderBoxes.push(h("label.check-line", h("input", { type: "checkbox", value: m, checked: true }), " ", reminderText(m)));

  // Repeat: plain-English choices for the chosen date, plus how it ends.
  const existing = event?.rrule ? splitRule(event.rrule) : null;
  let repeatKey = "none";
  const repeat = h("select", { name: "repeat", "aria-label": "Repeat" });
  const endsType = select(
    [
      { value: "never", label: "No end date" },
      { value: "until", label: "Until a date" },
      { value: "count", label: "A set number of times" },
    ],
    existing?.ends.type ?? "never",
    { name: "repeatEnds", "aria-label": "Repeat ends" },
  );
  const untilDate = h("input", { type: "date", value: existing?.ends.date ?? "", "aria-label": "Last date" });
  const countInput = h("input", { type: "number", min: 1, max: 999, value: existing?.ends.count ?? 10, "aria-label": "Number of times" });
  const endsBox = h("div.cal-repeat-ends", endsType, untilDate, countInput);
  function drawRepeat() {
    const opts = repeatChoices(date.value || today());
    if (existing && repeatKey === "none" && !repeat.options.length) {
      const m = opts.find((o) => o.rrule === existing.core);
      repeatKey = m ? m.key : "custom";
    } else if (repeat.value) repeatKey = repeat.value;
    if (existing && !opts.some((o) => o.rrule === existing.core)) {
      opts.push({ key: "custom", label: `As set up: ${describeRule(existing.core, null)}`, rrule: existing.core });
    }
    replace(repeat, ...opts.map((o) => h("option", { value: o.key, selected: o.key === repeatKey }, o.label)));
    if (!opts.some((o) => o.key === repeatKey)) repeat.value = "none";
    syncRepeat();
  }
  function syncRepeat() {
    const on = repeat.value !== "none";
    endsBox.hidden = !on;
    untilDate.hidden = endsType.value !== "until";
    countInput.hidden = endsType.value !== "count";
  }
  function ruleValue() {
    const opt = repeatChoices(date.value || today()).find((o) => o.key === repeat.value);
    const core = repeat.value === "custom" ? existing.core : opt?.rrule ?? "";
    if (!core) return null;
    if (endsType.value === "until" && untilDate.value) return `${core};UNTIL=${untilDate.value.replaceAll("-", "")}`;
    if (endsType.value === "count") return `${core};COUNT=${Math.max(1, Number(countInput.value) || 1)}`;
    return core;
  }
  repeat.addEventListener("change", syncRepeat);
  endsType.addEventListener("change", syncRepeat);
  date.addEventListener("change", () => {
    if (!endDate.value || endDate.value < date.value) endDate.value = date.value;
    drawRepeat();
    clearWarning();
  });

  const timedRow = h("div.form-row.cal-times", h("label", "Starts", startTime), h("label", "Ends", endTime));
  const allDayRow = h("div.form-row.cal-times", h("label", "Last day", endDate));
  function syncAllDay() {
    timedRow.hidden = allDay.checked;
    allDayRow.hidden = !allDay.checked;
    clearWarning();
  }
  allDay.addEventListener("change", syncAllDay);
  for (const el of [startTime, endTime]) el.addEventListener("change", clearWarning);

  const warnBox = h("div.cal-warning", { role: "alert", hidden: true });
  const err = h("p.error-text", { role: "alert" });
  const saveBtn = h("button.btn.primary", { type: "submit" }, isNew ? "Save event" : "Save changes");
  let confirmedBusy = false;
  function clearWarning() {
    confirmedBusy = false;
    warnBox.hidden = true;
    saveBtn.textContent = isNew ? "Save event" : "Save changes";
  }

  function body() {
    const attendees = attendeeBoxes.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => Number(c.value));
    const reminders = reminderBoxes.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => Number(c.value));
    const b = {
      title: title.value,
      kind: kind.value,
      matterId: matter.value ? Number(matter.value) : null,
      allDay: allDay.checked,
      location: location.value || null,
      notes: notes.value || null,
      attendees,
      reminders,
      rrule: ruleValue(),
    };
    if (allDay.checked) {
      b.start = date.value;
      b.end = endDate.value && endDate.value >= date.value ? endDate.value : date.value;
    } else {
      b.start = `${date.value}T${startTime.value || "09:00"}`;
      b.end = `${date.value}T${endTime.value || startTime.value || "10:00"}`;
      if (event) b.timeZone = event.timeZone;
    }
    return b;
  }

  const form = h(
    "form.modal-body.form-grid.cal-form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const b = body();
        try {
          // Double-booking check before saving (first occurrence); the server reports the rest.
          if (!b.allDay && b.attendees.length && !confirmedBusy && b.end > b.start) {
            const q = new URLSearchParams({ users: b.attendees.join(","), start: b.start, end: b.end });
            if (event) q.set("exclude", String(event.id));
            if (b.timeZone) q.set("tz", b.timeZone);
            const busy = await get(`/calendar/availability?${q}`);
            if (busy.length) {
              replace(warnBox,
                h("strong", "Double-booking"),
                h("ul", busy.slice(0, 5).map((x) => h("li", busyText(x)))),
                h("p", "Save anyway, or change the time."),
              );
              warnBox.hidden = false;
              confirmedBusy = true;
              saveBtn.textContent = "Save anyway";
              return;
            }
          }
          const r = isNew ? await post("/calendar/events", b) : await patch(`/calendar/events/${event.id}`, b);
          dlg.close();
          reportSaved(isNew ? `Added “${r.event.title}”` : "Saved", r.conflicts);
          onSaved(r.event);
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h("label", "Title", title),
    h("div.form-row", h("label", "Type", kind), h("label.cal-span2", "Matter", matter)),
    h("div.cal-when", h("label", "Date", date), h("label.check-line.cal-allday", allDay, " All day")),
    timedRow,
    allDayRow,
    tzNote,
    h("label", "Repeats", repeat),
    endsBox,
    existing && !isNew && event.exceptions?.length
      ? h("p.muted.small", `This series has ${plural(event.exceptions.length, "one-off change")}. Changing its date, time or repeat pattern removes them.`)
      : null,
    h("fieldset.cal-people", h("legend", "Who is attending"), attendeeBoxes),
    h("label", "Location", location),
    h("fieldset.cal-reminders", h("legend", "Reminders"), reminderBoxes),
    h("label", "Notes", notes),
    cancelledList(event, onSaved),
    warnBox,
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), saveBtn),
  );
  const dlg = modal(isNew ? "New event" : event.rrule ? "Edit the whole series" : "Edit event", form, { wide: true });
  dlg.classList.add("cal-dialog");
  drawRepeat();
  syncAllDay();
  title.focus();
  return dlg;
}

/** In the series dialog: the dates cancelled on their own, each with Restore. */
function cancelledList(event, onSaved) {
  const gone = (event?.exceptions ?? []).filter((x) => x.cancelled);
  if (!gone.length) return null;
  const label = (key) => {
    if (/^\d{8}$/.test(key)) return fmtDate(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`, today());
    const iso = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${key.slice(9, 11)}:${key.slice(11, 13)}:00Z`;
    return `${fmtDate(localStamp(iso).slice(0, 10), today())}, ${clock(iso)}`;
  };
  return h(
    "fieldset",
    h("legend", "Cancelled dates"),
    gone.map((x) =>
      h(
        "div.cal-cancelled",
        h("span", label(x.occurrence)),
        h(
          "button.btn.small",
          {
            type: "button",
            onclick: async (e) => {
              try {
                await post(`/calendar/events/${event.id}/occurrences/${x.occurrence}/restore`);
                e.target.closest(".cal-cancelled").remove();
                toast("Restored that date");
                onSaved();
              } catch (ex) {
                toast(ex.message, { error: true });
              }
            },
          },
          "Restore",
        ),
      ),
    ),
  );
}

/** Edit one occurrence of a repeating event. */
export function occurrenceDialog(item, onSaved = () => {}) {
  const tz = item.timeZone || FIRM_TZ;
  const title = h("input", { required: true, maxlength: 500, value: item.title, name: "title" });
  const startL = item.allDay ? null : localStamp(item.start, tz);
  const endL = item.allDay ? null : localStamp(item.end, tz);
  const date = h("input", { type: "date", required: true, value: item.allDay ? item.start : startL.slice(0, 10), name: "date" });
  const startTime = h("input", { type: "time", value: startL?.slice(11, 16) ?? "", name: "startTime", step: 300 });
  const endTime = h("input", { type: "time", value: endL?.slice(11, 16) ?? "", name: "endTime", step: 300 });
  const endDate = h("input", { type: "date", value: item.allDay ? item.end : "", name: "endDate" });
  const location = h("input", { maxlength: 1000, value: item.location ?? "", name: "location" });
  const notes = h("textarea", { rows: 3, maxlength: 10000 }, item.notes ?? "");
  const err = h("p.error-text", { role: "alert" });
  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const b = { title: title.value, location: location.value || null, notes: notes.value || null };
        if (item.allDay) {
          b.start = date.value;
          b.end = endDate.value && endDate.value >= date.value ? endDate.value : date.value;
        } else {
          b.start = `${date.value}T${startTime.value}`;
          b.end = `${date.value}T${endTime.value || startTime.value}`;
        }
        try {
          const r = await patch(`/calendar/events/${item.eventId}/occurrences/${item.occurrence}`, b);
          dlg.close();
          reportSaved("Changed this date only", r.conflicts);
          onSaved();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h("p.muted", "Changes here apply to this one date. The rest of the series stays as it is."),
    h("label", "Title", title),
    h("label", "Date", date),
    item.allDay ? h("div.form-row.cal-times", h("label", "Last day", endDate)) : h("div.form-row.cal-times", h("label", "Starts", startTime), h("label", "Ends", endTime)),
    h("label", "Location", location),
    h("label", "Notes", notes),
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Save this date")),
  );
  const dlg = modal("Edit this date only", form);
  dlg.classList.add("cal-dialog");
  title.focus();
}

/** Details of one calendar item, with the actions that fit it. */
export function itemDialog(item, onChanged = () => {}) {
  if (item.type === "task") {
    const dlg = modal(
      "Task due",
      h(
        "div.modal-body",
        h("p.cal-detail-title", item.title),
        h("dl.cal-dl",
          h("dt", "Due"), h("dd", longDate(item.dueDate)),
          h("dt", "Assigned to"), h("dd", item.assigneeName || "Unassigned"),
          item.matter ? [h("dt", "Matter"), h("dd", h("a", { href: `#/matters/${item.matter.id}`, onclick: () => dlg.close() }, matterLabel(item.matter)))] : null,
          h("dt", "Priority"), h("dd.cap", item.priority),
        ),
        h("p.muted.small", "Tasks are shown on the calendar on their due date. Change them on the matter or in My tasks."),
        h("div.form-actions", h("a.btn", { href: item.matter ? `#/matters/${item.matter.id}` : "#/my", onclick: () => dlg.close() }, item.matter ? "Open the matter" : "Open My tasks")),
      ),
    );
    return dlg;
  }
  const close = () => dlg.close();
  const run = async (fn, msg) => {
    try {
      await fn();
      close();
      toast(msg);
      onChanged();
    } catch (ex) {
      toast(ex.message, { error: true });
    }
  };
  const openSeries = async () => {
    try {
      const ev = await get(`/calendar/events/${item.eventId}`);
      close();
      eventDialog(ev, {}, onChanged);
    } catch (ex) {
      toast(ex.message, { error: true });
    }
  };
  const dateOf = item.allDay ? item.start : localStamp(item.start, FIRM_TZ).slice(0, 10);
  const actions = item.recurring
    ? [
        h("button.btn", { type: "button", onclick: () => (close(), occurrenceDialog(item, onChanged)) }, "Edit this date only"),
        h("button.btn", { type: "button", onclick: openSeries }, "Edit the whole series"),
        item.modified
          ? h("button.btn", { type: "button", onclick: () => run(() => post(`/calendar/events/${item.eventId}/occurrences/${item.occurrence}/restore`), "Put back as the series has it") }, "Undo change to this date")
          : null,
        h(
          "button.btn.danger-text",
          { type: "button", onclick: () => confirm(`Cancel “${item.title}” on ${fmtDate(dateOf, today())} only?`) && run(() => del(`/calendar/events/${item.eventId}/occurrences/${item.occurrence}`), "Cancelled that date") },
          "Cancel this date",
        ),
        h(
          "button.btn.danger-text",
          { type: "button", onclick: () => confirm(`Delete every “${item.title}” in the series? This cannot be undone.`) && run(() => del(`/calendar/events/${item.eventId}`), "Series deleted") },
          "Delete the series",
        ),
      ]
    : [
        h("button.btn", { type: "button", onclick: openSeries }, "Edit"),
        h("button.btn.danger-text", { type: "button", onclick: () => confirm(`Delete “${item.title}”?`) && run(() => del(`/calendar/events/${item.eventId}`), "Deleted") }, "Delete"),
      ];
  const names = item.attendees.map((u) => userName(u)).filter(Boolean);
  const dlg = modal(
    item.kind === "other" ? "Event" : kindLabel(item.kind),
    h(
      "div.modal-body",
      h("p.cal-detail-title", item.title),
      item.conflict ? h("p.cal-warning", "Double-booked: someone attending has another event at this time.") : null,
      h(
        "dl.cal-dl",
        h("dt", "When"),
        h("dd", longDate(dateOf), " · ", whenText(item)),
        item.recurring ? [h("dt", "Repeats"), h("dd", item.modified ? "This date was changed on its own" : "Part of a repeating series")] : null,
        item.matter ? [h("dt", "Matter"), h("dd", h("a", { href: `#/matters/${item.matter.id}`, onclick: close }, matterLabel(item.matter)))] : null,
        [h("dt", "Attending"), h("dd", names.length ? names.join(", ") : "No one named")],
        item.location ? [h("dt", "Location"), h("dd", item.location)] : null,
        item.reminders?.length ? [h("dt", "Reminders"), h("dd", item.reminders.map(reminderText).join(", "))] : null,
      ),
      item.notes ? h("div.cal-notes", h("h3", "Notes"), h("p.pre", item.notes)) : null,
      h("div.form-actions.cal-actions", actions),
    ),
    { wide: !!item.notes },
  );
  dlg.classList.add("cal-dialog");
  return dlg;
}

// ------------------------------------------------- compact lists elsewhere

/** Pill tone per kind of event, the same everywhere (Calendar, Home, matter page). */
export const KIND_TONE = { meeting: "info", hearing: "brand", court_deadline: "danger", statute_of_limitations: "danger", reminder: "warning", other: "neutral" };
/** Kinds worth naming next to the title; a plain meeting needs no label. */
const NAMED_KINDS = new Set(["hearing", "court_deadline", "statute_of_limitations", "reminder"]);

/** One line of an event or task for compact lists. */
export function itemLine(item, onChanged, { showMatter = true, showDate = false, taskOwner = false } = {}) {
  const isTask = item.type === "task";
  // taskOwner: in a list of tasks under their own heading, the first column names who has the task.
  const sub = [
    showMatter && item.matter ? matterLabel(item.matter) : null,
    !isTask && item.location ? item.location : null,
    isTask && !taskOwner && item.assigneeName ? item.assigneeName : null,
  ].filter(Boolean);
  return h(
    "li.cal-line" + (isTask ? ".is-task" : `.k-${item.kind}`) + (item.conflict ? ".is-conflict" : ""),
    h(
      "button.cal-line-btn",
      { type: "button", onclick: () => itemDialog(item, onChanged) },
      h(
        "span.cal-line-when",
        showDate ? h("span.cal-line-date", fmtDate(item.date, today())) : null,
        h("span.cal-line-time", isTask ? (taskOwner ? item.assigneeName || "Unassigned" : "Task due") : whenText(item)),
      ),
      h("span.cal-line-mark", { "aria-hidden": "true" }),
      h("span.cal-line-main", h("span.cal-line-title", item.title), sub.length ? h("span.cal-line-sub", sub.join(" · ")) : null),
      item.conflict || (!isTask && NAMED_KINDS.has(item.kind))
        ? h(
            "span.cal-line-tags",
            item.conflict ? pill("Double-booked", "danger") : null,
            !isTask && NAMED_KINDS.has(item.kind) ? pill(kindLabel(item.kind), KIND_TONE[item.kind], { dot: false }) : null,
          )
        : null,
    ),
  );
}

/** My tasks: the signed-in person's events today. */
export function todayStrip(userId) {
  const box = h("div.cal-today-slot");
  const frame = (body) =>
    card({
      title: "Today's calendar",
      subtitle: longDate(today()),
      icon: "calendar",
      className: "cal-today",
      flush: true,
      actions: button("Calendar", { href: "#/calendar", variant: "ghost", size: "sm", iconRight: "arrow-right" }),
      body,
    });
  const load = async () => {
    try {
      const d = await get(`/calendar/agenda?from=${today()}&to=${today()}&user=${userId}&tasks=0`);
      const items = d.items.filter((i) => i.type === "event");
      replace(box, frame(items.length ? h("ul.cal-lines.cal-today-list", items.map((i) => itemLine(i, load))) : h("p.muted.cal-none", "Nothing on your calendar today.")));
    } catch (ex) {
      replace(box, frame(h("p.error-text.cal-none", `The calendar could not be loaded: ${ex.message}`)));
    }
  };
  box.append(frame(loadingBlock("Loading today's calendar", "lines", 2)));
  load();
  return box;
}

/** Matter page: the matter's next events. */
export function upcomingCard(matterId) {
  const box = h("div.cal-upcoming-slot");
  const frame = (body, footer = null) =>
    card({
      title: "Upcoming",
      subtitle: "Hearings, deadlines and meetings on this matter",
      icon: "calendar-days",
      className: "cal-upcoming",
      flush: true,
      actions: [
        button("Court deadline", { href: `#/deadlines/${matterId}`, variant: "ghost", size: "sm", icon: "deadlines" }),
        button("Add event", { size: "sm", icon: "plus", onclick: () => eventDialog(null, { matterId, attendees: state.me ? [state.me] : [] }, load) }),
      ],
      body,
      footer,
    });
  const load = async () => {
    try {
      const d = await get(`/calendar/agenda?scope=firm&matter=${matterId}&from=${today()}&to=${addDays(today(), 365)}&tasks=0`);
      const items = d.items.slice(0, 6);
      replace(box,
        frame(
          items.length
            ? h("ul.cal-lines.cal-upcoming-list", items.map((i) => itemLine(i, load, { showMatter: false, showDate: true })))
            : h("p.muted.cal-none", "Nothing on the calendar for this matter."),
          d.items.length > items.length ? h("span.muted", `${d.items.length - items.length} more later in the year.`) : null,
        ),
      );
    } catch (ex) {
      replace(box, frame(h("p.error-text.cal-none", ex.message)));
    }
  };
  box.append(frame(loadingBlock("Loading upcoming events", "lines", 2)));
  load();
  return box;
}
