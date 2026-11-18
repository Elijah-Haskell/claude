// Settings > Email: how the firm's email is sent (with a test message), each person's email
// notices, the message templates used on matters, and the outbox of recent mail.

import { h, select, modal, toast, fmtTime } from "../dom.js";
import { get, put, post, del } from "../api.js";
import { state } from "../state.js";
import { icon } from "../ui/icons.js";
import { button, iconButton, emptyState, field, pill, callout, useStyles, loadingBlock } from "../ui/components.js";
import { dataTable } from "../ui/table.js";

const STATUS = { queued: "Waiting", sending: "Sending", sent: "Sent", failed: "Not sent", cancelled: "Cancelled" };
const STATUS_TONE = { queued: "warning", sending: "info", sent: "success", failed: "danger", cancelled: "neutral" };

/** The same header every Settings section uses. */
function head() {
  return h(
    "header.card-header",
    h(
      "div.card-heading",
      h("span.card-icon", icon("mail", { size: 16 })),
      h("div", h("h2.card-title", "Email"), h("p.card-subtitle", "How the firm's email is sent, your own email notices, message templates and recent mail.")),
    ),
  );
}

function blockHead(title, sub = null, action = null) {
  return h("div.email-block-head" + (action ? ".with-action" : ""), h("div", h("h3", title), sub ? h("p", sub) : null), action);
}
const KIND = { matter: "From a matter", task_assigned: "New task", digest: "Daily summary", reminder: "Reminder", password_reset: "Password reset", test: "Test" };

