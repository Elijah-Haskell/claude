// The task row and the things you do to a task: finish (with undo), change the due date
// or the person inline, rename, skip, delete, and quick-add. Shared by My tasks, Firm
// tasks and the matter page.

import { h, append, clear, replace, fmtDate, relDate, daysBetween, addDays, weekday, toast, plural } from "./dom.js";
import { post, patch, del } from "./api.js";
import { state, today, users, dateFieldLabel, loadMatters } from "./state.js";
import { parseQuickAdd } from "./quickadd.js";
import { logTimeDialog } from "./billing/ui.js";
import { icon } from "./ui/icons.js";
import { avatar } from "./ui/components.js";
import { popover, closePopover, menu } from "./ui/popover.js";

// --------------------------------------------------------------- explaining dates

function days(n, business) {
  const a = Math.abs(n);
  return `${a} ${business ? "business " : ""}day${a === 1 ? "" : "s"}`;
}

/** Plain-English due-date rule of a task, e.g. "2 business days before Closing date". */
export function ruleText(t, depTitles = []) {
  if (t.anchor === "manual" || t.offset_days == null) return null;
  const b = !!t.business_days;
  if (t.anchor === "applied") return t.offset_days === 0 ? "the day the checklist was added" : `${days(t.offset_days, b)} after the checklist was added`;
  if (t.anchor === "after_deps") {
    const what = depTitles.length ? depTitles.map((x) => `“${x}”`).join(" and ") : "the tasks before it";
    return t.offset_days === 0 ? `the day ${what} ${depTitles.length > 1 ? "are" : "is"} done` : `${days(t.offset_days, b)} after ${what} ${depTitles.length > 1 ? "are" : "is"} done`;
  }
  if (String(t.anchor).startsWith("field:")) {
    const label = dateFieldLabel(t.anchor.slice(6));
    if (t.offset_days === 0) return `on the ${label}`;
    return `${days(t.offset_days, b)} ${t.offset_days < 0 ? "before" : "after"} the ${label}`;
  }
  return null;
}

/** Why a task has the date it has (or has none). */
export function dueExplain(t, depTitles = []) {
  const rule = ruleText(t, depTitles);
  if (t.due_locked) return rule ? `Date typed in by hand. The checklist rule would be: ${rule}.` : "Date set manually.";
  if (!rule) return t.due_date ? "Date set manually." : "No due date.";
  if (t.due_date) return `Due ${rule}.`;
  if (t.anchor === "after_deps") return `No date yet. It will be due ${rule}.`;
  if (String(t.anchor).startsWith("field:")) return `No date yet: set the ${dateFieldLabel(t.anchor.slice(6))} on the matter. Rule: ${rule}.`;
  return `Due ${rule}.`;
}

/** "due today", "due tomorrow", "3 days late", "due Tue Nov 24". */
function dueWords(d) {
  const r = relDate(d, today());
  if (/late$/.test(r)) return r;
  return "due " + (/^(Today|Tomorrow|Yesterday)$/.test(r) ? r.toLowerCase() : r);
}

function dueClass(t) {
  if (!t.due_date || t.status === "done" || t.status === "skipped") return "";
  const n = daysBetween(today(), t.due_date);
  if (n < 0) return "late";
  if (n === 0) return "today";
  if (n <= 2) return "soon";
  return "";
}

// ------------------------------------------------------------------- effects

/** Lines describing what a change set off: tasks unlocked, automations, re-dated tasks. */
export function effectLines(effects, exceptTaskId = null) {
  if (!effects) return [];
  const lines = [];
  for (const u of effects.unlocked || []) {
    const who = u.assignee_id === state.me ? "you" : u.assignee_name || "nobody yet";
    lines.push(`Ready now: “${u.title}” for ${who}${u.due_date ? `, ${dueWords(u.due_date)}` : ""}`);
  }
  for (const e of effects.events || []) {
    if (["automation", "checklist_done", "stage_changed", "checklist_applied", "automation_stopped"].includes(e.kind)) lines.push(e.detail);
  }
  const redated = (effects.redated || []).filter((t) => t.id !== exceptTaskId && !(effects.unlocked || []).some((u) => u.id === t.id));
  if (redated.length) lines.push(`${plural(redated.length, exceptTaskId ? "other task" : "task")} re-dated`);
  const relocked = (effects.relocked || []).filter((t) => t.id !== exceptTaskId);
  if (relocked.length) lines.push(`${plural(relocked.length, "task")} waiting again: ${relocked.map((t) => `“${t.title}”`).join(", ")}`);
  return lines;
}

