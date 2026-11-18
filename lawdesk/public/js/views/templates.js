// Document templates: Settings > Document templates (upload, the fields each one uses, the
// list of fields you can use) and "Create from template" on a matter.

import { h, replace, select, modal, toast, fmtTime, plural } from "../dom.js";
import { get, post, del } from "../api.js";
import { sendFile, fmtSize } from "../upload.js";

const fail = (err) => toast(err.message, { error: true });
const KIND = { docx: "Word", txt: "Text", html: "Web page" };

/** Plain-English label for a field, from the catalog, or a tidy version of the field name. */
function labeller(catalog) {
  const map = new Map(catalog.flatMap((g) => g.fields).map((f) => [f.field, f.label]));
  return (field) => map.get(field) ?? field.split(".").pop().replace(/_/g, " ");
}

const code = (field) => `{{${field}}}`;

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${text}`);
  } catch {
    toast(`Type ${text} in your template`);
  }
}

// --------------------------------------------------------------- settings page

export async function templatesSettingsView() {
  const page = h("div.page.templates-page");
  const listBox = h("div.template-list");
  let catalog = [];
  let showDeleted = false;

  async function load() {
    const [templates, cat] = await Promise.all([get(`/document-templates${showDeleted ? "?deleted=1" : ""}`), get("/document-templates/fields")]);
    catalog = cat;
    drawList(templates);
    drawReference();
  }

  function drawList(templates) {
    const label = labeller(catalog);
    replace(listBox, 
      templates.length
        ? h(
            "ul.plain.templates",
            templates.map((t) =>
              h(
                "li.card.template" + (t.deletedAt ? ".deleted" : ""),
                h(
                  "div.template-head",
                  h("div", h("h3", t.name), h("p.muted.small", [KIND[t.kind] || t.kind, t.category, t.filename, fmtSize(t.size), `updated ${fmtTime(t.updatedAt)}`].filter(Boolean).join(" · "))),
                  h(
                    "div.head-actions",
                    t.deletedAt
                      ? h("button.btn.small", { type: "button", onclick: () => post(`/document-templates/${t.id}/restore`).then(() => (toast(`Restored “${t.name}”`), load()), fail) }, "Restore")
                      : [
                          h("a.btn.small", { href: `/api/document-templates/${t.id}/file`, download: t.filename }, "Download"),
                          replaceButton(t),
                          h(
                            "button.btn.small.danger-text",
                            {
                              type: "button",
                              onclick: () =>
                                del(`/document-templates/${t.id}`).then(
                                  () => (toast(`Deleted “${t.name}”`, { action: { label: "Undo", run: () => post(`/document-templates/${t.id}/restore`).then(load, fail) } }), load()),
                                  fail,
                                ),
                            },
                            "Delete",
                          ),
                        ],
                  ),
                ),
                t.description ? h("p", t.description) : null,
                h(
                  "div.template-fields",
                  h("span.muted.small", t.fields.length ? `Fills in ${plural(t.fields.length, "field")}:` : "This template has no merge fields."),
                  h("ul.plain.field-chips", t.fields.map((f) => h("li.field-chip", { title: code(f) }, label(f)))),
                ),
              ),
            ),
          )
        : h("div.card.empty-big", h("p", "No templates yet."), h("p", "Upload a Word, text or web page file that uses merge fields such as {{client.name}}.")),
      h(
        "label.toggle",
        h("input", { type: "checkbox", checked: showDeleted, onchange: (e) => ((showDeleted = e.target.checked), load()) }),
        " Show deleted templates",
      ),
    );
  }

  function replaceButton(t) {
    const input = h("input.visually-hidden", {
      type: "file",
      accept: ".docx,.txt,.md,.html,.htm",
      tabindex: "-1",
      "aria-hidden": "true",
      onchange: async () => {
        const file = input.files[0];
        input.value = "";
        if (!file) return;
        try {
          const r = await sendFile(`/document-templates/${t.id}/upload`, file);
          toast(`Replaced the file for “${r.name}”. It uses ${plural(r.fields.length, "field")}.`);
          load();
        } catch (err) {
          fail(err);
        }
      },
    });
    return [h("button.btn.small", { type: "button", onclick: () => input.click() }, "Replace file"), input];
  }

  // Upload form
  const name = h("input", { maxlength: 200, placeholder: "e.g. Engagement letter" });
  const category = h("input", { maxlength: 100, placeholder: "e.g. Letters" });
  const description = h("input", { maxlength: 1000, placeholder: "What it's for (optional)" });
  const file = h("input", { type: "file", accept: ".docx,.txt,.md,.html,.htm", required: true });
  const err = h("p.error-text", { role: "alert" });
  const bar = h("span.progress-fill", { style: { width: "0%" } });
  const upload = h(
    "form.card.form-grid.template-upload",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const f = file.files[0];
        if (!f) return;
        try {
          const t = await sendFile(
            "/document-templates/upload",
            f,
            { templateName: name.value.trim() || undefined, category: category.value.trim(), description: description.value.trim() },
            { onProgress: (x) => (bar.style.width = Math.round(x * 100) + "%") },
          );
          toast(`Added “${t.name}”. It fills in ${plural(t.fields.length, "field")}.`);
          upload.reset();
          bar.style.width = "0%";
          load();
        } catch (ex) {
          err.textContent = ex.message;
          bar.style.width = "0%";
        }
      },
    },
    h("h2", "Add a template"),
    h("p.muted", "Word (.docx), text or web page files. Where a value should go, type the field in double curly brackets, for example {{client.name}}."),
    h("label", "File", file),
    h("div.form-row", h("label", "Name", name), h("label", "Category", category)),
    h("label", "Description", description),
    h("span.progress-bar", { "aria-hidden": "true" }, bar),
    err,
    h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Add template")),
  );

  const reference = h("aside.card.field-reference", { "aria-labelledby": "fields-title" });
  function drawReference() {
    replace(reference, 
      h("h2#fields-title", "Fields you can use"),
      h("p.muted.small", "Click a field to copy it, then paste it into your template."),
      catalog
        .filter((g) => g.fields.length)
        .map((g) =>
          h(
            "section.field-group",
            h("h3", g.group),
            h(
              "dl.field-list",
              g.fields.map((f) => [
                h("dt", h("button.field-code", { type: "button", title: "Copy", onclick: () => copy(code(f.field)) }, code(f.field))),
                h("dd", f.label, f.example ? h("span.muted", ` (today: ${f.example})`) : null, f.hint ? h("span.muted.small.field-hint", f.hint) : null),
              ]),
            ),
          ),
        ),
      h(
        "section.field-group",
        h("h3", "Wording that depends on a value"),
        h(
          "dl.field-list",
          h("dt", h("code", "{{#if client.email}} … {{/if}}")),
          h("dd", "Include the words in between only when the client has an email address."),
          h("dt", h("code", "{{#if not matter.closed_on}} … {{else}} … {{/if}}")),
          h("dd", "Choose between two wordings."),
          h("dt", h("code", "{{client.name|upper}}")),
          h("dd", "Capital letters. Use |lower for small letters, |long to write a date out."),
          h("dt", h("code", "{{custom.anything}}")),
          h("dd", "A value typed in when the document is created."),
        ),
      ),
    );
  }

  page.append(
    h("a.back", { href: "#/settings" }, "← Settings"),
    h("div.page-head", h("div", h("h1", "Document templates"), h("p.sub", "Letters and forms that fill in client and matter details for you."))),
    h("div.templates-layout", h("div.templates-main", upload, listBox), reference),
  );
  await load();
  return page;
}

// ---------------------------------------------------- create from template

/**
 * On a matter: pick a template, see which fields will be filled and which will be blank,
 * then create the document and open it.
 */
export async function templateDialog(matterId, { folder = "" } = {}) {
  let templates;
  let folders;
  try {
    [templates, { folders }] = await Promise.all([get("/document-templates"), get(`/matters/${matterId}/documents`)]);
  } catch (err) {
    return fail(err);
  }
  if (!templates.length) {
    const none = modal(
      "Create from template",
      h(
        "div.modal-body",
        h("p", "There are no document templates yet."),
        h("div.form-actions", h("a.btn.primary", { href: "#/settings/templates", onclick: () => none.close() }, "Add a template")),
      ),
    );
    return;
  }
  const paths = new Set();
  for (const f of folders) f.split("/").forEach((_, i, a) => paths.add(a.slice(0, i + 1).join("/")));
  const pick = select(templates.map((t) => ({ value: t.id, label: t.name, group: t.category || "Other" })), templates[0].id, { "aria-label": "Template" });
  const filename = h("input", { maxlength: 200, required: true });
  const folderSel = select([{ value: "", label: "Top level" }, ...[...paths].sort().map((p) => ({ value: p, label: p.split("/").join(" › ") }))], folder);
  const report = h("div.field-check", { "aria-live": "polite" });
  const err = h("p.error-text", { role: "alert" });
  const go = h("button.btn.primary", { type: "submit" }, "Create document");
  let customFields = [];

  async function check() {
    replace(report, h("p.muted", "Checking…"));
    try {
      const c = await get(`/matters/${matterId}/templates/${pick.value}/check`);
      filename.value = c.suggestedName;
      const filled = c.fields.filter((f) => f.status === "filled");
      const blank = c.fields.filter((f) => f.status !== "filled" && !f.field.startsWith("custom."));
      customFields = c.fields.filter((f) => f.field.startsWith("custom."));
      replace(report, 
        blank.length
          ? h(
              "div.check-warn",
              h("p", h("b", blank.length === 1 ? "1 field will be blank" : `${blank.length} fields will be blank`), blank.length === 1 ? ". Fill it in on the matter first, or edit the document afterwards." : ". Fill them in on the matter first, or edit the document afterwards."),
              h("ul", blank.map((f) => h("li", f.label, f.status === "unknown" ? h("span.muted.small", ` (${code(f.field)} isn't a field Lawdesk knows; check the template)`) : null))),
            )
          : h("p.check-ok", "Every field has a value for this matter."),
        customFields.length
          ? h(
              "fieldset.custom-fields",
              h("legend", "Values to type in"),
              customFields.map((f) => h("label", f.label.replace(/ \(typed in when creating the document\)$/, ""), h("input", { "data-field": f.field.slice(7), maxlength: 2000 }))),
            )
          : null,
        filled.length
          ? h(
              "details.check-filled",
              h("summary", `${plural(filled.length, "field")} will be filled in`),
              h("dl.field-values", filled.map((f) => [h("dt", f.label), h("dd", f.value)])),
            )
          : null,
      );
    } catch (ex) {
      replace(report, h("p.error-text", ex.message));
    }
  }
  pick.addEventListener("change", check);

  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        go.disabled = true;
        const custom = {};
        for (const inp of report.querySelectorAll("[data-field]")) if (inp.value.trim()) custom[inp.dataset.field] = inp.value.trim();
        try {
          const r = await post(`/matters/${matterId}/documents/generate`, { templateId: Number(pick.value), filename: filename.value.trim(), folder: folderSel.value, custom });
          dlg.close();
          toast(`Created “${r.document.name}”${r.empty.length ? ` (${plural(r.empty.length, "blank field")})` : ""}`);
          location.hash = `#/matters/${matterId}/documents/${r.document.id}`;
        } catch (ex) {
          err.textContent = ex.message;
          go.disabled = false;
        }
      },
    },
    h("label", "Template", pick),
    report,
    h("div.form-row", h("label", "File name", filename), h("label", "Folder", folderSel)),
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), go),
  );
  const dlg = modal("Create from template", form, { wide: true });
  await check();
}
