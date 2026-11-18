// Contacts: the searchable list of people and companies, one contact's page (details,
// other names, relationships, matters, notes, conflict checks that found them), and the
// new / edit contact forms.

import { h, select, modal, toast, plural, replace } from "../dom.js";
import { get, post, patch, del } from "../api.js";
import { loadSetup, prefs } from "../state.js";
import { roleLabel, statusPill, shortDate } from "./conflicts.js";
import { pageHeader, card, button, iconButton, pill, emptyState, callout, segmented, field, avatar, useStyles } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { icon } from "../ui/icons.js";

// ------------------------------------------------------------ vocabulary

const RELATIONSHIPS = [
  ["owner", "an owner of"],
  ["officer", "an officer of"],
  ["director", "a director of"],
  ["member", "a member of"],
  ["manager", "a manager of"],
  ["partner", "a partner in"],
  ["shareholder", "a shareholder of"],
  ["employee", "an employee of"],
  ["registered_agent", "the registered agent of"],
  ["parent", "the parent company of"],
  ["affiliate", "an affiliate of"],
  ["spouse", "the spouse of"],
  ["former_spouse", "a former spouse of"],
  ["family", "a family member of"],
  ["insurer", "the insurer of"],
  ["other", "related to"],
];
const relPhrase = (k) => RELATIONSHIPS.find(([v]) => v === k)?.[1] ?? "related to";

const ALIAS_KINDS = [
  ["former_name", "Former name"],
  ["maiden_name", "Maiden name"],
  ["nickname", "Nickname"],
  ["dba", "Doing business as"],
  ["trade_name", "Trade name"],
  ["misspelling", "Common misspelling"],
  ["other", "Other"],
];
const aliasLabel = (k) => ALIAS_KINDS.find(([v]) => v === k)?.[1] ?? "Other";

const DETAIL_KINDS = [
  ["phone", "Phone"],
  ["email", "Email"],
  ["address", "Address"],
  ["website", "Website"],
];
const LABEL_SUGGESTIONS = ["Work", "Home", "Cell", "Office", "Mailing", "Billing", "Fax", "Other"];

const kindLabel = (k) => (k === "company" ? "Company" : "Person");
const fail = (err) => toast(err.message, { error: true });