function fail(err) {
  toast(err.message || String(err), { error: true });
}

// ------------------------------------------------------------------ actions

export async function completeTask(t, refresh) {
  const done = t.status === "done" || t.status === "skipped";
  try {
    if (done) {
      const r = await post(`/tasks/${t.id}/reopen`);
      toast([`Reopened “${t.title}”`, ...effectLines(r.effects, t.id)]);
    } else {
      const r = await post(`/tasks/${t.id}/complete`);
      toast([`Done: “${t.title}”`, ...effectLines(r.effects, t.id)], {
        action: { label: "Undo", run: () => post(`/tasks/${t.id}/reopen`).then(refresh, fail) },
        ms: 8000,
      });
    }
  } catch (err) {
    fail(err);
  }
  await refresh();
}

async function skipTask(t, refresh) {
  try {
    const r = await post(`/tasks/${t.id}/skip`);
    toast([`Skipped “${t.title}”`, ...effectLines(r.effects, t.id)], {
      action: { label: "Undo", run: () => post(`/tasks/${t.id}/reopen`).then(refresh, fail) },
    });
  } catch (err) {
    fail(err);
  }
  await refresh();
}

async function updateTask(t, body, refresh, message) {
  try {
    const r = await patch(`/tasks/${t.id}`, body);
    const lines = effectLines(r.effects, t.id);
    if (message || lines.length) toast([message || "Saved", ...lines]);
  } catch (err) {
    fail(err);
  }
  await refresh();
}

async function deleteTask(t, refresh) {
  if (!confirm(`Delete “${t.title}”? This can't be undone.`)) return;
  try {
    const r = await del(`/tasks/${t.id}`);
    toast([`Deleted “${t.title}”`, ...effectLines(r, t.id)]);
  } catch (err) {
    fail(err);
  }
  await refresh();
}

// ----------------------------------------------------------------- popovers

// The popover lives in ui/popover.js; re-exported here for older imports.
export { popover, closePopover };

function nextWeekday(from, target) {
  const n = (target - weekday(from) + 7) % 7 || 7;
  return addDays(from, n);
}

export function editDue(t, anchor, refresh, depTitles = []) {
  const now = today();
  const input = h("input", { type: "date", value: t.due_date || "", "aria-label": "Due date" });
  const save = (value, msg) => {
    closePopover();
    return updateTask(t, { dueDate: value }, refresh, msg);
  };
  const quick = [
    ["Today", now],
    ["Tomorrow", addDays(now, 1)],
    ["Friday", nextWeekday(addDays(now, -1), 5)],
    ["Next Mon", nextWeekday(now, 1)],
    ["+1 week", addDays(t.due_date || now, 7)],
  ];
  const rule = ruleText(t, depTitles);
  popover(
    anchor,
    h(
      "form.pop-form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          if (input.value && input.value !== t.due_date) save(input.value, `Due ${fmtDate(input.value, now)}`);
          else closePopover();
        },
      },
      h("div.pop-title", "Due date"),
      h("label.pop-label", h("span.visually-hidden", "Due date"), input),
      h(
        "div.pop-quick",
        quick.map(([label, d]) => h("button.btn.small", { type: "button", onclick: () => save(d, `Due ${fmtDate(d, now)}`) }, label)),
      ),
      h("p.pop-note", icon("info", { size: 14 }), h("span", dueExplain(t, depTitles))),
      h(
        "div.pop-actions",
        t.due_locked && rule
          ? h("button.btn.small.ghost", { type: "button", onclick: () => save(null, "Due date follows the checklist schedule again") }, "Use checklist schedule")
          : !rule && t.due_date
            ? h("button.btn.small.ghost", { type: "button", onclick: () => save(null, "Due date cleared") }, "No date")
            : h("span"),
        h("button.btn.primary.small", { type: "submit" }, "Save"),
      ),
    ),
    "Change due date",
  );
}

