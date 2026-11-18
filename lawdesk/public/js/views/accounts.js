// Settings > Sign-in and access: who can sign in, at what level, and help for people who
// are locked out. Administrators only (the server enforces it too).

import { h, replace, select, modal, toast, fmtTime } from "../dom.js";
import { get, post, patch } from "../api.js";
import { state } from "../state.js";
import { card, field, button, pill, person, callout, loadingBlock } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { menu } from "../ui/popover.js";
import { iconButton } from "../ui/components.js";

/** A readable temporary password, e.g. "kx7m-9pqr-t2vw-h4nd" (about 80 bits). */
export function suggestPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{4}/g).join("-");
}

function tempPasswordInput() {
  const input = h("input.mono-input", { required: true, minlength: 12, maxlength: 200, autocomplete: "off", value: suggestPassword(), "aria-label": "Temporary password" });
  const again = button("Suggest another", { size: "sm", onclick: () => (input.value = suggestPassword()) });
  return { input, el: field("Temporary password", h("div.temp-pw", input, again), { hint: "They choose their own when they first sign in. Give it to them in person or by phone, not by email." }) };
}

const INTRO =
  "Administrators can change firm settings and manage accounts. Attorneys and staff can work on every matter that isn't restricted. The client level is reserved for a future client portal and can't see firm work.";

