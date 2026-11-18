// Checklists: the list of reusable task lists, and the editor for one.

import { h, select, toast, plural, slug } from "../dom.js";
import { get, post, put, del } from "../api.js";
import { state } from "../state.js";

const ruleDays = (n, business) => `${n} ${business ? "business " : ""}day${n === 1 ? "" : "s"}`;

export async function checklistsView() {
  const lists = await get("/checklists");
  return h(
    "div.page",
    h("div.page-head", h("h1", "Checklists"), h("a.btn.primary", { href: "#/checklists/new" }, "New checklist")),
    h("p.muted", "A checklist is a set of tasks you add to a matter in one go: who does each step, when it's due, and what has to happen first."),
    lists.length
      ? h(
          "ul.card-list",
          lists.map((l) =>
            h(
              "li",
              h(
                "a.card.list-card",
                { href: `#/checklists/${l.id}` },
                h("h2", l.name),
                h("p.muted", [l.practice_area || "Any practice area", plural(l.items.length, "step"), l.times_used ? `used ${plural(l.times_used, "time")}` : "not used yet"].join(" · ")),
                l.open_tasks ? h("p.small", `${plural(l.open_tasks, "open task")} on matters`) : null,
                h("ol.mini-steps", l.items.slice(0, 5).map((i) => h("li", i.title)), l.items.length > 5 ? h("li.muted", `and ${l.items.length - 5} more`) : null),
              ),
            ),
          ),
        )
      : h("p.empty", "No checklists yet."),
  );
}

let uidSeq = 0;

function toStep(it) {
  let mode = "added";
  let dir = "after";
  let n = it.offsetDays ?? 0;
  let field = state.setup.dateFields[0]?.key ?? "";
  if (it.offsetDays == null) mode = "none";
  else if (it.anchor === "after_deps") mode = "deps";
  else if (String(it.anchor).startsWith("field:")) {
    mode = "date";
    field = it.anchor.slice(6);
    dir = n < 0 ? "before" : n > 0 ? "after" : "on";
    n = Math.abs(n);
  }
  return {
    uid: ++uidSeq,
    key: it.key,
    keyTouched: true,
    title: it.title,
    description: it.description || "",
    role: it.role || "",
    priority: it.priority || "normal",
    mode,
    n: Math.abs(n),
    business: !!it.businessDays,
    dir,
    field,
    deps: it.dependsOn || [],
  };
}

function blankStep() {
  return {
    uid: ++uidSeq,
    key: "",
    keyTouched: false,
    title: "",
    description: "",
    role: "",
    priority: "normal",
    mode: "added",
    n: 1,
    business: true,
    dir: "before",
    field: state.setup.dateFields[0]?.key ?? "",
    deps: [],
  };
}

function stepRule(s, steps) {
  const depNames = s.deps.map((k) => steps.find((x) => x.key === k)?.title || k);
  const waits = depNames.length ? ` Starts once ${depNames.map((x) => `“${x}”`).join(" and ")} ${depNames.length > 1 ? "are" : "is"} done.` : "";
  if (s.mode === "none") return "No due date." + waits;
  if (s.mode === "added") return (s.n === 0 ? "Due the day the checklist is added." : `Due ${ruleDays(s.n, s.business)} after the checklist is added.`) + waits;
  if (s.mode === "deps") {
    if (!depNames.length) return "Pick the steps it depends on.";
    return s.n === 0 ? `Due the day ${depNames.map((x) => `“${x}”`).join(" and ")} ${depNames.length > 1 ? "are" : "is"} done.` : `Due ${ruleDays(s.n, s.business)} after ${depNames.map((x) => `“${x}”`).join(" and ")} ${depNames.length > 1 ? "are" : "is"} done.`;
  }
  const label = state.setup.dateFields.find((f) => f.key === s.field)?.label || "matter date";
  if (s.dir === "on") return `Due on the ${label}.` + waits;
  return `Due ${ruleDays(s.n, s.business)} ${s.dir} the ${label}.` + waits;
}

