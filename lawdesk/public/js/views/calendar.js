// Calendar: month, week and list views of the firm's events and task due dates, for the
// whole firm or one person; new/edit event dialogs; .ics import; private feed links for
// Outlook, Google and Apple.

import { h, replace, select, modal, toast, addDays, weekday, fmtTime, plural } from "../dom.js";
import { get, post, del } from "../api.js";
import { state, today, users, userName, prefs, loadMatters } from "../state.js";
import { KINDS, clock, eventDialog, itemDialog, itemLine, kindLabel, longDate, matterLabel, minutesOfDay, monthName, dayName } from "../cal.js";
import { pageHeader, card, button, iconButton, emptyState, segmented, callout } from "../ui/components.js";
import { menu } from "../ui/popover.js";

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_PX = 48;
const ALLDAY_MAX = 3;
const phoneQuery = window.matchMedia("(max-width: 720px)");

export async function calendarView() {
  const page = h("div.page.cal-page");
  let view = prefs.get("cal.view", "month");
  if (!["month", "week", "list"].includes(view)) view = "month";
  let scope = prefs.get("cal.scope", "firm");
  if (scope !== "firm" && !users().some((u) => String(u.id) === scope)) scope = "firm";
  let showTasks = prefs.get("cal.tasks", "1") === "1";
  let anchor = today();
  let selected = today();
  let listDays = 30;
  let allDayOpen = false;
  let data = null;
  let seq = 0;

  const titleEl = h("h2.cal-range", { "aria-live": "polite" });
  const body = h("div.cal-body");
  const below = h("div.cal-below");

  const range = () => {
    if (view === "month") {
      const first = anchor.slice(0, 8) + "01";
      const start = addDays(first, -weekday(first));
      return { from: start, to: addDays(start, 41) };
    }
    if (view === "week") {
      const start = addDays(anchor, -weekday(anchor));
      return { from: start, to: addDays(start, 6) };
    }
    return { from: anchor, to: addDays(anchor, listDays - 1) };
  };

  function rangeTitle() {
    const { from, to } = range();
    const y = (d) => d.slice(0, 4);
    const md = (d) => `${monthName(Number(d.slice(5, 7)) - 1).slice(0, 3)} ${Number(d.slice(8, 10))}`;
    if (view === "month") return `${monthName(Number(anchor.slice(5, 7)) - 1)} ${y(anchor)}`;
    return `${md(from)}${y(from) !== y(to) ? ", " + y(from) : ""} – ${md(to)}, ${y(to)}`;
  }

  async function load() {
    const my = ++seq;
    const { from, to } = range();
    const q = new URLSearchParams({ from, to, tasks: showTasks ? "1" : "0" });
    if (scope === "firm") q.set("scope", "firm");
    else q.set("user", scope);
    titleEl.textContent = rangeTitle();
    try {
      const d = await get(`/calendar/agenda?${q}`);
      if (my !== seq) return;
      data = d;
      draw();
    } catch (ex) {
      if (my !== seq) return;
      replace(body, h("div.cal-error", callout({ tone: "danger", title: "The calendar could not be loaded.", body: ex.message, action: button("Try again", { size: "sm", onclick: load }) })));
      replace(below);
    }
  }

  function byDate() {
    const map = new Map();
    const put = (d, it) => (map.has(d) ? map.get(d) : map.set(d, []).get(d)).push(it);
    for (const it of data.items) {
      if (it.type === "event" && it.allDay && it.end > it.start) {
        for (let d = it.start; d <= it.end; d = addDays(d, 1)) put(d, it);
      } else put(it.date, it);
    }
    return map;
  }

  function draw() {
    if (!data) return;
    // The view that is drawn (the browser checks wait on this, not on the button).
    body.dataset.view = view;
    if (view === "month") {
      const map = byDate();
      replace(body, drawMonth(map));
      replace(below, dayPanel(selected, map.get(selected) ?? []));
    } else {
      replace(body, view === "week" ? (phoneQuery.matches ? drawDayList(range().from, 7, true) : drawWeek()) : drawList());
      replace(below);
    }
  }

  // ----------------------------------------------------------------- month
  function chip(it) {
    const isTask = it.type === "task";
    return h(
      "button.cal-chip" + (isTask ? ".is-task" : `.k-${it.kind}`) + (it.allDay && !isTask ? ".is-allday" : "") + (it.conflict ? ".is-conflict" : ""),
      {
        type: "button",
        title: `${isTask ? "Task due" : kindLabel(it.kind)}: ${it.title}${it.matter ? " · " + matterLabel(it.matter) : ""}${it.conflict ? " · Double-booked" : ""}`,
        onclick: (e) => (e.stopPropagation(), itemDialog(it, load)),
      },
      isTask ? h("span.cal-box", { "aria-hidden": "true" }) : h("span.cal-kdot", { "aria-hidden": "true" }),
      !isTask && !it.allDay ? h("span.cal-chip-time", shortClock(it.start)) : null,
      h("span.cal-chip-text", it.title),
    );
  }

  /** Events first (all-day, then by time), then task due dates. */
  const sortDay = (items) =>
    items
      .slice()
      .sort(
        (a, b) =>
          Number(a.type === "task") - Number(b.type === "task") ||
          Number(b.allDay) - Number(a.allDay) ||
          (a.start || "").localeCompare(b.start || "") ||
          a.title.localeCompare(b.title),
      );

  function drawMonth(map) {
    const { from } = range();
    const month = anchor.slice(0, 7);
    const grid = h("div.cal-month", { role: "grid", "aria-label": rangeTitle() });
    grid.append(h("div.cal-row.cal-head", { role: "row" }, SHORT_DAYS.map((d, i) => h("div.cal-hd", { role: "columnheader", "aria-label": dayName(addDays(from, i)) }, d))));
    for (let w = 0; w < 6; w++) {
      const row = h("div.cal-row", { role: "row" });
      for (let i = 0; i < 7; i++) {
        const d = addDays(from, w * 7 + i);
        const items = sortDay(map.get(d) ?? []);
        const max = 3;
        const cell = h(
          "div.cal-cell" + (d.slice(0, 7) !== month ? ".other" : "") + (d === today() ? ".today" : "") + (d === selected ? ".selected" : "") + (i === 0 || i === 6 ? ".weekend" : ""),
          { role: "gridcell", dataset: { date: d }, "aria-selected": d === selected ? "true" : "false", onclick: () => selectDay(d) },
          h(
            "button.cal-daynum",
            { type: "button", "aria-label": `${longDate(d)}, ${plural(items.length, "item")}`, onclick: (e) => (e.stopPropagation(), selectDay(d)) },
            String(Number(d.slice(8, 10))),
          ),
          h("div.cal-chips", items.slice(0, max).map(chip)),
          items.length > max ? h("button.cal-more", { type: "button", onclick: (e) => (e.stopPropagation(), selectDay(d)) }, `${items.length - max} more`) : null,
          items.length
            ? h(
                "div.cal-dots",
                { "aria-hidden": "true" },
                items.slice(0, 4).map((it) => h("span.cal-dot" + (it.type === "task" ? ".is-task" : `.k-${it.kind}`))),
              )
            : null,
        );
        row.append(cell);
      }
      grid.append(row);
    }
    return grid;
  }

  function selectDay(d) {
    selected = d;
    if (view === "month" && d.slice(0, 7) !== anchor.slice(0, 7)) {
      anchor = d;
      return load();
    }
    draw();
    document.querySelector(".cal-daypanel")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function dayPanel(d, items) {
    const sorted = sortDay(items);
    const events = sorted.filter((it) => it.type !== "task");
    const tasks = sorted.filter((it) => it.type === "task");
    const summary = [events.length ? plural(events.length, "event") : null, tasks.length ? plural(tasks.length, "task") + " due" : null].filter(Boolean).join(" · ");
    return card({
      title: longDate(d),
      subtitle: d === today() ? `Today${summary ? " · " + summary : ""}` : summary || null,
      icon: "calendar",
      className: "cal-daypanel",
      flush: true,
      actions: button("Add event", { size: "sm", icon: "plus", onclick: () => newEvent({ date: d }) }),
      body: items.length
        ? [
            events.length ? h("ul.cal-lines", events.map((it) => itemLine(it, load))) : null,
            tasks.length ? [h("h3.cal-subhead", "Tasks due"), h("ul.cal-lines", tasks.map((it) => itemLine(it, load, { taskOwner: true })))] : null,
          ]
        : emptyState({ icon: "calendar", title: "Nothing on the calendar", body: "Hearings, meetings and deadlines on this day will show here.", compact: true }),
    });
  }

  // ------------------------------------------------------------------ week
  function drawWeek() {
    const { from } = range();
    const map = byDate();
    const days = [...Array(7)].map((_, i) => addDays(from, i));
    const timedOf = (d) => (map.get(d) ?? []).filter((it) => it.type === "event" && !it.allDay);
    let lo = 8 * 60,
      hi = 18 * 60;
    for (const d of days)
      for (const it of timedOf(d)) {
        lo = Math.min(lo, Math.floor(minutesOfDay(it.start) / 60) * 60);
        const endM = it.end.slice(0, 10) === it.start.slice(0, 10) || minutesOfDay(it.end) > minutesOfDay(it.start) ? minutesOfDay(it.end) : 24 * 60;
        hi = Math.max(hi, Math.ceil(Math.max(endM, minutesOfDay(it.start) + 30) / 60) * 60);
      }
    hi = Math.min(hi, 24 * 60);
    const height = ((hi - lo) / 60) * HOUR_PX;

    const head = h(
      "div.cal-week-head",
      h("div.cal-gutter"),
      days.map((d) =>
        h(
          "button.cal-week-day" + (d === today() ? ".today" : ""),
          { type: "button", onclick: () => newEvent({ date: d }), title: `Add an event on ${longDate(d)}` },
          h("span.cal-wd", SHORT_DAYS[weekday(d)]),
          h("span.cal-wn", String(Number(d.slice(8, 10)))),
        ),
      ),
    );
    const allDayOf = (d) => sortDay((map.get(d) ?? []).filter((it) => it.type === "task" || it.allDay));
    const longest = Math.max(0, ...days.map((d) => allDayOf(d).length));
    const allDayRow = h(
      "div.cal-week-allday",
      h("div.cal-gutter.cal-allday-label", "All day"),
      days.map((d) => {
        const items = allDayOf(d);
        const shown = allDayOpen ? items : items.slice(0, ALLDAY_MAX);
        return h(
          "div.cal-week-allcell" + (d === today() ? ".today" : ""),
          shown.map(chip),
          !allDayOpen && items.length > ALLDAY_MAX ? h("button.cal-more", { type: "button", onclick: () => ((allDayOpen = true), draw()) }, `${items.length - ALLDAY_MAX} more`) : null,
        );
      }),
    );
    const allDayToggle =
      allDayOpen && longest > ALLDAY_MAX
        ? h("div.cal-allday-less", h("button.cal-more", { type: "button", onclick: () => ((allDayOpen = false), draw()) }, "Show fewer"))
        : null;
    const gutter = h("div.cal-gutter.cal-hours");
    gutter.style.height = height + "px";
    for (let m = lo; m < hi; m += 60) {
      const lab = h("span.cal-hour", clockOfMinutes(m));
      lab.style.top = ((m - lo) / 60) * HOUR_PX + "px";
      gutter.append(lab);
    }
    const cols = days.map((d) => {
      const col = h("div.cal-week-col" + (d === today() ? ".today" : "") + (weekday(d) === 0 || weekday(d) === 6 ? ".weekend" : ""), { "aria-label": longDate(d) });
      col.style.height = height + "px";
      for (let m = lo; m < hi; m += 60) {
        const line = h("div.cal-hourline");
        line.style.top = ((m - lo) / 60) * HOUR_PX + "px";
        col.append(line);
      }
      for (const { it, lane, lanes } of layLanes(timedOf(d))) {
        const s = minutesOfDay(it.start);
        let e = minutesOfDay(it.end);
        if (e <= s) e = it.end === it.start ? s + 30 : 24 * 60;
        const size = e - s < 50 ? ".short" : e - s < 75 ? ".medium" : "";
        const block = h(
          "button.cal-block" + `.k-${it.kind}` + (it.conflict ? ".is-conflict" : "") + size + (lanes > 1 ? ".narrow" : ""),
          {
            type: "button",
            onclick: () => itemDialog(it, load),
            title: `${clock(it.start)}${it.start === it.end ? "" : " – " + clock(it.end)}: ${it.title}${it.location ? " · " + it.location : ""}${it.conflict ? " · Double-booked" : ""}`,
          },
          h("span.cal-block-title", it.title),
          h("span.cal-block-time", shortClock(it.start)),
          it.location && e - s >= 75 ? h("span.cal-block-loc", it.location) : null,
        );
        block.style.top = ((s - lo) / 60) * HOUR_PX + 1 + "px";
        block.style.height = Math.max(20, ((e - s) / 60) * HOUR_PX - 3) + "px";
        block.style.left = `calc(${(lane / lanes) * 100}% + 2px)`;
        block.style.width = `calc(${100 / lanes}% - 5px)`;
        col.append(block);
      }
      return col;
    });
    return h("div.cal-week", head, allDayRow, allDayToggle, h("div.cal-week-grid", gutter, cols));
  }

  // ------------------------------------------------------------------ list
  function drawDayList(from, n, showEmpty) {
    const map = byDate();
    const out = h("div.cal-list");
    let any = false;
    for (let i = 0; i < n; i++) {
      const d = addDays(from, i);
      const items = map.get(d) ?? [];
      if (!items.length && !showEmpty) continue;
      any = true;
      out.append(
        h(
          "section.cal-list-day" + (d === today() ? ".today" : ""),
          h("h3.cal-list-date", h("span", longDate(d)), d === today() ? h("span.pill.pill-brand", "Today") : null),
          items.length ? h("ul.cal-lines", sortDay(items).map((it) => itemLine(it, load))) : h("p.cal-list-none", "Nothing scheduled."),
        ),
      );
    }
    if (!any)
      out.append(
        emptyState({
          icon: "calendar",
          title: "Nothing on the calendar in these dates",
          body: "Hearings, meetings, court deadlines and task due dates show here as they are added.",
          action: button("New event", { size: "sm", icon: "plus", onclick: () => newEvent({ date: anchor }) }),
        }),
      );
    return out;
  }

  function drawList() {
    return h(
      "div",
      drawDayList(anchor, listDays, false),
      h("div.cal-list-more", button(`Show the next 30 days`, { size: "sm", iconRight: "chevron-down", onclick: () => ((listDays += 30), load()) })),
    );
  }

  // --------------------------------------------------------------- toolbar
  const move = (dir) => {
    if (view === "month") {
      const [y, m] = anchor.split("-").map(Number);
      const nm = new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10);
      anchor = nm;
      selected = nm.slice(0, 7) === today().slice(0, 7) ? today() : nm;
    } else if (view === "week") anchor = addDays(anchor, 7 * dir);
    else anchor = addDays(anchor, listDays * dir);
    load();
  };
  const unitName = () => (view === "month" ? "month" : view === "week" ? "week" : `${listDays} days`);
  const prevBtn = iconButton("chevron-left", "Previous", { class: "bordered", onclick: () => move(-1) });
  const nextBtn = iconButton("chevron-right", "Next", { class: "bordered", onclick: () => move(1) });
  const syncNavLabels = () => {
    for (const [b, w] of [[prevBtn, "Previous"], [nextBtn, "Next"]]) {
      b.setAttribute("aria-label", `${w} ${unitName()}`);
      b.title = `${w} ${unitName()}`;
    }
  };
  syncNavLabels();
  const viewSwitch = segmented(
    [
      { value: "month", label: "Month" },
      { value: "week", label: "Week" },
      { value: "list", label: "List" },
    ],
    view,
    (v) => {
      view = v;
      prefs.set("cal.view", v);
      if (v === "list") listDays = 30;
      anchor = selected;
      syncNavLabels();
      load();
    },
    { label: "View" },
  );
  viewSwitch.classList.add("cal-views");
  const scopeSel = select(
    [{ value: "firm", label: "Whole firm" }, ...users().map((u) => ({ value: u.id, label: u.id === state.me ? `${u.name} (you)` : u.name }))],
    scope,
    {
      "aria-label": "Whose calendar",
      id: "cal-scope",
      onchange: (e) => {
        scope = e.target.value;
        prefs.set("cal.scope", scope);
        load();
      },
    },
  );
  const tasksToggle = h(
    "label.toggle.cal-tasks-toggle",
    h("input", {
      type: "checkbox",
      role: "switch",
      checked: showTasks,
      onchange: (e) => {
        showTasks = e.target.checked;
        prefs.set("cal.tasks", showTasks ? "1" : "0");
        load();
      },
    }),
    h("span.toggle-track", { "aria-hidden": "true" }),
    "Task due dates",
  );

  const newEvent = (preset = {}) =>
    eventDialog(null, { attendees: scope !== "firm" ? [Number(scope)] : state.me ? [state.me] : [], ...preset }, () => load());

  const moreBtn = button("Import or subscribe", { iconRight: "chevron-down", "aria-haspopup": "menu" });
  moreBtn.addEventListener("click", () =>
    menu(
      moreBtn,
      [
        { label: "Import a calendar file", icon: "archive", hint: ".ics from Outlook, Google, Apple or a court notice", onSelect: () => importDialog(load) },
        { label: "Subscribe in Outlook, Google or Apple", icon: "calendar-days", hint: "A private link to Lawdesk events", onSelect: () => subscribeDialog() },
      ],
      "Import or subscribe",
      { align: "end" },
    ),
  );

  page.append(
    pageHeader({
      title: "Calendar",
      subtitle: "Hearings, court deadlines and meetings, with task due dates. Times are Central.",
      actions: [
        button("Deadline calculator", { icon: "deadlines", href: "#/deadlines" }),
        moreBtn,
        button("New event", { variant: "primary", icon: "plus", onclick: () => newEvent({ date: selected }) }),
      ],
    }),
    h(
      "section.card.card-v2.flush.cal-shell",
      { "aria-label": "Calendar" },
      h(
        "div.cal-toolbar",
        h("div.cal-nav", prevBtn, button("Today", { onclick: () => ((anchor = today()), (selected = today()), load()) }), nextBtn, titleEl),
        h("div.cal-filters", viewSwitch, scopeSel, tasksToggle),
      ),
      body,
      h("footer.card-footer.cal-legend-foot", legend()),
    ),
    below,
  );
  const onMedia = () => view === "week" && draw();
  phoneQuery.addEventListener("change", onMedia);
  window.addEventListener("hashchange", () => phoneQuery.removeEventListener("change", onMedia), { once: true });
  if (!state.matters.length) loadMatters().catch(() => {});
  await load();
  return page;
}

