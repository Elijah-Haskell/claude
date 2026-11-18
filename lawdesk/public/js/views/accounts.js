// Settings > Sign-in and access: who can sign in, at what level, and help for people who
// are locked out. Administrators only (the server enforces it too).

import { h, replace, select, modal, toast, fmtTime } from "../dom.js";
import { get, post, patch } from "../api.js";
import { state } from "../state.js";

/** A readable temporary password, e.g. "kx7m-9pqr-t2vw-h4nd" (about 80 bits). */
export function suggestPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{4}/g).join("-");
}

function tempPasswordInput() {
  const input = h("input", { required: true, minlength: 12, maxlength: 200, autocomplete: "off", value: suggestPassword(), "aria-label": "Temporary password" });
  const again = h("button.btn.small", { type: "button", onclick: () => (input.value = suggestPassword()) }, "Suggest another");
  return { input, el: h("label", h("span", "Temporary password (they choose their own when they first sign in)"), h("div.temp-pw", input, again)) };
}

export function accountsSection() {
  const card = h("section.card#s-accounts", h("h2", "Sign-in and access"));
  if (state.account?.role !== "admin") {
    card.append(h("p.muted", "Only an administrator can add sign-in accounts or change who has access."));
    return card;
  }
  const body = h("div", h("p.muted", "Loading…"));
  card.append(
    h(
      "p.muted",
      "Administrators can change firm settings and manage accounts. Attorneys and staff can work on every matter that isn't restricted. ",
      "The client level is reserved for a future client portal and can't see firm work.",
    ),
    body,
  );

  let roles = [];
  const fail = (err) => toast(err.message, { error: true });
  async function act(fn, message) {
    try {
      await fn();
      if (message) toast(message);
    } catch (err) {
      fail(err);
    }
    await load();
  }

  async function load() {
    let data;
    try {
      data = await get("/auth/accounts");
    } catch (err) {
      replace(body, h("p.error-text", err.message));
      return;
    }
    roles = data.roles;
    const rows = data.accounts.filter((p) => p.active || p.account);
    replace(
      body,
      h(
        "table.settings-table.accounts-table",
        h("thead", h("tr", h("th", "Person"), h("th", "Sign-in email"), h("th", "Access"), h("th", "Status"), h("th", ""))),
        h("tbody", rows.map(row)),
      ),
      inviteForm(),
    );
  }

  function status(a) {
    if (!a) return h("span.muted", "No sign-in");
    const bits = [];
    if (a.disabled) bits.push(h("span.tag.acct-off", "Turned off"));
    else if (a.locked) bits.push(h("span.tag.acct-locked", "Locked"));
    else if (a.mustChangePassword) bits.push(h("span.tag", "Temporary password"));
    else bits.push(h("span.tag.acct-ok", "Active"));
    if (a.twoFactor) bits.push(h("span.tag", "Two-step"));
    return h("div.acct-status", bits, h("div.muted.small", a.lastSignInAt ? `Last signed in ${fmtTime(a.lastSignInAt)}` : "Hasn't signed in yet"));
  }

  function row(p) {
    const a = p.account;
    const self = p.userId === state.account?.id;
    const roleSelect = a
      ? select(roles, a.role, {
          "aria-label": `Access for ${p.name}`,
          onchange: (e) => act(() => patch(`/auth/accounts/${p.userId}`, { role: e.target.value }), `${p.name}: access changed`),
        })
      : null;
    const actions = a
      ? [
          h("button.btn.small", { type: "button", onclick: () => resetDialog(p) }, "Reset password"),
          a.locked ? h("button.btn.small", { type: "button", onclick: () => act(() => post(`/auth/accounts/${p.userId}/unlock`), `${p.name} can sign in again`) }, "Unlock") : null,
          a.sessions && !self
            ? h("button.btn.small", { type: "button", onclick: () => act(() => post(`/auth/accounts/${p.userId}/sign-out`), `Signed ${p.name} out everywhere`) }, "Sign out everywhere")
            : null,
          self
            ? null
            : h(
                "button.btn.small" + (a.disabled ? "" : ".danger-text"),
                {
                  type: "button",
                  onclick: () =>
                    (a.disabled || confirm(`Turn off sign-in for ${p.name}? They'll be signed out now. Their work and history stay.`)) &&
                    act(() => patch(`/auth/accounts/${p.userId}`, { disabled: !a.disabled }), a.disabled ? `${p.name} can sign in again` : `${p.name} can no longer sign in`),
                },
                a.disabled ? "Turn on" : "Turn off",
              ),
        ]
      : [h("button.btn.small", { type: "button", onclick: () => giveDialog(p) }, "Give sign-in")];
    return h(
      "tr" + (a?.disabled ? ".inactive" : ""),
      h("td", { "data-label": "Person" }, p.name, self ? h("span.muted.small", " (you)") : null),
      h("td", { "data-label": "Sign-in email" }, a ? a.email : h("span.muted", p.email || "")),
      h("td", { "data-label": "Access" }, roleSelect ?? h("span.muted", "")),
      h("td", { "data-label": "Status" }, status(a)),
      h("td.acct-actions", actions),
    );
  }

  function giveDialog(p) {
    const email = h("input", { type: "email", required: true, maxlength: 200, value: p.email || "", "aria-label": "Sign-in email" });
    const role = select(roles, p.defaultRole === "attorney" ? "attorney" : "staff", { "aria-label": "Access" });
    const pw = tempPasswordInput();
    const dlg = modal(
      `Give ${p.name} a sign-in`,
      h(
        "form.modal-body.form-grid",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await post("/auth/accounts", { userId: p.userId, email: email.value, role: role.value, temporaryPassword: pw.input.value });
              dlg.close();
              toast([`${p.name} can now sign in`, "Give them the temporary password in person or by phone, not by email."], { ms: 10000 });
              await load();
            } catch (err) {
              fail(err);
            }
          },
        },
        h("label", h("span", "Sign-in email"), email),
        h("label", h("span", "Access"), role),
        pw.el,
        h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Create sign-in")),
      ),
    );
  }

  function resetDialog(p) {
    const pw = tempPasswordInput();
    const off = h("input", { type: "checkbox" });
    const dlg = modal(
      `Reset ${p.name}'s password`,
      h(
        "form.modal-body.form-grid",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await post(`/auth/accounts/${p.userId}/password`, { temporaryPassword: pw.input.value, turnOffTwoFactor: off.checked });
              dlg.close();
              toast([`New temporary password set for ${p.name}`, "They've been signed out and will choose their own password when they sign in."], { ms: 10000 });
              await load();
            } catch (err) {
              fail(err);
            }
          },
        },
        pw.el,
        p.account.twoFactor ? h("label.check-line", off, h("span", "Also turn off two-step sign-in (they lost their phone and their recovery codes)")) : null,
        h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Set temporary password")),
      ),
    );
  }

  function inviteForm() {
    const name = h("input", { placeholder: "Name", "aria-label": "New person's name", required: true, maxlength: 200 });
    const email = h("input", { type: "email", placeholder: "Email address", "aria-label": "New person's email", required: true, maxlength: 200 });
    const role = select(roles, "staff", { "aria-label": "New person's access" });
    const pw = tempPasswordInput();
    return h(
      "form.invite-form.form-grid",
      {
        onsubmit: (e) => {
          e.preventDefault();
          act(async () => {
            await post("/auth/accounts", { name: name.value, email: email.value, role: role.value, temporaryPassword: pw.input.value });
            window.dispatchEvent(new Event("lawdesk:setup"));
          }, `Added ${name.value}. Give them the temporary password in person or by phone.`);
        },
      },
      h("h3", "Add someone with a sign-in"),
      h("div.form-row", h("label", h("span", "Name"), name), h("label", h("span", "Email address"), email), h("label", h("span", "Access"), role)),
      pw.el,
      h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Add and create sign-in")),
    );
  }

  load();
  return card;
}
