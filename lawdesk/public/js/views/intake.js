// The conflict-check step of the New matter dialog: other parties to enter, a check on
// the client and those parties before the matter opens, and the decision that must be
// recorded to go on. The saved check is linked to the new matter and the parties added.

import { h, select, toast } from "../dom.js";
import { post, patch } from "../api.js";
import { hitList, decisionChoices, decisionProblem, countsText } from "./conflicts.js";
import { button, iconButton, useStyles } from "../ui/components.js";
import { icon } from "../ui/icons.js";

const PARTY_ROLES = [
  { value: "adverse_party", label: "Adverse party" },
  { value: "opposing_counsel", label: "Opposing counsel" },
  { value: "co_party", label: "Co-party" },
  { value: "related_party", label: "Related party" },
  { value: "witness", label: "Witness" },
];

let seq = 0;

/**
 * client(): { name, kind, contactId } or null, read from the dialog's client fields.
 * submit: the dialog's submit button, whose label this step keeps up to date.
 * onDeclined: called after a "declined" decision is recorded (the dialog closes).
 */
export function intakeConflicts({ client, submit, onDeclined, contacts }) {
  useStyles("contacts");
  const listId = `intake-contacts-${++seq}`;
  const rows = h("ol.intake-parties");
  let check = null; // the saved check, once run
  let checkedKey = null; // the names it was run on
  let recorded = null; // "decision|note" already sent

  const decide = decisionChoices({ name: `intake-decision-${seq}`, onChange: () => sync() });
  const results = h("div.intake-results");
  const status = h("p.intake-status");
  const err = h("p.error-text", { role: "alert" });
  const panel = h("section.intake-panel", { hidden: true, "aria-live": "polite" }, h("h3.intake-panel-title", icon("conflicts", { size: 16 }), "Conflict check"), status, results, decide.el, err);

  function partyRow(p = {}) {
    const name = h("input", { list: listId, placeholder: "Name", maxlength: 200, autocomplete: "off", "aria-label": "Party name", value: p.name || "" });
    const kind = select(
      [
        { value: "company", label: "Company" },
        { value: "person", label: "Person" },
      ],
      p.kind || "person",
      { "aria-label": "Person or company" },
    );
    const role = select(PARTY_ROLES, p.role || "adverse_party", { "aria-label": "Role" });
    const row = h("li.intake-party", name, kind, role, iconButton("x", "Remove this party", { size: "sm", variant: "danger", onclick: () => (row.remove(), sync()) }));
    const known = () => contacts.find((c) => c.name.toLowerCase() === name.value.trim().toLowerCase());
    name.addEventListener("input", () => {
      const c = known();
      if (c) kind.value = c.kind;
    });
    row.read = () => {
      const c = known();
      return { name: name.value.trim(), kind: c ? c.kind : kind.value, role: role.value, contactId: c ? c.id : null };
    };
    return row;
  }

  const partiesField = h(
    "fieldset.intake-fieldset",
    h("legend", "Other parties"),
    h("p.intake-hint", "The other side, their lawyers and anyone else involved. They are checked for conflicts with the client before the matter opens."),
    rows,
    h("datalist", { id: listId }, contacts.map((c) => h("option", { value: c.name }))),
    h("div", button("Add a party", { size: "sm", variant: "ghost", icon: "plus", onclick: () => (rows.append(partyRow()), rows.lastElementChild.querySelector("input").focus(), sync()) })),
  );
  rows.append(partyRow());

  const parties = () => [...rows.children].map((r) => r.read()).filter((p) => p.name);
  function terms() {
    const t = [];
    const c = client();
    if (c?.name) t.push({ name: c.name, kind: c.kind || null, role: "client", contactId: c.contactId ?? null });
    for (const p of parties()) t.push({ name: p.name, kind: p.kind, role: p.role, contactId: p.contactId });
    return t;
  }
  const keyOf = (t) => JSON.stringify(t.map((x) => [x.name.toLowerCase(), x.kind, x.role]));
  const current = () => check && checkedKey === keyOf(terms());

  function sync() {
    const t = terms();
    if (!t.length) {
      submit.textContent = "Open matter";
      panel.hidden = true;
      return;
    }
    if (!current()) {
      submit.textContent = "Check for conflicts";
      if (check) {
        status.textContent = "The names have changed since the check. Check again before opening the matter.";
        status.className = "intake-status cc-warn";
        results.hidden = decide.el.hidden = true;
      }
      return;
    }
    results.hidden = decide.el.hidden = false;
    submit.textContent = decide.value() === "declined" ? "Record decision (matter not opened)" : "Open matter";
  }

  async function run() {
    const t = terms();
    submit.disabled = true;
    submit.textContent = "Checking…";
    try {
      check = await post("/conflict-checks", { terms: t.map(({ contactId, ...x }) => x) });
      checkedKey = keyOf(t);
      recorded = null;
      panel.hidden = false;
      status.className = "intake-status";
      status.textContent = `Saved as check no. ${check.id}. ${countsText(check.counts)}. Record a decision to go on.`;
      // Contacts picked from the list match themselves; say so briefly unless something is flagged.
      const picked = new Set(t.map((x) => x.contactId).filter(Boolean));
      const own = check.results.filter((x) => picked.has(x.contactId) && !x.concerns?.length && x.match === "direct");
      const rest = check.results.filter((x) => !own.includes(x));
      results.replaceChildren(
        ...(own.length
          ? [h(
              "div.intake-own",
              h("p.intake-own-title", icon("circle-check", { size: 14 }), "Already on file, nothing flagged"),
              h("ul.plain.intake-own-list", own.map((x) => h("li", h("a", { href: `#/contacts/${x.contactId}`, target: "_blank" }, x.name), x.involvements?.length ? h("span.muted", ` · ${x.involvements.map((i) => `${i.text}`).join("; ")}`) : null))),
            )]
          : []),
        ...(rest.length || !own.length ? [hitList(rest, { compact: true })] : []),
      );
      panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } finally {
      submit.disabled = false;
      sync();
    }
  }

  return {
    partiesField,
    panel,
    /** Wire up to the dialog's form so edits mark the check out of date. */
    bind(form) {
      form.addEventListener("input", sync);
      form.addEventListener("change", sync);
      sync();
    },
    /** Called on submit. Resolves true when the matter may be opened now. */
    async beforeOpen() {
      err.textContent = "";
      if (!terms().length) return true;
      if (!current()) {
        await run();
        return false;
      }
      const value = decide.value();
      const note = decide.note();
      const problem = decisionProblem(value, note);
      if (problem) {
        err.textContent = problem;
        return false;
      }
      if (recorded !== `${value}|${note}`) {
        await post(`/conflicts/checks/${check.id}/decision`, { decision: value, note: note || null });
        recorded = `${value}|${note}`;
      }
      if (value === "declined") {
        toast([`Conflict check no. ${check.id} recorded as declined`, "The matter was not opened."]);
        onDeclined?.();
        return false;
      }
      return true;
    },
    /** After the matter is created: link the check and record the parties. */
    async afterOpen(matter) {
      const problems = [];
      if (check) {
        try {
          await patch(`/conflicts/checks/${check.id}`, { matterId: matter.id });
        } catch (ex) {
          problems.push(ex.message);
        }
      }
      for (const p of parties()) {
        try {
          let id = p.contactId;
          if (!id) id = (await post("/contacts", { name: p.name, kind: p.kind })).id;
          await post(`/conflicts/matters/${matter.id}/parties`, { contactId: id, role: p.role });
        } catch (ex) {
          problems.push(`${p.name}: ${ex.message}`);
        }
      }
      if (problems.length) toast(["Some parties could not be added", ...problems], { error: true });
    },
  };
}