/** "9a", "1:30p" style compact times for chips and blocks. */
function shortClock(instant) {
  return clock(instant).replace(":00", "").replace(" AM", "am").replace(" PM", "pm");
}

function clockOfMinutes(m) {
  const hh = Math.floor(m / 60) % 24;
  return `${hh % 12 === 0 ? 12 : hh % 12} ${hh < 12 ? "AM" : "PM"}`;
}

/** Side-by-side lanes for overlapping timed events in one day column. */
function layLanes(items) {
  const sorted = items.slice().sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
  const out = [];
  let cluster = [];
  let clusterEnd = "";
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) out.push({ ...c, lanes });
    cluster = [];
  };
  for (const it of sorted) {
    if (cluster.length && it.start >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.it.end > it.start).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ it, lane });
    if (it.end > clusterEnd || cluster.length === 1) clusterEnd = it.end > clusterEnd ? it.end : clusterEnd;
  }
  if (cluster.length) flush();
  return out;
}

function legend() {
  return h(
    "div.cal-legend",
    { role: "list", "aria-label": "Key" },
    KINDS.map((k) => h("span.cal-legend-item", { role: "listitem" }, h("span.cal-dot" + `.k-${k.value}`), k.label)),
    h("span.cal-legend-item", { role: "listitem" }, h("span.cal-dot.is-task"), "Task due"),
    h("span.cal-legend-item", { role: "listitem" }, h("span.cal-legend-dbl"), "Double-booked"),
  );
}

