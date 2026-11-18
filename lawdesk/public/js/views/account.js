// My account: details, password, two-factor sign-in, and where you're signed in.

import { h, replace, toast, fmtTime } from "../dom.js";
import { get, post, del } from "../api.js";

export async function accountView() {
  const page = h("div.page.account-page");
  const fail = (err) => toast(err.message, { error: true });

  async function draw() {
    const me = await get("/auth/me");
    const u = me.user;
    replace(
      page,
      h("div.page-head", h("div", h("h1", "My account"), h("p.sub", "Your sign-in details and security."))),
      h("div.account-grid", details(u), password(u), twoFactor(u, me.recoveryCodesLeft), sessions(me.sessions)),
    );
  }

  function details(u) {
    return h(
      "section.card#a-details",
      h("h2", "Your details"),
      h(
        "dl.account-facts",
        h("dt", "Name"),
        h("dd", u.name),
        h("dt", "Email address"),
        h("dd", u.email),
        h("dt", "Access"),
        h("dd", u.roleLabel),
        h("dt", "Password last changed"),
        h("dd", u.passwordChangedAt ? fmtTime(u.passwordChangedAt) : "Not recorded"),
      ),
      h("p.muted.small", "To change your name, email address or access, ask the firm's administrator."),
    );
  }

  function password(u) {
    const cur = h("input", { type: "password", autocomplete: "current-password", required: true, maxlength: 200 });
    const next = h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 12, maxlength: 200 });
    const again = h("input", { type: "password", autocomplete: "new-password", required: true, maxlength: 200 });
    const form = h(
      "form.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          if (next.value !== again.value) return toast("The two new passwords don't match", { error: true });
          try {
            await post("/auth/password", { currentPassword: cur.value, newPassword: next.value });
            toast(["Password changed", "You've been signed out on your other devices."]);
            await draw();
          } catch (err) {
            fail(err);
          }
        },
      },
      h("label", h("span", "Current password"), cur),
      h("label", h("span", "New password (at least 12 characters)"), next),
      h("label", h("span", "New password again"), again),
      h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Change password")),
    );
    return h("section.card#a-password", h("h2", "Password"), form);
  }

  function twoFactor(u, left) {
    const card = h("section.card#a-2fa", h("h2", "Two-step sign-in"));
    if (!u.twoFactor) {
      card.append(
        h("p", "Ask for a code from your phone as well as your password when you sign in. Anyone who learns your password still can't get in without your phone."),
        h("p.muted.small", "You'll need an authenticator app, such as Microsoft Authenticator, Google Authenticator or 1Password."),
        h("div.form-actions", h("button.btn.primary", { type: "button", onclick: () => begin(card) }, "Turn on two-step sign-in")),
      );
      return card;
    }
    const pw = h("input", { type: "password", autocomplete: "current-password", required: true, maxlength: 200, "aria-label": "Your password" });
    const withPassword = async (fn) => {
      if (!pw.value) return toast("Enter your password first", { error: true });
      try {
        await fn(pw.value);
      } catch (err) {
        fail(err);
      }
    };
    card.append(
      h("p", h("span.status-on", "On."), " You'll be asked for a code from your phone each time you sign in."),
      h("p.muted.small", `${left} recovery code${left === 1 ? "" : "s"} left.`),
      h("label.form-grid", h("span", "Your password, to make changes"), pw),
      h(
        "div.form-actions",
        h(
          "button.btn",
          {
            type: "button",
            onclick: () =>
              withPassword(async (p) => {
                const r = await post("/auth/two-factor/recovery-codes", { password: p });
                showCodes(card, r.recoveryCodes);
              }),
          },
          "Make new recovery codes",
        ),
        h(
          "button.btn.danger-text",
          {
            type: "button",
            onclick: () =>
              withPassword(async (p) => {
                if (!confirm("Turn off two-step sign-in? Your password alone will be enough to sign in.")) return;
                await post("/auth/two-factor/disable", { password: p });
                toast("Two-step sign-in is off");
                await draw();
              }),
          },
          "Turn off",
        ),
      ),
    );
    return card;
  }

  async function begin(card) {
    let s;
    try {
      s = await post("/auth/two-factor/setup");
    } catch (err) {
      return fail(err);
    }
    const code = h("input#a-2fa-code", { inputmode: "numeric", autocomplete: "one-time-code", required: true, maxlength: 10 });
    replace(
      card,
      h("h2", "Two-step sign-in"),
      h(
        "ol.setup-steps",
        h("li", "Open your authenticator app and add an account. On this phone you can ", h("a", { href: s.uri }, "open it directly"), "; otherwise choose to enter a key."),
        h("li", "Enter this key (spaces don't matter):", h("div.setup-key", { "aria-label": "Set-up key" }, s.key), h("span.muted.small", "Account: Lawdesk. Type: time-based.")),
        h("li", "Type the six-digit code the app shows."),
      ),
      h(
        "form.form-grid",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const r = await post("/auth/two-factor/enable", { code: code.value });
              toast("Two-step sign-in is on");
              showCodes(card, r.recoveryCodes);
            } catch (err) {
              fail(err);
            }
          },
        },
        h("label", h("span", "Code from the app"), code),
        h("div.form-actions", h("button.btn", { type: "button", onclick: () => draw() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Turn on")),
      ),
    );
    code.focus();
  }

  function showCodes(card, codes) {
    replace(
      card,
      h("h2", "Your recovery codes"),
      h("p", "If you lose your phone, each of these codes lets you sign in once instead of a code from the app. Print them or write them down and keep them somewhere safe. They won't be shown again."),
      h("ul.recovery-codes", codes.map((c) => h("li", c))),
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => window.print() }, "Print"), h("button.btn.primary", { type: "button", onclick: () => draw() }, "I've saved them")),
    );
  }

  function sessions(list) {
    const others = list.filter((s) => !s.current).length;
    return h(
      "section.card#a-sessions",
      h("h2", "Where you're signed in"),
      h(
        "ul.plain.session-list",
        list.map((s) =>
          h(
            "li.session",
            h(
              "div",
              h("div", s.device, s.current ? h("span.tag.session-current", "This device") : null),
              h("div.muted.small", `Signed in ${fmtTime(s.signedInAt)} · last active ${fmtTime(s.lastSeenAt)}${s.ip ? ` · ${s.ip}` : ""}`),
            ),
            s.current
              ? null
              : h(
                  "button.btn.small",
                  {
                    type: "button",
                    onclick: async () => {
                      try {
                        await del(`/auth/sessions/${s.id}`);
                        toast("Signed out of that device");
                        await draw();
                      } catch (err) {
                        fail(err);
                      }
                    },
                  },
                  "Sign out",
                ),
          ),
        ),
      ),
      others
        ? h(
            "div.form-actions",
            h(
              "button.btn",
              {
                type: "button",
                onclick: async () => {
                  try {
                    const r = await post("/auth/sessions/sign-out-others");
                    toast(`Signed out of ${r.signedOut} other device${r.signedOut === 1 ? "" : "s"}`);
                    await draw();
                  } catch (err) {
                    fail(err);
                  }
                },
              },
              "Sign out everywhere else",
            ),
          )
        : h("p.muted.small", "You aren't signed in anywhere else."),
      h("p.muted.small", "You're signed out automatically after 8 hours without using Lawdesk, and 24 hours after signing in."),
    );
  }

  await draw();
  return page;
}
