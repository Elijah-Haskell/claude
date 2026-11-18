// The matter page's "Parties" and "Conflict check" cards.

import { h, select, toast, replace } from "../dom.js";
import { get, post, del } from "../api.js";
import { ROLE_OPTIONS, roleLabel, statusPill, stamp } from "./conflicts.js";
import { contactPicker, forgetContacts } from "./contacts.js";

/** Returns [partiesCard, conflictCard]; both load themselves and refresh each other. */
export function matterConflictCards(matterId, { onChange } = {}) {
  const partiesBox = h("section.card.parties-card", h("h2", "Parties"), h("p.muted", "Loading…"));
  const checkBox = h("section.card.cc-status-card", h("h2", "Conflict check"), h("p.muted", "Loading…"));
  let parties = [];
  const fail = (err) => toast(err.message, { error: true });

  async function load() {
    try {
      const [ps, checks] = await Promise.all([get(`/conflicts/matters/${matterId}/parties`), get(`/conflict-checks?matterId=${matterId}&limit=20`)]);
      parties = ps;
      await drawParties();
      drawCheck(checks);
    } catch (err) {
      replace(partiesBox, h("h2", "Parties"), h("p.error-text", err.message));
    }
  }

  async function drawParties() {
    const picker = await contactPicker({ label: "Party" });
    const role = select(ROLE_OPTIONS.filter((o) => o.value !== "prospective_client"), "adverse_party", { "aria-label": "Role" });
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.party-form",
      {
        hidden: true,
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = "";
          try {
            const contactId = await picker.resolve();
            await post(`/conflicts/matters/${matterId}/parties`, { contactId, role: role.value });
            forgetContacts();
            toast(`Added ${picker.input.value.trim()} as ${roleLabel(role.value).toLowerCase()}`);
            await load();
            onChange?.();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      picker.el,
      role,
      err,
      h("div.form-actions", h("button.btn.small", { type: "button", onclick: () => ((form.hidden = true), (addBtn.hidden = false)) }, "Cancel"), h("button.btn.small.primary", { type: "submit" }, "Add party")),
    );
    const addBtn = h("button.btn.small", { type: "button", onclick: () => ((form.hidden = false), (addBtn.hidden = true), picker.input.focus()) }, "Add a party");
    replace(partiesBox, 
      h("h2", "Parties"),
      parties.length
        ? h(
            "ul.plain.party-list",
            parties.map((p) =>
              h(
                "li",
                h("span.party-who", h("a", { href: `#/contacts/${p.contact_id}` }, p.contact_name), h("span.muted.small", roleLabel(p.role) + (p.note && p.id ? ` · ${p.note}` : ""))),
                p.id
                  ? h(
                      "button.icon-btn.danger",
                      {
                        type: "button",
                        "aria-label": `Remove ${p.contact_name}`,
                        title: "Remove from this matter",
                        onclick: async () => {
                          if (!confirm(`Remove ${p.contact_name} as ${roleLabel(p.role).toLowerCase()}?`)) return;
                          try {
                            await del(`/conflicts/parties/${p.id}`);
                            await load();
                            onChange?.();
                          } catch (ex) {
                            fail(ex);
                          }
                        },
                      },
                      "×",
                    )
                  : null,
              ),
            ),
          )
        : h("p.muted", "No parties recorded."),
      addBtn,
      form,
    );
  }

  function drawCheck(checks) {
    const latest = checks[0];
    const runNew = h(
      "button.btn.small" + (latest ? "" : ".primary"),
      {
        type: "button",
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const k = await post("/conflict-checks", { matterId });
            location.hash = `#/conflicts/${k.id}`;
          } catch (ex) {
            fail(ex);
            e.currentTarget.disabled = false;
          }
        },
      },
      latest ? "Run a new check" : "Run conflict check",
    );
    if (!latest) {
      replace(checkBox, h("h2", "Conflict check"), h("p", statusPill(null)), h("p.muted.small", "No conflict check is on file for this matter. A new check searches the client and every party above."), runNew);
      return;
    }
    const newer = parties.filter((p) => p.created_at && p.created_at > latest.runAt);
    replace(checkBox, 
      h("h2", "Conflict check"),
      h("div.cc-current", statusPill(latest.decision), h("a.small", { href: `#/conflicts/${latest.id}` }, `Check no. ${latest.id}`)),
      h("p.muted.small", `Run ${stamp(latest.runAt)}${latest.runByName ? ` by ${latest.runByName}` : ""}. ${latest.counts && (latest.counts.strong || latest.counts.possible || latest.counts.weak) ? "Found " + ["strong", "possible", "weak"].filter((b) => latest.counts[b]).map((b) => `${latest.counts[b]} ${b}`).join(", ") + "." : "No matches."}`),
      latest.decision ? h("p.small", `${latest.decision === "cleared" ? "Cleared" : latest.decision === "waived" ? "Waived" : "Declined"} by ${latest.decidedByName || "someone not recorded"}${latest.decisionNote ? `: ${latest.decisionNote}` : ""}`) : null,
      newer.length ? h("p.cc-warn", `${newer.map((p) => p.contact_name).join(", ")} ${newer.length === 1 ? "was" : "were"} added after this check.`) : null,
      checks.length > 1 ? h("p.muted.small", `${checks.length - 1} earlier ${checks.length === 2 ? "check" : "checks"} on file.`) : null,
      h("div.cc-card-actions", runNew, h("a.btn.small", { href: `/api/conflict-checks/${latest.id}/report`, target: "_blank", rel: "noopener" }, "Print report")),
    );
  }

  load();
  return [partiesBox, checkBox];
}
