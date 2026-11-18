// Documents: the Documents card (or tab panel) on a matter page, a matter's full Documents
// page (folders, upload, preview, versions, deleted documents) and the firm-wide search.

import { h, replace, select, modal, toast, fmtTime, plural } from "../dom.js";
import { get, patch, post, del } from "../api.js";
import { sendFile, fmtSize, kindOf, previewKind, fileUrl } from "../upload.js";
import { templateDialog } from "./templates.js";
import { icon } from "../ui/icons.js";
import { pageHeader, card, button, iconButton, emptyState, field, pill, callout, useStyles, loadingBlock } from "../ui/components.js";
import { dataTable } from "../ui/table.js";

const fail = (err) => toast(err.message, { error: true });

let facetsCache = null;
async function facets(fresh = false) {
  if (!facetsCache || fresh) facetsCache = await get("/documents/facets");
  return facetsCache;
}

const folderLabel = (f) => (f ? f.split("/").join(" › ") : "Top level");

const KIND_ICON = { PDF: "file-text", Word: "file-text", Text: "file-text", "Web page": "file-text", Excel: "file-spreadsheet", Slides: "file", Image: "file-image", Email: "mail", Zip: "archive" };

/** A small neutral tile with the file type's icon. The type is also written out next to it. */
export function docIcon(mime, size = "md") {
  const kind = kindOf(mime);
  return h("span.doc-icon.doc-icon-" + size, { title: kind, "aria-hidden": "true" }, icon(KIND_ICON[kind] || "file", { size: size === "sm" ? 14 : 16 }));
}

/** "Just now", "3h ago", "Yesterday", or a date: how recently a document changed. */
function when(stamp) {
  const t = new Date(stamp).getTime();
  if (Number.isNaN(t)) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2 * 86400) return "Yesterday";
  return fmtTime(stamp).replace(/,.*$/, "");
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
          button("Don't upload", { onclick: pick("skip") }),
          button("Keep both", { onclick: pick("rename") }),
          button("Save as new version", { variant: "primary", onclick: pick("version") }),
        ),
      ),
    );
    dlg.addEventListener("close", () => resolve(answer));
  });
}