// ---------------------------------------------------------------- import

function importDialog(onDone) {
  const file = h("input", { type: "file", accept: ".ics,text/calendar", required: true, name: "file" });
  const matter = select([{ value: "", label: "No matter" }, ...state.matters.map((m) => ({ value: m.id, label: matterLabel(m) }))], "");
  const kind = select([{ value: "", label: "Work it out from the file (default: meeting)" }, ...KINDS], "");
  const people = users().map((u) => h("label.check-line", h("input", { type: "checkbox", value: u.id, checked: u.id === state.me }), " ", u.name));
  const out = h("div.cal-import-result", { "aria-live": "polite" });
  const err = h("p.error-text", { role: "alert" });
  const go = h("button.btn.primary", { type: "submit" }, "Import");
  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const f = file.files?.[0];
        if (!f) return (err.textContent = "Choose a .ics file first.");
        if (f.size > 5_000_000) return (err.textContent = "That file is larger than 5 MB.");
        go.disabled = true;
        try {
          const text = await f.text();
          const r = await post("/calendar/import", {
            ics: text,
            matterId: matter.value ? Number(matter.value) : null,
            kind: kind.value || undefined,
            attendees: people.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => Number(c.value)),
          });
          replace(out,
            h("p", h("strong", `${plural(r.created.length, "event")} added, ${r.updated.length} updated, ${r.skipped.length} skipped.`)),
            r.skipped.length ? h("ul.small", r.skipped.slice(0, 10).map((s) => h("li", `${s.summary || s.uid || "An event"}: ${s.reason}`))) : null,
            r.warnings?.length ? h("ul.small.cal-warn-list", r.warnings.slice(0, 10).map((w) => h("li", w))) : null,
            h("p.muted.small", "Importing the same file again updates those events instead of adding copies."),
          );
          toast(`Imported ${plural(r.created.length + r.updated.length, "event")}`);
          onDone();
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          go.disabled = false;
        }
      },
    },
    h("p.muted", "Add events from a calendar file (.ics) exported from Outlook, Google Calendar, Apple Calendar or a court's e-filing notice. This is a one-time copy; later changes in the other calendar are not picked up."),
    h("label", "Calendar file", file),
    h("label", "Put the events on a matter (optional)", matter),
    h("label", "Type of event", kind),
    h("fieldset", h("legend", "Show them on these people's calendars"), people),
    out,
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Close"), go),
  );
  const dlg = modal("Import a calendar file", form, { wide: true });
  dlg.classList.add("cal-dialog");
}

