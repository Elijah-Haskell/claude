// Documents: the card on a matter page, a matter's full Documents page (folders, upload,
// preview, versions, trash) and the firm-wide Documents search.

import { h, replace, select, modal, toast, fmtTime, plural } from "../dom.js";
import { get, patch, post, del } from "../api.js";
import { sendFile, fmtSize, kindOf, previewKind, fileUrl } from "../upload.js";
import { templateDialog } from "./templates.js";

const fail = (err) => toast(err.message, { error: true });

let facetsCache = null;
async function facets(fresh = false) {
  if (!facetsCache || fresh) facetsCache = await get("/documents/facets");
  return facetsCache;
}

const folderLabel = (f) => (f ? f.split("/").join(" › ") : "Top level");

function typeBadge(mime) {
  return h("span.doc-type", { title: mime || "" }, kindOf(mime));
}

// ------------------------------------------------------------------ uploads

/** Ask what to do when a file's name is already used in that folder. */
function askConflict(name, folder) {
  return new Promise((resolve) => {
    let answer = "skip";
    const pick = (v) => () => ((answer = v), dlg.close());
    const dlg = modal(
      "A document with this name already exists",
      h(
        "div.modal-body",
        h("p", "“", h("b", name), "” is already in ", folderLabel(folder), "."),
        h("p.muted", "Saving it as a new version keeps every earlier version, so nothing is lost."),
        h(
          "div.form-actions",
          h("button.btn", { type: "button", onclick: pick("skip") }, "Don't upload"),
          h("button.btn", { type: "button", onclick: pick("rename") }, "Keep both"),
          h("button.btn.primary", { type: "button", onclick: pick("version") }, "Save as new version"),
        ),
      ),
    );
    dlg.addEventListener("close", () => resolve(answer));
  });
}

/**
 * Upload files one after another into a matter folder, showing progress in `box`.
 * `existing` (the matter's documents, if known) lets us ask about a name clash before sending.
 * Returns the documents that were saved.
 */
export async function uploadFiles(matterId, files, folder, box, existing = []) {
  const { maxBytes } = await facets();
  const saved = [];
  for (const file of files) {
    const bar = h("span.progress-fill", { style: { width: "0%" } });
    const status = h("span.upload-status.muted.small", "Waiting…");
    const row = h(
      "li.upload-row",
      h("span.upload-name", file.name),
      h("span.progress-bar", { role: "progressbar", "aria-label": `Uploading ${file.name}`, "aria-valuemin": "0", "aria-valuemax": "100" }, bar),
      status,
    );
    box?.append(row);
    const setPct = (f) => {
      const pct = Math.round(f * 100);
      bar.style.width = pct + "%";
      bar.parentElement.setAttribute("aria-valuenow", String(pct));
      status.textContent = pct < 100 ? `${pct}%` : "Saving…";
    };
    const finish = (text, ok) => {
      status.textContent = text;
      row.classList.add(ok ? "done" : "failed");
      if (ok) setTimeout(() => row.remove(), 4000);
    };
    if (file.size > maxBytes) {
      finish(`Too large (limit ${fmtSize(maxBytes)})`, false);
      continue;
    }
    if (file.size === 0) {
      finish("The file is empty", false);
      continue;
    }
    let mode = "error";
    const clash = existing.some((d) => d.folder === folder && d.name.toLowerCase() === file.name.normalize("NFC").toLowerCase());
    if (clash) {
      mode = await askConflict(file.name, folder);
      if (mode === "skip") {
        finish("Not uploaded", true);
        continue;
      }
    }
    for (;;) {
      try {
        const doc = await sendFile(`/matters/${matterId}/documents/upload`, file, { folder, onConflict: mode }, { onProgress: setPct });
        saved.push(doc);
        finish(doc.version > 1 ? `Saved as version ${doc.version}` : "Uploaded", true);
        break;
      } catch (err) {
        if (err.status === 409 && mode === "error") {
          mode = await askConflict(file.name, folder);
          if (mode === "skip") {
            finish("Not uploaded", true);
            break;
          }
          continue;
        }
        finish(err.message, false);
        break;
      }
    }
  }
  if (saved.length) facets(true).catch(() => {});
  return saved;
}