export async function checklistEditView([idStr]) {
  const isNew = idStr === "new";
  const list = isNew ? { name: "", description: "", practice_area_id: null, items: [], open_tasks: 0 } : await get(`/checklists/${idStr}`);
  let steps = list.items.map(toStep);
  if (!steps.length) steps.push(blankStep());
  const roles = [...new Set([...(state.setup.roles || []), "attorney", "paralegal", "assistant"])];

  const name = h("input.big-input", { value: list.name, placeholder: "Checklist name, e.g. LLC formation", "aria-label": "Checklist name", maxlength: 200, required: true });
  const area = select([{ value: "", label: "Any practice area" }, ...state.setup.practiceAreas.map((p) => ({ value: p.id, label: p.name }))], list.practice_area_id ?? "", { "aria-label": "Practice area" });
  const desc = h("input", { value: list.description || "", placeholder: "What it's for (optional)", "aria-label": "Description", maxlength: 5000 });
  const stepsBox = h("ol.steps");
  const err = h("div.error-box", { role: "alert", hidden: true });
  const propagate = h("input", { type: "checkbox", id: "propagate", checked: list.open_tasks > 0 });
  const roleList = h("datalist#role-list", roles.map((r) => h("option", { value: r })));

  /** Keep keys unique and filled in from titles until someone edits them. */
  function fixKeys() {
    const used = new Set();
    for (const s of steps) {
      if (!s.keyTouched) {
        const base = slug(s.title) || "step";
        let k = base;
        let i = 2;
        while (used.has(k)) k = `${base}_${i++}`;
        const old = s.key;
        s.key = k;
        if (old && old !== k) for (const o of steps) o.deps = o.deps.map((d) => (d === old ? k : d));
      }
      used.add(s.key);
    }
  }

  function draw(focusUid, focusSel = ".step-title") {
    fixKeys();
    stepsBox.replaceChildren(...steps.map((s, i) => stepCard(s, i)));
    if (focusUid) stepsBox.querySelector(`[data-uid="${focusUid}"] ${focusSel}`)?.focus();
  }

  function stepCard(s, i) {
    const ruleLine = h("p.rule-line", stepRule(s, steps));
    const updateRule = () => (ruleLine.textContent = stepRule(s, steps));
    const title = h("input.step-title", {
      value: s.title,
      placeholder: "What needs doing",
      "aria-label": `Step ${i + 1} title`,
      maxlength: 300,
      // Update the other cards in place rather than redrawing: a redraw on blur would
      // swallow the click that caused the blur.
      oninput: (e) => {
        s.title = e.target.value;
        fixKeys();
        keyIn.value = s.key;
        for (const chip of stepsBox.querySelectorAll(`.dep-chip[data-uid="${s.uid}"]`)) chip.textContent = s.title || s.key;
        updateRule();
      },
      onkeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const ns = blankStep();
          steps.splice(i + 1, 0, ns);
          draw(ns.uid);
        }
      },
    });
    const keyIn = h("input.key-input", {
      value: s.key,
      "aria-label": `Step ${i + 1} key`,
      title: "Short id used for dependencies. Lower-case letters, digits, _ and -.",
      maxlength: 64,
      onchange: (e) => {
        const old = s.key;
        s.key = e.target.value.trim();
        s.keyTouched = true;
        for (const o of steps) o.deps = o.deps.map((d) => (d === old ? s.key : d));
        draw();
      },
    });
    const role = h("input", { value: s.role, list: "role-list", "aria-label": `Step ${i + 1} role`, placeholder: "anyone", maxlength: 60, oninput: (e) => (s.role = e.target.value.trim()) });
    const prio = select(["normal", "high", "low"].map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) + " priority" })), s.priority, { "aria-label": `Step ${i + 1} priority`, onchange: (e) => (s.priority = e.target.value) });

    const mode = select(
      [
        { value: "added", label: "after it's added to the matter" },
        { value: "deps", label: "after the steps it waits for" },
        { value: "date", label: "relative to a matter date" },
        { value: "none", label: "no due date" },
      ],
      s.mode,
      { "aria-label": `Step ${i + 1} due rule`, onchange: (e) => ((s.mode = e.target.value), draw(s.uid, ".rule-mode")) },
    );
    mode.classList.add("rule-mode");
    const n = h("input.num-input", { type: "number", min: 0, max: 3650, value: s.n, "aria-label": "Days", oninput: (e) => ((s.n = Math.max(0, Number(e.target.value) || 0)), updateRule()) });
    const unit = select([{ value: "1", label: "business days" }, { value: "0", label: "calendar days" }], s.business ? "1" : "0", {
      "aria-label": "Day type",
      onchange: (e) => ((s.business = e.target.value === "1"), updateRule()),
    });
    const dir = select([{ value: "before", label: "before" }, { value: "on", label: "on" }, { value: "after", label: "after" }], s.dir, { "aria-label": "Before or after", onchange: (e) => ((s.dir = e.target.value), draw(s.uid, ".dir-sel")) });
    dir.classList.add("dir-sel");
    const field = select(state.setup.dateFields.map((f) => ({ value: f.key, label: f.label })), s.field, { "aria-label": "Matter date", onchange: (e) => ((s.field = e.target.value), updateRule()) });

    const ruleControls =
      s.mode === "none"
        ? [h("span.muted", "Due"), mode]
        : s.mode === "date"
          ? [h("span.muted", "Due"), s.dir === "on" ? null : [n, unit], dir, field, mode]
          : [h("span.muted", "Due"), n, unit, mode];

    const others = steps.filter((o) => o.uid !== s.uid);
    const deps = h(
      "div.dep-chips",
      { role: "group", "aria-label": `Step ${i + 1} depends on` },
      h("span.muted", "Waits for:"),
      others.length
        ? others.map((o) =>
            h(
              "button.dep-chip",
              {
                type: "button",
                "aria-pressed": s.deps.includes(o.key) ? "true" : "false",
                onclick: () => {
                  s.deps = s.deps.includes(o.key) ? s.deps.filter((d) => d !== o.key) : [...s.deps, o.key];
                  draw(s.uid, `.dep-chip[data-uid="${o.uid}"]`);
                },
                dataset: { uid: o.uid },
              },
              o.title || o.key,
            ),
          )
        : h("span.muted", "nothing (add more steps first)"),
    );

    const move = (delta) => {
      const j = i + delta;
      if (j < 0 || j >= steps.length) return;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      draw(s.uid, delta < 0 ? ".up" : ".down");
    };

    return h(
      "li.step.card",
      { dataset: { uid: s.uid } },
      h(
        "div.step-head",
        h("span.step-n", String(i + 1)),
        title,
        h(
          "div.step-tools",
          h("button.icon-btn.up", { type: "button", "aria-label": `Move step ${i + 1} up`, disabled: i === 0, onclick: () => move(-1) }, "↑"),
          h("button.icon-btn.down", { type: "button", "aria-label": `Move step ${i + 1} down`, disabled: i === steps.length - 1, onclick: () => move(1) }, "↓"),
          h(
            "button.icon-btn.danger",
            {
              type: "button",
              "aria-label": `Remove step ${i + 1}`,
              onclick: () => {
                steps.splice(i, 1);
                for (const o of steps) o.deps = o.deps.filter((d) => d !== s.key);
                if (!steps.length) steps.push(blankStep());
                draw();
              },
            },
            "×",
          ),
        ),
      ),
      h("div.step-row", h("label.mini", "Who", role), h("label.mini", "Priority", prio), h("label.mini", "Key", keyIn)),
      h("div.step-row.rule-row", ruleControls),
      deps,
      ruleLine,
      h(
        "details.step-desc",
        { open: s.description ? true : null },
        h("summary", "Notes for this step"),
        h("textarea", { rows: 2, maxlength: 5000, "aria-label": `Step ${i + 1} notes`, oninput: (e) => (s.description = e.target.value) }, s.description),
      ),
    );
  }

  async function save() {
    fixKeys();
    err.hidden = true;
    const body = {
      name: name.value,
      description: desc.value || null,
      practiceAreaId: area.value ? Number(area.value) : null,
      propagate: propagate.checked,
      items: steps
        .filter((s) => s.title.trim() || steps.length === 1)
        .map((s) => ({
          key: s.key,
          title: s.title,
          description: s.description || null,
          role: s.role || null,
          priority: s.priority,
          anchor: s.mode === "deps" ? "after_deps" : s.mode === "date" ? `field:${s.field}` : "applied",
          offsetDays: s.mode === "none" ? null : s.mode === "date" ? (s.dir === "on" ? 0 : s.dir === "before" ? -s.n : s.n) : s.n,
          businessDays: s.business,
          dependsOn: s.deps,
        })),
    };
    try {
      if (isNew) {
        const l = await post("/checklists", body);
        toast(`Created “${l.name}”`);
        location.hash = `#/checklists/${l.id}`;
      } else {
        const r = await put(`/checklists/${list.id}`, body);
        toast(propagate.checked ? `Saved. ${plural(r.changedTasks, "open task")} updated.` : "Saved. Tasks already on matters were left as they are.");
        location.hash = `#/checklists/${list.id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      err.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  async function remove() {
    if (!confirm(`Delete the checklist “${list.name}”?`)) return;
    try {
      await del(`/checklists/${list.id}`);
      toast("Checklist deleted");
      location.hash = "#/checklists";
    } catch (ex) {
      toast(ex.message, { error: true });
    }
  }

  draw();
  const page = h(
    "form.page.checklist-edit",
    {
      onsubmit: (e) => {
        e.preventDefault();
        save();
      },
      onkeydown: (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          save();
        }
      },
    },
    roleList,
    h("a.back", { href: "#/checklists" }, "← Checklists"),
    h("div.page-head", name),
    h("div.filters", area, desc),
    err,
    stepsBox,
    h(
      "button.btn.add-step",
      {
        type: "button",
        onclick: () => {
          const ns = blankStep();
          steps.push(ns);
          draw(ns.uid);
        },
      },
      "+ Add step",
    ),
    h(
      "div.save-bar",
      !isNew
        ? h(
            "label.check-line",
            propagate,
            " ",
            list.open_tasks
              ? `Also update the ${plural(list.open_tasks, "open task")} already on matters (tasks someone edited by hand keep their title; typed-in dates are kept)`
              : "Also update open tasks already on matters (there are none right now)",
          )
        : null,
      h(
        "div.save-actions",
        !isNew ? h("button.btn.danger-text", { type: "button", onclick: remove, disabled: list.times_used > 0, title: list.times_used ? "Used on matters; rename it instead" : null }, "Delete") : null,
        h("a.btn", { href: "#/checklists" }, "Cancel"),
        h("button.btn.primary", { type: "submit" }, isNew ? "Create checklist" : "Save"),
      ),
    ),
  );
  return page;
}

