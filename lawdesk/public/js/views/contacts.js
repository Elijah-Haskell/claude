// Contacts: the searchable list of people and companies, one contact's page (details,
// other names, relationships, matters, notes, conflict checks that found them), and the
// new / edit contact forms.

import { h, select, modal, toast, plural, replace } from "../dom.js";
import { get, post, patch, del } from "../api.js";
import { loadSetup, prefs } from "../state.js";
import { roleLabel, statusPill, shortDate } from "./conflicts.js";

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
              ? h("div.similar-box", h("strong", "Similar names already on file"), h("ul.plain", hits.map((x) => h("li", h("a", { href: `#/contacts/${x.contactId}`, onclick: () => dlg.close() }, x.name), h("span.muted.small", ` · ${kindLabel(x.kind)}`)))))
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
      h("div.form-row.two", h("label", "Name", name), h("label", "Type", kind)),
      similar,
      h("div.form-row.two", h("label", "Email", email), h("label", "Phone", phone)),
      h("label", "Notes", notes),
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, existing ? "Save" : "Add contact")),
    );
    const dlg = modal(existing ? "Edit contact" : "New contact", form, { wide: true });
    dlg.addEventListener("close", () => resolve(saved));
    name.focus();
    if (name.value) lookAlike();
  });
}

// ------------------------------------------------------------------ list