/** A hidden file input; calls onFiles with the chosen files. */
function filePicker(onFiles, { multiple = true } = {}) {
  const input = h("input.visually-hidden", {
    type: "file",
    multiple,
    tabindex: "-1",
    "aria-hidden": "true",
    onchange: () => {
      const files = [...input.files];
      input.value = "";
      if (files.length) onFiles(files);
    },
  });
  return input;
}

// Drop targets nest (a folder inside the page), and a drop handled by an inner one never
// reaches the outer ones, so every highlight is cleared when any drag ends.
const resets = new Set();
const resetAll = () => resets.forEach((r) => (r.isConnected ? r.reset() : resets.delete(r)));
window.addEventListener("drop", resetAll, true);
window.addEventListener("dragend", resetAll, true);
// A file dropped anywhere else must not make the browser leave the app to open it.
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragover", (e) => {
  if (hasFiles(e) && !e.defaultPrevented) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  }
});
window.addEventListener("drop", (e) => hasFiles(e) && e.preventDefault());

/** Make an element accept dropped files (and, optionally, dragged documents). */
function dropTarget(el, { onFiles, onDoc }) {
  let depth = 0;
  resets.add({
    get isConnected() {
      return el.isConnected;
    },
    reset() {
      depth = 0;
      el.classList.remove("drop-over");
    },
  });
  const accepts = (e) => [...e.dataTransfer.types].some((t) => t === "Files" || (onDoc && t === "application/x-lawdesk-doc"));
  el.addEventListener("dragenter", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    depth++;
    el.classList.add("drop-over");
  });
  el.addEventListener("dragover", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = [...e.dataTransfer.types].includes("Files") ? "copy" : "move";
  });
  el.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) el.classList.remove("drop-over");
  });
  el.addEventListener("drop", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    el.classList.remove("drop-over");
    const doc = e.dataTransfer.getData("application/x-lawdesk-doc");
    if (doc && onDoc) onDoc(Number(doc));
    else if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
  });
}

// ------------------------------------------------------------- matter card

/** The Documents card on a matter page: recent documents, upload, create from template. */
export function matterDocumentsCard(matterId) {
  const card = h("section.card.docs-card", { "aria-labelledby": "docs-card-title" });
  const list = h("div");
  const progress = h("ul.upload-list", { "aria-live": "polite" });
  const picker = filePicker((files) => doUpload(files));
  let known = [];

  async function doUpload(files) {
    const saved = await uploadFiles(matterId, files, "", progress, known);
    if (saved.length) {
      toast(saved.length === 1 ? `Uploaded “${saved[0].name}”` : `Uploaded ${plural(saved.length, "document")}`);
      load();
    }
  }

  async function load() {
    try {
      const { documents } = await get(`/matters/${matterId}/documents`);
      known = documents;
      const recent = documents.slice().sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)).slice(0, 5);
      replace(list, 
        documents.length
          ? h(
              "ul.plain.doc-mini",
              recent.map((d) =>
                h(
                  "li",
                  h("a.doc-mini-name", { href: `#/matters/${matterId}/documents/${d.id}` }, d.name),
                  h("span.muted.small", [kindOf(d.mime), d.folder ? folderLabel(d.folder) : null, fmtTime(d.updatedAt)].filter(Boolean).join(" · ")),
                ),
              ),
            )
          : h("p.muted", "No documents yet. Drop files here or use Upload."),
        h("a.docs-all", { href: `#/matters/${matterId}/documents` }, documents.length ? `All ${plural(documents.length, "document")} →` : "Open documents →"),
      );
    } catch (err) {
      replace(list, h("p.error-text", err.message));
    }
  }

  card.append(
    h("h2#docs-card-title", "Documents"),
    list,
    progress,
    h(
      "div.docs-card-actions",
      h("button.btn.small", { type: "button", onclick: () => picker.click() }, "Upload"),
      h("button.btn.small", { type: "button", onclick: () => templateDialog(matterId, {}) }, "Create from template"),
      picker,
    ),
  );
  dropTarget(card, { onFiles: doUpload });
  load();
  return card;
}