// ------------------------------------------------------------- subscribe

// Steps checked against each vendor's help page in November 2026; sources in docs/calendar-subscribe.md.
const APPS = [
  {
    key: "outlook-web",
    label: "Outlook on the web / new Outlook",
    steps: ["Open Outlook and go to Calendar.", "Select Add calendar.", "Select Subscribe from web.", "Paste the link, give the calendar a name, then select Import."],
    note: "Microsoft says subscribed calendars usually refresh about every 3 hours, and sometimes take more than 24 hours.",
    source: "https://support.microsoft.com/en-us/office/import-or-subscribe-to-a-calendar-in-outlook-com-or-outlook-on-the-web-cff1429c-5af6-41ec-a5b4-74f2c278e98c",
    sourceLabel: "Microsoft Support: Import or subscribe to a calendar in Outlook.com or Outlook on the web",
  },
  {
    key: "outlook-classic",
    label: "Outlook for Windows (classic)",
    steps: ["Go to the Calendar.", "On the Home tab, in the Manage Calendars group, select Open Calendar.", "Select From Internet.", "Paste the link and select OK."],
    note: "If classic Outlook refuses the link, add it in Outlook on the web instead; it then appears in Outlook on your computer too.",
    source: "https://learn.microsoft.com/en-us/troubleshoot/outlook/calendaring/cannot-add-an-internet-calendar",
    sourceLabel: "Microsoft Learn: You can't add an Internet calendar in Outlook",
  },
  {
    key: "google",
    label: "Google Calendar",
    steps: ["On a computer, open Google Calendar (this cannot be done in the phone app).", "On the left, next to Other calendars, click Add other calendars, then From URL.", "Paste the link.", "Click Add calendar. It appears on the left under Other calendars."],
    note: "Google reads the link from its own servers, so it works only once Lawdesk is reachable from the internet.",
    source: "https://support.google.com/calendar/answer/37100",
    sourceLabel: "Google Calendar Help: Subscribe to someone's Google Calendar",
  },
  {
    key: "apple-mac",
    label: "Apple Calendar (Mac)",
    steps: ["Open Calendar.", "Choose File > New Calendar Subscription.", "Paste the link, then click Subscribe.", "Give it a name; under Location choose iCloud to see it on your iPhone too, or On My Mac for this computer only.", "Choose how often to refresh under Auto-refresh, then click OK."],
    source: "https://support.apple.com/guide/calendar/icl1022/mac",
    sourceLabel: "Apple Support: Subscribe to calendars on Mac",
  },
  {
    key: "apple-iphone",
    label: "iPhone or iPad",
    steps: ["Open the Calendar app and tap Calendars at the bottom of the screen.", "Tap Add Calendar, then Add Subscription Calendar.", "Paste the link and tap Subscribe."],
    source: "https://support.apple.com/guide/iphone/iph3d1110d4/ios",
    sourceLabel: "Apple Support: iPhone User Guide, set up multiple calendars",
  },
];

