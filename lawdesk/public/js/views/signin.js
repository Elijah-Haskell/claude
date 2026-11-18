// The screens shown before the app: sign in (and the two-factor code), first-run set-up,
// choosing a new password after an administrator set a temporary one, and reset links.
// Every one uses the same branded frame: a navy brand panel beside a white form panel
// (on a phone the panel shrinks to the logo above the form).

import { h, replace } from "../dom.js";
import { post } from "../api.js";
import { field as kitField, button } from "../ui/components.js";
import { icon } from "../ui/icons.js";

const MIN = 12;

const HIGHLIGHTS = [
  ["briefcase", "Matters and tasks", "Every file, its next step and who is on it."],
  ["calendar-clock", "Deadlines and calendar", "Court dates and reminders in one place."],
  ["landmark", "Billing and trust", "Invoices and client funds, kept to the rules."],
];

function logo(onDark) {
  return h(
    "div.auth-logo" + (onDark ? "" : ".auth-logo-compact"),
    h("img", { src: onDark ? "brand/lawdesk-mark-on-dark.svg" : "brand/lawdesk-mark.svg", alt: "", width: 34, height: 34 }),
    h("span.auth-wordmark", "Lawdesk"),
  );
}

function brandPanel() {
  return h(
    "aside.auth-aside",
    logo(true),
    h(
      "div.auth-aside-body",
      h("p.auth-tagline", "Your firm's practice desk."),
      h("p.auth-lede", "Matters, deadlines, documents, billing and trust accounting, together."),
      h(
        "ul.auth-highlights",
        HIGHLIGHTS.map(([ic, title, text]) => h("li", h("span.auth-hl-icon", icon(ic, { size: 18 })), h("span.auth-hl-text", h("strong", title), h("span", text)))),
      ),
    ),
    h("p.auth-aside-foot", icon("lock", { size: 14 }), h("span", "For the people at your firm only.")),
  );
}

function page(title, intro, ...body) {
  return h(
    "div.auth-page",
    brandPanel(),
    h(
      "main.auth-main#main",
      { tabindex: "-1" },
      h("div.auth-card", logo(false), h("h1.auth-title", title), intro ? h("p.auth-intro", intro) : null, ...body),
    ),
  );
}

function field(label, attrs) {
  const input = h("input", attrs);
  return { input, el: kitField(label, input) };
}

/** A form that shows the server's message on failure and keeps the button from double-sending. */
function form(fields, buttonLabel, submit) {
  const message = h("span");
  const error = h(
    "div.callout.callout-danger.error-box",
    { role: "alert", hidden: true },
    icon("circle-alert", { size: 16, class: "callout-icon" }),
    h("div.callout-text", message),
  );
  const btn = button(buttonLabel, { variant: "primary", size: "lg", type: "submit", class: "auth-submit" });
  const el = h(
    "form.form-grid.auth-form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        btn.disabled = true;
        try {
          await submit();
        } catch (err) {
          message.textContent = err.message || String(err);
          error.hidden = false;
        } finally {
          btn.disabled = false;
        }
      },
    },
    error,
    fields.map((f) => f.el),
    btn,
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

const pwHint = () => h("p.auth-hint", `At least ${MIN} characters. A few unrelated words make a strong password that is easy to remember.`);

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
  replace(holder, f.el, h("p.auth-foot", "Forgot your password? Ask the firm's administrator to reset it."));
  const el = page("Sign in", "Welcome back. Sign in with your work email address.", holder);
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
    h("p.auth-foot", "No phone? Enter one of your recovery codes instead."),
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
    h("p.auth-foot", button("Sign out", { variant: "ghost", size: "sm", onclick: () => post("/auth/sign-out").finally(() => location.reload()) })),
  );
}

function resetScreen(token) {
  const np = newPasswordFields();
  const holder = h("div");
  const f = form([np.pw, np.again], "Save new password", async () => {
    np.check();
    await post("/auth/reset", { token, password: np.pw.input.value });
    replace(
      holder,
      h("div.callout.callout-success", icon("circle-check", { size: 16, class: "callout-icon" }), h("div.callout-text", h("span", "Your password has been changed."))),
      h("p", button("Sign in", { variant: "primary", size: "lg", class: "auth-submit", onclick: goIn })),
    );
  });
  replace(holder, f.el, pwHint());
  return page("Choose a new password", "Choose a password only you know. You'll use it to sign in from now on.", holder);
}