function addressLines(d) {
  const cityLine = [d.city, [d.region, d.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [d.line1, d.line2, cityLine, d.country].filter(Boolean);
}

// ---------------------------------------------------- picking a contact

let contactCache = null;
async function allContacts(fresh = false) {
  if (!contactCache || fresh) contactCache = await get("/contacts");
  return contactCache;
}
export function forgetContacts() {
  contactCache = null;
}
let pickerSeq = 0;

/**
 * A name box that suggests existing contacts. If the typed name is not on file, a
 * Person / Company choice appears and resolve() creates the contact.
 */
export async function contactPicker({ placeholder = "Name of a person or company", label = "Contact", exclude = null } = {}) {
  const contacts = await allContacts();
  const listId = `contact-options-${++pickerSeq}`;
  const input = h("input.picker-name", { list: listId, placeholder, maxlength: 200, autocomplete: "off", "aria-label": label });
  const kind = select(
    [
      { value: "person", label: "New person" },
      { value: "company", label: "New company" },
    ],
    "person",
    { "aria-label": "New contact is a", hidden: true },
  );
  const find = () => {
    const v = input.value.trim().toLowerCase();
    return v ? contacts.find((c) => c.name.toLowerCase() === v && c.id !== exclude) : null;
  };
  const sync = () => (kind.hidden = !input.value.trim() || !!find());
  input.addEventListener("input", sync);
  const el = h("span.picker", input, kind, h("datalist", { id: listId }, contacts.filter((c) => c.id !== exclude).map((c) => h("option", { value: c.name }))));
  return {
    el,
    input,
    clear: () => ((input.value = ""), sync()),
    async resolve() {
      const name = input.value.trim();
      if (!name) throw new Error(`Enter a ${label.toLowerCase()}`);
      const hit = find();
      if (hit) return hit.id;
      const c = await post("/contacts", { name, kind: kind.value });
      contacts.push(c);
      return c.id;
    },
  };
}

// --------------------------------------------------------- new / edit

/** Create or edit a contact. Resolves with the saved contact, or null if cancelled. */
export function contactDialog(existing = null, { name: presetName = "" } = {}) {
  return new Promise((resolve) => {
    const c = existing ?? {};
    const name = h("input", { value: c.name ?? presetName, required: true, maxlength: 200, autocomplete: "off" });
    const kind = select(
      [
        { value: "person", label: "Person" },
        { value: "company", label: "Company" },
      ],
      c.kind ?? "person",
    );
    const email = h("input", { type: "email", value: c.email ?? "", maxlength: 200 });
    const phone = h("input", { type: "tel", value: c.phone ?? "", maxlength: 60 });
    const notes = h("textarea", { rows: 3, maxlength: 5000 }, c.notes ?? "");
    const similar = h("div.similar", { "aria-live": "polite" });
    const err = h("p.error-text", { role: "alert" });
    let saved = null;
    let t;
    const lookAlike = () => {
      clearTimeout(t);
      const v = name.value.trim();
      if (v.length < 3) return replace(similar, );
      t = setTimeout(async () => {
        try {
          const r = await post("/conflicts/search", { preview: true, related: false, terms: [{ name: v, kind: kind.value }], minScore: 0.8, limit: 5 });
          const hits = r.hits.filter((x) => x.contactId !== c.id);
          replace(similar, 
            hits.length
              ? h(
                  "div.similar-box",
                  callout({
                    tone: "warning",
                    title: "Similar names already on file",
                    body: h("ul.plain.ct-similar", hits.map((x) => h("li", h("a", { href: `#/contacts/${x.contactId}`, onclick: () => dlg.close() }, x.name), h("span.muted", ` · ${kindLabel(x.kind)}`)))),
                  }),
                )
              : null,
          );
        } catch {
          replace(similar, );
        }
      }, 250);
    };
    name.addEventListener("input", lookAlike);
    kind.addEventListener("change", lookAlike);
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = "";
          const body = { name: name.value, kind: kind.value, email: email.value || null, phone: phone.value || null };
          try {
            if (existing) saved = await patch(`/contacts/${c.id}`, { ...body, notes: notes.value || null });
            else {
              saved = await post("/contacts", body);
              if (notes.value.trim()) saved = await patch(`/contacts/${saved.id}`, { notes: notes.value });
            }
            forgetContacts();
            loadSetup().then(() => window.dispatchEvent(new Event("lawdesk:setup")), () => {});
            dlg.close();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("div.form-row.ct-two", field("Name", name, { required: true }), field("Type", kind)),
      similar,
      h("div.form-row", field("Email", email, { optional: true }), field("Phone", phone, { optional: true })),
      field("Notes", notes, { optional: true }),
      err,
      h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), button(existing ? "Save" : "Add contact", { variant: "primary", type: "submit" })),
    );
    const dlg = modal(existing ? "Edit contact" : "New contact", form, { wide: true });
    dlg.addEventListener("close", () => resolve(saved));
    name.focus();
    if (name.value) lookAlike();
  });
}

// ------------------------------------------------------------------ list

function mattersText(c) {
  if (!c.matters) return h("span.muted", "No matters");
  if (c.openMatters === c.matters) return `${c.matters} open`;
  if (!c.openMatters) return `${c.matters} closed`;
  return `${c.openMatters} open, ${c.matters - c.openMatters} closed`;
}

