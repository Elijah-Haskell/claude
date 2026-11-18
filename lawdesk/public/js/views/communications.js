// The matter page's "Communications" card: the log of emails, calls and meetings, writing an
// email to the client from a template, logging a call, and filing a saved email (.eml)
// dragged onto the card.

import { h, select, modal, toast, fmtTime, plural } from "../dom.js";
import { get, post, del, ApiError } from "../api.js";
import { icon } from "../ui/icons.js";
import { card, button, emptyState, field, pill, segmented, callout, kv, useStyles, loadingBlock } from "../ui/components.js";

const KIND_LABEL = {
  "email:out": "Email sent",
  "email:in": "Email received",
  phone: "Phone call",
  meeting: "Meeting",
  note: "Note",
};

const STATUS_LABEL = { queued: "Waiting to send", sending: "Sending", sent: "Sent", failed: "Not sent", cancelled: "Cancelled" };
const STATUS_TONE = { queued: "warning", sending: "info", failed: "danger", cancelled: "neutral" };

function iconFor(e) {
  if (e.kind === "email") return e.direction === "out" ? "send" : "mail-open";
  return { phone: "phone-call", meeting: "users", note: "sticky-note" }[e.kind] || "message-square";
}

/** "Today 2:15 PM", "Yesterday", "Nov 3": when something happened, short. */
function shortWhen(stamp) {
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (x) => x.toDateString();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (day(d) === day(new Date())) return `Today ${time}`;
  if (day(d) === day(y)) return `Yesterday ${time}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function labelFor(e) {
  return e.kind === "email" ? KIND_LABEL[`email:${e.direction || "in"}`] : KIND_LABEL[e.kind] || e.kind;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Couldn't read that file"));
    r.readAsDataURL(file);
  });
}

function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}


/**
 * The Communications card. `onChange` runs after anything is added (the matter page refreshes
 * its activity). opts.limit: how many entries to show before "Show all" (default 6).
 * Use renderCommunications / communicationsTab (below) to show it in a matter tab.
 */
export function communicationsCard(matterId, { onChange, limit = 6 } = {}) {
  useStyles("email");
  const list = h("div.comms-list", loadingBlock("Loading communications", "lines", 3));
  const filterBox = h("div.comms-toolbar");
  const subtitle = h("span", "Emails, calls, meetings and notes");
  let data = { entries: [], recipients: [], templates: [] };
  let filter = "all";
  let showAll = false;
  const fail = (err) => toast(err.message, { error: true });

  async function load() {
    try {
      data = await get(`/matters/${matterId}/communications`);
    } catch (err) {
      list.replaceChildren(h("div.comms-pad", callout({ tone: "danger", title: "Couldn't load communications", body: err.message, action: button("Try again", { size: "sm", onclick: load }) })));
      return;
    }
    draw();
  }
  const changed = () => {
    load();
    onChange?.();
  };

  // ---------------------------------------------------------------- list
  function draw() {
    const emails = data.entries.filter((e) => e.kind === "email").length;
    const other = data.entries.length - emails;
    subtitle.textContent = data.entries.length ? `${plural(emails, "email")} · ${plural(other, "call or note", "calls and notes")}` : "Emails, calls, meetings and notes";
    filterBox.replaceChildren(
      segmented(
        [
          { value: "all", label: "All", count: data.entries.length },
          { value: "email", label: "Emails", count: emails },
          { value: "other", label: "Calls & notes", count: other },
        ],
        filter,
        (v) => ((filter = v), (showAll = false), draw()),
        { label: "Show" },
      ),
    );
    filterBox.classList.toggle("is-empty", !data.entries.length);
    const shown = data.entries.filter((e) => filter === "all" || (filter === "email" ? e.kind === "email" : e.kind !== "email"));
    const visible = showAll ? shown : shown.slice(0, limit);
    list.replaceChildren(
      ...[
      shown.length
        ? h("ol.comms-entries", visible.map(entryRow))
        : data.entries.length
          ? emptyState({ icon: "inbox", title: "Nothing of this kind yet", compact: true })
          : emptyState({ icon: "email", title: "No communications yet", body: "Emails sent from here, saved emails you file, and calls or meetings you log appear here.", compact: true }),
      shown.length > visible.length ? h("div.comms-more", button(`Show all ${shown.length}`, { size: "sm", variant: "ghost", iconRight: "chevron-down", onclick: () => ((showAll = true), draw()) })) : null,
      ].filter(Boolean),
    );
  }

  function entryRow(e) {
    const who =
      e.kind === "email"
        ? e.direction === "out"
          ? `To ${e.to_addrs || "—"}`
          : `From ${e.from_addr || "unknown sender"}`
        : [e.participants, e.duration_minutes ? `${e.duration_minutes} min` : null].filter(Boolean).join(" · ");
    const status =
      e.kind === "email" && e.direction === "out" && e.send_status && e.send_status !== "sent"
        ? pill(STATUS_LABEL[e.send_status] || e.send_status, STATUS_TONE[e.send_status] || "neutral", { title: e.send_error || null })
        : null;
    if (status) status.classList.add("comms-status");
    // A call or note without a subject is titled by its kind, so the kind isn't repeated below.
    const titled = e.subject || e.kind === "email";
    const subject = e.subject || (e.kind === "email" ? "(no subject)" : labelFor(e));
    const sub = titled ? [h("span.comms-kind", labelFor(e)), who ? ` · ${who}` : ""] : who || (e.direction === "in" ? "They called us" : e.direction === "out" ? "We called them" : "");
    const body = h("div.comms-body", { hidden: true });
    return h(
      "li.comms-entry",
      { dataset: { kind: e.kind } },
      h(
        "button.comms-head",
        {
          type: "button",
          "aria-expanded": "false",
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            const open = btn.getAttribute("aria-expanded") === "true";
            btn.setAttribute("aria-expanded", String(!open));
            body.hidden = open;
            if (!open && !body.dataset.loaded) {
              body.replaceChildren(loadingBlock("Loading", "lines", 2));
              try {
                const full = await get(`/communications/${e.id}`);
                body.dataset.loaded = "1";
                body.replaceChildren(...detail(full).filter(Boolean));
              } catch (err) {
                body.replaceChildren(h("p.error-text", err.message));
              }
            }
          },
        },
        h("span.comms-icon", { "aria-hidden": "true" }, icon(iconFor(e), { size: 15 })),
        h("span.comms-main", h("span.comms-subject", subject), sub ? h("span.comms-who", sub) : null),
        h("span.comms-side", status, h("span.comms-when", { title: fmtTime(e.occurred_at) }, shortWhen(e.occurred_at))),
        icon("chevron-down", { size: 15, class: "comms-chevron" }),
      ),
      body,
    );
  }

  function detail(full) {
    const meta = [
      full.from_addr ? ["From", full.from_addr] : null,
      full.to_addrs ? ["To", full.to_addrs] : null,
      full.cc_addrs ? ["Cc", full.cc_addrs] : null,
      full.participants ? ["With", full.participants] : null,
      ["When", fmtTime(full.occurred_at)],
      full.duration_minutes ? ["Length", `${full.duration_minutes} minutes`] : null,
      full.created_by_name ? ["Recorded by", full.created_by_name] : null,
      full.send_error && full.send_status !== "sent" ? ["Problem", h("span.comms-problem", full.send_error)] : null,
    ].filter(Boolean);
    return [
      kv(meta, { inline: true }),
      full.body ? h("div.comms-text", full.body) : h("p.comms-note", "No notes."),
      full.attachments?.length ? h("p.comms-attach", icon("paperclip", { size: 14 }), h("span", "Attachments saved to Documents: ", full.attachments.map((a) => a.name).join(", "))) : null,
      full.document_id ? h("p.comms-note", "The original email is saved in this matter's Documents, in the Correspondence folder.") : null,
      full.kind !== "email"
        ? h(
            "div.comms-entry-actions",
            button("Remove from log", {
              size: "sm",
              variant: "ghost",
              icon: "trash-2",
              class: "danger-text",
              onclick: async () => {
                if (!confirm("Remove this entry from the log?")) return;
                try {
                  await del(`/communications/${full.id}`);
                  toast("Entry removed");
                  changed();
                } catch (err) {
                  fail(err);
                }
              },
            }),
          )
        : null,
    ];
  }

  // ---------------------------------------------------------------- compose
  async function compose() {
    let docs = [];
    try {
      docs = (await get(`/matters/${matterId}/documents`)).documents || [];
    } catch {
      /* documents are optional */
    }
    const picks = data.recipients.map((r) => [r, h("input", { type: "checkbox", checked: r.isClient })]);
    const extraTo = h("input", { type: "text", placeholder: "Other addresses, separated by commas", "aria-label": "Other recipients", maxlength: 2000 });
    const cc = h("input", { type: "text", "aria-label": "Cc", maxlength: 2000 });
    const tpl = select([{ value: "", label: "No template" }, ...data.templates.map((t) => ({ value: t.id, label: t.name }))], "", { "aria-label": "Template" });
    const subject = h("input", { required: true, maxlength: 900, "aria-label": "Subject" });
    const body = h("textarea.comms-compose-body", { rows: 12, required: true, maxlength: 200000, "aria-label": "Message" });
    const attach = docs.map((d) => [d, h("input", { type: "checkbox" })]);
    const err = h("p.error-text", { role: "alert" });

    const toList = () => [...picks.filter(([, c]) => c.checked).map(([r]) => `${r.name} <${r.email}>`), ...(extraTo.value.trim() ? [extraTo.value] : [])];

    tpl.addEventListener("change", async () => {
      const t = data.templates.find((x) => String(x.id) === tpl.value);
      if (!t) return;
      if (body.value.trim() && !confirm("Replace what you have written with this template?")) return;
      try {
        const r = await post(`/matters/${matterId}/communications/preview`, { to: toList(), subject: t.subject, body: t.body });
        subject.value = r.subject;
        body.value = r.body;
        err.textContent = r.unknown.length ? `The template uses fields that don't exist: ${r.unknown.join(", ")}` : r.empty.length ? `No value yet for: ${r.empty.join(", ")}` : "";
      } catch (ex) {
        err.textContent = ex.message;
      }
    });

    const send = (allowEmptyFields) =>
      post(`/matters/${matterId}/communications/email`, {
        to: toList(),
        cc: cc.value || null,
        subject: subject.value,
        body: body.value,
        documentIds: attach.filter(([, c]) => c.checked).map(([d]) => d.id),
        allowEmptyFields,
      });

    const sendBtn = button("Send", { variant: "primary", type: "submit", icon: "send" });
    const form = h(
      "form.modal-body.form-grid.comms-compose",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = "";
          sendBtn.disabled = true;
          try {
            try {
              await send(false);
            } catch (ex) {
              if (!(ex instanceof ApiError && ex.status === 422)) throw ex;
              if (!confirm(`${ex.message}\n\nSend anyway, leaving them blank?`)) return;
              await send(true);
            }
            dlg.close();
            toast("Email queued to send. It is saved in the matter's communications.");
            changed();
          } catch (ex) {
            err.textContent = ex.message;
          } finally {
            sendBtn.disabled = false;
          }
        },
      },
      h(
        "fieldset.comms-to",
        h("legend", "To"),
        picks.length
          ? h(
              "div.comms-recipients",
              picks.map(([r, c]) =>
                h("label.check-line", c, h("span.comms-recipient", h("span.comms-recipient-name", r.name, r.isClient ? h("span.muted", " (client)") : null), h("span.comms-recipient-email", r.email))),
              ),
            )
          : h("p.comms-note", "No contacts on this matter have an email address yet. Type one below."),
        extraTo,
      ),
      h("div.form-row", field("Cc", cc, { optional: true }), field("Template", tpl)),
      field("Subject", subject),
      field("Message", body, { hint: "Merge fields such as {{client.name}}, {{matter.name}}, {{matter.number}} and {{user.name}} are filled in when you choose a template or send." }),
      attach.length
        ? h(
            "details.comms-attach-pick",
            h("summary", icon("paperclip", { size: 14 }), `Attach documents from this matter (${attach.length})`),
            h("div.comms-attach-list", attach.map(([d, c]) => h("label.check-line", c, h("span", d.folder ? `${d.folder} › ${d.name}` : d.name)))),
          )
        : null,
      err,
      h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), sendBtn),
    );
    const dlg = modal("Write an email", form, { wide: true, subtitle: "Sent from the firm's address and saved to this matter." });
    subject.focus();
  }

  // ---------------------------------------------------------------- log a call
  function logEntry() {
    const kind = select(
      [
        { value: "phone", label: "Phone call" },
        { value: "meeting", label: "Meeting" },
        { value: "note", label: "Note" },
      ],
      "phone",
      { "aria-label": "Kind" },
    );
    const direction = select(
      [
        { value: "", label: "—" },
        { value: "in", label: "They called us" },
        { value: "out", label: "We called them" },
      ],
      "",
      { "aria-label": "Who called" },
    );
    const when = h("input", { type: "datetime-local", value: localNow(), required: true, "aria-label": "When" });
    const minutes = h("input", { type: "number", min: 0, max: 1440, step: 1, inputmode: "numeric", "aria-label": "Length in minutes" });
    const who = h("input", { maxlength: 500, placeholder: "e.g. Dana Client", "aria-label": "With" });
    const subject = h("input", { maxlength: 300, "aria-label": "Subject" });
    const notes = h("textarea", { rows: 5, maxlength: 200000, "aria-label": "Notes" });
    const err = h("p.error-text", { role: "alert" });
    const dirLabel = field("Who called", direction);
    kind.addEventListener("change", () => (dirLabel.hidden = kind.value !== "phone"));
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await post(`/matters/${matterId}/communications/log`, {
              kind: kind.value,
              direction: kind.value === "phone" && direction.value ? direction.value : null,
              occurredAt: when.value ? new Date(when.value).toISOString() : null,
              durationMinutes: minutes.value === "" ? null : Number(minutes.value),
              participants: who.value || null,
              subject: subject.value || null,
              notes: notes.value || null,
            });
            dlg.close();
            toast("Added to the log");
            changed();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("div.form-row", field("Kind", kind), dirLabel, field("Length (minutes)", minutes, { optional: true })),
      h("div.form-row.two", field("When", when), field("With", who)),
      field("Subject", subject, { optional: true }),
      field("Notes", notes, { optional: true }),
      err,
      h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), button("Add to log", { variant: "primary", type: "submit" })),
    );
    const dlg = modal("Log a call or meeting", form, { wide: true });
    who.focus();
  }

  // ---------------------------------------------------------------- file .eml
  async function importFiles(files) {
    const emls = [...files].filter((f) => /\.eml$/i.test(f.name) || f.type === "message/rfc822");
    if (!emls.length) return toast("Only saved emails (.eml files) can be filed here. Other files go in Documents.", { error: true });
    let ok = 0;
    for (const f of emls) {
      try {
        const r = await post(`/matters/${matterId}/communications/import`, { filename: f.name, contentBase64: await readAsBase64(f) });
        ok++;
        const extra = [
          r.attachments.length ? `${plural(r.attachments.length, "attachment")} saved to Documents` : null,
          r.skipped.length ? `${plural(r.skipped.length, "attachment")} not saved: ${r.skipped.map((s) => s.name).join(", ")}` : null,
        ].filter(Boolean);
        toast([`Filed “${r.subject || f.name}”`, ...extra]);
      } catch (err) {
        toast(`${f.name}: ${err.message}`, { error: true });
      }
    }
    if (ok) changed();
  }

  const fileInput = h("input.comms-file-input.visually-hidden", {
    type: "file",
    accept: ".eml,message/rfc822",
    multiple: true,
    tabindex: "-1",
    "aria-label": "Choose saved emails to file",
    onchange: (e) => {
      importFiles(e.target.files);
      e.target.value = "";
    },
  });
  const drop = h(
    "div.comms-drop",
    icon("mail", { size: 15, class: "comms-drop-icon" }),
    h(
      "span",
      "Drag a saved email (.eml) here to file it to this matter, or ",
      h("button.linkish.comms-link", { type: "button", onclick: () => fileInput.click() }, "choose a file"),
      ".",
    ),
    fileInput,
  );

  const el = card({
    id: "communications",
    title: "Communications",
    subtitle,
    icon: "email",
    className: "comms",
    flush: true,
    actions: [
      button("Log a call or meeting", { size: "sm", icon: "phone", onclick: logEntry }),
      button("Write an email", { size: "sm", icon: "mail", onclick: () => compose().catch(fail) }),
    ],
    body: [filterBox, list],
    footer: drop,
  });
  for (const [ev, on] of [
    ["dragenter", true],
    ["dragover", true],
    ["dragleave", false],
    ["drop", false],
  ]) {
    el.addEventListener(ev, (e) => {
      if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes("Files")) return;
      e.preventDefault();
      el.classList.toggle("dragging", on);
      if (ev === "drop") importFiles(e.dataTransfer.files);
    });
  }
  load();
  return el;
}

/** Render the Communications panel into `container` (a matter tab, or any other slot). */
export function renderCommunications(container, matterId, opts = {}) {
  container.replaceChildren(communicationsCard(matterId, { limit: 50, ...opts }));
  return container;
}

/** Ready to pass to registerMatterTab() from ui/matter-slots.js. */
export const communicationsTab = {
  id: "communications",
  label: "Communications",
  icon: "email",
  order: 40,
  render: (ctx) => communicationsCard(ctx.matterId, { limit: 50, onChange: () => Promise.resolve(ctx.refresh?.()).catch(() => {}) }),
};
