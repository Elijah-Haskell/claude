// The screens shown before the app: sign in (and the two-factor code), first-run set-up,
// choosing a new password after an administrator set a temporary one, and reset links.

import { h, replace } from "../dom.js";
import { post } from "../api.js";

const MIN = 12;

function page(title, intro, ...body) {
  return h(
    "div.auth-page",
    h(
      "main.auth-card.card#main",
      { tabindex: "-1" },
      h("div.auth-brand", "Lawdesk"),
      h("h1.auth-title", title),
      intro ? h("p.auth-intro", intro) : null,
      ...body,
    ),
  );
}

function field(label, attrs) {
  const input = h("input", attrs);
  return { input, el: h("label", h("span", label), input) };
}

/** A form that shows the server's message on failure and keeps the button from double-sending. */
function form(fields, buttonLabel, submit) {
  const error = h("p.error-box", { role: "alert", hidden: true });
  const button = h("button.btn.primary.auth-submit", { type: "submit" }, buttonLabel);
  const el = h(
    "form.form-grid.auth-form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        button.disabled = true;
        try {
          await submit();
        } catch (err) {
          error.textContent = err.message || String(err);
          error.hidden = false;
        } finally {
          button.disabled = false;
        }
      },
    },
    error,
    fields.map((f) => f.el),
    button,
  );
  return { el, error };
}

const goIn = () => {
  if (/^#\/reset\//.test(location.hash) || !location.hash) location.hash = "#/my";
  location.reload();
};

function newPasswordFields(labelNew = "New password") {
  const pw = field(labelNew, { type: "password", autocomplete: "new-password", required: true, minlength: MIN, maxlength: 200 });
  const again = field("Type it again", { type: "password", autocomplete: "new-password", required: true, maxlength: 200 });
  const check = () => {
    if (pw.input.value !== again.input.value) throw new Error("The two passwords don't match");
  };
  return { pw, again, check };
}

const pwHint = () => h("p.muted.small.auth-hint", `At least ${MIN} characters. A few unrelated words make a strong password that is easy to remember.`);

export function authScreen(status) {
  const reset = /^#\/reset\/([\w-]+)$/.exec(location.hash);
  if (reset) return resetScreen(reset[1]);
  if (status.setupNeeded) return setupScreen();
  if (status.signedIn && status.user.mustChangePassword) return mustChangeScreen(status.user);
  return signInScreen();
}

function signInScreen() {
  const email = field("Email address", { type: "email", autocomplete: "username", required: true, maxlength: 200, id: "signin-email" });
  const pw = field("Password", { type: "password", autocomplete: "current-password", required: true, maxlength: 200, id: "signin-password" });
  const holder = h("div");
  const f = form([email, pw], "Sign in", async () => {
    const r = await post("/auth/sign-in", { email: email.input.value, password: pw.input.value });
    if (r.twoFactor) replace(holder, codeStep(r.challenge));
    else goIn();
  });
  replace(holder, f.el, h("p.muted.small.auth-foot", "Forgot your password? Ask the firm's administrator to reset it."));
  const el = page("Sign in", null, holder);
  queueMicrotask(() => email.input.focus());
  return el;
}

function codeStep(challenge) {
  const code = field("Six-digit code", {
    inputmode: "numeric",
    autocomplete: "one-time-code",
    required: true,
    maxlength: 20,
    id: "signin-code",
  });
  const f = form([code], "Continue", async () => {
    await post("/auth/sign-in/code", { challenge, code: code.input.value });
    goIn();
  });
  queueMicrotask(() => code.input.focus());
  return h(
    "div",
    h("p.auth-intro", "Open the authenticator app on your phone and enter the code it shows for Lawdesk."),
    f.el,
    h("p.muted.small.auth-foot", "No phone? Enter one of your recovery codes instead."),
  );
}

function setupScreen() {
  const name = field("Your name", { autocomplete: "name", required: true, maxlength: 200, id: "setup-name" });
  const email = field("Email address", { type: "email", autocomplete: "username", required: true, maxlength: 200, id: "setup-email" });
  const np = newPasswordFields("Password");
  const f = form([name, email, np.pw, np.again], "Create administrator account", async () => {
    np.check();
    await post("/auth/setup", { name: name.input.value, email: email.input.value, password: np.pw.input.value });
    goIn();
  });
  return page(
    "Welcome to Lawdesk",
    "No one has an account yet. Create the first one: it will be the administrator, who can add everyone else at the firm.",
    f.el,
    pwHint(),
  );
}

function mustChangeScreen(user) {
  const current = field("Temporary password", { type: "password", autocomplete: "current-password", required: true, maxlength: 200, id: "change-current" });
  const np = newPasswordFields();
  const f = form([current, np.pw, np.again], "Save new password", async () => {
    np.check();
    await post("/auth/password", { currentPassword: current.input.value, newPassword: np.pw.input.value });
    goIn();
  });
  return page(
    "Choose your password",
    `Welcome, ${user.name}. You signed in with a temporary password; choose your own to continue.`,
    f.el,
    pwHint(),
    h("p.auth-foot", h("button.btn.small", { type: "button", onclick: () => post("/auth/sign-out").finally(() => location.reload()) }, "Sign out")),
  );
}

function resetScreen(token) {
  const np = newPasswordFields();
  const holder = h("div");
  const f = form([np.pw, np.again], "Save new password", async () => {
    np.check();
    await post("/auth/reset", { token, password: np.pw.input.value });
    replace(holder, h("p.auth-intro", "Your password has been changed."), h("p", h("button.btn.primary", { type: "button", onclick: goIn }, "Sign in")));
  });
  replace(holder, f.el, pwHint());
  return page("Choose a new password", null, holder);
}
