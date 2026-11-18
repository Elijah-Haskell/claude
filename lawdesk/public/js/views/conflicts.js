// Conflict checks: run a check on one or more names, read the results in plain English,
// record the decision, print the report, and look back through saved checks.

import { h, select, toast, plural, replace } from "../dom.js";
import { get, post, patch } from "../api.js";
import { loadMatters, state } from "../state.js";

// ------------------------------------------------------------ vocabulary

export const ROLE_OPTIONS = [
  { value: "prospective_client", label: "Prospective client" },
  { value: "client", label: "Client" },
  { value: "adverse_party", label: "Adverse party" },
  { value: "opposing_counsel", label: "Opposing counsel" },
  { value: "co_party", label: "Co-party" },
  { value: "witness", label: "Witness" },
  { value: "related_party", label: "Related party" },
];
export const roleLabel = (r) => ROLE_OPTIONS.find((o) => o.value === r)?.label ?? (r ? String(r).replace(/_/g, " ") : "");

export const KIND_OPTIONS = [
  { value: "", label: "Person or company" },
  { value: "person", label: "Person" },
  { value: "company", label: "Company" },
];

export const DECISIONS = [
  { value: "cleared", label: "Cleared", help: "No conflict. The firm may proceed." },
  { value: "waived", label: "Waived", help: "A conflict exists and has been consented to. Say where the written consent is filed." },
  { value: "declined", label: "Declined", help: "The firm will not take this on." },
];
export const decisionLabel = (d) => DECISIONS.find((x) => x.value === d)?.label ?? "Awaiting decision";

const BANDS = [
  ["strong", "Strong matches", "Very likely the same person or company."],
  ["possible", "Possible matches", "Close enough that someone should look."],
  ["weak", "Weak matches", "Probably different, listed so nothing is missed."],
];

/** "Nov 18, 2026, 10:12 AM" */
export function stamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
export function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function statusPill(decision) {
  return h("span.status-pill." + (decision || "pending"), decisionLabel(decision));
}

export function countsText(c) {
  const parts = ["strong", "possible", "weak"].filter((b) => c?.[b]).map((b) => `${c[b]} ${b}`);
  return parts.length ? parts.join(", ") : "No matches";
}

// --------------------------------------------------------------- results

/** Hits grouped strong / possible / weak, each with its reasons in plain English. */
export function hitList(hits, { compact = false } = {}) {
  if (!hits.length) {
    return h("div.cc-clear", h("p.cc-clear-title", "No matches"), h("p.muted", "None of these names matched anyone on record, including other names and related contacts."));
  }
  return h(
    "div.cc-results",
    BANDS.map(([band, title, help]) => {
      const list = hits.filter((x) => x.band === band);
      if (!list.length) return compact ? null : h("section.cc-band.cc-" + band, h("h3.cc-band-title", title, h("span.cc-count", "0")), h("p.muted.small", "None."));
      return h(
        "section.cc-band.cc-" + band,
        h("h3.cc-band-title", title, h("span.cc-count", String(list.length))),
        compact ? null : h("p.muted.small.cc-band-help", help),
        list.map((x) =>
          h(
            "article.cc-hit",
            h(
              "div.cc-hit-head",
              h("a.cc-hit-name", { href: `#/contacts/${x.contactId}` }, x.name),
              h("span.cc-hit-kind", x.kind === "company" ? "Company" : "Person"),
              x.match === "related" ? h("span.cc-hit-kind", "Through a relationship") : null,
            ),
            x.concerns?.length ? h("ul.cc-concerns", x.concerns.map((c) => h("li", c))) : null,
            h("ul.cc-reasons", (x.plain ?? x.reasons ?? []).map((r) => h("li", r))),
          ),
        ),
      );
    }),
  );
}

/** The three decision choices with a note. Used on a saved check and in the new-matter dialog. */
export function decisionChoices({ value = "", note = "", name = "decision", onChange } = {}) {
  const noteBox = h("textarea.cc-note", { rows: 3, maxlength: 2000, "aria-label": "Note" }, note || "");
  const noteLabel = h("span.cc-note-label");
  const radios = DECISIONS.map((d) =>
    h(
      "label.cc-choice",
      h("input", { type: "radio", name, value: d.value, checked: d.value === value }),
      h("span.cc-choice-text", h("strong", d.label), h("span.muted.small", d.help)),
    ),
  );
  const el = h("div.cc-decide", h("fieldset.cc-choices", h("legend", "Decision"), radios), h("label.cc-note-wrap", noteLabel, noteBox));
  const current = () => el.querySelector(`input[name="${name}"]:checked`)?.value ?? "";
  const label = () => (noteLabel.textContent = current() === "waived" ? "Note (required for a waiver: where the written consent is filed)" : "Note (optional)");
  el.addEventListener("change", () => (label(), onChange?.(current())));
  label();
  return { el, value: current, note: () => noteBox.value.trim(), focus: () => radios[0].querySelector("input").focus() };
}