export function editAssignee(t, anchor, refresh) {
  const pick = (id) => {
    closePopover();
    if (id === t.assignee_id) return;
    const who = id ? (id === state.me ? "you" : users().find((u) => u.id === id)?.name) : "nobody";
    return updateTask(t, { assigneeId: id }, refresh, `Assigned to ${who}`);
  };
  const list = h(
    "div.pop-list",
    { role: "listbox", "aria-label": "Assign to" },
    h("div.menu-heading", "Assign to"),
    users().map((u) =>
      h(
        "button.pop-item" + (u.id === t.assignee_id ? ".current" : ""),
        { type: "button", role: "option", "aria-selected": u.id === t.assignee_id ? "true" : "false", onclick: () => pick(u.id) },
        avatar(u.name, { size: "xs" }),
        h("span.menu-label", u.name, u.id === state.me ? h("span.muted", " (you)") : ""),
        u.default_role ? h("span.menu-hint.cap", u.default_role) : null,
      ),
    ),
    h("div.menu-sep", { role: "separator" }),
    h("button.pop-item", { type: "button", role: "option", onclick: () => pick(null) }, avatar(null, { size: "xs" }), h("span.menu-label", "Unassigned")),
  );
  list.addEventListener("keydown", (e) => {
    const items = [...list.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "j") (items[i + 1] || items[0]).focus(), e.preventDefault();
    if (e.key === "ArrowUp" || e.key === "k") (items[i - 1] || items[items.length - 1]).focus(), e.preventDefault();
  });
  popover(anchor, list, "Assign to");
  (list.querySelector(".current") || list.querySelector("button")).focus();
}

function renameInline(t, titleEl, refresh) {
  const input = h("input.inline-input", { value: t.title, "aria-label": "Task title", maxlength: 300 });
  let done = false;
  const finish = (saveIt) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (saveIt && v && v !== t.title) updateTask(t, { title: v }, refresh, "Renamed");
    else replace(titleEl, t.title);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault(), finish(true);
    if (e.key === "Escape") e.preventDefault(), e.stopPropagation(), finish(false), titleEl.closest(".task")?.focus();
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
  replace(titleEl, input);
  input.focus();
  input.select();
}

function moreMenu(t, anchor, refresh, titleEl) {
  const finished = t.status === "done" || t.status === "skipped";
  menu(
    anchor,
    [
      { label: "Rename", icon: "pencil", onSelect: () => renameInline(t, titleEl, refresh) },
      ...["high", "normal", "low"]
        .filter((p) => p !== t.priority)
        .map((p) => ({ label: `Priority: ${p}`, icon: "flag", onSelect: () => updateTask(t, { priority: p }, refresh, `Priority set to ${p}`) })),
      finished
        ? { label: "Reopen", icon: "rotate-ccw", onSelect: () => completeTask(t, refresh) }
        : { label: "Skip (not needed)", icon: "arrow-right", onSelect: () => skipTask(t, refresh) },
      t.matter_id ? { label: "Open matter", icon: "briefcase", href: `#/matters/${t.matter_id}` } : null,
      t.matter_id ? { label: "Log time", icon: "clock", onSelect: () => logTimeDialog({ matterId: t.matter_id, taskId: t.id, taskTitle: t.title, description: t.title }) } : null,
      "-",
      { label: "Delete", icon: "trash-2", danger: true, onSelect: () => deleteTask(t, refresh) },
    ],
    "Task actions",
  );
}

// -------------------------------------------------------------------- the row

/**
 * The pieces of a task row, so a list row (taskRow) and a table row (Firm tasks) share
 * the same controls and keyboard behaviour.
 * opts: { refresh, showMatter = true, byId: Map of the matter's tasks (for dependency titles),
 *         showDeps, showRole, showDescription }
 */
