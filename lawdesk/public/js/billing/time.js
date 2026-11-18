// Time: the current user's entries one week at a time, with quick entry and the timer.

import { h, replace, toast, addDays, fmtDate, plural } from "../dom.js";
import { get, post, del } from "../api.js";
import { state, today, prefs } from "../state.js";
import { hours, weekStart, clock } from "./format.js";
import { billingPage, allMatters, matterSelect, readHours, logTimeDialog, confirmDialog, fail } from "./ui.js";
import { startTimer, resumeTimer, stopTimer, runningEntry, onTimerChange, elapsedMs, refreshTimer } from "./timer.js";
import { card, field, button, iconButton, pill, stat, emptyState } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { menu } from "../ui/popover.js";
import { icon } from "../ui/icons.js";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export async function timeView(_m, ctx) {
  const now = today();
  let week = weekStart(now);
  const matters = await allMatters(true);
  const page = billingPage("#/billing/time", "Time", "Your time entries, one week at a time.");

  // ------------------------------------------------------------ quick entry
  const lastMatter = prefs.get("billing.lastMatter", "");
  const matter = matterSelect(matters, lastMatter, { id: "qt-matter" });
  const date = h("input", { type: "date", value: now, id: "qt-date" });
  const hrs = h("input.bl-hours", { inputmode: "decimal", autocomplete: "off", placeholder: "1.5 or 1:30", id: "qt-hours" });
  const desc = h("input.bl-desc", { maxlength: 4000, placeholder: "What was done, as the client should read it", id: "qt-desc" });
  const billable = h("input", { type: "checkbox", checked: true, id: "qt-billable" });
  const err = h("p.error-text", { role: "alert" });

  const readQuick = () => {
    if (!matter.value) throw new Error("Choose the matter this time is for");
    prefs.set("billing.lastMatter", matter.value);
    return { matterId: Number(matter.value), date: date.value || now, description: desc.value, billable: billable.checked };
  };
  const timerBtn = button("Start timer", {
    icon: "clock",
    id: "qt-timer",
    onclick: async () => {
      err.textContent = "";
      try {
        const body = readQuick();
        const typed = hrs.value.trim() ? readHours(hrs) : 0;
        await startTimer({ ...body, minutes: typed });
        toast("Timer started. It keeps running while you use the rest of Lawdesk.");
        hrs.value = "";
        desc.value = "";
        await load();
      } catch (ex) {
        err.textContent = ex.message;
      }
    },
  });
  const quick = card({
    tag: "form",
    className: "bl-quick",
    title: "Add time",
    subtitle: "Type hours as 1.5 or 1:30, or start a timer and stop it when you're done.",
    icon: "plus",
    body: [
      h(
        "div.bl-quick-row",
        field("Matter", matter, { className: "bl-q-matter" }),
        field("Date", date, { className: "bl-q-date" }),
        field("Hours", hrs, { className: "bl-q-hours" }),
        field("Description", desc, { className: "bl-q-desc" }),
      ),
      err,
    ],
    footer: h(
      "div.bl-quick-foot",
      h("label.check-line", billable, h("span", "Billable to the client")),
      h("div.bl-quick-buttons", timerBtn, button("Add time", { variant: "primary", type: "submit", icon: "plus" })),
    ),
  });
  quick.setAttribute("aria-label", "Add time");
  quick.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      const body = { ...readQuick(), minutes: readHours(hrs) };
      await post("/billing/time", body);
      toast(`Logged ${hours(body.minutes)} hours`);
      hrs.value = "";
      desc.value = "";
      if (weekStart(body.date) !== week) week = weekStart(body.date);
      await load();
      hrs.focus();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  // ------------------------------------------------------------------ week
  const timerCard = h("div.bl-running-slot");
  const stats = h("div.stats.bl-week-stats");
  const weekTitle = h("span");
  const weekNav = h("div.bl-week-nav");

  const dayOrder = []; // day headings in date order, refilled on each draw
  const table = dataTable({
    columns: [
      {
        key: "hours",
        label: "Hours",
        align: "right",
        className: "bl-entry-hours nowrap",
        render: (r) => (r.timer_started_at ? pill("Running", "warning") : hours(r.minutes)),
      },
      { key: "what", label: "Work", primary: true, className: "bl-entry-main", render: entryMain },
      { key: "actions", label: "", phoneLabel: "", className: "bl-entry-actions", render: entryActions },
    ],
    rows: [],
    toolbar: false,
    sortable: false,
    label: "Time entries this week",
    noun: ["entry", "entries"],
    tableClass: "bl-time-table",
    rowClass: (r) => ["bl-entry", r.timer_started_at ? "running" : "", r.billable ? "" : "nonbill"].join(" "),
    groupBy: (r) => r.day,
    groupOrder: dayOrder,
    pageSize: 500,
    empty: () =>
      emptyState({
        icon: "clock",
        title: "No time logged this week",
        body: week === weekStart(now) ? "Time you add above, or log from a task or a matter, appears here day by day." : "Nothing was logged in this week.",
        compact: true,
      }),
  });
  const weekCard = card({
    className: "bl-week-card",
    flush: true,
    title: weekTitle,
    icon: "calendar-days",
    actions: weekNav,
    body: table,
  });

  async function load() {
    const to = addDays(week, 6);
    const rows = await get(`/billing/time?userId=${state.me}&from=${week}&to=${to}`);
    if (ctx && !ctx.isCurrent()) return;
    draw(rows);
    drawTimer(runningEntry());
  }

  function drawTimer(run) {
    if (!run) return replace(timerCard);
    const c = h("span.bl-big-clock", clock(elapsedMs(run)));
    const t = setInterval(() => (document.contains(c) ? (c.textContent = clock(elapsedMs(run))) : clearInterval(t)), 1000);
    replace(
      timerCard,
      h(
        "section.card.bl-running",
        { "aria-label": "Running timer" },
        h("span.bl-running-dot", { "aria-hidden": "true" }),
        h("div.bl-running-time", h("span.bl-running-label", "Timer running"), c),
        h(
          "div.bl-running-what",
          h("span.bl-running-matter", run.matter_number ? h("span.matter-num", run.matter_number) : null, " ", run.matter_name || ""),
          run.description ? h("span.bl-running-desc", run.description) : null,
        ),
        button("Stop timer", { variant: "primary", onclick: () => stopTimer(run.id).then(() => (toast("Timer stopped"), load()), fail) }),
      ),
    );
  }

  function draw(rows) {
    const total = rows.reduce((s, r) => s + r.minutes, 0);
    const bill = rows.filter((r) => r.billable).reduce((s, r) => s + r.minutes, 0);
    const todays = rows.filter((r) => r.date === now).reduce((s, r) => s + r.minutes, 0);
    const thisWeek = week === weekStart(now);
    weekTitle.textContent = `Week of ${fmtDate(week, now)}`;
    replace(
      weekNav,
      iconButton("chevron-left", "Previous week", { size: "sm", onclick: () => ((week = addDays(week, -7)), load()) }),
      thisWeek ? null : button("This week", { size: "sm", variant: "ghost", onclick: () => ((week = weekStart(now)), load()) }),
      iconButton("chevron-right", "Next week", { size: "sm", onclick: () => ((week = addDays(week, 7)), load()) }),
    );
    replace(
      stats,
      stat({ label: thisWeek ? "This week" : "That week", value: `${hours(total)} h`, icon: "clock", hint: plural(rows.length, "entry", "entries") }),
      stat({
        label: "Billable",
        value: `${hours(bill)} h`,
        icon: "receipt",
        hint: total ? `${Math.round((bill / total) * 100)}% of the week` : "Nothing logged",
      }),
      stat({ label: "Not billable", value: `${hours(total - bill)} h`, icon: "circle-dot", hint: "Kept for the firm's records" }),
      thisWeek ? stat({ label: "Today", value: `${hours(todays)} h`, icon: "sun", tone: todays ? "info" : null, hint: fmtDate(now, now) }) : null,
    );
    // Day headings say the weekday and the day's total.
    const sums = new Map();
    for (const r of rows) sums.set(r.date, (sums.get(r.date) || 0) + r.minutes);
    const label = (d) => {
      const i = (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7;
      return `${DAY_NAMES[i]} ${fmtDate(d, now).slice(4)}${d === now ? " (today)" : ""} · ${hours(sums.get(d))} hours`;
    };
    dayOrder.splice(0, dayOrder.length, ...[...sums.keys()].sort().map(label));
    table.setRows(rows.map((r) => ({ ...r, day: label(r.date) })));
  }

  function entryMain(r) {
    const locked = r.invoice_id != null;
    const billed = r.invoice_status === "final";
    const num = r.matter_number ?? matters.find((m) => m.id === r.matter_id)?.number;
    return h(
      "div.cell-stack",
      h("span.bl-entry-desc", r.description || h("span.muted", "No description")),
      h("span.cell-sub.bl-entry-matter", h("a", { href: `#/matters/${r.matter_id}` }, num ? h("span.matter-num", num) : null, " ", r.matter_name || "")),
      !r.billable || locked || r.task_id
        ? h(
            "span.bl-entry-flags",
            r.billable ? null : pill("Not billable", "neutral", { dot: false }),
            billed
              ? pill(`Billed on invoice ${r.invoice_number}`, "success", { dot: false })
              : locked
                ? pill("On a draft invoice", "info", { dot: false })
                : null,
            r.task_id ? pill("Linked to a task", "neutral", { dot: false }) : null,
          )
        : null,
    );
  }

  function entryActions(r) {
    const running = !!r.timer_started_at;
    if (r.invoice_id != null) return h("span.bl-locked", { title: "On an invoice, so it can't be changed here" }, icon("lock", { size: 14 }));
    return h(
      "div.bl-row-actions",
      running
        ? button("Stop", { size: "sm", onclick: () => stopTimer(r.id).then(load, fail) })
        : button("Resume", {
            size: "sm",
            variant: "ghost",
            icon: "clock",
            title: "Continue timing this entry",
            onclick: () => resumeTimer(r.id).then(() => (toast("Timer resumed"), load()), fail),
          }),
      iconButton("ellipsis", "More actions for this entry", {
        size: "sm",
        "aria-haspopup": "menu",
        onclick: (e) =>
          menu(
            e.currentTarget,
            [
              { label: "Edit", icon: "pencil", onSelect: () => logTimeDialog({ entry: r, onSaved: load }) },
              "-",
              { label: "Delete", icon: "trash-2", danger: true, onSelect: () => deleteEntry(r) },
            ],
            "Time entry",
          ),
      }),
    );
  }

  async function deleteEntry(r) {
    const ok = await confirmDialog(
      "Delete this time entry?",
      [`${hours(r.minutes)} hours on ${fmtDate(r.date, now)}: ${r.description || "no description"}.`, "This can't be undone."],
      {
        confirmLabel: "Delete entry",
        danger: true,
      },
    );
    if (!ok) return;
    try {
      await del(`/billing/time/${r.id}`);
      toast("Time entry deleted");
      await refreshTimer();
      load();
    } catch (ex) {
      fail(ex);
    }
  }

  const live = () => !ctx || ctx.isCurrent();
  const off = onTimerChange(() => (live() ? load() : off()));
  const onChanged = () => (live() ? load() : window.removeEventListener("lawdesk:time-changed", onChanged));
  window.addEventListener("lawdesk:time-changed", onChanged);

  page.append(h("div.bl-stack", timerCard, quick, stats, weekCard));
  await load();
  return page;
}

export { plural };
