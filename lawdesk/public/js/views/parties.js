// The matter page's "Parties" and "Conflict check" cards.

import { h, select, toast, replace } from "../dom.js";
import { get, post, del } from "../api.js";
import { ROLE_OPTIONS, roleLabel, statusPill, stamp } from "./conflicts.js";
import { contactPicker, forgetContacts } from "./contacts.js";
import { card, button, iconButton, useStyles } from "../ui/components.js";

/** Returns [partiesCard, conflictCard]; both load themselves and refresh each other. */
export function matterConflictCards(matterId, { onChange } = {}) {
  useStyles("contacts");
  const partiesBody = h("div.parties-body", h("p.muted", "Loading…"));
  const checkBody = h("div.cc-status-body", h("p.muted", "Loading…"));
  const partiesBox = card({ title: "Parties", icon: "users", className: "parties-card", body: partiesBody });
  const checkBox = card({ title: "Conflict check", icon: "conflicts", className: "cc-status-card", body: checkBody });
  let parties = [];
  const fail = (err) => toast(err.message, { error: true });

  async function load() {
    try {
      const [ps, checks] = await Promise.all([get(`/conflicts/matters/${matterId}/parties`), get(`/conflict-checks?matterId=${matterId}&limit=20`)]);
      parties = ps;
      await drawParties();
      drawCheck(checks);
    } catch (err) {
      replace(partiesBody, h("p.error-text", err.message));
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
      h("div.form-actions", button("Cancel", { size: "sm", onclick: () => ((form.hidden = true), (addBtn.hidden = false)) }), button("Add party", { size: "sm", variant: "primary", type: "submit" })),
    );
    const addBtn = button("Add a party", { size: "sm", variant: "ghost", icon: "plus", class: "party-add", onclick: () => ((form.hidden = false), (addBtn.hidden = true), picker.input.focus()) });
    replace(
      partiesBody,
      parties.length
        ? h(
            "ul.plain.party-list",
            parties.map((p) =>
              h(
                "li",
                h("span.party-who", h("a", { href: `#/contacts/${p.contact_id}` }, p.contact_name), h("span.party-role", roleLabel(p.role) + (p.note && p.id ? ` · ${p.note}` : ""))),
                p.id
                  ? iconButton("x", `Remove ${p.contact_name} from this matter`, {
                      size: "sm",
                      variant: "danger",
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
                    })
                  : null,
              ),
            ),
          )
        : h("p.party-empty", "No parties recorded."),
      addBtn,
      form,
    );
  }

  function drawCheck(checks) {
    const latest = checks[0];
    const runNew = button(latest ? "Run a new check" : "Run conflict check", {
      size: "sm",
      variant: latest ? "secondary" : "primary",
      icon: "search",
      onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const k = await post("/conflict-checks", { matterId });
            location.hash = `#/conflicts/${k.id}`;
          } catch (ex) {
            fail(ex);
            runNew.disabled = false;
          }
      },
    });
    if (!latest) {
      replace(checkBody, h("div.cc-current", statusPill(null)), h("p.cc-status-text", "No conflict check is on file for this matter. A new check searches the client and every party above."), h("div.cc-card-actions", runNew));
      return;
    }
    const newer = parties.filter((p) => p.created_at && p.created_at > latest.runAt);
    replace(
      checkBody,
      h("div.cc-current", statusPill(latest.decision), h("a.cc-check-link", { href: `#/conflicts/${latest.id}` }, `Check no. ${latest.id}`)),
      h("p.cc-status-text", `Run ${stamp(latest.runAt)}${latest.runByName ? ` by ${latest.runByName}` : ""}. ${latest.counts && (latest.counts.strong || latest.counts.possible || latest.counts.weak) ? "Found " + ["strong", "possible", "weak"].filter((b) => latest.counts[b]).map((b) => `${latest.counts[b]} ${b}`).join(", ") + "." : "No matches."}`),
      latest.decision ? h("p.cc-status-text", `${latest.decision === "cleared" ? "Cleared" : latest.decision === "waived" ? "Waived" : "Declined"} by ${latest.decidedByName || "someone not recorded"}${latest.decisionNote ? `: ${latest.decisionNote}` : ""}`) : null,
      newer.length ? h("p.cc-warn", `${newer.map((p) => p.contact_name).join(", ")} ${newer.length === 1 ? "was" : "were"} added after this check.`) : null,
      checks.length > 1 ? h("p.cc-status-text", `${checks.length - 1} earlier ${checks.length === 2 ? "check" : "checks"} on file.`) : null,
      h("div.cc-card-actions", runNew, button("Print report", { size: "sm", variant: "ghost", icon: "file-text", href: `/api/conflict-checks/${latest.id}/report`, target: "_blank", rel: "noopener" })),
    );
  }

  load();
  return [partiesBox, checkBox];
}