export function taskParts(t, opts) {
  const now = today();
  const refresh = opts.refresh;
  const finished = t.status === "done" || t.status === "skipped";
  const waiting = t.status === "waiting";
  const byId = opts.byId || new Map();
  const depTitles = (t.depends_on || []).map((id) => byId.get(id)?.title || (t.waiting_on || []).find((w) => w.id === id)?.title).filter(Boolean);

  const titleEl = h("span.task-title-text", t.title);
  const check = h(
    "button.check",
    {
      type: "button",
      "aria-label": finished ? `Reopen: ${t.title}` : waiting ? `Waiting: ${t.title}` : `Mark done: ${t.title}`,
      title: finished ? "Reopen" : waiting ? "Waiting on other tasks" : "Mark done",
      "aria-pressed": finished ? "true" : "false",
      onclick: (e) => {
        if (waiting) {
          toast(`Waiting on ${(t.waiting_on || []).map((w) => `“${w.title}”`).join(", ")}. Finish or skip that first.`, { error: true });
          return;
        }
        e.currentTarget.closest(".task")?.classList.add("completing");
        completeTask(t, refresh);
      },
    },
    h("span.check-mark", { "aria-hidden": "true" }, icon("check", { size: 12, strokeWidth: 3 })),
  );

  const dc = dueClass(t);
  const dueBtn = h(
    "button.chip.due" + (dc ? "." + dc : "") + (t.due_locked ? ".locked" : "") + (!t.due_date && !finished ? ".nodate" : ""),
    {
      type: "button",
      title: dueExplain(t, depTitles) + (finished ? "" : " Click to change."),
      "aria-label": `Due: ${t.due_date ? fmtDate(t.due_date, now) : "no date"}. Change`,
      disabled: finished,
      onclick: (e) => editDue(t, e.currentTarget, refresh, depTitles),
    },
    icon(finished ? "circle-check" : dc === "late" ? "clock" : "calendar", { size: 13 }),
    h(
      "span",
      finished
        ? `${t.status === "skipped" ? "Skipped" : "Done"}${t.completed_on ? " " + (t.completed_on === now ? "today" : fmtDate(t.completed_on, now).slice(4)) : ""}`
        : relDate(t.due_date, now),
    ),
  );
  const whoName = t.assignee_id === state.me ? "Me" : t.assignee_name;
  const whoBtn = h(
    "button.chip.who" + (t.assignee_id ? "" : ".none"),
    {
      type: "button",
      title: t.assignee_name ? `Assigned to ${t.assignee_name}. Click to change.` : "Unassigned. Click to assign.",
      "aria-label": `Assigned to ${t.assignee_name || "nobody"}. Change`,
      disabled: finished,
      onclick: (e) => editAssignee(t, e.currentTarget, refresh),
    },
    avatar(t.assignee_id ? t.assignee_name : null, { size: "xs" }),
    h("span.who-name", whoName || "Unassigned"),
  );
  const moreBtn = h(
    "button.icon-btn.sm.more",
    { type: "button", "aria-label": `More actions for ${t.title}`, title: "More actions", "aria-haspopup": "menu", onclick: (e) => moreMenu(t, e.currentTarget, refresh, titleEl) },
    icon("ellipsis", { size: 16 }),
  );

  const matterLink =
    t.matter_id
      ? h("a.matter-link", { href: `#/matters/${t.matter_id}` }, t.matter_number ? h("span.matter-num", t.matter_number) : null, h("span.matter-name", t.matter_name))
      : h("span.muted", "No matter");
  const meta = [];
  if (opts.showMatter !== false) meta.push(matterLink);
  if (t.priority === "high") meta.push(h("span.tag.high", icon("flag", { size: 11 }), "High"));
  if (t.priority === "low") meta.push(h("span.tag.low", "Low"));
  if (t.role && opts.showRole) meta.push(h("span.tag.cap", t.role));
  if (!finished && t.blocks && t.blocks.length)
    meta.push(h("span.tag.blocks", { title: "Waiting on this: " + t.blocks.map((b) => b.title).join(", ") }, `${t.blocks.length} waiting on this`));
  if (opts.showDeps && depTitles.length && !waiting)
    meta.push(h("span.deps", "after ", depTitles.map((d, i) => [i ? ", " : "", h("span.dep", "“", d, "”")])));

  let waitBox = null;
  if (waiting && (t.waiting_on || []).length) {
    waitBox = h(
      "div.waiting-on",
      h("span.wait-label", icon("hourglass", { size: 12 }), "Waiting on"),
      h(
        "ul",
        t.waiting_on.map((w) => {
          const who = w.assignee_id === state.me ? "you" : w.assignee_name || "unassigned";
          const due = w.status === "waiting" ? "also waiting on another task" : w.due_date ? dueWords(w.due_date) : "no due date";
          const late = w.due_date && w.status !== "waiting" && w.due_date < now;
          return h(
            "li",
            opts.byId && opts.byId.has(w.id)
              ? h("a", { href: `#task-${w.id}`, onclick: (e) => (e.preventDefault(), focusTask(w.id)) }, w.title)
              : t.matter_id
                ? h("a", { href: `#/matters/${t.matter_id}` }, w.title)
                : h("span", w.title),
            h("span.muted", ` — ${who}, `),
            h("span" + (late ? ".late-text" : ".muted"), due),
          );
        }),
      ),
      t.anchor === "after_deps" && !t.due_date ? h("div.muted.small", dueExplain(t, depTitles)) : null,
    );
  }

  const onKey = (e, row) => {
    if (e.target !== row || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "x" || e.key === " ") e.preventDefault(), check.click();
    else if (e.key === "d" && !finished) e.preventDefault(), dueBtn.click();
    else if (e.key === "a" && !finished) e.preventDefault(), whoBtn.click();
    else if (e.key === "e") e.preventDefault(), renameInline(t, titleEl, refresh);
    else if (e.key === "Enter" && t.matter_id && opts.showMatter !== false) location.hash = `#/matters/${t.matter_id}`;
    else if (e.key === "." || e.key === "m") e.preventDefault(), moreBtn.click();
  };

  return { t, check, titleEl, dueBtn, whoBtn, moreBtn, matterLink, meta, waitBox, onKey, finished, waiting, rowClass: "task " + t.status + (t.priority === "high" ? " prio-high" : "") };
}

