// The running timer. Timers live on the server (a time entry with timer_started_at),
// so one started on any page keeps running while you move around the app, and after a
// reload. The header shows it with a Stop button wherever you are.

import { h, replace } from "../dom.js";
import { get, post } from "../api.js";
import { state } from "../state.js";
import { clock } from "./format.js";

let running = null; // the running entry for the current user, or null
let tick = null;
const box = h("div.bl-timer", { hidden: true, role: "status", "aria-live": "off" });
const listeners = new Set();

/** Milliseconds on a running entry: minutes already logged plus time since it started. */
export function elapsedMs(entry, now = Date.now()) {
  if (!entry) return 0;
  const since = entry.timer_started_at ? Math.max(0, now - Date.parse(entry.timer_started_at)) : 0;
  return entry.minutes * 60_000 + since;
}

export function runningEntry() {
  return running;
}

/** Called with the running entry (or null) whenever it changes. Returns an unsubscribe. */
export function onTimerChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function draw() {
  if (!running) {
    box.hidden = true;
    replace(box);
    return;
  }
  box.hidden = false;
  const label = running.matter_number || running.matter_name || "Timer";
  replace(
    box,
    h("span.bl-timer-dot", { "aria-hidden": "true" }),
    h(
      "a.bl-timer-text",
      { href: "#/billing/time", title: `Timer running on ${label}${running.description ? `: ${running.description}` : ""}` },
      h("span.bl-timer-clock", clock(elapsedMs(running))),
      h("span.bl-timer-matter", label),
    ),
    h("button.bl-timer-stop", { type: "button", onclick: () => stopTimer(running.id) }, "Stop"),
  );
}

function setRunning(entry) {
  running = entry || null;
  clearInterval(tick);
  tick = running
    ? setInterval(() => {
        const c = box.querySelector(".bl-timer-clock");
        if (c && running) c.textContent = clock(elapsedMs(running));
      }, 1000)
    : null;
  draw();
  for (const fn of listeners) fn(running);
}

/** Reload the current user's running timer from the server. */
export async function refreshTimer() {
  if (!state.me) return setRunning(null);
  try {
    const list = await get(`/billing/timers?userId=${state.me}`);
    setRunning(list[0] || null);
  } catch {
    /* the header timer is a convenience; leave it as it was */
  }
}

export async function startTimer(input) {
  const e = await post("/billing/timers", { ...input, userId: state.me });
  await refreshTimer();
  return e;
}

export async function resumeTimer(entryId) {
  const e = await post(`/billing/time/${entryId}/start`);
  await refreshTimer();
  return e;
}

export async function stopTimer(entryId) {
  const e = await post(`/billing/time/${entryId}/stop`);
  await refreshTimer();
  window.dispatchEvent(new CustomEvent("lawdesk:time-changed"));
  return e;
}

/** The header element. app.js puts it in the top bar once. */
export function timerBox() {
  refreshTimer();
  window.addEventListener("hashchange", refreshTimer);
  window.addEventListener("lawdesk:me", refreshTimer);
  return box;
}