export async function contactsView() {
  useStyles("contacts");
  let kind = prefs.get("contacts.kind", "");
  let q = "";
  let seq = 0;
  const note = h("p.ct-more-note");

  async function load() {
    const my = ++seq;
    const qs = new URLSearchParams({ limit: "500" });
    if (q.trim()) qs.set("q", q.trim());
    if (kind) qs.set("kind", kind);
    const r = await get(`/directory?${qs}`);
    if (my !== seq) return;
    note.textContent = r.total > r.contacts.length ? `Showing ${r.contacts.length} of ${r.total} contacts. Search to narrow the list.` : "";
    table.setRows(r.contacts);
  }

  const seg = segmented(
    [
      { value: "", label: "Everyone" },
      { value: "person", label: "People" },
      { value: "company", label: "Companies" },
    ],
    kind,
    (v) => {
      kind = v;
      prefs.set("contacts.kind", v || null);
      load();
    },
    { label: "Show" },
  );
  let t;
  // The directory search runs on the server so it also finds other names, phones and addresses.
  const search = h(
    "div.dt-search",
    icon("search", { size: 16, class: "dt-search-icon" }),
    h("input.search.dt-search-input", {
      type: "search",
      placeholder: "Search by name, other name, email, phone or address",
      "aria-label": "Search contacts",
      "data-search": "",
      oninput: (e) => {
        q = e.target.value;
        clearTimeout(t);
        t = setTimeout(load, 150);
      },
    }),
  );
  const newContact = async () => {
    const c = await contactDialog();
    if (c) location.hash = `#/contacts/${c.id}`;
  };

  const table = dataTable({
    rows: [],
    label: "Contacts",
    noun: ["contact", "contacts"],
    rowClass: () => "ct-row",
    rowHref: (c) => `#/contacts/${c.id}`,
    prefsKey: "contacts.table",
    sort: { key: "name", dir: "asc" },
    filters: [search, seg],
    columns: [
      {
        key: "name",
        label: "Name",
        primary: true,
        className: "ct-name",
        sort: (c) => c.name.toLowerCase(),
        render: (c) =>
          h(
            "div.ct-name-cell",
            avatar(c.name, { size: "sm" }),
            h("div.cell-stack", h("a.cell-title", { href: `#/contacts/${c.id}` }, c.name), c.aliases.length ? h("span.cell-sub", "Also known as " + c.aliases.join("; ")) : null),
          ),
      },
      { key: "kind", label: "Type", sort: (c) => c.kind, render: (c) => h("span.ct-kind", icon(c.kind === "company" ? "building-2" : "user", { size: 14 }), kindLabel(c.kind)) },
      {
        key: "reach",
        label: "Phone and email",
        phoneLabel: "Contact",
        sortable: false,
        render: (c) => (c.phone || c.email ? h("div.cell-stack", c.phone ? h("span.tnum", c.phone) : null, c.email ? h("span.cell-sub.ct-email", c.email) : null) : h("span.muted", "—")),
      },
      { key: "city", label: "City", hideOnPhone: true, sort: (c) => c.city || null, render: (c) => c.city || h("span.muted", "—") },
      { key: "matters", label: "Matters", align: "right", defaultDir: "desc", sort: (c) => c.openMatters * 1000 + c.matters, render: (c) => h("span.nowrap", mattersText(c)) },
    ],
    empty: ({ searching }) =>
      q.trim() || searching
        ? emptyState({ icon: "search", title: "No contacts match", body: "Try part of a name, an old name, a phone number or a street.", compact: true })
        : emptyState({ icon: "contacts", title: "No contacts yet", body: "Clients, the other side and their lawyers appear here.", action: button("New contact", { variant: "primary", icon: "plus", onclick: newContact }), compact: true }),
  });

  await load();
  return h(
    "div.page.ct-page",
    pageHeader({
      title: "Contacts",
      subtitle: "Clients, the other side, their lawyers, and everyone else on the firm’s matters.",
      actions: [button("Conflict check", { icon: "conflicts", href: "#/conflicts" }), button("New contact", { variant: "primary", icon: "plus", onclick: newContact })],
    }),
    card({ flush: true, className: "table-card", body: [table, note] }),
  );
}

// ---------------------------------------------------------- one contact

