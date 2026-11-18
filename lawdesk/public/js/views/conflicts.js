// Conflict checks: run a check on one or more names, read the results in plain English,
// record the decision, print the report, and look back through saved checks.

import { h, select, toast, plural, replace } from "../dom.js";
import { get, post, patch } from "../api.js";
import { loadMatters, state } from "../state.js";
import { pageHeader, card, button, iconButton, pill, emptyState, callout, segmented, field, useStyles } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { icon } from "../ui/icons.js";

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
const BAND_TONE = { strong: "danger", possible: "warning", weak: "neutral" };
const DECISION_TONE = { cleared: "success", waived: "info", declined: "neutral", pending: "warning" };

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

/** The decision on a check as a kit pill (class status-pill.<decision> kept for the browser checks). */
export function statusPill(decision) {
  const key = decision || "pending";
  const el = pill(decisionLabel(decision), DECISION_TONE[key] || "neutral");
  el.classList.add("status-pill", key);
  return el;
}

export function countsText(c) {
  const parts = ["strong", "possible", "weak"].filter((b) => c?.[b]).map((b) => `${c[b]} ${b}`);
  return parts.length ? parts.join(", ") : "No matches";
}

// --------------------------------------------------------------- results

/** Hits grouped strong / possible / weak, each with its reasons in plain English. */
export function hitList(hits, { compact = false } = {}) {
  useStyles("contacts");
  if (!hits.length) {
    return h(
      "div.cc-clear",
      h("span.cc-clear-icon", icon("circle-check", { size: 18 })),
      h("div", h("p.cc-clear-title", "No matches"), h("p.cc-clear-body", "None of these names matched anyone on record, including other names and related contacts.")),
    );
  }
  return h(
    "div.cc-results",
    BANDS.map(([band, title, help]) => {
      const list = hits.filter((x) => x.band === band);
      if (!list.length && compact) return null;
      return h(
        "section.cc-band.cc-" + band,
        h("div.cc-band-head", h("h3.cc-band-title", title), pill(String(list.length), list.length ? BAND_TONE[band] : "neutral", { dot: false }), compact ? null : h("span.cc-band-help", help)),
        list.length
          ? list.map((x) =>
              h(
                "article.cc-hit",
                h(
                  "div.cc-hit-head",
                  h("a.cc-hit-name", { href: `#/contacts/${x.contactId}` }, x.name),
                  h("span.cc-hit-kind", icon(x.kind === "company" ? "building-2" : "user", { size: 13 }), x.kind === "company" ? "Company" : "Person"),
                  x.match === "related" ? pill("Through a relationship", "neutral", { dot: false }) : null,
                ),
                x.concerns?.length ? h("ul.cc-concerns", x.concerns.map((c) => h("li", icon("triangle-alert", { size: 14 }), h("span", c)))) : null,
                h("ul.cc-reasons", (x.plain ?? x.reasons ?? []).map((r) => h("li", r))),
              ),
            )
          : h("p.cc-none", "None."),
      );
    }),
  );
}

