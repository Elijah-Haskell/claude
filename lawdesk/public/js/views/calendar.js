// Calendar: month, week and list views of the firm's events and task due dates, for the
// whole firm or one person; new/edit event dialogs; .ics import; private feed links for
// Outlook, Google and Apple.

import { h, replace, select, modal, toast, addDays, weekday, fmtTime, plural } from "../dom.js";
import { get, post, del } from "../api.js";
import { state, today, users, userName, prefs, loadMatters } from "../state.js";
import { KINDS, clock, eventDialog, itemDialog, itemLine, kindLabel, longDate, matterLabel, minutesOfDay, monthName, dayName } from "../cal.js";

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_PX = 44;
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
  let data = null;
  let seq = 0;

  const titleEl = h("h2.cal-range", { "aria-live": "polite" });
  const body = h("div.cal-body");

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
      replace(body, h("p.error-box", ex.message));
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
    if (view === "month") replace(body, drawMonth());
    else if (view === "week") replace(body, phoneQuery.matches ? drawDayList(range().from, 7, true) : drawWeek());
    else replace(body, drawList());
    viewButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  }

  // ----------------------------------------------------------------- month
  function chip(it) {
    const isTask = it.type === "task";
    return h(
      "button.cal-chip" + (isTask ? ".is-task" : `.k-${it.kind}`) + (it.conflict ? ".is-conflict" : ""),
      {
        type: "button",
        title: `${isTask ? "Task due" : kindLabel(it.kind)}: ${it.title}${it.matter ? " · " + matterLabel(it.matter) : ""}`,
        onclick: (e) => (e.stopPropagation(), itemDialog(it, load)),
      },
      isTask ? h("span.cal-box", { "aria-hidden": "true" }) : !it.allDay ? h("span.cal-chip-time", clock(it.start).replace(":00", "").replace(" ", "").toLowerCase()) : null,
      h("span.cal-chip-text", it.title),
    );
  }

  function drawMonth() {
    const { from } = range();
    const map = byDate();
    const month = anchor.slice(0, 7);
    const grid = h("div.cal-month", { role: "grid", "aria-label": rangeTitle() });
    grid.append(h("div.cal-row.cal-head", { role: "row" }, SHORT_DAYS.map((d, i) => h("div.cal-hd", { role: "columnheader", "aria-label": dayName(addDays(from, i)) }, d))));
    for (let w = 0; w < 6; w++) {
      const row = h("div.cal-row", { role: "row" });
      for (let i = 0; i < 7; i++) {
        const d = addDays(from, w * 7 + i);
        const items = map.get(d) ?? [];
        const max = 3;
        const cell = h(
          "div.cal-cell" + (d.slice(0, 7) !== month ? ".other" : "") + (d === today() ? ".today" : "") + (d === selected ? ".selected" : ""),
          { role: "gridcell", dataset: { date: d }, onclick: () => selectDay(d) },
          h("button.cal-daynum", { type: "button", "aria-label": `${longDate(d)}, ${plural(items.length, "item")}`, onclick: (e) => (e.stopPropagation(), selectDay(d)) }, String(Number(d.slice(8, 10)))),
          h("div.cal-chips", items.slice(0, max).map(chip)),
          items.length > max ? h("button.cal-more", { type: "button", onclick: (e) => (e.stopPropagation(), selectDay(d)) }, `${items.length - max} more`) : null,
          items.length ? h("div.cal-dots", { "aria-hidden": "true" }, items.slice(0, 4).map((it) => h("span.cal-dot" + (it.type === "task" ? ".is-task" : `.k-${it.kind}`)))) : null,
        );
        row.append(cell);
      }
      grid.append(row);
    }
    return h("div", grid, dayPanel(selected, map.get(selected) ?? []));
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
    return h(
      "section.card.cal-daypanel",
      h("div.cal-daypanel-head", h("h3", longDate(d)), h("button.btn.small", { type: "button", onclick: () => newEvent({ date: d }) }, "Add event on this day")),
      items.length ? h("ul.cal-lines", sortDay(items).map((it) => itemLine(it, load))) : h("p.muted", "Nothing on the calendar."),
    );
  }

  const sortDay = (items) => items.slice().sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.start || "").localeCompare(b.start || "") || (a.type === b.type ? 0 : a.type === "event" ? -1 : 1));

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
    const allDayRow = h(
      "div.cal-week-allday",
      h("div.cal-gutter.small.muted", "All day"),
      days.map((d) => h("div.cal-week-allcell", (map.get(d) ?? []).filter((it) => it.type === "task" || it.allDay).map(chip))),
    );
    const gutter = h("div.cal-gutter.cal-hours");
    gutter.style.height = height + "px";
    for (let m = lo; m < hi; m += 60) {
      const lab = h("span.cal-hour", clockOfMinutes(m));
      lab.style.top = ((m - lo) / 60) * HOUR_PX + "px";
      gutter.append(lab);
    }
    const cols = days.map((d) => {
      const col = h("div.cal-week-col" + (d === today() ? ".today" : ""), { "aria-label": longDate(d) });
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
        const block = h(
          "button.cal-block" + `.k-${it.kind}` + (it.conflict ? ".is-conflict" : ""),
          { type: "button", onclick: () => itemDialog(it, load), title: `${clock(it.start)}${it.start === it.end ? "" : " – " + clock(it.end)}: ${it.title}` },
          h("span.cal-block-title", it.title),
          " ",
          h("span.cal-block-time", clock(it.start)),
          it.location && e - s >= 60 ? h("span.cal-block-loc", it.location) : null,
        );
        block.style.top = ((s - lo) / 60) * HOUR_PX + "px";
        block.style.height = Math.max(22, ((e - s) / 60) * HOUR_PX - 2) + "px";
        block.style.left = `calc(${(lane / lanes) * 100}% + 2px)`;
        block.style.width = `calc(${100 / lanes}% - 4px)`;
        col.append(block);
      }
      return col;
    });
    return h("div.cal-week", head, allDayRow, h("div.cal-week-grid", gutter, cols));
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
          h("h3.cal-list-date", h("span", longDate(d)), d === today() ? h("span.tag", "Today") : null),
          items.length ? h("ul.cal-lines", sortDay(items).map((it) => itemLine(it, load))) : h("p.muted.small", "Nothing scheduled."),
        ),
      );
    }
    if (!any) out.append(h("p.empty-big", h("p", "Nothing on the calendar in these dates.")));
    return out;
  }

  function drawList() {
    return h(
      "div",
      drawDayList(anchor, listDays, false),
      h(
        "div.cal-list-more",
        h("button.btn", { type: "button", onclick: () => ((listDays += 30), load()) }, "Show the next 30 days"),
      ),
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
  const viewButtons = [
    ["month", "Month"],
    ["week", "Week"],
    ["list", "List"],
  ].map(([v, label]) =>
    h(
      "button",
      {
        type: "button",
        dataset: { view: v },
        "aria-pressed": String(view === v),
        onclick: () => {
          view = v;
          prefs.set("cal.view", v);
          if (v === "list") listDays = 30;
          anchor = selected;
          load();
        },
      },
      label,
    ),
  );
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
      checked: showTasks,
      onchange: (e) => {
        showTasks = e.target.checked;
        prefs.set("cal.tasks", showTasks ? "1" : "0");
        load();
      },
    }),
    " Show task due dates",
  );

  const newEvent = (preset = {}) =>
    eventDialog(null, { attendees: scope !== "firm" ? [Number(scope)] : state.me ? [state.me] : [], ...preset }, () => load());

  page.append(
    h(
      "div.page-head",
      h("div", h("h1", "Calendar"), h("p.sub", "Hearings, deadlines and meetings, with task due dates. Times are Central.")),
      h(
        "div.head-actions",
        h("button.btn", { type: "button", onclick: () => importDialog(load) }, "Import a calendar file"),
        h("button.btn", { type: "button", onclick: () => subscribeDialog() }, "Subscribe in Outlook, Google or Apple"),
        h("a.btn", { href: "#/deadlines" }, "Court deadline calculator"),
        h("button.btn.primary", { type: "button", onclick: () => newEvent({ date: selected }) }, "New event"),
      ),
    ),
    h(
      "div.cal-toolbar",
      h(
        "div.cal-nav",
        h("button.btn", { type: "button", onclick: () => move(-1), "aria-label": "Previous" }, "‹"),
        h("button.btn", { type: "button", onclick: () => ((anchor = today()), (selected = today()), load()) }, "Today"),
        h("button.btn", { type: "button", onclick: () => move(1), "aria-label": "Next" }, "›"),
        titleEl,
      ),
      h("div.cal-filters", h("div.segmented", { role: "group", "aria-label": "View" }, viewButtons), scopeSel, tasksToggle),
    ),
    body,
    legend(),
  );
  const onMedia = () => view === "week" && draw();
  phoneQuery.addEventListener("change", onMedia);
  window.addEventListener("hashchange", () => phoneQuery.removeEventListener("change", onMedia), { once: true });
  if (!state.matters.length) loadMatters().catch(() => {});
  await load();
  return page;
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
    { "aria-label": "Key" },
    KINDS.map((k) => h("span.cal-legend-item", h("span.cal-dot" + `.k-${k.value}`), k.label)),
    h("span.cal-legend-item", h("span.cal-box"), "Task due"),
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
      h("p.small", "Source: ", h("a", { href: a.source, target: "_blank", rel: "noopener noreferrer" }, a.sourceLabel)),
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
        ? h("p.cal-info", "Lawdesk is running on this computer only, so Outlook on the web and Google cannot reach the link yet. Apple Calendar or classic Outlook on this same computer can. The link will work everywhere once Lawdesk is hosted.")
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