/** Problems with a decision before it is sent, or null. */
export function decisionProblem(value, note) {
  if (!value) return "Choose cleared, waived or declined.";
  if (value === "waived" && !note) return "A waiver needs a note saying where the written consent is filed.";
  return null;
}

function tabs(current) {
  return h(
    "nav.cc-tabs",
    { "aria-label": "Conflict checks" },
    [
      ["#/conflicts", "New check"],
      ["#/conflicts/history", "Saved checks"],
    ].map(([href, label]) => h("a", { href, "aria-current": current === href ? "page" : null }, label)),
  );
}

// ------------------------------------------------------------- new check

function hashParams() {
  const i = location.hash.indexOf("?");
  return new URLSearchParams(i < 0 ? "" : location.hash.slice(i + 1));
}

function termRow(t = {}, onRemove) {
  const name = h("input.cc-term-name", { value: t.name || "", maxlength: 200, placeholder: "Full name of a person or company", "aria-label": "Name", autocomplete: "off" });
  const kind = select(KIND_OPTIONS, t.kind || "", { "aria-label": "Person or company" });
  const role = select([{ value: "", label: "Role not stated" }, ...ROLE_OPTIONS], t.role || "", { "aria-label": "Role in the matter" });
  const row = h(
    "li.cc-term",
    name,
    kind,
    role,
    h("button.icon-btn.danger", { type: "button", "aria-label": "Remove this name", title: "Remove", onclick: () => onRemove(row) }, "×"),
  );
  row.read = () => ({ name: name.value.trim(), kind: kind.value || null, role: role.value || null });
  row.focus = () => name.focus();
  return row;
}

export async function conflictsView() {
  const params = hashParams();
  let initial = [];
  if (params.get("from")) {
    try {
      const k = await get(`/conflict-checks/${Number(params.get("from"))}`);
      initial = k.terms.map((t) => ({ name: t.name, kind: t.kind, role: t.role }));
    } catch {
      /* fall back to an empty form */
    }
  } else if (params.get("name")) initial = [{ name: params.get("name"), kind: params.get("kind"), role: params.get("role") }];
  if (!initial.length) initial = [{ role: "prospective_client" }, { role: "adverse_party" }];

  const matters = await loadMatters().catch(() => state.matters);
  const list = h("ol.cc-terms");
  const remove = (row) => {
    row.remove();
    if (!list.children.length) list.append(termRow({}, remove));
  };
  for (const t of initial) list.append(termRow(t, remove));
  const matterSel = select(
    [{ value: "", label: "Not for a particular matter yet" }, ...matters.map((m) => ({ value: m.id, label: [m.number, m.name].filter(Boolean).join(" ") }))],
    params.get("matterId") || "",
    { "aria-label": "Matter" },
  );
  const err = h("p.error-text", { role: "alert" });
  const runBtn = h("button.btn.primary", { type: "submit" }, "Run conflict check");

  const form = h(
    "form.card.cc-form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const terms = [...list.children].map((r) => r.read()).filter((t) => t.name);
        if (!terms.length) {
          err.textContent = "Enter at least one name.";
          list.firstElementChild?.focus();
          return;
        }
        runBtn.disabled = true;
        runBtn.textContent = "Checking…";
        try {
          const k = await post("/conflict-checks", { terms, matterId: matterSel.value ? Number(matterSel.value) : null });
          location.hash = `#/conflicts/${k.id}`;
        } catch (ex) {
          err.textContent = ex.message;
          runBtn.disabled = false;
          runBtn.textContent = "Run conflict check";
        }
      },
    },
    h("h2", "Names to check"),
    h(
      "p.muted",
      "Enter everyone involved: the prospective client, the other side, their lawyers, and any owners or related companies you know of. Each name is compared with every contact, former name and trade name on record, allowing for nicknames, initials, misspellings and word order.",
    ),
    h("div.cc-term-head", { "aria-hidden": "true" }, h("span", "Name"), h("span", "Person or company"), h("span", "Role"), h("span")),
    list,
    h(
      "button.btn.small.cc-add",
      {
        type: "button",
        onclick: () => {
          const r = termRow({}, remove);
          list.append(r);
          r.focus();
        },
      },
      "Add another name",
    ),
    h("label.cc-matter", h("span", "For matter"), matterSel),
    err,
    h("div.form-actions", runBtn),
  );

  const recent = h("section.card.cc-recent", h("h2", "Recent checks"), h("p.muted", "Loading…"));
  get("/conflict-checks?limit=5")
    .then((rows) =>
      replace(recent, 
        h("h2", "Recent checks"),
        rows.length ? h("ul.plain.cc-recent-list", rows.map(recentRow)) : h("p.muted", "No checks have been saved yet."),
        h("p", h("a", { href: "#/conflicts/history" }, "All saved checks")),
      ),
    )
    .catch(() => recent.remove());

  const page = h(
    "div.page.cc-page",
    h("div.page-head", h("div", h("h1", "Conflict check"), h("p.sub", "Every check is saved with its results and the decision, for the client file.")), tabs("#/conflicts")),
    h("div.cc-new-grid", form, recent),
  );
  setTimeout(() => list.firstElementChild?.focus(), 0);
  return page;
}