export async function contactsView() {
  let kind = prefs.get("contacts.kind", "");
  let q = "";
  const body = h("tbody");
  const count = h("p.result-count.muted");
  let seq = 0;

  async function load() {
    const my = ++seq;
    const qs = new URLSearchParams({ limit: "500" });
    if (q.trim()) qs.set("q", q.trim());
    if (kind) qs.set("kind", kind);
    const r = await get(`/directory?${qs}`);
    if (my !== seq) return;
    count.textContent = r.total > r.contacts.length ? `Showing ${r.contacts.length} of ${r.total} contacts. Search to narrow the list.` : plural(r.total, "contact");
    body.replaceChildren(
      ...(r.contacts.length
        ? r.contacts.map((c) =>
            h(
              "tr.ct-row",
              {
                tabindex: "0",
                onclick: (e) => !e.target.closest("a") && (location.hash = `#/contacts/${c.id}`),
                onkeydown: (e) => {
                  if (e.key === "Enter") location.hash = `#/contacts/${c.id}`;
                  if (e.key === "ArrowDown") (e.preventDefault(), e.currentTarget.nextElementSibling?.focus());
                  if (e.key === "ArrowUp") (e.preventDefault(), e.currentTarget.previousElementSibling?.focus());
                },
              },
              h(
                "td.ct-name",
                { "data-label": "Name" },
                h("a", { href: `#/contacts/${c.id}` }, c.name),
                c.aliases.length ? h("div.muted.small", "Also known as " + c.aliases.join("; ")) : null,
              ),
              h("td", { "data-label": "Type" }, kindLabel(c.kind)),
              h("td.ct-reach" + (!c.phone && !c.email ? ".is-empty" : ""), { "data-label": "Contact" }, c.phone ? h("div", c.phone) : null, c.email ? h("div.muted.small", c.email) : null, !c.phone && !c.email ? h("span.muted", "—") : null),
              h("td" + (c.city ? "" : ".is-empty"), { "data-label": "City" }, c.city || h("span.muted", "—")),
              h("td.num-cell", { "data-label": "Matters" }, c.matters ? (c.openMatters === c.matters ? `${c.matters} open` : c.openMatters ? `${c.matters}, ${c.openMatters} open` : `${c.matters} closed`) : h("span.muted", "No matters")),
            ),
          )
        : [h("tr", h("td.empty", { colspan: "5" }, q ? "No contacts match that search." : "No contacts yet."))]),
    );
  }

  const seg = h(
    "div.segmented",
    { role: "group", "aria-label": "Show" },
    [
      ["", "Everyone"],
      ["person", "People"],
      ["company", "Companies"],
    ].map(([v, label]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": v === kind ? "true" : "false",
          onclick: (e) => {
            kind = v;
            prefs.set("contacts.kind", v || null);
            seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false"));
            load();
          },
        },
        label,
      ),
    ),
  );
  let t;
  await load();
  return h(
    "div.page.ct-page",
    h(
      "div.page-head",
      h("div", h("h1", "Contacts"), h("p.sub", "Clients, the other side, their lawyers, and everyone else on the firm’s matters.")),
      h(
        "div.head-actions",
        h("a.btn", { href: "#/conflicts" }, "Conflict check"),
        h(
          "button.btn.primary",
          {
            type: "button",
            onclick: async () => {
              const c = await contactDialog();
              if (c) location.hash = `#/contacts/${c.id}`;
            },
          },
          "New contact",
        ),
      ),
    ),
    h(
      "div.filters",
      seg,
      h("input.search", {
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
    ),
    count,
    h("table.ld-table.ct-table", h("thead", h("tr", h("th", "Name"), h("th", "Type"), h("th", "Phone and email"), h("th", "City"), h("th.num-cell", "Matters"))), body),
  );
}

// ---------------------------------------------------------- one contact

export async function contactView([idStr]) {
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

  // ------------------------------------------------------------- details
  function detailsCard() {
    const c = p.contact;
    const rows = [];
    if (c.phone) rows.push({ kind: "phone", label: "Phone", text: [c.phone] });
    if (c.email) rows.push({ kind: "email", label: "Email", text: [c.email] });
    for (const d of p.details) rows.push({ id: d.id, kind: d.kind, label: d.label || DETAIL_KINDS.find(([k]) => k === d.kind)[1], text: d.kind === "address" ? addressLines(d) : [d.value] });
    const order = { phone: 0, email: 1, address: 2, website: 3 };
    rows.sort((a, b) => order[a.kind] - order[b.kind]);

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
      h("div.form-actions", h("button.btn.small", { type: "button", onclick: () => ((form.hidden = true), (addBtn.hidden = false)) }, "Cancel"), h("button.btn.small.primary", { type: "submit" }, "Add")),
    );
    const addBtn = h("button.btn.small", { type: "button", onclick: () => ((form.hidden = false), (addBtn.hidden = true), value.focus()) }, "Add phone, email or address");
    return h(
      "section.card.ct-details",
      h("h2", "Contact details"),
      rows.length
        ? h(
            "dl.ct-dl",
            rows.map((r) =>
              h(
                "div.ct-dl-row",
                h("dt", r.label),
                h(
                  "dd",
                  r.kind === "email" ? h("a", { href: `mailto:${r.text[0]}` }, r.text[0]) : r.kind === "phone" ? h("a", { href: `tel:${r.text[0].replace(/[^\d+]/g, "")}` }, r.text[0]) : r.text.map((l) => h("div", l)),
                  r.id
                    ? h("button.icon-btn.danger.ct-x", { type: "button", "aria-label": `Remove ${r.label}`, title: "Remove", onclick: () => confirm("Remove this from the contact?") && act(() => del(`/contact-details/${r.id}`), "Removed") }, "×")
                    : null,
                ),
              ),
            ),
          )
        : h("p.muted", "No phone, email or address on file."),
      addBtn,
      form,
    );
  }

  // ------------------------------------------------------- other names
  function aliasesCard() {
    const name = h("input", { placeholder: "Other name", maxlength: 200, required: true, "aria-label": "Other name" });
    const kind = select(ALIAS_KINDS.map(([v, l]) => ({ value: v, label: l })), p.contact.kind === "company" ? "dba" : "former_name", { "aria-label": "Kind of name" });
    return h(
      "section.card",
      h("h2", "Other names"),
      h("p.muted.small", "Former and maiden names, nicknames and trade names. Conflict checks search these too."),
      p.aliases.length
        ? h(
            "ul.plain.ct-list",
            p.aliases.map((a) =>
              h(
                "li",
                h("span", a.name),
                h("span.muted.small", aliasLabel(a.kind)),
                h("button.icon-btn.danger", { type: "button", "aria-label": `Remove ${a.name}`, title: "Remove", onclick: () => act(() => del(`/conflicts/aliases/${a.id}`), "Removed") }, "×"),
              ),
            ),
          )
        : h("p.muted", "None recorded."),
      h("form.ct-inline-form", { onsubmit: (e) => (e.preventDefault(), act(() => post(`/conflicts/contacts/${id}/aliases`, { name: name.value, kind: kind.value }), `Added “${name.value}”`)) }, name, kind, h("button.btn", { type: "submit" }, "Add")),
    );
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
      sentence,
      h(
        "div.form-actions",
        h("button.btn.small", { type: "button", title: "Turn the sentence round", onclick: () => ((reversed = !reversed), drawSentence()) }, "Swap sides"),
        h("button.btn.small.primary", { type: "submit" }, "Add relationship"),
      ),
    );
    return h(
      "section.card",
      h("h2", "Relationships"),
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
                  r.note ? h("span.muted.small", ` (${r.note})`) : null,
                ),
                h("button.icon-btn.danger", { type: "button", "aria-label": "Remove relationship", title: "Remove", onclick: () => confirm("Remove this relationship?") && act(() => del(`/conflicts/relationships/${r.id}`), "Removed") }, "×"),
              ),
            ),
          )
        : h("p.muted", "None recorded. Owners, officers, parent companies and family members belong here, so conflict checks can follow them."),
      form,
    );
  }

  // ------------------------------------------------------------ matters
  function mattersCard() {
    return h(
      "section.card",
      h("h2", "Matters"),
      p.matters.length
        ? h(
            "table.ld-table.ct-matters",
            h("thead", h("tr", h("th", "Matter"), h("th", "Role"), h("th", "Status"))),
            h(
              "tbody",
              p.matters.map((m) =>
                h(
                  "tr",
                  h("td", { "data-label": "Matter" }, h("a", { href: `#/matters/${m.id}` }, m.number ? h("span.num", m.number) : null, m.name)),
                  h("td.cap-first", { "data-label": "Role" }, roleLabel(m.role), m.note ? h("div.muted.small", m.note) : null),
                  h("td", { "data-label": "Status" }, m.status === "closed" ? `Closed ${m.closed_on ? m.closed_on.slice(0, 4) : ""}` : "Open"),
                ),
              ),
            ),
          )
        : h("p.muted", "Not on any matter."),
    );
  }

  function notesCard() {
    const box = h("textarea", { rows: 5, maxlength: 5000, "aria-label": "Notes" }, p.contact.notes || "");
    const save = h("button.btn.small", { type: "submit", disabled: true }, "Save notes");
    box.addEventListener("input", () => (save.disabled = box.value === (p.contact.notes || "")));
    return h(
      "section.card",
      h("h2", "Notes"),
      h("form.ct-notes", { onsubmit: (e) => (e.preventDefault(), act(() => patch(`/contacts/${id}`, { notes: box.value || null }), "Notes saved")) }, box, h("div.form-actions", save)),
    );
  }

  function checksCard() {
    return h(
      "section.card",
      h("h2", "Conflict checks"),
      p.checks.length
        ? h(
            "ul.plain.ct-list",
            p.checks.map((k) =>
              h(
                "li",
                h("a", { href: `#/conflicts/${k.id}` }, `No. ${k.id}`),
                h("span.muted.small", [shortDate(k.run_at), k.band ? `${k.band} match` : null, k.matter_name ? [k.matter_number, k.matter_name].filter(Boolean).join(" ") : null].filter(Boolean).join(" · ")),
                statusPill(k.decision),
              ),
            ),
          )
        : h("p.muted", "No saved check has found this contact."),
    );
  }

  async function draw() {
    const c = p.contact;
    const open = p.matters.filter((m) => m.status === "open").length;
    const rels = await relationshipsCard();
    page.replaceChildren(
      h("a.back", { href: "#/contacts" }, "← Contacts"),
      h(
        "div.page-head",
        h("div", h("h1", c.name), h("p.sub", [kindLabel(c.kind), p.matters.length ? `${plural(p.matters.length, "matter")}${open ? `, ${open} open` : ""}` : "No matters"].join(" · "))),
        h(
          "div.head-actions",
          h("a.btn", { href: `#/conflicts?name=${encodeURIComponent(c.name)}&kind=${c.kind}` }, "Run conflict check"),
          h(
            "button.btn",
            {
              type: "button",
              onclick: async () => {
                if (await contactDialog(c)) (toast("Saved"), refresh());
              },
            },
            "Edit",
          ),
        ),
      ),
      h("div.ct-grid", h("div.ct-main", mattersCard(), rels, notesCard()), h("aside.ct-aside", detailsCard(), aliasesCard(), checksCard())),
    );
  }
  await draw();
  return page;
}
