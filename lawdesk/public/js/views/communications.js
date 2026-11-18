// The matter page's "Communications" card: the log of emails, calls and meetings, writing an
// email to the client from a template, logging a call, and filing a saved email (.eml)
// dragged onto the card.

import { h, select, modal, toast, fmtTime, plural } from "../dom.js";
import { get, post, del, ApiError } from "../api.js";

const KIND_LABEL = {
  "email:out": "Email sent",
  "email:in": "Email received",
  phone: "Phone call",
  meeting: "Meeting",
  note: "Note",
};

const STATUS_LABEL = { queued: "Waiting to send", sending: "Sending", sent: "Sent", failed: "Not sent", cancelled: "Cancelled" };

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

/** Build the card. `onChange` runs after anything is added (the matter page refreshes its activity). */
export function communicationsCard(matterId, { onChange } = {}) {
  const card = h("section.card.comms#communications", { "aria-labelledby": "comms-title" });
  const list = h("div.comms-list");
  let data = { entries: [], recipients: [], templates: [] };
  let filter = "all";
  const fail = (err) => toast(err.message, { error: true });

  async function load() {
    try {
      data = await get(`/matters/${matterId}/communications`);
    } catch (err) {
      list.replaceChildren(h("p.error-text", err.message));
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
    const shown = data.entries.filter((e) => filter === "all" || (filter === "email" ? e.kind === "email" : e.kind !== "email"));
    list.replaceChildren(
      shown.length
        ? h("ol.comms-entries", shown.map(entryRow))
        : h("p.empty", data.entries.length ? "Nothing of this kind yet." : "No emails, calls or meetings recorded on this matter yet."),
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
        ? h("span.tag.comms-status" + (e.send_status === "failed" ? ".bad" : ""), { title: e.send_error || "" }, STATUS_LABEL[e.send_status] || e.send_status)
        : null;
    const body = h("div.comms-body", { hidden: true });
    const row = h(
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
        h("span.comms-kind", labelFor(e)),
        h("span.comms-when", fmtTime(e.occurred_at)),
        h("span.comms-subject", e.subject || (e.kind === "email" ? "(no subject)" : "")),
        h("span.comms-who", who),
        status,
      ),
      body,
    );
    return row;
  }

  function detail(full) {
    const meta = [
      full.from_addr ? ["From", full.from_addr] : null,
      full.to_addrs ? ["To", full.to_addrs] : null,
      full.cc_addrs ? ["Cc", full.cc_addrs] : null,
      full.participants ? ["With", full.participants] : null,
      full.duration_minutes ? ["Length", `${full.duration_minutes} minutes`] : null,
      full.created_by_name ? ["Recorded by", full.created_by_name] : null,
      full.send_error && full.send_status !== "sent" ? ["Problem", full.send_error] : null,
    ].filter(Boolean);
    return [
      h("dl.comms-meta", meta.map(([k, v]) => [h("dt", k), h("dd", v)])),
      full.body ? h("div.comms-text", full.body) : h("p.muted", "No notes."),
      full.attachments?.length ? h("p.comms-attach", "Attachments saved to Documents: ", full.attachments.map((a) => a.name).join(", ")) : null,
      full.document_id ? h("p.muted.small", "The original email is saved in this matter's Documents, in the Correspondence folder.") : null,
      full.kind !== "email"
        ? h(
            "div.form-actions",
            h(
              "button.btn.small",
              {
                type: "button",
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
              },
              "Remove",
            ),
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
    const hint = h("p.muted.small", "Merge fields such as {{client.name}}, {{matter.name}}, {{matter.number}} and {{user.name}} are filled in when you choose a template or send.");

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

    const send = async (allowEmptyFields) => {
      const r = await post(`/matters/${matterId}/communications/email`, {
        to: toList(),
        cc: cc.value || null,
        subject: subject.value,
        body: body.value,
        documentIds: attach.filter(([, c]) => c.checked).map(([d]) => d.id),
        allowEmptyFields,
      });
      return r;
    };

    const form = h(
      "form.modal-body.form-grid.comms-compose",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = "";
          const sendBtn = form.querySelector("button[type=submit]");
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
          ? picks.map(([r, c]) => h("label.check-line", c, " ", h("span", r.name, r.isClient ? h("span.muted", " (client)") : null, h("span.muted", ` ${r.email}`))))
          : h("p.muted.small", "No contacts have an email address yet. Type one below."),
        extraTo,
      ),
      h("label", "Cc", cc),
      h("label", "Template", tpl),
      h("label", "Subject", subject),
      h("label", "Message", body),
      hint,
      attach.length
        ? h("details.comms-attach-pick", h("summary", `Attach documents from this matter (${attach.length})`), attach.map(([d, c]) => h("label.check-line", c, " ", d.folder ? `${d.folder}/${d.name}` : d.name)))
        : null,
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Send")),
    );
    const dlg = modal("Write an email", form, { wide: true });
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
    const dirLabel = h("label", "Who called", direction);
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
      h("div.form-row", h("label", "Kind", kind), dirLabel, h("label", "Length (minutes)", minutes)),
      h("div.form-row.two", h("label", "When", when), h("label", "With", who)),
      h("label", "Subject", subject),
      h("label", "Notes", notes),
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Add to log")),
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

  const fileInput = h("input.comms-file-input", {
    type: "file",
    accept: ".eml,message/rfc822",
    multiple: true,
    "aria-label": "Choose saved emails to file",
    onchange: (e) => {
      importFiles(e.target.files);
      e.target.value = "";
    },
  });
  const drop = h(
    "div.comms-drop",
    h("span", "Drag a saved email (.eml) here to file it to this matter, or "),
    h("button.comms-link", { type: "button", onclick: () => fileInput.click() }, "choose a file"),
    h("span", "."),
    fileInput,
  );
  for (const [ev, on] of [
    ["dragenter", true],
    ["dragover", true],
    ["dragleave", false],
    ["drop", false],
  ]) {
    card.addEventListener(ev, (e) => {
      if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes("Files")) return;
      e.preventDefault();
      card.classList.toggle("dragging", on);
      if (ev === "drop") importFiles(e.dataTransfer.files);
    });
  }

  const filterSel = select(
    [
      { value: "all", label: "Everything" },
      { value: "email", label: "Emails" },
      { value: "other", label: "Calls, meetings and notes" },
    ],
    "all",
    { "aria-label": "Show", onchange: (e) => ((filter = e.target.value), draw()) },
  );

  card.append(
    h(
      "div.comms-toolbar",
      h("h2#comms-title", "Communications"),
      h(
        "div.comms-actions",
        filterSel,
        h("button.btn.small", { type: "button", onclick: logEntry }, "Log a call or meeting"),
        h("button.btn.small.primary", { type: "button", onclick: () => compose().catch(fail) }, "Write an email"),
      ),
    ),
    list,
    drop,
  );
  load();
  return card;
}
