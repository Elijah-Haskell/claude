// My account: details, password, two-factor sign-in, and where you're signed in.

import { h, replace, toast, fmtTime } from "../dom.js";
import { get, post, del } from "../api.js";
import { pageHeader, card, kv, field, button, pill, avatar, callout } from "../ui/components.js";
import { icon } from "../ui/icons.js";

export async function accountView() {
  const page = h("div.page.account-page");
  const fail = (err) => toast(err.message, { error: true });

  async function draw() {
    const me = await get("/auth/me");
    const u = me.user;
    replace(
      page,
      pageHeader({
        title: "My account",
        subtitle: "Your sign-in details and security.",
        meta: [h("span.account-who", avatar(u.name, { size: "sm" }), h("span", u.name)), h("span", u.email), pill(u.roleLabel, "brand", { dot: false })],
      }),
      h("div.account-grid", h("div.account-col", details(u), password()), h("div.account-col", twoFactor(u, me.recoveryCodesLeft), sessions(me.sessions))),
    );
  }

  function details(u) {
    return card({
      id: "a-details",
      title: "Your details",
      icon: "circle-user",
      body: [
        kv([
          ["Name", u.name],
          ["Email address", u.email],
          ["Access", u.roleLabel],
          ["Password last changed", u.passwordChangedAt ? fmtTime(u.passwordChangedAt) : "Not recorded"],
        ]),
        h("p.account-note", "To change your name, email address or access, ask the firm's administrator."),
      ],
    });
  }

  function password() {
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
      field("Current password", cur),
      field("New password", next, { hint: "At least 12 characters. A few unrelated words are strong and easy to remember." }),
      field("New password again", again),
      h("div.form-actions", button("Change password", { variant: "primary", type: "submit" })),
    );
    return card({ id: "a-password", title: "Password", icon: "lock", body: form });
  }

  function twoFactor(u, left) {
    const body = h("div.account-2fa");
    const c = card({
      id: "a-2fa",
      title: "Two-step sign-in",
      subtitle: "A code from your phone as well as your password",
      icon: "phone",
      actions: u.twoFactor ? pill("On", "success") : pill("Off", "neutral"),
      body,
    });
    if (!u.twoFactor) {
      body.append(
        h("p", "Ask for a code from your phone as well as your password when you sign in. Anyone who learns your password still can't get in without your phone."),
        h("p.account-note", "You'll need an authenticator app, such as Microsoft Authenticator, Google Authenticator or 1Password."),
        h("div.form-actions", button("Turn on two-step sign-in", { variant: "primary", icon: "lock", onclick: () => begin(c, body) })),
      );
      return c;
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
    body.append(
      h("p", "You'll be asked for a code from your phone each time you sign in."),
      h("p.account-note", `${left} recovery code${left === 1 ? "" : "s"} left.`),
      h("div.form-grid", field("Your password, to make changes", pw)),
      h(
        "div.form-actions",
        button("Make new recovery codes", {
          onclick: () =>
            withPassword(async (p) => {
              const r = await post("/auth/two-factor/recovery-codes", { password: p });
              showCodes(body, r.recoveryCodes);
            }),
        }),
        button("Turn off", {
          variant: "danger",
          onclick: () =>
            withPassword(async (p) => {
              if (!confirm("Turn off two-step sign-in? Your password alone will be enough to sign in.")) return;
              await post("/auth/two-factor/disable", { password: p });
              toast("Two-step sign-in is off");
              await draw();
            }),
        }),
      ),
    );
    return c;
  }

  async function begin(c, body) {
    let s;
    try {
      s = await post("/auth/two-factor/setup");
    } catch (err) {
      return fail(err);
    }
    const code = h("input#a-2fa-code", { inputmode: "numeric", autocomplete: "one-time-code", required: true, maxlength: 10 });
    replace(
      body,
      h(
        "ol.setup-steps",
        h("li", "Open your authenticator app and add an account. On this phone you can ", h("a", { href: s.uri }, "open it directly"), "; otherwise choose to enter a key."),
        h("li", "Enter this key (spaces don't matter):", h("div.setup-key", { "aria-label": "Set-up key" }, s.key), h("span.account-note", "Account: Lawdesk. Type: time-based.")),
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
              showCodes(body, r.recoveryCodes);
            } catch (err) {
              fail(err);
            }
          },
        },
        field("Code from the app", code),
        h("div.form-actions", button("Cancel", { onclick: () => draw() }), button("Turn on", { variant: "primary", type: "submit" })),
      ),
    );
    code.focus();
  }

  function showCodes(body, codes) {
    replace(
      body,
      callout({ tone: "warning", title: "Save your recovery codes now.", body: "They won't be shown again." }),
      h("p", "If you lose your phone, each of these codes lets you sign in once instead of a code from the app. Print them or write them down and keep them somewhere safe."),
      h("ul.recovery-codes", codes.map((c) => h("li", c))),
      h("div.form-actions", button("Print", { icon: "file-text", onclick: () => window.print() }), button("I've saved them", { variant: "primary", onclick: () => draw() })),
    );
  }

  function sessions(list) {
    const others = list.filter((s) => !s.current).length;
    const signOutOthers = others
      ? button("Sign out everywhere else", {
          size: "sm",
          onclick: async () => {
            try {
              const r = await post("/auth/sessions/sign-out-others");
              toast(`Signed out of ${r.signedOut} other device${r.signedOut === 1 ? "" : "s"}`);
              await draw();
            } catch (err) {
              fail(err);
            }
          },
        })
      : null;
    return card({
      id: "a-sessions",
      title: "Where you're signed in",
      icon: "layout-grid",
      actions: signOutOthers,
      flush: true,
      body: h(
        "ul.plain.session-list",
        list.map((s) =>
          h(
            "li.session",
            h("span.session-icon", icon(s.current ? "circle-check" : "circle-user", { size: 18 })),
            h(
              "div.session-text",
              h("div.session-device", h("span", s.device), s.current ? h("span.session-current", pill("This device", "success", { dot: false })) : null),
              h("div.session-sub", `Signed in ${fmtTime(s.signedInAt)} · last active ${fmtTime(s.lastSeenAt)}${s.ip ? ` · ${s.ip}` : ""}`),
            ),
            s.current
              ? null
              : button("Sign out", {
                  size: "sm",
                  variant: "ghost",
                  onclick: async () => {
                    try {
                      await del(`/auth/sessions/${s.id}`);
                      toast("Signed out of that device");
                      await draw();
                    } catch (err) {
                      fail(err);
                    }
                  },
                }),
          ),
        ),
      ),
      footer: h(
        "span.account-note",
        others ? "" : "You aren't signed in anywhere else. ",
        "You're signed out automatically after 8 hours without using Lawdesk, and 24 hours after signing in.",
      ),
    });
  }

  await draw();
  return page;
}