function recentRow(k) {
  return h(
    "li",
    h(
      "a.cc-recent-item",
      { href: `#/conflicts/${k.id}` },
      h("span.cc-recent-names", k.terms.map((t) => t.name).join("; ")),
      h("span.muted.small", `No. ${k.id} · ${shortDate(k.runAt)} · ${countsText(k.counts)}`),
      statusPill(k.decision),
    ),
  );
}

// ----------------------------------------------------------- saved check

export async function checkView([idStr]) {
  const id = Number(idStr);
  const page = h("div.page.cc-page");
  let k = await get(`/conflict-checks/${id}`);

  async function draw() {
    const matterText = k.matterId ? [k.matterNumber, k.matterName].filter(Boolean).join(" ") : null;
    const decide = decisionChoices({ value: k.decision || "", note: k.decision ? k.decisionNote || "" : "" });
    const err = h("p.error-text", { role: "alert" });
    const decisionCard = h(
      "section.card.cc-decision",
      h("h2", "Decision"),
      h(
        "div.cc-current",
        statusPill(k.decision),
        k.decision ? h("span.muted.small", `by ${k.decidedByName || "someone not recorded"}, ${stamp(k.decidedAt)}`) : h("span.muted.small", "Nobody has decided this check yet."),
      ),
      k.decision && k.decisionNote ? h("p.cc-note-show", k.decisionNote) : null,
      h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            err.textContent = "";
            const problem = decisionProblem(decide.value(), decide.note());
            if (problem) return (err.textContent = problem);
            try {
              await post(`/conflicts/checks/${id}/decision`, { decision: decide.value(), note: decide.note() || null });
              k = await get(`/conflict-checks/${id}`);
              toast(`Recorded: ${decisionLabel(k.decision).toLowerCase()}`);
              draw();
            } catch (ex) {
              err.textContent = ex.message;
            }
          },
        },
        k.decision ? h("p.muted.small", "To change the decision, choose again. The earlier decision stays in the history.") : null,
        decide.el,
        err,
        h("div.form-actions", h("button.btn.primary", { type: "submit" }, k.decision ? "Change decision" : "Record decision")),
      ),
      k.decisions?.length > 1
        ? h(
            "details.cc-history",
            h("summary", `Decision history (${k.decisions.length})`),
            h("ol.plain", k.decisions.map((d) => h("li", statusPill(d.decision), h("span.muted.small", ` ${d.decidedByName || "Not recorded"}, ${stamp(d.decidedAt)}`), d.note ? h("div.small", d.note) : null))),
          )
        : null,
    );

    let matterCard;
    if (matterText) {
      matterCard = h("section.card", h("h2", "Matter"), h("p", h("a", { href: `#/matters/${k.matterId}` }, matterText)));
    } else {
      const matters = await loadMatters().catch(() => state.matters);
      const sel = select([{ value: "", label: "Choose a matter…" }, ...matters.map((m) => ({ value: m.id, label: [m.number, m.name].filter(Boolean).join(" ") }))], "", { "aria-label": "Matter to link" });
      matterCard = h(
        "section.card",
        h("h2", "Matter"),
        h("p.muted", "Not linked to a matter. Link it once the matter is opened, so the check is on that file."),
        h(
          "form.apply",
          {
            onsubmit: async (e) => {
              e.preventDefault();
              if (!sel.value) return;
              try {
                await patch(`/conflicts/checks/${id}`, { matterId: Number(sel.value) });
                k = await get(`/conflict-checks/${id}`);
                toast("Linked to the matter");
                draw();
              } catch (ex) {
                toast(ex.message, { error: true });
              }
            },
          },
          sel,
          h("button.btn", { type: "submit" }, "Link"),
        ),
      );
    }

    replace(page, 
      h("a.back", { href: "#/conflicts/history" }, "← Saved checks"),
      h(
        "div.page-head",
        h("div", h("h1", `Conflict check no. ${k.id}`), h("p.sub", [`Run ${stamp(k.runAt)} by ${k.runByName || "someone not recorded"}`, matterText ? `for ${matterText}` : "not linked to a matter"].join(" · "))),
        h(
          "div.head-actions",
          h("a.btn", { href: `/api/conflict-checks/${k.id}/report`, target: "_blank", rel: "noopener" }, "Print report"),
          h("a.btn", { href: `/api/conflict-checks/${k.id}/report?download=1` }, "Save report"),
          h("a.btn", { href: `#/conflicts?from=${k.id}` }, "Check again"),
        ),
      ),
      h(
        "div.cc-grid",
        h(
          "div.cc-main",
          h(
            "section.card",
            h("h2", "Names searched"),
            h(
              "ul.plain.cc-searched",
              k.terms.map((t) => h("li", h("span.cc-searched-name", t.name), h("span.muted.small", [t.kind === "company" ? "Company" : t.kind === "person" ? "Person" : null, roleLabel(t.role) || "Role not stated"].filter(Boolean).join(" · ")))),
            ),
          ),
          h("section.card", h("h2", "What the search found"), h("p.cc-summary", countsText(k.counts)), hitList(k.results)),
        ),
        h("aside.cc-aside", decisionCard, matterCard),
      ),
    );
  }
  await draw();
  return page;
}