export function accountsSection() {
  const body = h("div.accounts-body");
  const addBtn = button("Add someone", { variant: "primary", size: "sm", icon: "user-plus", onclick: () => inviteDialog() });
  const sec = card({
    id: "s-accounts",
    className: "settings-card",
    title: "Sign-in and access",
    subtitle: INTRO,
    icon: "lock",
    actions: state.account?.role === "admin" ? addBtn : null,
    flush: true,
    body,
  });
  if (state.account?.role !== "admin") {
    replace(body, h("div.accounts-pad", callout({ tone: "info", body: "Only an administrator can add sign-in accounts or change who has access." })));
    return sec;
  }
  replace(body, h("div.accounts-pad", loadingBlock("Loading sign-in accounts")));

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
      replace(body, h("div.accounts-pad", callout({ tone: "danger", title: "Couldn't load sign-in accounts.", body: err.message })));
      return;
    }
    roles = data.roles;
    const rows = data.accounts.filter((p) => p.active || p.account);
    replace(
      body,
      dataTable({
        columns: [
          {
            key: "name",
            label: "Person",
            primary: true,
            sort: (p) => p.name,
            render: (p) => h("div.acct-person", person(p.name, p.account ? p.account.email : p.email || "No sign-in email"), p.userId === state.account?.id ? h("span.acct-you", "You") : null),
          },
          { key: "role", label: "Access", sortable: false, render: (p) => roleCell(p) },
          { key: "status", label: "Status", sortable: false, render: (p) => status(p.account) },
          { key: "actions", label: "", sortable: false, className: "acct-actions-cell", render: (p) => actions(p) },
        ],
        rows,
        rowKey: (p) => p.userId,
        rowClass: (p) => (p.account?.disabled ? "inactive" : ""),
        toolbar: false,
        tableClass: "accounts-table",
        label: "Sign-in accounts",
        noun: ["person", "people"],
        sort: { key: "name", dir: "asc" },
      }),
    );
  }

  function roleCell(p) {
    const a = p.account;
    if (!a) return h("span.muted", "—");
    return select(roles, a.role, {
      "aria-label": `Access for ${p.name}`,
      class: "acct-role",
      onchange: (e) => act(() => patch(`/auth/accounts/${p.userId}`, { role: e.target.value }), `${p.name}: access changed`),
    });
  }

  function status(a) {
    if (!a) return h("div.acct-status", pill("No sign-in", "neutral"));
    const main = a.disabled
      ? pill("Turned off", "neutral")
      : a.locked
        ? pill("Locked", "danger")
        : a.mustChangePassword
          ? pill("Temporary password", "warning")
          : pill("Active", "success");
    return h(
      "div.acct-status",
      h("div.acct-pills", main, a.twoFactor ? pill("Two-step", "info", { dot: false }) : null),
      h("span.acct-last", a.lastSignInAt ? `Last signed in ${fmtTime(a.lastSignInAt)}` : "Hasn't signed in yet"),
    );
  }

  function actions(p) {
    const a = p.account;
    const self = p.userId === state.account?.id;
    if (!a) return h("div.acct-actions", button("Give sign-in", { size: "sm", onclick: () => giveDialog(p) }));
    const items = [
      { label: "Reset password", icon: "lock", onSelect: () => resetDialog(p) },
      a.locked ? { label: "Unlock", icon: "rotate-ccw", onSelect: () => act(() => post(`/auth/accounts/${p.userId}/unlock`), `${p.name} can sign in again`) } : null,
      a.sessions && !self ? { label: "Sign out everywhere", icon: "log-out", onSelect: () => act(() => post(`/auth/accounts/${p.userId}/sign-out`), `Signed ${p.name} out everywhere`) } : null,
      self
        ? null
        : a.disabled
          ? { label: "Turn sign-in back on", icon: "circle-check", onSelect: () => act(() => patch(`/auth/accounts/${p.userId}`, { disabled: false }), `${p.name} can sign in again`) }
          : {
              label: "Turn off sign-in",
              icon: "x",
              danger: true,
              onSelect: () =>
                confirm(`Turn off sign-in for ${p.name}? They'll be signed out now. Their work and history stay.`) &&
                act(() => patch(`/auth/accounts/${p.userId}`, { disabled: true }), `${p.name} can no longer sign in`),
            },
    ].filter(Boolean);
    const more = iconButton("more", `More actions for ${p.name}`, { size: "sm", "aria-haspopup": "menu", onclick: (e) => menu(e.currentTarget, items, `Actions for ${p.name}`) });
    return h(
      "div.acct-actions",
      a.locked ? button("Unlock", { size: "sm", onclick: () => act(() => post(`/auth/accounts/${p.userId}/unlock`), `${p.name} can sign in again`) }) : button("Reset password", { size: "sm", onclick: () => resetDialog(p) }),
      more,
    );
  }

  function formDialog(title, subtitle, fields, submitLabel, onSubmit) {
    const submit = button(submitLabel, { variant: "primary", type: "submit" });
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await onSubmit();
            dlg.close();
          } catch (err) {
            fail(err);
          }
        },
      },
      fields,
      h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), submit),
    );
    const dlg = modal(title, form, { subtitle });
    return dlg;
  }

  function giveDialog(p) {
    const email = h("input", { type: "email", required: true, maxlength: 200, value: p.email || "" });
    const role = select(roles, p.defaultRole === "attorney" ? "attorney" : "staff");
    const pw = tempPasswordInput();
    formDialog(`Give ${p.name} a sign-in`, null, [field("Sign-in email", email), field("Access", role), pw.el], "Create sign-in", async () => {
      await post("/auth/accounts", { userId: p.userId, email: email.value, role: role.value, temporaryPassword: pw.input.value });
      toast([`${p.name} can now sign in`, "Give them the temporary password in person or by phone, not by email."], { ms: 10000 });
      await load();
    });
  }

  function resetDialog(p) {
    const pw = tempPasswordInput();
    const off = h("input", { type: "checkbox" });
    formDialog(
      `Reset ${p.name}'s password`,
      "They'll be signed out and choose their own password when they next sign in.",
      [pw.el, p.account.twoFactor ? h("label.check-line", off, h("span", "Also turn off two-step sign-in (they lost their phone and their recovery codes)")) : null],
      "Set temporary password",
      async () => {
        await post(`/auth/accounts/${p.userId}/password`, { temporaryPassword: pw.input.value, turnOffTwoFactor: off.checked });
        toast([`New temporary password set for ${p.name}`, "They've been signed out and will choose their own password when they sign in."], { ms: 10000 });
        await load();
      },
    );
  }

  function inviteDialog() {
    const name = h("input", { required: true, maxlength: 200 });
    const email = h("input", { type: "email", required: true, maxlength: 200 });
    const role = select(roles, "staff");
    const pw = tempPasswordInput();
    formDialog(
      "Add someone with a sign-in",
      "Adds the person to the firm and creates their sign-in in one step.",
      [h("div.form-row", field("Name", name), field("Email address", email)), field("Access", role), pw.el],
      "Add and create sign-in",
      async () => {
        await post("/auth/accounts", { name: name.value, email: email.value, role: role.value, temporaryPassword: pw.input.value });
        window.dispatchEvent(new Event("lawdesk:setup"));
        toast(`Added ${name.value}. Give them the temporary password in person or by phone.`);
        await load();
      },
    );
  }

  load();
  return sec;
}