export async function contactView([idStr]) {
  useStyles("contacts");
  const id = Number(idStr);
  const page = h("div.page.ct-page");
  let p = await get(`/contacts/${id}/profile`);

  const refresh = async () => {
    p = await get(`/contacts/${id}/profile`);
    draw();
  };
  const act = async (fn, message) => {
    try {
      await fn();
      if (message) toast(message);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };
  const removeBtn = (label, onclick) => iconButton("x", label, { size: "sm", variant: "danger", class: "ct-x", onclick });

  // ------------------------------------------------------------- details
  function detailsCard() {
    const c = p.contact;
    const rows = [];
    if (c.phone) rows.push({ kind: "phone", label: "Phone", text: [c.phone] });
    if (c.email) rows.push({ kind: "email", label: "Email", text: [c.email] });
    for (const d of p.details) rows.push({ id: d.id, kind: d.kind, label: d.label || DETAIL_KINDS.find(([k]) => k === d.kind)[1], text: d.kind === "address" ? addressLines(d) : [d.value] });
    const order = { phone: 0, email: 1, address: 2, website: 3 };
    rows.sort((a, b) => order[a.kind] - order[b.kind]);
    const kindIcon = { phone: "phone", email: "mail", address: "building-2", website: "external-link" };

    const kindSel = select(DETAIL_KINDS.map(([v, l]) => ({ value: v, label: l })), "phone", { "aria-label": "Kind of detail" });
    const labelIn = h("input", { list: "detail-labels", placeholder: "Label, e.g. Work", maxlength: 60, "aria-label": "Label" });
    const value = h("input", { maxlength: 300, "aria-label": "Number or address" });
    const line1 = h("input", { placeholder: "Street", maxlength: 200, "aria-label": "Street" });
    const line2 = h("input", { placeholder: "Suite, unit (optional)", maxlength: 200, "aria-label": "Street, line 2" });
    const city = h("input", { placeholder: "City", maxlength: 100, "aria-label": "City" });
    const region = h("input", { placeholder: "State", value: "KS", maxlength: 60, "aria-label": "State" });
    const zip = h("input", { placeholder: "ZIP", maxlength: 20, "aria-label": "ZIP code" });
    const addr = h("div.ct-addr", line1, line2, h("div.ct-addr-row", city, region, zip));
    const syncKind = () => {
      const k = kindSel.value;
      addr.hidden = k !== "address";
      value.hidden = k === "address";
      value.type = k === "email" ? "email" : k === "phone" ? "tel" : "text";
      value.placeholder = { phone: "Phone number", email: "Email address", website: "Web address" }[k] ?? "";
    };
    kindSel.addEventListener("change", syncKind);
    syncKind();
    const form = h(
      "form.ct-add-detail",
      {
        hidden: true,
        onsubmit: (e) => {
          e.preventDefault();
          const k = kindSel.value;
          act(
            () =>
              post(`/contacts/${id}/details`, k === "address" ? { kind: k, label: labelIn.value, line1: line1.value, line2: line2.value, city: city.value, region: region.value, postalCode: zip.value } : { kind: k, label: labelIn.value, value: value.value }),
            "Added",
          );
        },
      },
      h("div.ct-add-row", kindSel, labelIn),
      value,
      addr,
      h("datalist#detail-labels", LABEL_SUGGESTIONS.map((l) => h("option", { value: l }))),
      h("div.form-actions", button("Cancel", { size: "sm", onclick: () => ((form.hidden = true), (addBtn.hidden = false)) }), button("Add", { size: "sm", variant: "primary", type: "submit" })),
    );
    const addBtn = button("Add phone, email or address", { size: "sm", variant: "ghost", icon: "plus", class: "ct-add-btn", onclick: () => ((form.hidden = false), (addBtn.hidden = true), value.focus()) });
    return card({
      title: "Contact details",
      icon: "phone",
      className: "ct-details",
      body: [
        rows.length
          ? h(
              "dl.ct-dl",
              rows.map((r) =>
                h(
                  "div.ct-dl-row",
                  h("dt", icon(kindIcon[r.kind] || "info", { size: 14 }), h("span", r.label)),
                  h(
                    "dd",
                    h(
                      "div.ct-dd-text",
                      r.kind === "email" ? h("a", { href: `mailto:${r.text[0]}` }, r.text[0]) : r.kind === "phone" ? h("a.tnum", { href: `tel:${r.text[0].replace(/[^\d+]/g, "")}` }, r.text[0]) : r.text.map((l) => h("div", l)),
                    ),
                    r.id ? removeBtn(`Remove ${r.label}`, () => confirm("Remove this from the contact?") && act(() => del(`/contact-details/${r.id}`), "Removed")) : null,
                  ),
                ),
              ),
            )
          : h("p.ct-empty-line", "No phone, email or address on file."),
        addBtn,
        form,
      ],
    });
  }

  // ------------------------------------------------------- other names
  function aliasesCard() {
    const name = h("input", { placeholder: "Other name", maxlength: 200, required: true, "aria-label": "Other name" });
    const kind = select(ALIAS_KINDS.map(([v, l]) => ({ value: v, label: l })), p.contact.kind === "company" ? "dba" : "former_name", { "aria-label": "Kind of name" });
    return card({
      title: "Other names",
      subtitle: "Former and maiden names, nicknames and trade names. Conflict checks search these too.",
      icon: "user-round",
      body: [
        p.aliases.length
          ? h(
              "ul.plain.ct-list",
              p.aliases.map((a) => h("li", h("span.ct-alias", a.name), pill(aliasLabel(a.kind), "neutral", { dot: false }), removeBtn(`Remove ${a.name}`, () => act(() => del(`/conflicts/aliases/${a.id}`), "Removed")))),
            )
          : h("p.ct-empty-line", "None recorded."),
        h("form.ct-inline-form", { onsubmit: (e) => (e.preventDefault(), act(() => post(`/conflicts/contacts/${id}/aliases`, { name: name.value, kind: kind.value }), `Added “${name.value}”`)) }, name, kind, button("Add", { type: "submit" })),
      ],
    });
  }

  // ------------------------------------------------------ relationships
  async function relationshipsCard() {
    const me = p.contact.name;
    let reversed = false;
    const picker = await contactPicker({ label: "Other contact", exclude: id });
    const kind = select(RELATIONSHIPS.map(([v, l]) => ({ value: v, label: l })), p.contact.kind === "company" ? "parent" : "owner", { "aria-label": "Relationship" });
    const sentence = h("div.ct-sentence");
    const drawSentence = () => sentence.replaceChildren(...(reversed ? [picker.el, h("span", "is"), kind, h("strong", me)] : [h("strong", me), h("span", "is"), kind, picker.el]));
    drawSentence();
    const form = h(
      "form.ct-rel-form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          act(async () => {
            const other = await picker.resolve();
            await post("/conflicts/relationships", reversed ? { fromContactId: other, toContactId: id, kind: kind.value } : { fromContactId: id, toContactId: other, kind: kind.value });
            forgetContacts();
          }, "Relationship added");
        },
      },
      h("p.ct-rel-label", "Add a relationship"),
      sentence,
      h(
        "div.ct-rel-actions",
        button("Swap sides", { size: "sm", variant: "ghost", icon: "arrow-up-down", title: "Turn the sentence round", onclick: () => ((reversed = !reversed), drawSentence()) }),
        button("Add relationship", { size: "sm", variant: "primary", type: "submit" }),
      ),
    );
    return card({
      title: "Relationships",
      icon: "users",
      body: [
        p.relationships.length
          ? h(
              "ul.plain.ct-list.ct-rels",
              p.relationships.map((r) =>
                h(
                  "li",
                  h(
                    "span.ct-rel-text",
                    r.direction === "from" ? h("span", me) : h("a", { href: `#/contacts/${r.other_id}` }, r.other_name),
                    ` is ${relPhrase(r.kind)} `,
                    r.direction === "from" ? h("a", { href: `#/contacts/${r.other_id}` }, r.other_name) : h("span", me),
                    r.note ? h("span.muted", ` (${r.note})`) : null,
                  ),
                  removeBtn("Remove relationship", () => confirm("Remove this relationship?") && act(() => del(`/conflicts/relationships/${r.id}`), "Removed")),
                ),
              ),
            )
          : h("p.ct-empty-line", "None recorded. Owners, officers, parent companies and family members belong here, so conflict checks can follow them."),
        form,
      ],
    });
  }

  // ------------------------------------------------------------ matters
  function mattersCard() {
    return card({
      title: "Matters",
      icon: "matters",
      flush: true,
      body: p.matters.length
        ? h(
            "ul.plain.ct-matters",
            p.matters.map((m) =>
              h(
                "li",
                h(
                  "div.cell-stack",
                  h("a.cell-title", { href: `#/matters/${m.id}` }, m.number ? h("span.matter-num", m.number) : null, " ", m.name),
                  h("span.cell-sub.cap-first", roleLabel(m.role), m.note ? ` · ${m.note}` : ""),
                ),
                m.status === "closed" ? pill(`Closed${m.closed_on ? " " + m.closed_on.slice(0, 4) : ""}`, "neutral") : pill("Open", "info"),
              ),
            ),
          )
        : emptyState({ icon: "matters", title: "Not on any matter", body: "Matters this contact is a client or party on appear here.", compact: true }),
    });
  }

  function notesCard() {
    const box = h("textarea", { rows: 4, maxlength: 5000, "aria-label": "Notes" }, p.contact.notes || "");
    const save = button("Save notes", { size: "sm", type: "submit", disabled: true });
    box.addEventListener("input", () => (save.disabled = box.value === (p.contact.notes || "")));
    return card({
      title: "Notes",
      icon: "file-text",
      body: h("form.ct-notes", { onsubmit: (e) => (e.preventDefault(), act(() => patch(`/contacts/${id}`, { notes: box.value || null }), "Notes saved")) }, box, h("div.ct-notes-actions", save)),
    });
  }

  function checksCard() {
    return card({
      title: "Conflict checks",
      icon: "conflicts",
      body: p.checks.length
        ? h(
            "ul.plain.ct-list.ct-checks",
            p.checks.map((k) =>
              h(
                "li",
                h(
                  "div.cell-stack",
                  h("a.cell-title", { href: `#/conflicts/${k.id}` }, `Check no. ${k.id}`),
                  h("span.cell-sub", [shortDate(k.run_at), k.band ? `${k.band} match` : null, k.matter_name ? [k.matter_number, k.matter_name].filter(Boolean).join(" ") : null].filter(Boolean).join(" · ")),
                ),
                statusPill(k.decision),
              ),
            ),
          )
        : h("p.ct-empty-line", "No saved check has found this contact."),
    });
  }

  async function draw() {
    const c = p.contact;
    const open = p.matters.filter((m) => m.status === "open").length;
    const rels = await relationshipsCard();
    page.replaceChildren(
      pageHeader({
        title: c.name,
        breadcrumbs: [{ label: "Contacts", href: "#/contacts" }, { label: c.name }],
        meta: [
          h("span.ct-kind", icon(c.kind === "company" ? "building-2" : "user", { size: 14 }), kindLabel(c.kind)),
          h("span.ct-meta-sep", "·"),
          h("span", p.matters.length ? `${plural(p.matters.length, "matter")}${open ? `, ${open} open` : ""}` : "No matters"),
        ],
        actions: [
          button("Run conflict check", { icon: "conflicts", href: `#/conflicts?name=${encodeURIComponent(c.name)}&kind=${c.kind}` }),
          button("Edit", {
            icon: "pencil",
            onclick: async () => {
              if (await contactDialog(c)) (toast("Saved"), refresh());
            },
          }),
        ],
      }),
      h("div.ct-grid", h("div.ct-main", mattersCard(), rels, notesCard()), h("aside.ct-aside", detailsCard(), aliasesCard(), checksCard())),
    );
  }
  await draw();
  return page;
}