export function taskRow(t, opts) {
  const p = taskParts(t, opts);
  const row = h(
    "li.task" + "." + t.status + (t.priority === "high" ? ".prio-high" : ""),
    { tabindex: "0", id: `task-${t.id}`, dataset: { id: t.id }, "aria-label": `${t.title}${t.status !== "open" ? ", " + t.status : ""}` },
    p.check,
    h(
      "div.task-main",
      h("div.task-title", p.titleEl),
      p.meta.length ? h("div.task-meta", p.meta) : null,
      p.waitBox,
      t.description && opts.showDescription ? h("div.task-desc", t.description) : null,
    ),
    h("div.task-side", p.dueBtn, p.whoBtn, p.moreBtn),
  );
  row.addEventListener("keydown", (e) => p.onKey(e, row));
  return row;
}

export function focusTask(id) {
  const el = document.getElementById(`task-${id}`);
  if (el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1200);
  }
}

/** A titled group of task rows. */
export function taskGroup(title, tasks, opts, extra = {}) {
  if (!tasks.length && !extra.showEmpty) return null;
  return h(
    "section.task-group" + (extra.tone ? "." + extra.tone : ""),
    h("h2.group-title", extra.icon ? icon(extra.icon, { size: 15, class: "group-icon" }) : null, h("span", title), h("span.count", String(tasks.length)), extra.aside || null),
    tasks.length ? h("ul.task-list", tasks.map((t) => taskRow(t, opts))) : h("p.empty", extra.empty || "Nothing here."),
  );
}

/**
 * Rebuild a task area without losing the keyboard user's place: focus returns to the
 * same task if it is still open, otherwise to whatever task now sits in its slot.
 */
