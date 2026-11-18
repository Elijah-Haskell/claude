// Settings > Email: how the firm's email is sent (with a test message), each person's email
// notices, the message templates used on matters, and the outbox of recent mail.

import { h, select, modal, toast, fmtTime } from "../dom.js";
import { get, put, post, del } from "../api.js";
import { state } from "../state.js";

const STATUS = { queued: "Waiting", sending: "Sending", sent: "Sent", failed: "Not sent", cancelled: "Cancelled" };
const KIND = { matter: "From a matter", task_assigned: "New task", digest: "Daily summary", reminder: "Reminder", password_reset: "Password reset", test: "Test" };

/** Returns the section element; it loads its own data and can be kept across settings redraws. */
export function emailSettingsSection() {
  const section = h("section.card.email-settings#s-email", h("h2", "Email"), h("p.muted", "Loading…"));
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
      section.replaceChildren(h("h2", "Email"), sending(settings), notices(prefs), templateList(templates), outboxList(outbox));
    } catch (err) {
      section.replaceChildren(h("h2", "Email"), h("p.error-text", err.message));
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
        h("span.muted.small", "Fill in the usual settings for: "),
        Object.entries(s.providers).map(([k, p]) =>
          h(
            "button.btn.small",
            {
              type: "button",
              onclick: () => {
                if (!host.disabled) host.value = p.host;
                if (!port.disabled) port.value = p.port;
                if (!security.disabled) security.value = p.security;
              },
            },
            p.label,
          ),
        ),
      ),
      h("div.form-row", h("label", "Mail server", host), h("label", "Port", port), h("label", "Encryption", security)),
      h("div.form-row", h("label", "User name", user), h("label", "Password", pass), h("label", "Sign-in method", auth)),
      h(
        "p.muted.small",
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
      h("h3", "How email is sent"),
      h("label", "Sending", transport),
      s.transport === "dev" && s.devDir ? h("p.muted.small", `Messages are saved in the folder “${s.devDir}” on the server and are not delivered.`) : null,
      smtpBox,
      h("div.form-row", h("label", "From name", fromName), h("label", "From address", fromAddress), h("label", "Lawdesk address (for links in emails)", appUrl)),
      fixed.size ? h("p.muted.small", "Greyed-out fields are set on the server and can only be changed there.") : null,
      h(
        "div.form-actions",
        s.passwordSet && !fixed.has("password")
          ? h(
              "button.btn",
              {
                type: "button",
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
              },
              "Remove saved password",
            )
          : null,
        h("button.btn.primary", { type: "submit" }, "Save email settings"),
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
      h("label", "Send a test email to", testTo),
      h("button.btn", { type: "submit" }, "Send test email"),
    );
    return h("div.email-block", save, h("div.email-test-box", h("p.muted.small", "Save first, then send a test to check the settings."), test, testResult));
  }

  // ---------------------------------------------------------------- notices
  function notices(p) {
    if (!p) return h("div.email-block", h("h3", "My email notices"), h("p.muted", "Choose who you are working as to set your notices."));
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
      h("h3", `Email notices for ${who}`),
      p.email ? null : h("p.error-text", "There is no email address for this person. Add one under People to receive these."),
      box("taskAssigned", "When someone assigns me a task"),
      h("div.email-digest-line", box("digest", "A daily summary of my overdue tasks and tasks due today, at"), time, h("span.muted.small", "Central time")),
      h("div.email-indent", box("digestWeekends", "Send the daily summary on Saturdays and Sundays too")),
      box("reminders", "Calendar reminders for events I attend"),
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
        h("label", "Name", name),
        h("label", "Subject", subject),
        h("label", "Message", body),
        h("p.muted.small", "Merge fields: {{recipient.name}}, {{client.name}}, {{matter.name}}, {{matter.number}}, {{matter.dates.closing_date|long}}, {{user.name}}, {{today}} and the other fields used in document templates."),
        err,
        h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Save template")),
      );
      const dlg = modal(t ? "Edit email template" : "New email template", form, { wide: true });
    };
    return h(
      "div.email-block",
      h("h3", "Email templates"),
      list.length
        ? h(
            "ul.plain.email-templates",
            list.map((t) =>
              h(
                "li",
                h("span.email-tpl-name", t.name),
                h("span.muted.small.email-tpl-subject", t.subject),
                h(
                  "span.email-tpl-actions",
                  h("button.btn.small", { type: "button", onclick: () => edit(t) }, "Edit"),
                  h(
                    "button.btn.small",
                    {
                      type: "button",
                      onclick: async () => {
                        if (!confirm(`Delete the template “${t.name}”?`)) return;
                        try {
                          await del(`/email/templates/${t.id}`);
                          load();
                        } catch (err) {
                          fail(err);
                        }
                      },
                    },
                    "Delete",
                  ),
                ),
              ),
            ),
          )
        : h("p.muted", "No templates yet."),
      h("button.btn.small", { type: "button", onclick: () => edit(null) }, "New template"),
    );
  }

  // ---------------------------------------------------------------- outbox
  function outboxList(rows) {
    const action = (label, path) =>
      h(
        "button.btn.small",
        {
          type: "button",
          onclick: async () => {
            try {
              await post(path);
              load();
            } catch (err) {
              fail(err);
            }
          },
        },
        label,
      );
    return h(
      "div.email-block",
      h(
        "div.email-outbox-head",
        h("h3", "Recent email"),
        h(
          "button.btn.small",
          {
            type: "button",
            onclick: async () => {
              try {
                const r = await post("/email/outbox/run");
                toast(r.sent || r.failed || r.retrying ? `${r.sent} sent, ${r.retrying} will be retried, ${r.failed} not sent` : "Nothing was waiting to send");
                load();
              } catch (err) {
                fail(err);
              }
            },
          },
          "Send waiting email now",
        ),
      ),
      rows.length
        ? h(
            "table.settings-table.email-outbox",
            h("thead", h("tr", h("th", "When"), h("th", "To"), h("th", "Subject"), h("th", "Status"), h("th", ""))),
            h(
              "tbody",
              rows.map((r) =>
                h(
                  "tr",
                  h("td", { "data-label": "When" }, fmtTime(r.sent_at || r.created_at)),
                  h("td", { "data-label": "To" }, r.recipients.join(", ")),
                  h("td", { "data-label": "Subject" }, r.subject, h("span.muted.small", ` · ${KIND[r.kind] || r.kind}${r.matter_number ? ` · ${r.matter_number}` : ""}`)),
                  h(
                    "td",
                    { "data-label": "Status" },
                    h("span.tag" + (r.status === "failed" ? ".email-bad" : r.status === "sent" ? ".good" : ""), STATUS[r.status] || r.status),
                    r.last_error && r.status !== "sent" ? h("div.muted.small.email-error", r.last_error) : null,
                  ),
                  h(
                    "td",
                    r.status === "failed" || r.status === "cancelled" ? action("Try again", `/email/outbox/${r.id}/retry`) : null,
                    r.status === "queued" ? action("Cancel", `/email/outbox/${r.id}/cancel`) : null,
                  ),
                ),
              ),
            ),
          )
        : h("p.muted", "No email has been sent yet."),
    );
  }

  load();
  return section;
}