function uploadRow(name) {
  const fill = h("span.docs-progress-fill", { style: { width: "0%" } });
  const bar = h("span.docs-progress", { role: "progressbar", "aria-label": `Uploading ${name}`, "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
  const status = h("span.upload-status", "Waiting…");
  const row = h("li.upload-row", icon("upload", { size: 15, class: "upload-icon" }), h("span.upload-name", name), bar, status);
  return {
    row,
    status,
    set(f) {
      const pct = Math.round(f * 100);
      fill.style.width = pct + "%";
      bar.setAttribute("aria-valuenow", String(pct));
      status.textContent = pct < 100 ? `${pct}%` : "Saving…";
    },
    finish(text, ok) {
      status.textContent = text;
      fill.style.width = "100%";
      row.classList.add(ok ? "done" : "failed");
      if (ok) setTimeout(() => row.remove(), 4000);
    },
  };
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
    const r = uploadRow(file.name);
    box?.append(r.row);
    if (file.size > maxBytes) {
      r.finish(`Too large (limit ${fmtSize(maxBytes)})`, false);
      continue;
    }
    if (file.size === 0) {
      r.finish("The file is empty", false);
      continue;
    }
    let mode = "error";
    const clash = existing.some((d) => d.folder === folder && d.name.toLowerCase() === file.name.normalize("NFC").toLowerCase());
    if (clash) {
      mode = await askConflict(file.name, folder);
      if (mode === "skip") {
        r.finish("Not uploaded", true);
        continue;
      }
    }
    for (;;) {
      try {
        const doc = await sendFile(`/matters/${matterId}/documents/upload`, file, { folder, onConflict: mode }, { onProgress: r.set });
        saved.push(doc);
        r.finish(doc.version > 1 ? `Saved as version ${doc.version}` : "Uploaded", true);
        break;
      } catch (err) {
        if (err.status === 409 && mode === "error") {
          mode = await askConflict(file.name, folder);
          if (mode === "skip") {
            r.finish("Not uploaded", true);
            break;
          }
          continue;
        }
        r.finish(err.message, false);
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

/**
 * The Documents card on a matter page: the most recent documents, Upload and Create from
 * template; files dropped on it are uploaded to the matter's top level.
 * opts.limit: how many documents to list (default 5). Use matterDocumentsTab (below) to show
 * it as a matter tab instead.
 */
export function matterDocumentsCard(matterId, { limit = 5 } = {}) {
  useStyles("documents");
  const list = h("div.docs-card-list", loadingBlock("Loading documents", "lines", 3));
  const progress = h("ul.upload-list", { "aria-live": "polite" });
  const picker = filePicker((files) => doUpload(files));
  const footer = h("div.docs-card-foot");
  const subtitle = h("span", "Loading…");
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
      const recent = documents.slice().sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)).slice(0, limit);
      subtitle.textContent = documents.length ? `${plural(documents.length, "document")} · drop files here to upload` : "Drop files here to upload";
      replace(
        list,
        documents.length
          ? h(
              "ul.plain.doc-mini",
              recent.map((d) =>
                h(
                  "li",
                  docIcon(d.mime),
                  h(
                    "div.doc-mini-text",
                    h("a.doc-mini-name", { href: `#/matters/${matterId}/documents/${d.id}`, title: d.name }, d.name),
                    h("span.doc-mini-sub", [kindOf(d.mime), d.folder ? folderLabel(d.folder) : null, d.version > 1 ? `version ${d.version}` : null].filter(Boolean).join(" · ")),
                  ),
                  h("span.doc-mini-when", when(d.updatedAt)),
                ),
              ),
            )
          : emptyState({ icon: "folder-open", title: "No documents yet", body: "Drag files onto this card, or use Upload.", compact: true }),
      );
      replace(
        footer,
        h(
          "a.docs-all.card-footer-link",
          { href: `#/matters/${matterId}/documents` },
          documents.length > recent.length ? `View all ${plural(documents.length, "document")}` : "Open documents and folders",
          icon("arrow-right", { size: 14 }),
        ),
      );
    } catch (err) {
      replace(list, callout({ tone: "danger", title: "Couldn't load documents", body: err.message, action: button("Try again", { size: "sm", onclick: load }) }));
    }
  }

  const el = card({
    title: "Documents",
    subtitle,
    icon: "documents",
    className: "docs-card",
    flush: true,
    actions: [
      button("Create from template", { size: "sm", variant: "ghost", icon: "file-plus", onclick: () => templateDialog(matterId, {}) }),
      button("Upload", { size: "sm", icon: "upload", onclick: () => picker.click() }),
      picker,
    ],
    body: [progress, list],
    footer,
  });
  dropTarget(el, { onFiles: doUpload });
  load();
  return el;
}

/** Render the Documents panel into `container` (a matter tab, or any other slot). */
export function renderMatterDocuments(container, matterId, opts = {}) {
  container.replaceChildren(matterDocumentsCard(matterId, { limit: 25, ...opts }));
  return container;
}

/**
 * Ready to pass to registerMatterTab() from ui/matter-slots.js. Its id is "docs" because
 * #/matters/:id/documents is the full Documents page.
 */
export const matterDocumentsTab = {
  id: "docs",
  label: "Documents",
  icon: "documents",
  order: 30,
  render: (ctx) => matterDocumentsCard(ctx.matterId, { limit: 25 }),
};

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
  useStyles("documents");
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
  let query = "";

  const page = h("div.page.docs-page");
  const treeBox = h("nav.card.docs-tree", { "aria-label": "Folders" });
  const mainBox = h("div.docs-main");
  const progress = h("ul.upload-list", { "aria-live": "polite" });
  const picker = filePicker((files) => doUpload(files, docId || showTrash ? "" : folder));

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
    query = "";
    try {
      sessionStorage.setItem(key, f);
    } catch {}
    if (docId || showTrash) location.hash = `#/matters/${matterId}/documents`;
    else draw();
  }

  // ---------------------------------------------------------- header
  const matter = m.matter;
  const head = pageHeader({
    title: "Documents",
    breadcrumbs: [{ label: "Matters", href: "#/matters" }, { label: matter.number || matter.name, href: `#/matters/${matterId}` }, { label: "Documents" }],
    subtitle: [matter.name, matter.client_name].filter(Boolean).join(" · "),
    actions: [
      button("Create from template", { icon: "file-plus", onclick: () => templateDialog(matterId, { folder }) }),
      button("New folder", { icon: "folder-plus", onclick: newFolder }),
      button("Upload files", { variant: "primary", icon: "upload", onclick: () => picker.click() }),
      picker,
    ],
  });

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
          style: { paddingLeft: `${10 + depth * 16}px` },
          dataset: { folder: node.path },
          onclick: () => setFolder(node.path),
        },
        icon(depth === 0 ? "folder-open" : "folder", { size: 15, class: "tree-icon" }),
        h("span.tree-name", node.name),
        h("span.tree-count", String(count(node.path))),
      );
      dropTarget(btn, { onFiles: (files) => doUpload(files, node.path), onDoc: (id) => moveDoc(id, node.path) });
      return h("li", btn, node.children.length ? h("ul.tree", node.children.map((c) => item(c, depth + 1))) : null);
    };
    replace(
      treeBox,
      h("h2.docs-tree-title", "Folders"),
      h("ul.tree", item(root, 0)),
      h(
        "a.tree-item.trash-link" + (showTrash ? ".current" : ""),
        { href: `#/matters/${matterId}/documents/trash`, "aria-current": showTrash ? "true" : null },
        icon("trash-2", { size: 15, class: "tree-icon" }),
        h("span.tree-name", "Deleted documents"),
        h("span.tree-count", String(trashed.length)),
      ),
    );
  }

  // ---------------------------------------------------------- list
  function nameCell(d, { link = true, showFolder = false } = {}) {
    return h(
      "div.doc-name-cell",
      docIcon(d.mime),
      h(
        "div.cell-stack",
        link ? h("a.doc-name.cell-title", { href: `#/matters/${matterId}/documents/${d.id}` }, d.name) : h("span.doc-name.cell-title", d.name),
        h(
          "span.cell-sub",
          [kindOf(d.mime), showFolder ? folderLabel(d.folder) : null].filter(Boolean).join(" · "),
          // On phones the other columns are hidden, so the essentials go on this line.
          link ? h("span.doc-phone-meta", [d.category, when(d.updatedAt)].filter(Boolean).map((x) => ` · ${x}`).join("")) : null,
        ),
      ),
      link && d.tags.length ? h("span.doc-tags.doc-phone-meta", d.tags.map((t) => h("span.doc-tag", t))) : null,
    );
  }

  function drawList() {
    const here = docs.filter((d) => inFolder(d, folder));
    const title = folder ? folder.slice(folder.lastIndexOf("/") + 1) : "All documents";
    const folderTools = folder
      ? [button("Rename", { size: "sm", variant: "ghost", icon: "pencil", "aria-label": "Rename folder", onclick: renameFolder }), button("Remove", { size: "sm", variant: "ghost", icon: "trash-2", "aria-label": "Remove folder", onclick: deleteFolder })]
      : null;
    const drop = h(
      "div.dropzone",
      icon("upload", { size: 18, class: "dropzone-icon" }),
      h(
        "div",
        h("p", h("b", "Drag files here"), ` to add them to ${folderLabel(folder)}, or `, h("button.linkish", { type: "button", onclick: () => picker.click() }, "choose files"), "."),
        h("p.dropzone-sub", `Up to ${fmtSize(facetsCache.maxBytes)} each. Drag a document onto a folder to move it.`),
      ),
    );
    dropTarget(drop, { onFiles: (files) => doUpload(files, folder) });
    const table = dataTable({
      label: "Documents",
      tableClass: "docs-table",
      rows: here,
      rowClass: () => "doc-row",
      rowAttrs: (d) => ({
        draggable: "true",
        ondragstart: (e) => {
          e.dataTransfer.setData("application/x-lawdesk-doc", String(d.id));
          e.dataTransfer.effectAllowed = "move";
        },
      }),
      rowHref: (d) => `#/matters/${matterId}/documents/${d.id}`,
      search: { placeholder: "Search this folder", initial: query, text: (d) => [d.name, d.category, d.folder, ...d.tags] },
      noun: ["document", "documents"],
      prefsKey: "docs.list",
      sort: { key: "name", dir: "asc" },
      columns: [
        { key: "name", label: "Name", primary: true, sort: (d) => d.name, render: (d) => nameCell(d, { showFolder: d.folder !== folder }) },
        {
          key: "category",
          label: "Category and tags",
          hideOnPhone: true,
          sort: (d) => d.category || "",
          render: (d) =>
            d.category || d.tags.length ? h("div.doc-cat", d.category ? h("span", d.category) : null, d.tags.length ? h("span.doc-tags", d.tags.map((t) => h("span.doc-tag", t))) : null) : h("span.muted", "—"),
        },
        { key: "version", label: "Version", phoneLabel: "", className: "doc-version", align: "right", sort: (d) => d.version, render: (d) => `v${d.version}` },
        { key: "size", label: "Size", align: "right", hideOnPhone: true, sort: (d) => d.size, render: (d) => fmtSize(d.size) },
        { key: "updated", label: "Updated", className: "nowrap", hideOnPhone: true, sort: (d) => d.updatedAt, defaultDir: "desc", render: (d) => h("span", { title: fmtTime(d.updatedAt) }, when(d.updatedAt)) },
        {
          key: "actions",
          label: "",
          sortable: false,
          className: "row-actions",
          render: (d) => h("a.icon-btn.sm", { href: fileUrl(d.id), download: d.name, "aria-label": `Download ${d.name}`, title: "Download" }, icon("download", { size: 15 })),
        },
      ],
      empty: ({ searching }) =>
        searching
          ? emptyState({ icon: "search", title: "No matches", body: "No document in this folder matches. Try another word.", compact: true })
          : emptyState({ icon: "folder-open", title: "No documents in this folder yet", body: "Drag files here, upload them, or create one from a template.", compact: true }),
    });
    table.searchInput?.addEventListener("input", (e) => (query = e.target.value));
    replace(
      mainBox,
      card({
        title,
        subtitle: folder && folder.includes("/") ? folderLabel(folder) : plural(here.length, "document"),
        icon: folder ? "folder" : "folder-open",
        className: "docs-list-card",
        flush: true,
        actions: folderTools,
        body: [h("div.docs-drop-wrap", progress, drop), table],
      }),
    );
  }

  // ---------------------------------------------------------- trash
  function drawTrash() {
    const table = dataTable({
      label: "Deleted documents",
      tableClass: "docs-table",
      rows: trashed,
      noun: ["deleted document", "deleted documents"],
      toolbar: trashed.length > 0,
      sort: { key: "deleted", dir: "desc" },
      columns: [
        { key: "name", label: "Name", primary: true, sort: (d) => d.name, render: (d) => nameCell(d, { link: false }) },
        { key: "folder", label: "Folder", sort: (d) => d.folder, render: (d) => folderLabel(d.folder) },
        { key: "deleted", label: "Deleted", className: "nowrap", sort: (d) => d.deletedAt, render: (d) => fmtTime(d.deletedAt) },
        {
          key: "actions",
          label: "",
          sortable: false,
          className: "row-actions",
          render: (d) =>
            button("Restore", {
              size: "sm",
              icon: "rotate-ccw",
              onclick: async () => {
                try {
                  const r = await post(`/documents/${d.id}/restore`);
                  toast(r.name !== d.name ? `Restored as “${r.name}” (the old name is in use)` : `Restored “${r.name}”`);
                  await reload();
                } catch (err) {
                  fail(err);
                }
              },
            }),
        },
      ],
      empty: emptyState({ icon: "trash-2", title: "Nothing has been deleted", body: "Deleted documents appear here with all their versions, ready to restore.", compact: true }),
    });
    replace(
      mainBox,
      card({
        title: "Deleted documents",
        subtitle: "Deleted documents keep all their versions. Restore one to put it back in its folder.",
        icon: "trash-2",
        flush: true,
        body: table,
      }),
    );
  }

  // ---------------------------------------------------------- detail
  async function drawDetail() {
    replace(mainBox, loadingBlock("Loading document", "lines", 4));
    let d;
    try {
      d = await get(`/documents/${docId}`);
    } catch (err) {
      replace(mainBox, callout({ tone: "danger", title: "Couldn't open this document", body: err.message, action: button("Back to documents", { size: "sm", href: `#/matters/${matterId}/documents` }) }));
      return;
    }
    if (d.matterId !== matterId) {
      location.hash = `#/matters/${d.matterId}/documents/${d.id}`;
      return;
    }
    const versions = await get(`/documents/${docId}/versions`);
    const backLabel = folderLabel(d.folder) === "Top level" ? "All documents" : folderLabel(d.folder);
    const back = h("a.back", { href: `#/matters/${matterId}/documents` }, icon("chevron-left", { size: 15 }), backLabel);
    if (d.deletedAt) {
      replace(
        mainBox,
        back,
        card({
          body: emptyState({ icon: "trash-2", title: `“${d.name}” has been deleted`, body: "You can restore it from Deleted documents.", action: button("Go to deleted documents", { href: `#/matters/${matterId}/documents/trash` }) }),
        }),
      );
      return;
    }
    const preview = h("div.doc-preview");
    const kind = previewKind(d.mime);
    const note = (text) => (text ? h("p.doc-preview-note", text) : null);
    if (kind === "pdf")
      preview.append(
        h("iframe.doc-frame", { src: fileUrl(d.id, { inline: true }), title: `Preview of ${d.name}` }),
        note("If the preview stays blank, your browser can't show PDFs here; use Download."),
      );
    else if (kind === "image") preview.append(h("div.doc-image-wrap", h("img.doc-image", { src: fileUrl(d.id, { inline: true }), alt: `Preview of ${d.name}` })));
    else if (kind === "text") {
      preview.append(loadingBlock("Loading preview", "lines", 6));
      get(`/documents/${d.id}/text`)
        .then((t) =>
          replace(
            preview,
            t.text
              ? h("div.doc-paper-wrap", h("div.doc-paper", { tabindex: "0", "aria-label": `Text of ${d.name}` }, t.text))
              : emptyState({ icon: "file", title: "There's no text to show for this file", compact: true }),
            note(kindOf(d.mime) === "Word" ? "Text only. Download the file to see its formatting." : t.truncated ? "Only the start of the file is shown." : ""),
          ),
        )
        .catch((err) => replace(preview, callout({ tone: "danger", title: "Couldn't show a preview", body: err.message })));
    } else
      preview.append(
        emptyState({
          icon: KIND_ICON[kindOf(d.mime)] || "file",
          title: `${kindOf(d.mime)} files can't be shown here`,
          body: "Download the file to open it on your computer.",
          action: button("Download to open", { variant: "primary", icon: "download", href: fileUrl(d.id), download: d.name }),
        }),
      );

    async function uploadVersion(file) {
      const r = uploadRow(file.name);
      progress.append(r.row);
      try {
        const res = await sendFile(`/documents/${d.id}/versions/upload`, file, {}, { onProgress: r.set });
        r.row.remove();
        toast(`Saved version ${res.version} of “${res.name}”`);
        await reload();
      } catch (err) {
        r.row.remove();
        fail(err);
      }
    }
    const versionPicker = filePicker((files) => uploadVersion(files[0]), { multiple: false });

    // Details form: rename, move, category, tags.
    const name = h("input", { value: d.name, maxlength: 200, required: true });
    const { paths } = buildTree(folders);
    const folderSel = select([{ value: "", label: "Top level" }, ...paths.map((p) => ({ value: p, label: folderLabel(p) }))], d.folder);
    const category = h("input", { value: d.category || "", maxlength: 100, list: "doc-categories", placeholder: "e.g. Correspondence" });
    const tags = h("input", { value: d.tags.join(", "), maxlength: 1000, placeholder: "e.g. draft, signed" });
    const err = h("p.error-text", { role: "alert" });
    const saveBtn = button("Save changes", { variant: "primary", type: "submit" });
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
      field("Name", name),
      field("Folder", folderSel),
      field("Category", category),
      field("Tags", tags, { hint: "Separate tags with commas." }),
      h("datalist#doc-categories", (facetsCache.categories || []).map((c) => h("option", { value: c }))),
      err,
      h("div.form-actions", saveBtn),
    );

    const versionRows = versions.map((v) =>
      h(
        "li.version" + (v.version === d.version ? ".current" : ""),
        h(
          "div.version-main",
          h("div.version-line", h("span.version-n", `Version ${v.version}`), v.version === d.version ? pill("Current", "brand", { dot: false }) : null),
          h("span.version-meta", [fmtTime(v.uploadedAt), v.uploadedByName, fmtSize(v.size)].filter(Boolean).join(" · ")),
          v.filename !== d.name ? h("span.version-meta", v.filename) : null,
          v.note ? h("span.version-note", v.note) : null,
        ),
        h(
          "div.version-actions",
          h("a.icon-btn.sm", { href: fileUrl(d.id, { version: v.version }), download: "", "aria-label": `Download version ${v.version}`, title: "Download" }, icon("download", { size: 15 })),
          v.version !== d.version
            ? button("Make current", {
                size: "sm",
                onclick: async () => {
                  try {
                    const r = await post(`/documents/${d.id}/versions/${v.version}/restore`);
                    toast(`Version ${v.version} is current again (saved as version ${r.version})`);
                    await reload();
                  } catch (ex) {
                    fail(ex);
                  }
                },
              })
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

    const meta = [kindOf(d.mime), d.category, `Version ${d.version}`, fmtSize(d.size), `Updated ${fmtTime(d.updatedAt)}`, d.templateId ? "Made from a template" : null].filter(Boolean);
    replace(
      mainBox,
      back,
      h(
        "div.doc-title",
        docIcon(d.mime, "lg"),
        h("div.doc-title-text", h("h2", d.name), h("p.doc-title-meta", meta.join(" · ")), d.tags.length ? h("div.doc-tags", d.tags.map((t) => h("span.doc-tag", t))) : null),
        h(
          "div.head-actions",
          button("Download", { variant: "primary", icon: "download", href: fileUrl(d.id), download: d.name }),
          button("Upload new version", { icon: "upload", onclick: () => versionPicker.click() }),
          button("Delete", { variant: "ghost", icon: "trash-2", class: "danger-text", onclick: trashIt }),
          versionPicker,
        ),
      ),
      progress,
      h(
        "div.doc-detail",
        card({ title: "Preview", headingLevel: 3, className: "doc-preview-card", flush: true, subtitle: "Drop a file here to save it as the next version", body: preview }),
        h(
          "div.doc-side",
          card({ title: "Details", icon: "pencil", body: form }),
          card({ title: "Versions", icon: "history", subtitle: plural(versions.length, "version"), flush: true, body: h("ol.plain.versions", versionRows) }),
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
        field(label, input),
        err,
        h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), button("Save", { variant: "primary", type: "submit" })),
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
  useStyles("documents");
  const f = await facets(true);
  const params = new URLSearchParams();
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem("lawdesk.docs.search") || "{}");
  } catch {}
  const q = h("input.search", { type: "search", placeholder: "Search names, tags and the words inside documents", "aria-label": "Search documents", "data-search": "", value: saved.q || "" });
  const matter = select([{ value: "", label: "All matters" }, ...f.matters.map((m) => ({ value: m.id, label: [m.number, m.name].filter(Boolean).join(" ") }))], saved.matter || "", { "aria-label": "Matter" });
  const category = select([{ value: "", label: "Any category" }, ...f.categories.map((c) => ({ value: c, label: c }))], saved.category || "", { "aria-label": "Category" });
  const tag = select([{ value: "", label: "Any tag" }, ...f.tags.map((t) => ({ value: t, label: t }))], saved.tag || "", { "aria-label": "Tag" });
  const count = h("span.dt-count.result-count", { "aria-live": "polite" });
  const results = h("div.search-results", loadingBlock("Searching", "lines", 4));
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
      if (my === seq) replace(results, h("div.docs-search-error", callout({ tone: "danger", title: "The search didn't run", body: err.message, action: button("Try again", { size: "sm", onclick: run }) })));
      return;
    }
    if (my !== seq) return;
    const searching = !!q.value.trim();
    const filtered = searching || matter.value || category.value || tag.value;
    count.textContent = searching ? `${plural(r.results.length, "document")} found${r.results.length === 100 ? " (first 100)" : ""}` : filtered ? plural(r.results.length, "document") : `${plural(r.results.length, "recent document")}`;
    replace(
      results,
      r.results.length
        ? h(
            "ol.plain.result-list",
            r.results.map((d) =>
              h(
                "li.result",
                docIcon(d.mime),
                h(
                  "div.result-main",
                  h("div.result-head", h("a.doc-name", { href: `#/matters/${d.matterId}/documents/${d.id}` }, d.name), d.tags.length ? h("span.doc-tags", d.tags.map((t) => h("span.doc-tag", t))) : null),
                  h(
                    "p.result-meta",
                    d.matterNumber ? h("span.matter-num", d.matterNumber) : null,
                    h("a.result-matter", { href: `#/matters/${d.matterId}/documents` }, d.matterName),
                    h("span", [folderLabel(d.folder), d.category && d.category !== folderLabel(d.folder) ? d.category : null, `updated ${fmtTime(d.updatedAt)}`].filter(Boolean).join(" · ")),
                  ),
                  snippet(d),
                ),
              ),
            ),
          )
        : emptyState(
            searching || filtered
              ? { icon: "search", title: "No documents match", body: "Try fewer words, or clear the filters." }
              : { icon: "documents", title: "No documents yet", body: "Documents uploaded to a matter, or made from a template, appear here." },
          ),
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
    pageHeader({ title: "Documents", subtitle: "Every matter's documents. Search looks at names, tags and the words inside Word and text files." }),
    card({
      flush: true,
      className: "docs-search-card",
      body: [h("div.dt-toolbar.docs-search-bar", h("div.dt-search", icon("search", { size: 16, class: "dt-search-icon" }), q), h("div.dt-filters", matter, category, tag), h("div.dt-toolbar-end", count)), results],
    }),
  );
  await run();
  return page;
}