/** Returns the section element; it loads its own data and can be kept across settings redraws. */
export function emailSettingsSection() {
  useStyles("email");
  const section = h("section.card.settings-section.email-settings#s-email", head(), loadingBlock("Loading email settings", "lines", 4));
  const fail = (err) => toast(err.message, { error: true });

  async function load() {
    try {
      const me = state.me;
      const [settings, prefs, templates, outbox] = await Promise.all([
        get("/email/settings"),
        me ? get(`/email/prefs/${me}`) : Promise.resolve(null),
        get("/email/templates"),
        get("/email/outbox?limit=20"),
      ]);
      section.replaceChildren(head(), sending(settings), notices(prefs), templateList(templates), outboxList(outbox));
    } catch (err) {
      section.replaceChildren(head(), callout({ tone: "danger", title: "Couldn't load the email settings", body: err.message, action: button("Try again", { size: "sm", onclick: load }) }));
    }
  }

  // ---------------------------------------------------------------- sending
  function sending(s) {
    const fixed = new Set(s.fromEnvironment);
    const lock = (prop, el) => {
      if (fixed.has(prop)) {
        el.disabled = true;
        el.title = "Set on the server";
      }
      return el;
    };
    const transport = lock(
      "transport",
      select(
        [
          { value: "dev", label: "Save messages as files (for trying Lawdesk out; nothing is sent)" },
          { value: "smtp", label: "Send through the firm's mail server" },
        ],
        s.transport,
        { "aria-label": "How email is sent" },
      ),
    );
    const host = lock("host", h("input", { value: s.host, maxlength: 253, placeholder: "smtp.example.com", "aria-label": "Mail server" }));
    const port = lock("port", h("input", { type: "number", min: 1, max: 65535, value: s.port, "aria-label": "Port" }));
    const security = lock(
      "security",
      select(
        [
          { value: "starttls", label: "STARTTLS (usually port 587)" },
          { value: "tls", label: "TLS (usually port 465)" },
          { value: "none", label: "None (only for a server on this computer)" },
        ],
        s.security,
        { "aria-label": "Encryption" },
      ),
    );
    const user = lock("user", h("input", { value: s.user, maxlength: 300, autocomplete: "off", "aria-label": "User name" }));
    const pass = lock(
      "password",
      h("input", { type: "password", autocomplete: "new-password", maxlength: 1000, placeholder: s.passwordSet ? "Saved. Leave blank to keep it." : "", "aria-label": "Password" }),
    );
    const auth = lock(
      "auth",
      select(
        [
          { value: "auto", label: "Automatic" },
          { value: "plain", label: "PLAIN" },
          { value: "login", label: "LOGIN" },
        ],
        s.auth,
        { "aria-label": "Sign-in method" },
      ),
    );
    const fromName = lock("fromName", h("input", { value: s.fromName, maxlength: 100, "aria-label": "From name" }));
    const fromAddress = lock("fromAddress", h("input", { type: "email", value: s.fromAddress, maxlength: 254, placeholder: "office@yourfirm.com", "aria-label": "From address" }));
    const appUrl = lock("appUrl", h("input", { value: s.appUrl, maxlength: 300, "aria-label": "Lawdesk address" }));
    const smtpBox = h(
      "div.email-smtp",
      h(
        "div.email-presets",
        h("span.email-presets-label", "Fill in the usual settings for"),
        Object.entries(s.providers).map(([k, p]) =>
          button(p.label, {
            size: "sm",
            onclick: () => {
              if (!host.disabled) host.value = p.host;
              if (!port.disabled) port.value = p.port;
              if (!security.disabled) security.value = p.security;
            },
          }),
        ),
      ),
      h("div.form-row", field("Mail server", host), field("Port", port), field("Encryption", security)),
      h("div.form-row", field("User name", user), field("Password", pass), field("Sign-in method", auth)),
      h(
        "p.email-note",
        "Google Workspace and Microsoft 365 may require an app password, or sign-in through OAuth, which the firm's administrator sets up. See the email setup notes that come with Lawdesk.",
      ),
    );
    const showSmtp = () => (smtpBox.hidden = transport.value !== "smtp");
    transport.addEventListener("change", showSmtp);
    showSmtp();

    const testTo = h("input", { type: "email", value: state.setup?.allUsers?.find((u) => u.id === state.me)?.email || "", "aria-label": "Send a test to", placeholder: "you@yourfirm.com" });
    const testResult = h("p.email-test-result", { role: "status" });
    const save = h(
      "form.form-grid.email-sending",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const body = {};
          const add = (prop, el, v = el.value) => {
            if (!el.disabled) body[prop] = v;
          };
          add("transport", transport);
          add("host", host);
          add("port", port, port.value === "" ? "" : Number(port.value));
          add("security", security);
          add("user", user);
          add("auth", auth);
          add("fromName", fromName);
          add("fromAddress", fromAddress);
          add("appUrl", appUrl);
          if (!pass.disabled && pass.value) body.password = pass.value;
          try {
            const r = await put("/email/settings", body);
            toast(r.changed.length ? "Email settings saved" : "No changes");
            load();
          } catch (err) {
            fail(err);
          }
        },
      },
      blockHead("How email is sent", "Messages to clients and the team's notices go out through this account."),
      field("Sending", transport),
      s.transport === "dev" && s.devDir ? callout({ tone: "info", body: `Messages are saved in the folder “${s.devDir}” on the server and are not delivered.` }) : null,
      smtpBox,
      h("div.form-row", field("From name", fromName), field("From address", fromAddress), field("Lawdesk address", appUrl, { hint: "Used for links in emails." })),
      fixed.size ? h("p.email-note", "Greyed-out fields are set on the server and can only be changed there.") : null,
      h(
        "div.form-actions",
        s.passwordSet && !fixed.has("password")
          ? button("Remove saved password", {
              variant: "ghost",
              class: "danger-text",
              onclick: async () => {
                if (!confirm("Remove the saved mail server password?")) return;
                try {
                  await put("/email/settings", { clearPassword: true });
                  toast("Password removed");
                  load();
                } catch (err) {
                  fail(err);
                }
              },
            })
          : null,
        button("Save email settings", { variant: "primary", type: "submit" }),
      ),
    );
    const test = h(
      "form.email-test",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          testResult.textContent = "Sending…";
          testResult.className = "email-test-result";
          try {
            const r = await post("/email/settings/test", { to: testTo.value });
            testResult.textContent = r.ok ? (r.transport === "dev" ? `Saved. ${r.response}` : `Sent. The mail server replied: ${r.response}`) : `Not sent: ${r.error}`;
            testResult.classList.add(r.ok ? "ok" : "bad");
          } catch (err) {
            testResult.textContent = err.message;
            testResult.classList.add("bad");
          }
        },
      },
      field("Send a test email to", testTo),
      button("Send test email", { type: "submit", icon: "send" }),
    );
    return h("div.email-block", save, h("div.email-test-box", h("p.email-note", "Save first, then send a test to check the settings."), test, testResult));
  }

  // ---------------------------------------------------------------- notices
  function notices(p) {
    if (!p) return h("div.email-block", blockHead("My email notices", "Choose who you are working as to set your notices."));
    const who = state.setup?.allUsers?.find((u) => u.id === p.userId)?.name || "you";
    const box = (prop, label) =>
      h(
        "label.check-line",
        h("input", {
          type: "checkbox",
          checked: p[prop],
          onchange: async (e) => {
            try {
              Object.assign(p, await put(`/email/prefs/${p.userId}`, { [prop]: e.target.checked }));
              toast("Saved");
            } catch (err) {
              fail(err);
            }
          },
        }),
        " ",
        label,
      );
    const time = h("input", {
      type: "time",
      value: p.digestTime,
      "aria-label": "Time of the daily summary",
      onchange: async (e) => {
        try {
          await put(`/email/prefs/${p.userId}`, { digestTime: e.target.value });
          toast("Saved");
        } catch (err) {
          fail(err);
        }
      },
    });
    return h(
      "div.email-block.email-notices",
      blockHead(`Email notices for ${who}`, "Saved as soon as you change them."),
      p.email ? null : callout({ tone: "warning", body: "There is no email address for this person. Add one under People to receive these." }),
      h(
        "div.email-notices-list",
        box("taskAssigned", "When someone assigns me a task"),
        h("div.email-digest-line", box("digest", "A daily summary of my overdue tasks and tasks due today, at"), time, h("span.email-digest-tz", "Central time")),
        h("div.email-indent", box("digestWeekends", "Send the daily summary on Saturdays and Sundays too")),
        box("reminders", "Calendar reminders for events I attend"),
      ),
    );
  }

  // ---------------------------------------------------------------- templates
  function templateList(list) {
    const edit = (t) => {
      const name = h("input", { value: t?.name || "", required: true, maxlength: 200 });
      const subject = h("input", { value: t?.subject || "", required: true, maxlength: 900 });
      const body = h("textarea", { rows: 12, required: true, maxlength: 50000 }, t?.body || "");
      const err = h("p.error-text", { role: "alert" });
      const form = h(
        "form.modal-body.form-grid",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const b = { name: name.value, subject: subject.value, body: body.value };
              if (t) await put(`/email/templates/${t.id}`, b);
              else await post("/email/templates", b);
              dlg.close();
              toast("Template saved");
              load();
            } catch (ex) {
              err.textContent = ex.message;
            }
          },
        },
        field("Name", name),
        field("Subject", subject),
        field("Message", body, { hint: "Merge fields: {{recipient.name}}, {{client.name}}, {{matter.name}}, {{matter.number}}, {{matter.dates.closing_date|long}}, {{user.name}}, {{today}} and the other fields used in document templates." }),
        err,
        h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), button("Save template", { variant: "primary", type: "submit" })),
      );
      const dlg = modal(t ? "Edit email template" : "New email template", form, { wide: true });
    };
    return h(
      "div.email-block",
      blockHead("Email templates", "Ready-made messages to choose from when writing to a client from a matter.", button("New template", { size: "sm", icon: "plus", onclick: () => edit(null) })),
      list.length
        ? h(
            "ul.email-templates",
            list.map((t) =>
              h(
                "li",
                h("span.email-tpl-name", t.name),
                h("span.email-tpl-subject", t.subject),
                h(
                  "span.email-tpl-actions",
                  iconButton("pencil", `Edit ${t.name}`, { size: "sm", onclick: () => edit(t) }),
                  iconButton("trash-2", `Delete ${t.name}`, {
                    size: "sm",
                    variant: "danger",
                    onclick: async () => {
                      if (!confirm(`Delete the template “${t.name}”?`)) return;
                      try {
                        await del(`/email/templates/${t.id}`);
                        load();
                      } catch (err) {
                        fail(err);
                      }
                    },
                  }),
                ),
              ),
            ),
          )
        : emptyState({ icon: "email", title: "No email templates yet", body: "Add one for messages you send often, such as a status update.", compact: true }),
    );
  }

  // ---------------------------------------------------------------- outbox
  function outboxList(rows) {
    const action = (label, path, ic) =>
      button(label, {
        size: "sm",
        icon: ic,
        onclick: async () => {
          try {
            await post(path);
            load();
          } catch (err) {
            fail(err);
          }
        },
      });
    const runNow = button("Send waiting email now", {
      size: "sm",
      icon: "send",
      onclick: async () => {
        try {
          const r = await post("/email/outbox/run");
          toast(r.sent || r.failed || r.retrying ? `${r.sent} sent, ${r.retrying} will be retried, ${r.failed} not sent` : "Nothing was waiting to send");
          load();
        } catch (err) {
          fail(err);
        }
      },
    });
    return h(
      "div.email-block",
      blockHead("Recent email", "The last 20 messages Lawdesk sent or is waiting to send.", runNow),
      rows.length
        ? h(
            "div.email-outbox-wrap",
            dataTable({
              label: "Recent email",
              tableClass: "email-outbox",
              toolbar: false,
              rows,
              noun: ["message", "messages"],
              sortable: false,
              columns: [
                { key: "when", label: "When", className: "nowrap", render: (r) => fmtTime(r.sent_at || r.created_at) },
                { key: "to", label: "To", render: (r) => r.recipients.join(", ") },
                {
                  key: "subject",
                  label: "Subject",
                  primary: true,
                  render: (r) => h("div.cell-stack", h("span", r.subject), h("span.email-outbox-sub", [KIND[r.kind] || r.kind, r.matter_number].filter(Boolean).join(" · "))),
                },
                {
                  key: "status",
                  label: "Status",
                  render: (r) => [pill(STATUS[r.status] || r.status, STATUS_TONE[r.status] || "neutral"), r.last_error && r.status !== "sent" ? h("div.email-error", r.last_error) : null],
                },
                {
                  key: "actions",
                  label: "",
                  render: (r) =>
                    r.status === "failed" || r.status === "cancelled"
                      ? action("Try again", `/email/outbox/${r.id}/retry`, "rotate-ccw")
                      : r.status === "queued"
                        ? action("Cancel", `/email/outbox/${r.id}/cancel`, "x")
                        : null,
                },
              ],
            }),
          )
        : emptyState({ icon: "inbox", title: "No email sent yet", body: "Messages appear here as they are sent.", compact: true }),
    );
  }

  load();
  return section;
}