function subscribeDialog() {
  if (!state.me) return toast("Choose who you are first (User, top right).", { error: true });
  const list = h("div.cal-feeds");
  const created = h("div.cal-feed-new", { "aria-live": "polite" });
  const scope = select(
    [
      { value: "mine", label: "Only events I'm attending" },
      { value: "firm", label: "The whole firm's calendar" },
    ],
    "mine",
    { "aria-label": "What the link shows" },
  );
  const label = h("input", { maxlength: 200, placeholder: "e.g. Outlook on my laptop", "aria-label": "Name for this link" });
  let app = APPS[0].key;
  const steps = h("div.cal-steps");
  const tabs = APPS.map((a) =>
    h("button", { type: "button", dataset: { app: a.key }, "aria-pressed": String(a.key === app), onclick: () => ((app = a.key), drawSteps()) }, a.label),
  );
  function drawSteps() {
    const a = APPS.find((x) => x.key === app);
    tabs.forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.app === app)));
    replace(steps,
      h("ol", a.steps.map((s) => h("li", s))),
      a.note ? h("p.muted.small", a.note) : null,
      h("p.small.cal-source", "Source: ", h("a", { href: a.source, target: "_blank", rel: "noopener noreferrer" }, a.sourceLabel)),
    );
  }

  async function drawList() {
    try {
      const rows = await get(`/calendar/feed-tokens?user=${state.me}`);
      const active = rows.filter((r) => !r.revokedAt);
      replace(list,
        h("h3", "Your links"),
        active.length
          ? h(
              "ul.cal-feed-list",
              active.map((r) =>
                h(
                  "li",
                  h(
                    "div",
                    h("strong", r.label || (r.scope === "firm" ? "Whole firm" : "My events")),
                    h("div.muted.small", `${r.scope === "firm" ? "Whole firm" : "Events I'm attending"} · made ${fmtTime(r.createdAt)} · ${r.lastUsedAt ? "last read " + fmtTime(r.lastUsedAt) : "not used yet"}`),
                  ),
                  h(
                    "button.btn.small.danger-text",
                    {
                      type: "button",
                      onclick: async () => {
                        if (!confirm("Turn this link off? Any calendar subscribed with it will stop updating.")) return;
                        try {
                          await del(`/calendar/feed-tokens/${r.id}`);
                          toast("Link turned off");
                          drawList();
                        } catch (ex) {
                          toast(ex.message, { error: true });
                        }
                      },
                    },
                    "Turn off",
                  ),
                ),
              ),
            )
          : h("p.muted", "You have no active links."),
        rows.length > active.length ? h("p.muted.small", `${plural(rows.length - active.length, "link")} already turned off.`) : null,
      );
    } catch (ex) {
      replace(list, h("p.error-text", ex.message));
    }
  }

  const make = h(
    "form.cal-feed-form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const r = await post("/calendar/feed-tokens", { userId: state.me, scope: scope.value, label: label.value || null });
          const url = location.origin + r.url;
          const box = h("input.cal-feed-url", { readonly: true, value: url, "aria-label": "Private calendar link", onfocus: (ev) => ev.target.select() });
          replace(created,
            h("p", h("strong", "Your private link is ready. Copy it now: it is shown only once.")),
            h(
              "div.cal-copy",
              box,
              h(
                "button.btn.primary",
                {
                  type: "button",
                  onclick: async () => {
                    try {
                      await navigator.clipboard.writeText(url);
                      toast("Link copied");
                    } catch {
                      box.select();
                      toast("Press Ctrl+C (or Cmd+C) to copy");
                    }
                  },
                },
                "Copy link",
              ),
            ),
            h("p.muted.small", "Anyone who has this link can see the events in it. Don't email it or paste it anywhere shared. If it gets out, turn it off below and make a new one."),
          );
          label.value = "";
          drawList();
        } catch (ex) {
          toast(ex.message, { error: true });
        }
      },
    },
    h("label", "What it shows", scope),
    h("label", "Name (to recognise it later)", label),
    h("button.btn.primary", { type: "submit" }, "Make a private link"),
  );

  const dlg = modal(
    "Subscribe in Outlook, Google or Apple",
    h(
      "div.modal-body.cal-subscribe",
      h("p", `Make a private link for ${userName(state.me)}'s Lawdesk calendar, then add it to your calendar app. The app checks the link for changes on its own schedule; it shows Lawdesk events but cannot change them.`),
      location.hostname === "localhost" || location.hostname === "127.0.0.1"
        ? callout({ tone: "info", title: "Running on this computer only", body: "Outlook on the web and Google cannot reach the link yet. Apple Calendar or classic Outlook on this same computer can. The link will work everywhere once Lawdesk is hosted." })
        : null,
      make,
      created,
      h("h3", "How to add it"),
      h("div.segmented.cal-app-tabs", { role: "group", "aria-label": "Calendar app" }, tabs),
      steps,
      list,
    ),
    { wide: true },
  );
  dlg.classList.add("cal-dialog");
  drawSteps();
  drawList();
}