// ---------------------------------------------------------- folder tree

function buildTree(folders) {
  const all = new Set();
  for (const f of folders) {
    const parts = f.split("/");
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
  }
  const root = { path: "", name: "All documents", children: [] };
  const byPath = new Map([["", root]]);
  for (const p of [...all].sort((a, b) => a.localeCompare(b))) {
    const i = p.lastIndexOf("/");
    const node = { path: p, name: p.slice(i + 1), children: [] };
    byPath.set(p, node);
    byPath.get(i < 0 ? "" : p.slice(0, i)).children.push(node);
  }
  return { root, paths: [...all].sort((a, b) => a.localeCompare(b)) };
}

const inFolder = (doc, folder) => !folder || doc.folder === folder || doc.folder.startsWith(folder + "/");

// ------------------------------------------------------- matter documents page

export async function matterDocumentsView([idStr, sub]) {
  const matterId = Number(idStr);
  const docId = sub && sub !== "trash" ? Number(sub) : null;
  const showTrash = sub === "trash";
  const [m, data, trash] = await Promise.all([
    get(`/matters/${matterId}`),
    get(`/matters/${matterId}/documents`),
    get(`/matters/${matterId}/documents?deleted=only`),
    facets(true),
  ]);
  let docs = data.documents;
  let folders = data.folders;
  let trashed = trash.documents;
  const key = `lawdesk.docs.folder.${matterId}`;
  let folder = "";
  try {
    folder = sessionStorage.getItem(key) || "";
  } catch {}
  let sort = "name";

  const page = h("div.page.docs-page");
  const treeBox = h("nav.card.docs-tree", { "aria-label": "Folders" });
  const mainBox = h("div.docs-main");
  const progress = h("ul.upload-list", { "aria-live": "polite" });
  const picker = filePicker((files) => doUpload(files, folder));

  async function reload() {
    const [a, b] = await Promise.all([get(`/matters/${matterId}/documents`), get(`/matters/${matterId}/documents?deleted=only`)]);
    docs = a.documents;
    folders = a.folders;
    trashed = b.documents;
    if (folder && !buildTree(folders).paths.includes(folder)) folder = "";
    draw();
  }

  async function doUpload(files, into) {
    const saved = await uploadFiles(matterId, files, into, progress, docs);
    if (saved.length) {
      toast(saved.length === 1 ? `Uploaded “${saved[0].name}” to ${folderLabel(into)}` : `Uploaded ${plural(saved.length, "document")} to ${folderLabel(into)}`);
      await reload();
    }
  }

  async function moveDoc(id, to) {
    const d = docs.find((x) => x.id === id);
    if (!d || d.folder === to) return;
    try {
      await patch(`/documents/${id}`, { folder: to });
      toast(`Moved “${d.name}” to ${folderLabel(to)}`);
      await reload();
    } catch (err) {
      fail(err);
    }
  }

  function setFolder(f) {
    folder = f;
    try {
      sessionStorage.setItem(key, f);
    } catch {}
    if (docId || showTrash) location.hash = `#/matters/${matterId}/documents`;
    else draw();
  }

  // ---------------------------------------------------------- header
  const matter = m.matter;
  const head = h(
    "div",
    h("a.back", { href: `#/matters/${matterId}` }, "← ", matter.name),
    h(
      "div.page-head",
      h("div", h("h1", "Documents"), h("p.sub", [matter.number, matter.name, matter.client_name].filter(Boolean).join(" · "))),
      h(
        "div.head-actions",
        h("button.btn", { type: "button", onclick: () => templateDialog(matterId, { folder }) }, "Create from template"),
        h("button.btn", { type: "button", onclick: newFolder }, "New folder"),
        h("button.btn.primary", { type: "button", onclick: () => picker.click() }, "Upload files"),
        picker,
      ),
    ),
  );

  // ---------------------------------------------------------- tree
  function drawTree() {
    const { root } = buildTree(folders);
    const count = (p) => docs.filter((d) => inFolder(d, p)).length;
    const item = (node, depth) => {
      const current = !showTrash && !docId && node.path === folder;
      const btn = h(
        "button.tree-item" + (current ? ".current" : ""),
        {
          type: "button",
          "aria-current": current ? "true" : null,
          style: { paddingLeft: `${10 + depth * 14}px` },
          dataset: { folder: node.path },
          onclick: () => setFolder(node.path),
        },
        h("span.tree-name", node.name),
        h("span.tree-count", String(count(node.path))),
      );
      dropTarget(btn, { onFiles: (files) => doUpload(files, node.path), onDoc: (id) => moveDoc(id, node.path) });
      return h("li", btn, node.children.length ? h("ul.tree", node.children.map((c) => item(c, depth + 1))) : null);
    };
    replace(treeBox, 
      h("h2.visually-hidden", "Folders"),
      h("ul.tree", item(root, 0)),
      h(
        "a.tree-item.trash-link" + (showTrash ? ".current" : ""),
        { href: `#/matters/${matterId}/documents/trash`, "aria-current": showTrash ? "true" : null },
        h("span.tree-name", "Deleted documents"),
        h("span.tree-count", String(trashed.length)),
      ),
    );
  }

  // ---------------------------------------------------------- list
  function drawList() {
    const here = docs.filter((d) => inFolder(d, folder));
    const sorters = {
      name: (a, b) => a.name.localeCompare(b.name),
      updated: (a, b) => (b.updatedAt > a.updatedAt ? 1 : -1),
    };
    here.sort(sorters[sort]);
    const sortSel = select(
      [
        { value: "name", label: "Sort by name" },
        { value: "updated", label: "Newest first" },
      ],
      sort,
      { "aria-label": "Sort", onchange: (e) => ((sort = e.target.value), draw()) },
    );
    const folderTools = folder
      ? h(
          "span.folder-tools",
          h("button.btn.small", { type: "button", onclick: renameFolder }, "Rename folder"),
          h("button.btn.small", { type: "button", onclick: deleteFolder }, "Remove folder"),
        )
      : null;
    const drop = h(
      "div.dropzone",
      h("p", h("b", "Drag files here"), ` to upload them to ${folderLabel(folder)}, or `, h("button.linkish", { type: "button", onclick: () => picker.click() }, "choose files"), "."),
      h("p.muted.small", `Up to ${fmtSize(facetsCache.maxBytes)} each. You can also drag a document onto a folder to move it.`),
    );
    dropTarget(drop, { onFiles: (files) => doUpload(files, folder) });
    const rows = here.map((d) => {
      const tr = h(
        "tr.doc-row",
        { draggable: "true", dataset: { id: String(d.id) } },
        h(
          "td.doc-name-cell",
          { "data-label": "Name" },
          typeBadge(d.mime),
          h("a.doc-name", { href: `#/matters/${matterId}/documents/${d.id}` }, d.name),
          d.folder !== folder ? h("span.muted.small.doc-sub", folderLabel(d.folder)) : null,
        ),
        h("td", { "data-label": "Category" }, d.category || "", d.tags.length ? h("span.doc-tags", d.tags.map((t) => h("span.tag", t))) : null),
        h("td.num-cell", { "data-label": "Version" }, `v${d.version}`),
        h("td.num-cell", { "data-label": "Size" }, fmtSize(d.size)),
        h("td", { "data-label": "Updated" }, fmtTime(d.updatedAt)),
        h(
          "td.row-actions",
          h("a.btn.small", { href: fileUrl(d.id), download: d.name, "aria-label": `Download ${d.name}` }, "Download"),
        ),
      );
      tr.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/x-lawdesk-doc", String(d.id));
        e.dataTransfer.effectAllowed = "move";
      });
      return tr;
    });
    replace(mainBox, 
      h("div.docs-toolbar", h("h2", folderLabel(folder) === "Top level" ? "All documents" : folderLabel(folder)), h("span.muted", plural(here.length, "document")), folderTools, h("span.spacer"), sortSel),
      progress,
      drop,
      here.length
        ? h(
            "div.card.table-card",
            h(
              "table.docs-table",
              h("thead", h("tr", h("th", "Name"), h("th", "Category and tags"), h("th.num-cell", "Version"), h("th.num-cell", "Size"), h("th", "Updated"), h("th", h("span.visually-hidden", "Actions")))),
              h("tbody", rows),
            ),
          )
        : h("div.card.empty-big", h("p", "No documents in this folder yet."), h("p", "Upload files, or create one from a template.")),
    );
  }

  // ---------------------------------------------------------- trash
  function drawTrash() {
    replace(mainBox, 
      h("div.docs-toolbar", h("h2", "Deleted documents"), h("span.muted", plural(trashed.length, "document"))),
      h("p.muted", "Deleted documents keep all their versions. Restore one to put it back in its folder."),
      trashed.length
        ? h(
            "div.card.table-card",
            h(
              "table.docs-table",
              h("thead", h("tr", h("th", "Name"), h("th", "Folder"), h("th", "Deleted"), h("th", h("span.visually-hidden", "Actions")))),
              h(
                "tbody",
                trashed.map((d) =>
                  h(
                    "tr",
                    h("td.doc-name-cell", { "data-label": "Name" }, typeBadge(d.mime), h("span.doc-name", d.name)),
                    h("td", { "data-label": "Folder" }, folderLabel(d.folder)),
                    h("td", { "data-label": "Deleted" }, fmtTime(d.deletedAt)),
                    h(
                      "td.row-actions",
                      h(
                        "button.btn.small",
                        {
                          type: "button",
                          onclick: async () => {
                            try {
                              const r = await post(`/documents/${d.id}/restore`);
                              toast(r.name !== d.name ? `Restored as “${r.name}” (the old name is in use)` : `Restored “${r.name}”`);
                              await reload();
                            } catch (err) {
                              fail(err);
                            }
                          },
                        },
                        "Restore",
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h("div.card.empty-big", h("p", "Nothing has been deleted.")),
    );
  }

  // ---------------------------------------------------------- detail
  async function drawDetail() {
    let d;
    try {
      d = await get(`/documents/${docId}`);
    } catch (err) {
      replace(mainBox, h("p.error-text", err.message), h("a", { href: `#/matters/${matterId}/documents` }, "Back to documents"));
      return;
    }
    if (d.matterId !== matterId) {
      location.hash = `#/matters/${d.matterId}/documents/${d.id}`;
      return;
    }
    const versions = await get(`/documents/${docId}/versions`);
    if (d.deletedAt) {
      replace(mainBox, 
        h("a.back", { href: `#/matters/${matterId}/documents` }, "← All documents"),
        h("div.card", h("h2", d.name), h("p", "This document has been deleted."), h("a.btn", { href: `#/matters/${matterId}/documents/trash` }, "Go to deleted documents")),
      );
      return;
    }
    const preview = h("div.doc-preview");
    const kind = previewKind(d.mime);
    if (kind === "pdf")
      preview.append(
        h("iframe.doc-frame", { src: fileUrl(d.id, { inline: true }), title: `Preview of ${d.name}` }),
        h("p.muted.small", "If the preview stays blank, your browser can't show PDFs here; use Download."),
      );
    else if (kind === "image") preview.append(h("img.doc-image", { src: fileUrl(d.id, { inline: true }), alt: `Preview of ${d.name}` }));
    else if (kind === "text") {
      preview.append(h("p.muted", "Loading preview…"));
      get(`/documents/${d.id}/text`)
        .then((t) =>
          replace(preview, 
            t.text
              ? h("div.doc-paper", { tabindex: "0", "aria-label": `Text of ${d.name}` }, t.text)
              : h("div.doc-nopreview", h("p", "There's no text to show for this file.")),
            h("p.muted.small", kindOf(d.mime) === "Word" ? "Text only. Download the file to see its formatting." : t.truncated ? "Only the start of the file is shown." : ""),
          ),
        )
        .catch((err) => replace(preview, h("p.error-text", err.message)));
    } else preview.append(h("div.doc-nopreview", h("p", `${kindOf(d.mime)} files can't be shown here.`), h("a.btn.primary", { href: fileUrl(d.id), download: d.name }, "Download to open")));

    async function uploadVersion(file) {
        const bar = h("span.progress-fill", { style: { width: "0%" } });
        const row = h("li.upload-row", h("span.upload-name", file.name), h("span.progress-bar", bar), h("span.upload-status.muted.small", ""));
        progress.append(row);
        try {
          const r = await sendFile(`/documents/${d.id}/versions/upload`, file, {}, { onProgress: (f) => (bar.style.width = Math.round(f * 100) + "%") });
          row.remove();
          toast(`Saved version ${r.version} of “${r.name}”`);
          await reload();
        } catch (err) {
          row.remove();
          fail(err);
        }
    }
    const versionPicker = filePicker((files) => uploadVersion(files[0]), { multiple: false });

    // Details form: rename, move, category, tags.
    const name = h("input", { value: d.name, maxlength: 200, required: true });
    const { paths } = buildTree(folders);
    const folderSel = select([{ value: "", label: "Top level" }, ...paths.map((p) => ({ value: p, label: folderLabel(p) }))], d.folder);
    const category = h("input", { value: d.category || "", maxlength: 100, list: "doc-categories" });
    const tags = h("input", { value: d.tags.join(", "), maxlength: 1000, placeholder: "e.g. draft, signed", "aria-describedby": "tags-help" });
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.form-grid.doc-form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = "";
          try {
            await patch(`/documents/${d.id}`, {
              name: name.value.trim(),
              folder: folderSel.value,
              category: category.value.trim() || null,
              tags: tags.value.split(",").map((t) => t.trim()).filter(Boolean),
            });
            toast("Saved");
            facets(true).catch(() => {});
            await reload();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("label", "Name", name),
      h("label", "Folder", folderSel),
      h("label", "Category", category),
      h("label", "Tags", tags, h("span#tags-help.muted.small", "Separate tags with commas.")),
      h("datalist#doc-categories", (facetsCache.categories || []).map((c) => h("option", { value: c }))),
      err,
      h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Save changes")),
    );

    const versionRows = versions.map((v) =>
      h(
        "li.version" + (v.version === d.version ? ".current" : ""),
        h(
          "div.version-main",
          h("span.version-n", `Version ${v.version}`),
          v.version === d.version ? h("span.tag.good", "Current") : null,
          h("span.muted.small", [fmtTime(v.uploadedAt), v.uploadedByName, fmtSize(v.size), v.filename !== d.name ? v.filename : null].filter(Boolean).join(" · ")),
          v.note ? h("span.small.version-note", v.note) : null,
        ),
        h(
          "div.version-actions",
          h("a.btn.small", { href: fileUrl(d.id, { version: v.version }), download: "", "aria-label": `Download version ${v.version}` }, "Download"),
          v.version !== d.version
            ? h(
                "button.btn.small",
                {
                  type: "button",
                  onclick: async () => {
                    try {
                      const r = await post(`/documents/${d.id}/versions/${v.version}/restore`);
                      toast(`Version ${v.version} is current again (saved as version ${r.version})`);
                      await reload();
                    } catch (ex) {
                      fail(ex);
                    }
                  },
                },
                "Make current",
              )
            : null,
        ),
      ),
    );

    async function trashIt() {
      try {
        await del(`/documents/${d.id}`);
        toast(`Deleted “${d.name}”`, {
          action: {
            label: "Undo",
            run: () => post(`/documents/${d.id}/restore`).then(() => (location.hash = `#/matters/${matterId}/documents/${d.id}`), fail),
          },
        });
        location.hash = `#/matters/${matterId}/documents`;
      } catch (ex) {
        fail(ex);
      }
    }

    replace(mainBox, 
      h("a.back", { href: `#/matters/${matterId}/documents` }, "← ", folderLabel(d.folder) === "Top level" ? "All documents" : folderLabel(d.folder)),
      h(
        "div.doc-title",
        h("div", h("h2", typeBadge(d.mime), " ", d.name), h("p.muted.small", [`Version ${d.version}`, fmtSize(d.size), `updated ${fmtTime(d.updatedAt)}`, d.templateId ? "made from a template" : null].filter(Boolean).join(" · "))),
        h(
          "div.head-actions",
          h("a.btn.primary", { href: fileUrl(d.id), download: d.name }, "Download"),
          h("button.btn", { type: "button", onclick: () => versionPicker.click() }, "Upload new version"),
          h("button.btn.danger-text", { type: "button", onclick: trashIt }, "Delete"),
          versionPicker,
        ),
      ),
      progress,
      h(
        "div.doc-detail",
        h("section.card.doc-preview-card", h("h3.visually-hidden", "Preview"), preview),
        h(
          "div.doc-side",
          h("section.card", h("h2", "Details"), form),
          h("section.card", h("h2", "Versions"), h("ol.plain.versions", versionRows)),
        ),
      ),
    );
    // Dropping a file on the preview saves it as the next version.
    dropTarget(mainBox.querySelector(".doc-preview-card"), { onFiles: (files) => uploadVersion(files[0]) });
  }

  // ---------------------------------------------------------- folder actions
  function folderDialog(title, label, initial, submit) {
    const input = h("input", { value: initial, required: true, maxlength: 200 });
    const err = h("p.error-text", { role: "alert" });
    const dlg = modal(
      title,
      h(
        "form.modal-body.form-grid",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await submit(input.value.trim());
              dlg.close();
            } catch (ex) {
              err.textContent = ex.message;
            }
          },
        },
        h("label", label, input),
        err,
        h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Save")),
      ),
    );
    input.focus();
  }

  function newFolder() {
    const parent = showTrash || docId ? "" : folder;
    folderDialog("New folder", parent ? `Folder name (inside ${folderLabel(parent)})` : "Folder name", "", async (n) => {
      const path = parent ? `${parent}/${n}` : n;
      const r = await post(`/matters/${matterId}/folders`, { path });
      folders = r.folders;
      toast(`Made folder ${folderLabel(path)}`);
      setFolder(path);
    });
  }

  function renameFolder() {
    const i = folder.lastIndexOf("/");
    const parent = i < 0 ? "" : folder.slice(0, i);
    folderDialog("Rename folder", "New name", folder.slice(i + 1), async (n) => {
      const to = parent ? `${parent}/${n}` : n;
      await patch(`/matters/${matterId}/folders`, { from: folder, to });
      toast(`Renamed to ${folderLabel(to)}`);
      folder = to;
      try {
        sessionStorage.setItem(key, to);
      } catch {}
      await reload();
    });
  }

  async function deleteFolder() {
    try {
      await del(`/matters/${matterId}/folders?path=${encodeURIComponent(folder)}`);
      toast(`Removed folder ${folderLabel(folder)}`);
      folder = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
      await reload();
    } catch (err) {
      fail(err);
    }
  }

  function draw() {
    drawTree();
    if (docId) drawDetail();
    else if (showTrash) drawTrash();
    else drawList();
  }

  draw();
  const layout = h("div.docs-layout", treeBox, mainBox);
  dropTarget(layout, { onFiles: (files) => doUpload(files, docId || showTrash ? "" : folder) });
  page.append(head, layout);
  return page;
}

// ------------------------------------------------------------- firm search

/** Matched words shown with <mark>, everything as text (never as markup). */
function snippet(r) {
  if (r.highlights) return h("p.doc-snippet", r.highlights.map((p) => (p.hit ? h("mark", p.text) : p.text)));
  return null;
}

export async function documentsSearchView() {
  const f = await facets(true);
  const params = new URLSearchParams();
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem("lawdesk.docs.search") || "{}");
  } catch {}
  const q = h("input.search", { type: "search", placeholder: "Search names, tags and the text inside documents", "aria-label": "Search documents", "data-search": "", value: saved.q || "" });
  const matter = select([{ value: "", label: "All matters" }, ...f.matters.map((m) => ({ value: m.id, label: [m.number, m.name].filter(Boolean).join(" ") }))], saved.matter || "", { "aria-label": "Matter" });
  const category = select([{ value: "", label: "Any category" }, ...f.categories.map((c) => ({ value: c, label: c }))], saved.category || "", { "aria-label": "Category" });
  const tag = select([{ value: "", label: "Any tag" }, ...f.tags.map((t) => ({ value: t, label: t }))], saved.tag || "", { "aria-label": "Tag" });
  const count = h("p.result-count.muted", { "aria-live": "polite" });
  const results = h("div.search-results");
  let seq = 0;
  let timer = null;

  async function run() {
    const my = ++seq;
    for (const k of ["q", "matter", "category", "tag"]) params.delete(k);
    if (q.value.trim()) params.set("q", q.value.trim());
    if (matter.value) params.set("matter", matter.value);
    if (category.value) params.set("category", category.value);
    if (tag.value) params.set("tag", tag.value);
    params.set("limit", "100");
    try {
      sessionStorage.setItem("lawdesk.docs.search", JSON.stringify({ q: q.value, matter: matter.value, category: category.value, tag: tag.value }));
    } catch {}
    let r;
    try {
      r = await get(`/documents/search?${params}`);
    } catch (err) {
      if (my === seq) replace(results, h("p.error-text", err.message));
      return;
    }
    if (my !== seq) return;
    const searching = !!q.value.trim();
    count.textContent = searching
      ? `${plural(r.results.length, "document")} found${r.results.length === 100 ? " (showing the first 100)" : ""}`
      : `${plural(r.results.length, "recent document")}`;
    replace(results, 
      r.results.length
        ? h(
            "ol.plain.result-list",
            r.results.map((d) =>
              h(
                "li.card.result",
                h(
                  "div.result-head",
                  typeBadge(d.mime),
                  h("a.doc-name", { href: `#/matters/${d.matterId}/documents/${d.id}` }, d.name),
                  d.tags.map((t) => h("span.tag", t)),
                ),
                h(
                  "p.muted.small.result-meta",
                  [[d.matterNumber, d.matterName].filter(Boolean).join(" "), folderLabel(d.folder), d.category, `updated ${fmtTime(d.updatedAt)}`].filter(Boolean).join(" · "),
                ),
                snippet(d),
              ),
            ),
          )
        : h("div.card.empty-big", h("p", searching ? "No documents match." : "No documents yet."), searching ? h("p", "Try fewer words, or clear the filters.") : null),
    );
  }
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  };
  q.addEventListener("input", soon);
  for (const s of [matter, category, tag]) s.addEventListener("change", run);

  const page = h(
    "div.page.docs-search",
    h("div.page-head", h("div", h("h1", "Documents"), h("p.sub", "Every matter's documents. Search looks at names, tags and the words inside Word and text files."))),
    h("div.filters", q, matter, category, tag),
    count,
    results,
  );
  await run();
  return page;
}