export async function redraw(root, build) {
  const active = document.activeElement;
  const row = active && active.closest ? active.closest(".task") : null;
  const hadFocus = row && root.contains(row);
  const id = hadFocus ? row.dataset.id : null;
  const idx = hadFocus ? [...root.querySelectorAll(".task")].indexOf(row) : -1;
  const content = await build();
  replace(root, content);
  if (!hadFocus) return;
  const rows = [...root.querySelectorAll(".task")];
  const same = root.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  const target = same && !same.classList.contains("done") && !same.classList.contains("skipped") ? same : rows[Math.min(idx, rows.length - 1)];
  if (target) target.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ quick-add

/**
 * One-line task entry with live preview. opts: { matter (fixed matter row), defaultMe = true, onAdded }
 */
export function quickAdd(opts) {
  const input = h("input.quick-input", {
    type: "text",
    id: "quick-add",
    autocomplete: "off",
    "aria-label": "Quick add a task",
    "aria-describedby": "quick-preview",
    placeholder: opts.matter ? "Add a task to this matter, e.g. “Send draft to client by Friday”" : "Add a task, e.g. “Call client about the lease on Friday”",
    maxlength: 400,
  });
  const preview = h("div.quick-preview", { id: "quick-preview", "aria-live": "polite" });
  const btn = h("button.btn.primary", { type: "submit" }, "Add");
  let busy = false;

  const parse = () =>
    parseQuickAdd(input.value, {
      today: today(),
      users: users(),
      matters: state.matters,
    });

  const draw = () => {
    clear(preview);
    if (!input.value.trim()) {
      append(preview, h("span.quick-hint", "Type the task and press Enter. Include a date such as “Friday” or “11/20” to set when it is due."));
      return;
    }
    const p = parse();
    const matter = p.matter || opts.matter || null;
    const who = p.assignee || (opts.defaultMe !== false ? users().find((u) => u.id === state.me) : null);
    append(
      preview,
      h("span.pv.pv-title", h("b", p.title || "(no title yet)")),
      h("span.pv", icon("calendar", { size: 12 }), p.dueDate ? `Due ${fmtDate(p.dueDate, today())}` : "No due date"),
      h("span.pv", icon("user", { size: 12 }), who ? (who.id === state.me ? "You" : who.name) : "Unassigned"),
      matter ? h("span.pv", icon("briefcase", { size: 12 }), matter.number || matter.name) : h("span.pv.muted", icon("briefcase", { size: 12 }), "No matter"),
      p.priority && p.priority !== "normal" ? h("span.pv", icon("flag", { size: 12 }), `${p.priority} priority`) : null,
      p.problems.map((x) => h("span.pv.warn", icon("triangle-alert", { size: 12 }), x)),
    );
  };

  const form = h(
    "form.quick-add",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        if (busy) return;
        const p = parse();
        if (!p.title) {
          toast("Type what needs doing first.", { error: true });
          return;
        }
        const matter = p.matter || opts.matter || null;
        const who = p.assignee ? p.assignee.id : opts.defaultMe !== false ? state.me : null;
        busy = true;
        btn.disabled = true;
        try {
          const r = await post("/tasks", {
            title: p.title,
            dueDate: p.dueDate,
            assigneeId: who,
            matterId: matter ? matter.id : null,
            priority: p.priority || "normal",
          });
          input.value = "";
          draw();
          toast(`Added “${r.task.title}”${r.task.due_date ? `, due ${fmtDate(r.task.due_date, today())}` : ""}`);
          await opts.onAdded?.(r.task);
          input.focus();
        } catch (err) {
          fail(err);
        } finally {
          busy = false;
          btn.disabled = false;
        }
      },
    },
    h("div.quick-row", h("span.quick-plus", { "aria-hidden": "true" }, icon("plus", { size: 16 })), input, btn),
    preview,
  );
  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      draw();
      input.blur();
    }
  });
  if (!state.matters.length) loadMatters().catch(() => {});
  draw();
  return form;
}
