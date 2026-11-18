// Document templates: Settings > Document templates (upload, the fields each one uses, the
// list of fields you can use) and "Create from template" on a matter.

import { h, replace, select, modal, toast, fmtTime, plural } from "../dom.js";
import { get, post, del } from "../api.js";
import { sendFile, fmtSize } from "../upload.js";
import { icon } from "../ui/icons.js";
import { pageHeader, card, button, emptyState, field, callout, useStyles, loadingBlock } from "../ui/components.js";

const fail = (err) => toast(err.message, { error: true });
const KIND = { docx: "Word", txt: "Text", html: "Web page" };
const KIND_ICON = { docx: "file-text", txt: "file-text", html: "file" };

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
  useStyles("documents");
  const page = h("div.page.templates-page");
  const listBody = h("div.template-list", loadingBlock("Loading templates", "lines", 3));
  const listSub = h("span", "");
  let catalog = [];
  let showDeleted = false;

  async function load() {
    try {
      const [templates, cat] = await Promise.all([get(`/document-templates${showDeleted ? "?deleted=1" : ""}`), get("/document-templates/fields")]);
      catalog = cat;
      drawList(templates);
      drawReference();
    } catch (err) {
      replace(listBody, h("div.docs-search-error", callout({ tone: "danger", title: "Couldn't load the templates", body: err.message, action: button("Try again", { size: "sm", onclick: load }) })));
    }
  }

  function drawList(templates) {
    const label = labeller(catalog);
    const live = templates.filter((t) => !t.deletedAt).length;
    listSub.textContent = templates.length ? `${plural(live, "template")}${live !== templates.length ? ` · ${templates.length - live} deleted` : ""}` : "";
    replace(
      listBody,
      templates.length
        ? h(
            "ul.templates",
            templates.map((t) =>
              h(
                "li.template" + (t.deletedAt ? ".deleted" : ""),
                h("span.doc-icon", { "aria-hidden": "true" }, icon(KIND_ICON[t.kind] || "file", { size: 16 })),
                h(
                  "div.template-main",
                  h(
                    "div.template-head",
                    h(
                      "div",
                      h("h3.template-name", t.name, t.deletedAt ? h("span.visually-hidden", " (deleted)") : null),
                      h("p.template-meta", [KIND[t.kind] || t.kind, t.category, t.filename, fmtSize(t.size), `updated ${fmtTime(t.updatedAt)}`].filter(Boolean).join(" · ")),
                    ),
                    h(
                      "div.template-actions",
                      t.deletedAt
                        ? button("Restore", { size: "sm", icon: "rotate-ccw", onclick: () => post(`/document-templates/${t.id}/restore`).then(() => (toast(`Restored “${t.name}”`), load()), fail) })
                        : [
                            h("a.icon-btn.sm", { href: `/api/document-templates/${t.id}/file`, download: t.filename, "aria-label": `Download ${t.name}`, title: "Download" }, icon("download", { size: 15 })),
                            replaceButton(t),
                            button("Delete", {
                              size: "sm",
                              variant: "ghost",
                              class: "danger-text",
                              onclick: () =>
                                del(`/document-templates/${t.id}`).then(
                                  () => (toast(`Deleted “${t.name}”`, { action: { label: "Undo", run: () => post(`/document-templates/${t.id}/restore`).then(load, fail) } }), load()),
                                  fail,
                                ),
                            }),
                          ],
                    ),
                  ),
                  t.description ? h("p.template-desc", t.description) : null,
                  h(
                    "div.template-fields",
                    h("span.template-fields-label", t.fields.length ? `Fills in ${plural(t.fields.length, "field")}` : "This template has no merge fields."),
                    t.fields.length ? h("ul.field-chips", t.fields.map((f) => h("li.field-chip", { title: code(f) }, label(f)))) : null,
                  ),
                ),
              ),
            ),
          )
        : emptyState({ icon: "file-plus", title: "No templates yet", body: "Add a Word, text or web page file that uses merge fields such as {{client.name}}.", compact: true }),
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
    return [button("Replace file", { size: "sm", icon: "upload", onclick: () => input.click() }), input];
  }

  // Upload form
  const name = h("input", { maxlength: 200, placeholder: "e.g. Engagement letter" });
  const category = h("input", { maxlength: 100, placeholder: "e.g. Letters" });
  const description = h("input", { maxlength: 1000, placeholder: "What it's for" });
  const file = h("input", { type: "file", accept: ".docx,.txt,.md,.html,.htm", required: true });
  const err = h("p.error-text", { role: "alert" });
  const bar = h("span.docs-progress-fill", { style: { width: "0%" } });
  const upload = h(
    "form.form-grid.template-upload",
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
    field("File", file, { required: true, hint: "Word (.docx), text or web page. Where a value should go, type the field in double curly brackets, for example {{client.name}}." }),
    h("div.form-row", field("Name", name, { optional: true }), field("Category", category, { optional: true })),
    field("Description", description, { optional: true }),
    h("span.docs-progress", { "aria-hidden": "true" }, bar),
    err,
    h("div.form-actions", button("Add template", { variant: "primary", type: "submit", icon: "plus" })),
  );

  const refBody = h("div");
  function drawReference() {
    replace(
      refBody,
      catalog
        .filter((g) => g.fields.length)
        .map((g) =>
          h(
            "section.field-group",
            h("h3", g.group),
            h(
              "dl.field-list",
              g.fields.map((f) => [
                h("dt", h("button.field-code", { type: "button", title: "Copy", "aria-label": `Copy ${code(f.field)}` }, code(f.field), icon("copy", { size: 12 }))),
                h("dd", f.label, f.example ? h("span.muted", ` (today: ${f.example})`) : null, f.hint ? h("span.tpl-hint", f.hint) : null),
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
    // One listener for every copy button (the label is the field code).
    for (const b of refBody.querySelectorAll(".field-code")) b.addEventListener("click", () => copy(b.textContent));
  }

  const toggle = h(
    "label.toggle.templates-show-deleted",
    h("input", { type: "checkbox", role: "switch", checked: showDeleted, onchange: (e) => ((showDeleted = e.target.checked), load()) }),
    h("span.toggle-track", { "aria-hidden": "true" }),
    "Show deleted",
  );

  page.append(
    pageHeader({
      title: "Document templates",
      breadcrumbs: [{ label: "Settings", href: "#/settings" }, { label: "Document templates" }],
      subtitle: "Letters and forms that fill in client and matter details for you.",
    }),
    h(
      "div.templates-layout",
      h(
        "div.templates-main",
        card({ title: "Templates", subtitle: listSub, icon: "documents", flush: true, actions: toggle, body: listBody }),
        card({ title: "Add a template", icon: "upload", body: upload }),
      ),
      card({ title: "Fields you can use", subtitle: "Click a field to copy it, then paste it into your template.", icon: "copy", tag: "aside", className: "field-reference", body: refBody }),
    ),
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
  useStyles("documents");
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
        emptyState({
          icon: "file-plus",
          title: "There are no document templates yet",
          body: "Templates are letters and forms that fill in client and matter details. Add one in Settings.",
          action: button("Add a template", { variant: "primary", href: "#/settings/templates", onclick: () => none.close() }),
          compact: true,
        }),
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
  const go = button("Create document", { variant: "primary", type: "submit", icon: "file-plus" });
  let customFields = [];

  async function check() {
    replace(report, loadingBlock("Checking the fields", "lines", 2));
    try {
      const c = await get(`/matters/${matterId}/templates/${pick.value}/check`);
      filename.value = c.suggestedName;
      const filled = c.fields.filter((f) => f.status === "filled");
      const blank = c.fields.filter((f) => f.status !== "filled" && !f.field.startsWith("custom."));
      customFields = c.fields.filter((f) => f.field.startsWith("custom."));
      const warn = blank.length
        ? callout({
            tone: "warning",
            title: blank.length === 1 ? "1 field will be blank" : `${blank.length} fields will be blank`,
            body: h(
              "span",
              blank.length === 1 ? "Fill it in on the matter first, or edit the document afterwards." : "Fill them in on the matter first, or edit the document afterwards.",
              h("ul", blank.map((f) => h("li", f.label, f.status === "unknown" ? h("span.muted", ` (${code(f.field)} isn't a field Lawdesk knows; check the template)`) : null))),
            ),
          })
        : callout({ tone: "success", title: "Every field has a value for this matter." });
      warn.classList.add(blank.length ? "check-warn" : "check-ok");
      replace(
        report,
        warn,
        customFields.length
          ? h(
              "fieldset.custom-fields",
              h("legend", "Values to type in"),
              customFields.map((f) => field(f.label.replace(/ \(typed in when creating the document\)$/, ""), h("input", { "data-field": f.field.slice(7), maxlength: 2000 }))),
            )
          : null,
        filled.length
          ? h("details.check-filled", h("summary", `${plural(filled.length, "field")} will be filled in`), h("dl.field-values", filled.map((f) => [h("dt", f.label), h("dd", f.value)])))
          : null,
      );
    } catch (ex) {
      replace(report, callout({ tone: "danger", title: "Couldn't check this template", body: ex.message }));
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
    field("Template", pick),
    report,
    h("div.form-row", field("File name", filename), field("Folder", folderSel)),
    err,
    h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), go),
  );
  const dlg = modal("Create from template", form, { wide: true, subtitle: "Fills in the client and matter details, then saves the new document to this matter." });
  await check();
}
