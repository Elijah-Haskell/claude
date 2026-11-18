// Time: the current user's entries one week at a time, with quick entry and the timer.

import { h, replace, toast, addDays, fmtDate, plural } from "../dom.js";
import { get, post, del } from "../api.js";
import { state, today, prefs } from "../state.js";
import { hours, weekStart, clock } from "./format.js";
import { billingPage, allMatters, matterSelect, matterLabel, readHours, logTimeDialog, fail } from "./ui.js";
import { startTimer, resumeTimer, stopTimer, runningEntry, onTimerChange, elapsedMs, refreshTimer } from "./timer.js";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export async function timeView(_m, ctx) {
  const now = today();
  let week = weekStart(now);
  const matters = await allMatters(true);
  const page = billingPage("#/billing/time", "Time", "Your time entries, one week at a time.");

  // ------------------------------------------------------------ quick entry
  const lastMatter = prefs.get("billing.lastMatter", "");
  const matter = matterSelect(matters, lastMatter, { "aria-label": "Matter", id: "qt-matter" });
  const date = h("input", { type: "date", value: now, "aria-label": "Date", id: "qt-date" });
  const hrs = h("input.bl-hours", { inputmode: "decimal", autocomplete: "off", placeholder: "1.5 or 1:30", "aria-label": "Hours", id: "qt-hours" });
  const desc = h("input.bl-desc", { maxlength: 4000, placeholder: "Description, as the client should read it", "aria-label": "Description", id: "qt-desc" });
  const billable = h("input", { type: "checkbox", checked: true, id: "qt-billable" });
  const err = h("p.error-text", { role: "alert" });

  const readQuick = () => {
    if (!matter.value) throw new Error("Choose the matter this time is for");
    prefs.set("billing.lastMatter", matter.value);
    return { matterId: Number(matter.value), date: date.value || now, description: desc.value, billable: billable.checked };
  };
  const quick = h(
    "form.card.bl-quick",
    {
      "aria-label": "Add time",
      onsubmit: async (e) => {
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
      },
    },
    h("h2", "Add time"),
    h(
      "div.bl-quick-row",
      h("label.bl-q-matter", h("span", "Matter"), matter),
      h("label.bl-q-date", h("span", "Date"), date),
      h("label.bl-q-hours", h("span", "Hours"), hrs),
      h("label.bl-q-desc", h("span", "Description"), desc),
    ),
    h(
      "div.bl-quick-foot",
      h("label.check-line", billable, " Billable"),
      h("span.muted.small", "Hours can be typed as 1.5 or 1:30."),
      h(
        "div.bl-quick-buttons",
        h(
          "button.btn",
          {
            type: "button",
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
          },
          "Start timer",
        ),
        h("button.btn.primary", { type: "submit" }, "Add time"),
      ),
    ),
    err,
  );

  // ------------------------------------------------------------------ week
  const weekBox = h("div.bl-week");
  const weekHead = h("div.bl-week-head");
  const timerCard = h("div");

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
        h("div", h("div.bl-running-label", "Timer running"), c),
        h(
          "div.bl-running-what",
          h("strong", matterLabel({ name: run.matter_name, number: run.matter_number })),
          run.description ? h("div.muted", run.description) : null,
        ),
        h("button.btn.primary", { type: "button", onclick: () => stopTimer(run.id).then(() => (toast("Timer stopped"), load()), fail) }, "Stop timer"),
      ),
    );
  }

  function draw(rows) {
    const total = rows.reduce((s, r) => s + r.minutes, 0);
    const bill = rows.filter((r) => r.billable).reduce((s, r) => s + r.minutes, 0);
    const thisWeek = week === weekStart(now);
    replace(
      weekHead,
      h(
        "div.bl-week-nav",
        h("button.btn.small", { type: "button", "aria-label": "Previous week", onclick: () => ((week = addDays(week, -7)), load()) }, "‹ Previous"),
        h("h2.bl-week-title", `Week of ${fmtDate(week, now)}`),
        h("button.btn.small", { type: "button", "aria-label": "Next week", onclick: () => ((week = addDays(week, 7)), load()) }, "Next ›"),
        thisWeek ? null : h("button.btn.small", { type: "button", onclick: () => ((week = weekStart(now)), load()) }, "This week"),
      ),
      h(
        "div.bl-week-totals",
        h("span", h("strong", hours(total)), " hours"),
        h("span", h("strong", hours(bill)), " billable"),
        total - bill ? h("span", h("strong", hours(total - bill)), " not billable") : null,
      ),
    );
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(week, i);
      const list = rows.filter((r) => r.date === d);
      if (!list.length && (i >= 5 || d > now)) continue;
      const sum = list.reduce((s, r) => s + r.minutes, 0);
      days.push(
        h(
          "section.bl-day" + (d === now ? ".is-today" : ""),
          h(
            "h3.bl-day-title",
            h("span", DAY_NAMES[i], h("span.muted", ` ${fmtDate(d, now).slice(4)}`)),
            h("span.bl-day-sum", list.length ? `${hours(sum)} h` : ""),
          ),
          list.length ? h("ul.bl-entries", list.map(entryRow)) : h("p.empty.small", d === now ? "Nothing logged yet today." : "No time logged."),
        ),
      );
    }
    replace(weekBox, ...(days.length ? days : [h("p.empty", "No time logged this week.")]));
  }

  function entryRow(r) {
    const running = !!r.timer_started_at;
    const locked = r.invoice_id != null;
    const billed = r.invoice_status === "final";
    return h(
      "li.bl-entry" + (running ? ".running" : "") + (r.billable ? "" : ".nonbill"),
      { dataset: { id: r.id } },
      h("div.bl-entry-hours", running ? "Running" : hours(r.minutes)),
      h(
        "div.bl-entry-main",
        h(
          "a.bl-entry-matter",
          { href: `#/matters/${r.matter_id}` },
          matterLabel({ name: r.matter_name, number: matters.find((m) => m.id === r.matter_id)?.number }),
        ),
        h("div.bl-entry-desc", r.description || h("span.muted", "No description")),
        h(
          "div.bl-entry-flags",
          r.billable ? null : h("span.bl-flag", "Not billable"),
          billed ? h("span.bl-flag.billed", `Billed on invoice ${r.invoice_number}`) : locked ? h("span.bl-flag", "On a draft invoice") : null,
          r.task_id ? h("span.bl-flag", "Linked to a task") : null,
        ),
      ),
      h(
        "div.bl-entry-actions",
        locked
          ? null
          : running
            ? h("button.btn.small", { type: "button", onclick: () => stopTimer(r.id).then(load, fail) }, "Stop")
            : h(
                "button.btn.small",
                { type: "button", title: "Continue timing this entry", onclick: () => resumeTimer(r.id).then(() => (toast("Timer resumed"), load()), fail) },
                "Resume",
              ),
        locked ? null : h("button.btn.small", { type: "button", onclick: () => logTimeDialog({ entry: r, onSaved: load }) }, "Edit"),
        locked
          ? null
          : h(
              "button.btn.small.danger-text",
              {
                type: "button",
                onclick: async () => {
                  if (!confirm(`Delete this ${hours(r.minutes)} hour entry? This can't be undone.`)) return;
                  try {
                    await del(`/billing/time/${r.id}`);
                    toast("Time entry deleted");
                    await refreshTimer();
                    load();
                  } catch (ex) {
                    fail(ex);
                  }
                },
              },
              "Delete",
            ),
      ),
    );
  }

  const live = () => !ctx || ctx.isCurrent();
  const off = onTimerChange(() => (live() ? load() : off()));
  const onChanged = () => (live() ? load() : window.removeEventListener("lawdesk:time-changed", onChanged));
  window.addEventListener("lawdesk:time-changed", onChanged);

  page.append(timerCard, quick, h("section.card.bl-week-card", weekHead, weekBox));
  await load();
  return page;
}

export { plural };