/** The three decision choices with a note. Used on a saved check and in the new-matter dialog. */
export function decisionChoices({ value = "", note = "", name = "decision", onChange } = {}) {
  useStyles("contacts");
  const noteBox = h("textarea.cc-note", { rows: 3, maxlength: 2000, "aria-label": "Note" }, note || "");
  const noteLabel = h("span.field-label.cc-note-label");
  const radios = DECISIONS.map((d) =>
    h(
      "label.cc-choice.cc-choice-" + d.value,
      h("input", { type: "radio", name, value: d.value, checked: d.value === value }),
      h("span.cc-choice-text", h("strong", d.label), h("span.cc-choice-help", d.help)),
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

/** "New check" / "Saved checks" switch in the page header. */
function viewSwitch(current) {
  return h(
    "nav.segmented.cc-tabs",
    { "aria-label": "Conflict checks" },
    [
      ["#/conflicts", "New check", "plus"],
      ["#/conflicts/history", "Saved checks", "list-checks"],
    ].map(([href, label, ic]) => h("a", { href, "aria-current": current === href ? "page" : null }, icon(ic, { size: 14 }), label)),
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
  const row = h("li.cc-term", name, kind, role, iconButton("x", "Remove this name", { size: "sm", variant: "danger", class: "cc-term-x", onclick: () => onRemove(row) }));
  row.read = () => ({ name: name.value.trim(), kind: kind.value || null, role: role.value || null });
  row.focus = () => name.focus();
  return row;
}

export async function conflictsView() {
  useStyles("contacts");
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
  const runBtn = button("Run conflict check", { variant: "primary", icon: "search", type: "submit" });

  const form = h(
    "form.cc-form",
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
        runBtn.querySelector(".btn-label").textContent = "Checking…";
        try {
          const k = await post("/conflict-checks", { terms, matterId: matterSel.value ? Number(matterSel.value) : null });
          location.hash = `#/conflicts/${k.id}`;
        } catch (ex) {
          err.textContent = ex.message;
          runBtn.disabled = false;
          runBtn.querySelector(".btn-label").textContent = "Run conflict check";
        }
      },
    },
    h("p.cc-intro", "Enter everyone involved: the prospective client, the other side, their lawyers, and any owners or related companies you know of. Each name is compared with every contact, former name and trade name on record, allowing for nicknames, initials, misspellings and word order."),
    h("div.cc-term-head", { "aria-hidden": "true" }, h("span", "Name"), h("span", "Person or company"), h("span", "Role"), h("span")),
    list,
    h(
      "div.cc-add",
      button("Add another name", {
        size: "sm",
        variant: "ghost",
        icon: "plus",
        onclick: () => {
          const r = termRow({}, remove);
          list.append(r);
          r.focus();
        },
      }),
    ),
    field("For matter", matterSel, { hint: "Link the check to a matter so it is kept on that file.", className: "cc-matter" }),
    err,
    h("div.form-actions", runBtn),
  );

  const recentBody = h("div.cc-recent-body", h("p.muted", "Loading…"));
  const recent = card({
    title: "Recent checks",
    icon: "clock",
    className: "cc-recent",
    flush: true,
    body: recentBody,
    footer: h("a.cc-all-link", { href: "#/conflicts/history" }, "All saved checks", icon("arrow-right", { size: 14 })),
  });
  get("/conflict-checks?limit=5")
    .then((rows) =>
      replace(recentBody, rows.length ? h("ul.plain.cc-recent-list", rows.map(recentRow)) : emptyState({ icon: "conflicts", title: "No saved checks yet", body: "Checks you run appear here.", compact: true })),
    )
    .catch(() => recent.remove());

  const page = h(
    "div.page.cc-page",
    pageHeader({ title: "Conflict check", subtitle: "Every check is saved with its results and the decision, for the client file.", actions: [viewSwitch("#/conflicts")] }),
    h("div.cc-new-grid", card({ title: "Names to check", icon: "users", className: "cc-form-card", body: form }), recent),
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
      h("span.cc-recent-meta", `No. ${k.id} · ${shortDate(k.runAt)} · ${countsText(k.counts)}`),
      statusPill(k.decision),
    ),
  );
}

// ----------------------------------------------------------- saved check

export async function checkView([idStr]) {
  useStyles("contacts");
  const id = Number(idStr);
  const page = h("div.page.cc-page");
  let k = await get(`/conflict-checks/${id}`);

  async function draw() {
    const matterText = k.matterId ? [k.matterNumber, k.matterName].filter(Boolean).join(" ") : null;
    const decide = decisionChoices({ value: k.decision || "", note: k.decision ? k.decisionNote || "" : "" });
    const err = h("p.error-text", { role: "alert" });
    const decisionCard = card({
      title: "Decision",
      icon: "gavel",
      className: "cc-decision",
      body: [
        h(
          "div.cc-current",
          statusPill(k.decision),
          k.decision ? h("span.cc-current-by", `by ${k.decidedByName || "someone not recorded"}, ${stamp(k.decidedAt)}`) : h("span.cc-current-by", "Nobody has decided this check yet."),
        ),
        k.decision && k.decisionNote ? h("p.cc-note-show", k.decisionNote) : null,
        h(
          "form.cc-decision-form",
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
          k.decision ? h("p.cc-hint", "To change the decision, choose again. The earlier decision stays in the history.") : null,
          decide.el,
          err,
          h("div.form-actions", button(k.decision ? "Change decision" : "Record decision", { variant: "primary", type: "submit" })),
        ),
        k.decisions?.length > 1
          ? h(
              "details.cc-history",
              h("summary", `Decision history (${k.decisions.length})`),
              h("ol.plain", k.decisions.map((d) => h("li", statusPill(d.decision), h("span.cc-current-by", ` ${d.decidedByName || "Not recorded"}, ${stamp(d.decidedAt)}`), d.note ? h("div.cc-history-note", d.note) : null))),
            )
          : null,
      ],
    });

    let matterCard;
    if (matterText) {
      matterCard = card({ title: "Matter", icon: "matters", body: h("a.cc-matter-link", { href: `#/matters/${k.matterId}` }, matterText) });
    } else {
      const matters = await loadMatters().catch(() => state.matters);
      const sel = select([{ value: "", label: "Choose a matter…" }, ...matters.map((m) => ({ value: m.id, label: [m.number, m.name].filter(Boolean).join(" ") }))], "", { "aria-label": "Matter to link" });
      matterCard = card({
        title: "Matter",
        icon: "matters",
        body: [
          h("p.cc-hint", "Not linked to a matter. Link it once the matter is opened, so the check is on that file."),
          h(
            "form.cc-link-form",
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
            button("Link", { type: "submit" }),
          ),
        ],
      });
    }

    const flagged = k.results.some((x) => x.concerns?.length);
    replace(
      page,
      pageHeader({
        title: `Conflict check no. ${k.id}`,
        breadcrumbs: [{ label: "Conflict check", href: "#/conflicts" }, { label: "Saved checks", href: "#/conflicts/history" }, { label: `No. ${k.id}` }],
        subtitle: [`Run ${stamp(k.runAt)} by ${k.runByName || "someone not recorded"}`, matterText ? `for ${matterText}` : "not linked to a matter"].join(" · "),
        meta: [statusPill(k.decision)],
        actions: [
          button("Print report", { icon: "file-text", href: `/api/conflict-checks/${k.id}/report`, target: "_blank", rel: "noopener" }),
          button("Save report", { href: `/api/conflict-checks/${k.id}/report?download=1` }),
          button("Check again", { icon: "rotate-ccw", href: `#/conflicts?from=${k.id}` }),
        ],
      }),
      h(
        "div.cc-grid",
        h(
          "div.cc-main",
          card({
            title: "Names searched",
            icon: "users",
            body: h(
              "ul.plain.cc-searched",
              k.terms.map((t) => h("li", h("span.cc-searched-name", t.name), h("span.cc-searched-role", [t.kind === "company" ? "Company" : t.kind === "person" ? "Person" : null, roleLabel(t.role) || "Role not stated"].filter(Boolean).join(" · ")))),
            ),
          }),
          card({
            title: "What the search found",
            subtitle: countsText(k.counts),
            icon: "search",
            body: [flagged ? callout({ tone: "danger", title: "Needs a lawyer's review", body: "At least one name is already involved with the firm in a way that may conflict. Read the matches below before deciding." }) : null, hitList(k.results)],
          }),
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
  useStyles("contacts");
  const f = { decision: "", q: "", from: "", to: "", linked: "", hits: "" };
  let seq = 0;

  async function load() {
    const my = ++seq;
    const qs = new URLSearchParams();
    for (const [key, v] of Object.entries(f)) if (v) qs.set(key, v);
    qs.set("limit", "500");
    const rows = await get(`/conflict-checks?${qs}`);
    if (my !== seq) return;
    table.setRows(rows);
  }

  const seg = segmented(
    [
      { value: "", label: "All" },
      { value: "pending", label: "Awaiting decision" },
      { value: "cleared", label: "Cleared" },
      { value: "waived", label: "Waived" },
      { value: "declined", label: "Declined" },
    ],
    f.decision,
    (v) => ((f.decision = v), load()),
    { label: "Decision" },
  );
  let t;
  // Searched on the server, so names in notes and matters are found too.
  const search = h(
    "div.dt-search.cc-search",
    icon("search", { size: 16, class: "dt-search-icon" }),
    h("input.search.dt-search-input", {
      type: "search",
      placeholder: "Search names, matters and notes",
      "aria-label": "Search saved checks",
      "data-search": "",
      oninput: (e) => {
        f.q = e.target.value;
        clearTimeout(t);
        t = setTimeout(load, 200);
      },
    }),
  );
  const dateIn = (key, label) => h("label.cc-filter", h("span", label), h("input", { type: "date", "aria-label": label, onchange: (e) => ((f[key] = e.target.value), load()) }));
  const pick = (key, label, opts) => select(opts, "", { "aria-label": label, onchange: (e) => ((f[key] = e.target.value), load()) });

  const table = dataTable({
    rows: [],
    label: "Saved conflict checks",
    noun: ["saved check", "saved checks"],
    rowClass: () => "cc-row",
    rowHref: (k) => `#/conflicts/${k.id}`,
    sort: { key: "id", dir: "desc" },
    filters: [
      search,
      seg,
      h(
        "div.cc-filters",
        dateIn("from", "From"),
        dateIn("to", "To"),
        pick("linked", "Matter", [
          { value: "", label: "Any matter" },
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
    ],
    columns: [
      { key: "id", label: "No.", className: "nowrap cc-no", defaultDir: "desc", sort: (k) => k.id, render: (k) => h("a.cc-no-link", { href: `#/conflicts/${k.id}` }, `No. ${k.id}`) },
      {
        key: "names",
        label: "Names searched",
        primary: true,
        sort: (k) => k.terms[0]?.name || "",
        render: (k) => h("div.cell-stack", k.terms.map((x, i) => h(i ? "span.cell-sub" : "span.cell-title", x.name, x.roleLabel ? h("span.cc-role", ` · ${x.roleLabel}`) : null))),
      },
      { key: "run", label: "Run", className: "nowrap", defaultDir: "desc", sort: (k) => k.runAt, render: (k) => h("div.cell-stack", h("span", shortDate(k.runAt)), k.runByName ? h("span.cell-sub", k.runByName) : null) },
      {
        key: "matter",
        label: "Matter",
        hideOnPhone: true,
        sort: (k) => k.matterNumber || k.matterName || "",
        render: (k) => (k.matterId ? h("a", { href: `#/matters/${k.matterId}` }, k.matterNumber ? h("span.matter-num", k.matterNumber) : null, " ", k.matterName || "") : h("span.muted", "Not linked")),
      },
      {
        key: "result",
        label: "Result",
        sort: (k) => -(((k.counts?.strong || 0) * 100) + ((k.counts?.possible || 0) * 10) + (k.counts?.weak || 0)),
        render: (k) => h("span" + (k.counts?.strong ? ".cc-result-strong" : ""), countsText(k.counts)),
      },
      { key: "decision", label: "Decision", sort: (k) => decisionLabel(k.decision), render: (k) => statusPill(k.decision) },
    ],
    empty: emptyState({ icon: "conflicts", title: "No saved checks match", body: "Try another decision, date or result, or clear the search.", compact: true }),
  });

  await load();
  return h(
    "div.page.cc-page",
    pageHeader({ title: "Saved conflict checks", subtitle: "Every check run, what it found and what was decided.", actions: [viewSwitch("#/conflicts/history")] }),
    card({ flush: true, className: "table-card", body: table }),
  );
}