// --------------------------------------------------------- saved checks

export async function checkHistoryView() {
  const f = { decision: "", q: "", from: "", to: "", linked: "", hits: "" };
  const body = h("tbody");
  const count = h("p.result-count.muted");
  let seq = 0;

  async function load() {
    const my = ++seq;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
    qs.set("limit", "500");
    const rows = await get(`/conflict-checks?${qs}`);
    if (my !== seq) return;
    count.textContent = plural(rows.length, "saved check");
    body.replaceChildren(
      ...(rows.length
        ? rows.map((k) =>
            h(
              "tr.cc-row",
              { tabindex: "0", onclick: () => (location.hash = `#/conflicts/${k.id}`), onkeydown: (e) => e.key === "Enter" && (location.hash = `#/conflicts/${k.id}`) },
              h("td", { "data-label": "No." }, h("a", { href: `#/conflicts/${k.id}` }, String(k.id))),
              h("td", { "data-label": "Run" }, shortDate(k.runAt), h("div.muted.small", k.runByName || "")),
              h("td.cc-names-cell", { "data-label": "Names" }, k.terms.map((t) => h("div", t.name, t.roleLabel ? h("span.muted.small", ` · ${t.roleLabel}`) : null))),
              h("td", { "data-label": "Matter" }, k.matterId ? h("a", { href: `#/matters/${k.matterId}` }, [k.matterNumber, k.matterName].filter(Boolean).join(" ")) : h("span.muted", "Not linked")),
              h("td", { "data-label": "Result" }, countsText(k.counts)),
              h("td", { "data-label": "Decision" }, statusPill(k.decision)),
            ),
          )
        : [h("tr", h("td.empty", { colspan: "6" }, "No saved checks match these filters."))]),
    );
  }

  const seg = h(
    "div.segmented",
    { role: "group", "aria-label": "Decision" },
    [
      ["", "All"],
      ["pending", "Awaiting decision"],
      ["cleared", "Cleared"],
      ["waived", "Waived"],
      ["declined", "Declined"],
    ].map(([v, label]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": v === f.decision ? "true" : "false",
          onclick: (e) => {
            f.decision = v;
            seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false"));
            load();
          },
        },
        label,
      ),
    ),
  );
  let t;
  const search = h("input.search", {
    type: "search",
    placeholder: "Search names, matters and notes",
    "aria-label": "Search saved checks",
    "data-search": "",
    oninput: (e) => {
      f.q = e.target.value;
      clearTimeout(t);
      t = setTimeout(load, 200);
    },
  });
  const dateIn = (key, label) => h("label.cc-filter", h("span", label), h("input", { type: "date", "aria-label": label, onchange: (e) => ((f[key] = e.target.value), load()) }));
  const pick = (key, label, opts) => h("label.cc-filter", h("span", label), select(opts, "", { "aria-label": label, onchange: (e) => ((f[key] = e.target.value), load()) }));

  await load();
  return h(
    "div.page.cc-page",
    h("div.page-head", h("div", h("h1", "Saved conflict checks"), h("p.sub", "Every check run, what it found and what was decided.")), tabs("#/conflicts/history")),
    h("div.filters", seg, search),
    h(
      "div.filters.cc-filters",
      dateIn("from", "From"),
      dateIn("to", "To"),
      pick("linked", "Matter", [
        { value: "", label: "Any" },
        { value: "yes", label: "Linked to a matter" },
        { value: "no", label: "Not linked" },
      ]),
      pick("hits", "Result", [
        { value: "", label: "Any result" },
        { value: "strong", label: "Has a strong match" },
        { value: "any", label: "Has any match" },
        { value: "none", label: "No matches" },
      ]),
    ),
    count,
    h("table.ld-table.cc-table", h("thead", h("tr", h("th", "No."), h("th", "Run"), h("th", "Names searched"), h("th", "Matter"), h("th", "Result"), h("th", "Decision"))), body),
  );
}
