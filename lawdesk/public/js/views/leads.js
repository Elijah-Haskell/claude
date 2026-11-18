// Intake: people who have asked for help but are not clients yet.
//   #/intake           pipeline board (columns by status; move with the menu or by dragging)
//   #/intake/list      the same leads as a list with filters
//   #/intake/reports   leads by source, conversion rate and time to hire
//   #/intake/leads/:id one lead: conflict check, details, follow-ups, consultation,
//                      engagement letter, convert to client and matter
// Everything typed by people goes into the page as text (dom.js never uses innerHTML).

import { h, select, modal, toast, fmtDate, fmtTime, plural, relDate } from "../dom.js";
import { get, post, patch, del } from "../api.js";
import { state, today, users, prefs, loadSetup } from "../state.js";
import { pageHeader, card as kitCard, button, iconButton, pill, avatar, person, stat, emptyState, callout, field, useStyles } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { icon } from "../ui/icons.js";

/** A titled card on the lead page: panel("Notes", "file-text", "notes-card", ...body). */
function panel(title, ic, className, ...body) {
  return kitCard({ title, icon: ic, className, body: body.flat().filter((x) => x != null && x !== false) });
}

/** Where a lead is, as a kit pill. */
const LEAD_TONES = { new: "brand", contacted: "info", consult_scheduled: "info", engagement_sent: "warning", hired: "success", not_hired: "neutral" };
function leadPill(l) {
  return pill(l.statusLabel, LEAD_TONES[l.status] || "neutral");
}

let optionsCache = null;
export async function intakeOptions(force = false) {
  if (!optionsCache || force) optionsCache = await get("/intake/options");
  return optionsCache;
}

const OPEN_STATUSES = ["new", "contacted", "consult_scheduled", "engagement_sent"];
const fail = (err) => toast(err.message || String(err), { error: true });

function areaName(id) {
  return state.setup?.practiceAreas.find((p) => p.id === id)?.name ?? null;
}

function conflictTag(l) {
  if (!l.conflictCheckId) return pill("No conflict check", "neutral");
  if (l.conflictDecision === "cleared") return pill("Conflicts cleared", "success");
  if (l.conflictDecision === "waived") return pill("Conflict waived", "success");
  if (l.conflictDecision === "declined") return pill("Conflict: declined", "danger");
  return l.conflictHits || l.earlierHits
    ? pill(`${plural((l.conflictHits || 0) + (l.earlierHits || 0), "possible conflict", "possible conflicts")}`, "danger")
    : pill("Conflicts to review", "warning");
}

function ageText(days) {
  return days <= 0 ? "Came in today" : days === 1 ? "Came in yesterday" : `Came in ${days} days ago`;
}

/** Local time in Kansas for an instant: "Thu Nov 19, 9:00 AM". */
export function fmtInstant(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function downloadFile(f) {
  const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
  const a = h("a", { href: url, download: f.filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function tabs(current) {
  const items = [
    ["#/intake", "Pipeline", "board", "layout-grid"],
    ["#/intake/list", "List", "list", "list-checks"],
    ["#/intake/reports", "Reports", "reports", "chart-column"],
  ];
  return h(
    "nav.segmented.intake-tabs",
    { "aria-label": "Intake view" },
    items.map(([href, label, key, ic]) => h("a.seg-link", { href, "aria-current": key === current ? "page" : null }, icon(ic, { size: 14 }), label)),
  );
}

function pageHead(current) {
  useStyles("intake");
  return pageHeader({
    title: "Intake",
    subtitle: "New inquiries, from first contact to signed client.",
    actions: [tabs(current), button("Add lead", { variant: "primary", icon: "plus", onclick: () => newLeadDialog() })],
  });
}

// -------------------------------------------------------------- pipeline

export async function intakeBoardView() {
  const opts = await intakeOptions();
  const page = h("div.page.intake");
  let leads = [];
  let ownerFilter = prefs.get("intake.owner", "");
  const board = h("div.intake-board");

  async function load() {
    leads = await get("/intake/leads");
    draw();
  }

  async function move(lead, status, position = null) {
    if (status === lead.status && position == null) return;
    if (status === "hired") return convertDialog(lead, load);
    if (status === "not_hired") return notHiredDialog(lead, load);
    try {
      await post(`/intake/leads/${lead.id}/status`, { status, position });
      if (status !== lead.status) toast(`${lead.name} moved to ${opts.statuses.find((s) => s.key === status).label}`);
      await load();
    } catch (err) {
      fail(err);
    }
  }

  function card(l) {
    const mover = select(
      [{ value: "", label: "Move to…" }, ...opts.statuses.filter((s) => s.key !== l.status).map((s) => ({ value: s.key, label: s.label }))],
      "",
      { class: "lead-move", "aria-label": `Move ${l.name} to`, onchange: (e) => e.target.value && move(l, e.target.value) },
    );
    const el = h(
      "article.lead-card",
      { draggable: l.status === "hired" ? null : "true", dataset: { id: String(l.id) } },
      h("a.lead-name", { href: `#/intake/leads/${l.id}` }, l.name),
      h("div.lead-meta", [l.practiceArea, l.source].filter(Boolean).join(" · ") || "No practice area yet"),
      h(
        "div.lead-foot",
        l.status === "not_hired" ? null : conflictTag(l),
      ),
      l.consultAt && l.status === "consult_scheduled" ? h("div.lead-line", icon("calendar-clock", { size: 13 }), fmtInstant(l.consultAt)) : null,
      l.nextFollowUp && OPEN_STATUSES.includes(l.status)
        ? h("div.lead-line" + (l.nextFollowUp < today() ? ".late-text" : l.nextFollowUp === today() ? ".today-text" : ""), icon("clock", { size: 13 }), "Follow up " + relDate(l.nextFollowUp, today()).toLowerCase())
        : null,
      h(
        "div.lead-foot",
        h("span.lead-owner", { title: `Owner: ${l.ownerName || "no one"}` }, avatar(l.ownerName, { size: "xs" }), h("span.lead-age", l.status === "not_hired" ? l.notHiredReason || "" : ageText(l.ageDays))),
      ),
      l.status === "hired" ? (l.matterId ? h("a.lead-matter-link", { href: `#/matters/${l.matterId}` }, "Open matter", icon("arrow-right", { size: 13 })) : null) : mover,
    );
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(l.id));
      e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    return el;
  }

  function column(s, list) {
    const body = h("div.intake-col-body", list.length ? list.map(card) : h("p.intake-col-empty", s.key === "new" ? "No new inquiries." : "None"));
    const col = h(
      "section.intake-col",
      { dataset: { status: s.key }, "aria-label": s.label },
      h("h2.intake-col-head", h("span", s.label), h("span.intake-col-count", String(list.length))),
      body,
    );
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drop");
    });
    col.addEventListener("dragleave", (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove("drop");
    });
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drop");
      const id = Number(e.dataTransfer.getData("text/plain"));
      const lead = leads.find((x) => x.id === id);
      if (!lead) return;
      // Drop position: just above the card under the pointer.
      const cards = [...body.querySelectorAll(".lead-card")].filter((c) => c.dataset.id !== String(id));
      const after = cards.find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
      const pos = (c) => leads.find((x) => String(x.id) === c.dataset.id)?.position ?? 0;
      let position = null;
      if (after) {
        const i = cards.indexOf(after);
        position = i > 0 ? (pos(cards[i - 1]) + pos(after)) / 2 : pos(after) - 1;
      } else if (cards.length) position = pos(cards[cards.length - 1]) + 1;
      move(lead, s.key, s.key === "hired" || s.key === "not_hired" ? null : position);
    });
    return col;
  }

  function draw() {
    const shown = ownerFilter ? leads.filter((l) => String(l.ownerId) === String(ownerFilter)) : leads;
    // Decided leads: only the last 30 days on the board (the list shows all).
    const recent = (l) => !l.closedOn || l.closedOn >= addDaysIso(today(), -30);
    board.replaceChildren(...opts.statuses.map((s) => column(s, shown.filter((l) => l.status === s.key && recent(l)))));
  }

  const ownerSel = select([{ value: "", label: "Everyone's leads" }, ...users().map((u) => ({ value: u.id, label: u.name }))], ownerFilter, {
    "aria-label": "Owner",
    onchange: (e) => {
      ownerFilter = e.target.value;
      prefs.set("intake.owner", ownerFilter);
      draw();
    },
  });

  await load();
  page.append(
    pageHead("board"),
    h("div.filters.intake-board-bar", ownerSel, h("p.intake-hint", "Drag a lead to another column, or use its “Move to” menu. Hired and Not hired show the last 30 days.")),
    board,
  );
  return page;
}

function addDaysIso(iso, n) {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ list

export async function intakeListView() {
  const opts = await intakeOptions();
  let status = prefs.get("intake.listStatus", "open");
  let owner = "";

  async function load() {
    const params = new URLSearchParams();
    if (status === "open") params.set("open", "1");
    else if (status) params.set("status", status);
    if (owner) params.set("owner", owner);
    table.setRows(await get(`/intake/leads?${params}`));
  }

  const statusSel = select(
    [{ value: "open", label: "Still in progress" }, { value: "", label: "All leads" }, ...opts.statuses.map((s) => ({ value: s.key, label: s.label }))],
    status,
    { "aria-label": "Status", onchange: (e) => ((status = e.target.value), prefs.set("intake.listStatus", status), load()) },
  );
  const ownerSel = select([{ value: "", label: "Everyone" }, ...users().map((u) => ({ value: u.id, label: u.name }))], owner, {
    "aria-label": "Owner",
    onchange: (e) => ((owner = e.target.value), load()),
  });
  const now = today();
  const table = dataTable({
    rows: [],
    label: "Leads",
    noun: ["lead", "leads"],
    tableClass: "leads-table",
    rowClass: () => "matter-row",
    rowHref: (l) => `#/intake/leads/${l.id}`,
    prefsKey: "intake.list",
    sort: { key: "received", dir: "desc" },
    search: { placeholder: "Search leads", text: (l) => [l.name, l.email, l.phone, l.source, l.practiceArea, l.summary] },
    filters: [statusSel, ownerSel],
    columns: [
      {
        key: "name",
        label: "Lead",
        primary: true,
        sort: (l) => l.name.toLowerCase(),
        render: (l) => h("div.cell-stack", h("a.cell-title", { href: `#/intake/leads/${l.id}` }, l.name), h("span.cell-sub.lead-reach", [l.email, l.phone].filter(Boolean).join(" · ") || "No contact details")),
      },
      {
        key: "status",
        label: "Status",
        sort: (l) => opts.statuses.findIndex((s) => s.key === l.status),
        render: (l) => h("div.cell-stack", h("span", leadPill(l)), l.status === "not_hired" && l.notHiredReason ? h("span.cell-sub", l.notHiredReason) : null),
      },
      {
        key: "area",
        label: "Practice area and source",
        hideOnPhone: true,
        sort: (l) => l.practiceArea || null,
        render: (l) => h("div.cell-stack", h("span", l.practiceArea || "Not sure yet"), h("span.cell-sub", l.source || "Source not given")),
      },
      { key: "owner", label: "Owner", className: "nowrap", hideOnPhone: true, sort: (l) => l.ownerName || null, render: (l) => (l.ownerName ? person(l.ownerName, null, { size: "xs" }) : h("span.muted", "No one")) },
      { key: "received", label: "Received", className: "nowrap", defaultDir: "desc", sort: (l) => l.receivedOn, render: (l) => h("span", fmtDate(l.receivedOn, now)) },
      { key: "conflicts", label: "Conflicts", sortable: false, render: (l) => conflictTag(l) },
    ],
    empty: ({ searching }) =>
      searching
        ? emptyState({ icon: "search", title: "No leads match", body: "Try another name, email or phone number.", compact: true })
        : emptyState({ icon: "intake", title: "No leads here", body: "Inquiries from the website, the booking page and phone calls appear here.", action: button("Add lead", { variant: "primary", icon: "plus", onclick: () => newLeadDialog() }), compact: true }),
  });
  await load();
  return h("div.page.intake", pageHead("list"), kitCard({ flush: true, className: "table-card", body: table }));
}

// --------------------------------------------------------------- reports

export async function intakeReportsView() {
  const to = h("input", { type: "date", value: today(), "aria-label": "To" });
  const from = h("input", { type: "date", value: addDaysIso(today(), -89), "aria-label": "From" });
  const body = h("div.intake-report");

  async function load() {
    try {
      draw(await get(`/intake/reports?from=${from.value}&to=${to.value}`));
    } catch (err) {
      fail(err);
    }
  }
  const pct = (v) => (v == null ? "—" : `${v}%`);
  const days = (v) => (v == null ? "—" : `${v} ${v === 1 ? "day" : "days"}`);

  function table(title, sub, head, rows, ic) {
    return kitCard({
      title,
      subtitle: sub,
      icon: ic,
      flush: true,
      className: "intake-report-card",
      body: rows.length
        ? h("div.intake-report-scroll", h("table.report-table", h("thead", h("tr", head.map((x, i) => h(i ? "th.num-cell" : "th", { scope: "col" }, x)))), h("tbody", rows)))
        : emptyState({ icon: "chart-column", title: "Nothing in this period", body: "Choose a longer period to see more.", compact: true }),
    });
  }
  const row = (cells) => h("tr", cells.map((c, i) => h(i ? "td.num-cell" : "td", c)));

  function draw(r) {
    const t = r.totals;
    body.replaceChildren(
      h(
        "div.stats.report-stats",
        stat({ label: "Leads received", value: String(t.leads), icon: "inbox" }),
        stat({ label: "Became clients", value: String(t.hired), icon: "user-plus", tone: t.hired ? "success" : null }),
        stat({ label: "Conversion rate", value: pct(t.conversionPct), icon: "chart-column", hint: `Of decided leads: ${pct(t.decidedConversionPct)}` }),
        stat({ label: "Typical time to hire", value: days(r.timeToHire.medianDays), icon: "clock", hint: r.timeToHire.count ? `Median of ${plural(r.timeToHire.count, "lead")} hired` : "No one hired in this period" }),
      ),
      h(
        "div.intake-report-grid",
        table("Leads by source", r.definitions.bySource, ["Source", "Leads", "Hired", "Not hired", "In progress", "Conversion"], r.bySource.map((s) => row([s.source, String(s.leads), String(s.hired), String(s.notHired), String(s.open), pct(s.conversionPct)])), "users"),
        table("Pipeline today", "Leads at each step right now.", ["Status", "Leads"], r.pipeline.map((p) => row([p.label, String(p.count)])), "intake"),
        table("Leads by practice area", null, ["Practice area", "Leads", "Hired", "Conversion"], r.byArea.map((a) => row([a.area, String(a.leads), String(a.hired), pct(a.conversionPct)])), "briefcase"),
        table("Why leads did not hire the firm", r.definitions.notHired, ["Reason", "Leads"], r.notHiredReasons.map((x) => row([x.reason, String(x.count)])), "circle-alert"),
      ),
      kitCard({
        title: "What these numbers mean",
        icon: "info",
        className: "definitions",
        body: h(
          "div.intake-defs",
          ...["leads", "conversion", "decidedConversion", "timeToHire"].map((k) => h("p", r.definitions[k])),
          r.timeToHire.count
            ? h("p.muted", `Time to hire is based on ${plural(r.timeToHire.count, "lead")} hired in this period: average ${days(r.timeToHire.averageDays)}, fastest ${days(r.timeToHire.fastestDays)}, slowest ${days(r.timeToHire.slowestDays)}.`)
            : null,
        ),
      }),
    );
  }

  await load();
  return h(
    "div.page.intake",
    pageHead("reports"),
    h("form.filters.intake-period", { onsubmit: (e) => (e.preventDefault(), load()) }, h("label.intake-date", h("span", "From"), from), h("label.intake-date", h("span", "to"), to), button("Show", { type: "submit" })),
    body,
  );
}

// ------------------------------------------------------------- dialogs

export async function newLeadDialog() {
  const opts = await intakeOptions();
  const name = h("input", { name: "name", required: true, maxlength: 200, autocomplete: "off" });
  const email = h("input", { name: "email", type: "email", maxlength: 200 });
  const phone = h("input", { name: "phone", type: "tel", maxlength: 40 });
  const source = h("input", { name: "source", list: "intake-sources", maxlength: 120 });
  const area = select([{ value: "", label: "Not sure yet" }, ...state.setup.practiceAreas.map((p) => ({ value: p.id, label: p.name }))], "", { name: "area" });
  const owner = select([{ value: "", label: "No one yet" }, ...users().map((u) => ({ value: u.id, label: u.name }))], state.me, { name: "owner" });
  const summary = h("textarea", { name: "summary", rows: 3, maxlength: 10000 });
  const opposing = h("textarea", { name: "opposing", rows: 2, placeholder: "One name per line" });
  const err = h("p.error-text", { role: "alert" });
  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        try {
          const l = await post("/intake/leads", {
            name: name.value,
            email: email.value || null,
            phone: phone.value || null,
            source: source.value || null,
            practiceAreaId: area.value ? Number(area.value) : null,
            ownerId: owner.value ? Number(owner.value) : null,
            summary: summary.value || null,
            opposing: opposing.value,
          });
          dlg.close();
          toast(`Added ${l.name}. Conflict check run.`);
          location.hash = `#/intake/leads/${l.id}`;
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h("datalist#intake-sources", opts.sources.map((s) => h("option", { value: s }))),
    h("label", "Name (person or business)", name),
    h("div.form-row", h("label", "Email", email), h("label", "Phone", phone), h("label", "How they heard about us", source)),
    h("div.form-row.two", h("label", "Practice area", area), h("label", "Owner", owner)),
    h("label", "What they need", summary),
    h("label", "Other people or businesses involved (checked for conflicts)", opposing),
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Add lead")),
  );
  const dlg = modal("Add a lead", form, { wide: true });
  name.focus();
}

export async function notHiredDialog(lead, onDone) {
  const opts = await intakeOptions();
  const reason = select(opts.notHiredReasons.map((r) => ({ value: r, label: r })), opts.notHiredReasons[0], { name: "reason" });
  const note = h("input", { name: "note", maxlength: 2000, placeholder: "Optional, e.g. which firm they chose" });
  const err = h("p.error-text", { role: "alert" });
  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await post(`/intake/leads/${lead.id}/status`, { status: "not_hired", reason: reason.value, note: note.value || null });
          dlg.close();
          toast(`${lead.name} marked not hired. Open reminders and unsent emails were cancelled.`);
          await onDone?.();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h("label", "Reason", reason),
    h("label", "Note", note),
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Mark not hired")),
  );
  const dlg = modal(`Not hired: ${lead.name}`, form);
}

export async function convertDialog(lead, onDone) {
  const full = lead.conflictCheck === undefined ? await get(`/intake/leads/${lead.id}`) : lead;
  const s = state.setup;
  const decided = full.conflictCheck && (full.conflictCheck.decision === "cleared" || full.conflictCheck.decision === "waived");
  if (!decided) {
    const dlg = modal(
      "Clear the conflict check first",
      h(
        "div.modal-body",
        h("p", full.conflictCheck?.decision === "declined" ? "The conflict check for this lead was declined, so it can't become a client." : "Before opening a matter, a lawyer needs to clear (or waive) the conflict check on this lead."),
        h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Close"), location.hash !== `#/intake/leads/${lead.id}` ? h("a.btn.primary", { href: `#/intake/leads/${lead.id}`, onclick: () => dlg.close() }, "Open the lead") : null),
      ),
    );
    return;
  }
  const clientSel = select(
    [{ value: "", label: `New client: ${full.name}` }, ...s.contacts.map((c) => ({ value: c.id, label: `Existing contact: ${c.name}` }))],
    "",
    { name: "client" },
  );
  const area = select([{ value: "", label: "None" }, ...s.practiceAreas.map((p) => ({ value: p.id, label: p.name }))], full.practiceAreaId ?? "", { name: "area" });
  const defaultName = () => (area.value ? `${full.name} – ${areaName(Number(area.value))}` : full.name);
  const matterName = h("input", { name: "matterName", maxlength: 300, value: defaultName() });
  area.addEventListener("change", () => (matterName.value = defaultName()));
  const number = h("input", { name: "number", maxlength: 60, placeholder: "Optional" });
  const roleNames = s.roles.length ? s.roles : ["attorney", "paralegal"];
  const roleSels = roleNames.map((r) => {
    const holders = users().filter((u) => u.default_role === r);
    const def = r === "attorney" && full.ownerId ? full.ownerId : holders.length === 1 ? holders[0].id : "";
    return [r, select([{ value: "", label: "—" }, ...users().map((u) => ({ value: u.id, label: u.name }))], def, { "aria-label": r })];
  });
  const err = h("p.error-text", { role: "alert" });
  const form = h(
    "form.modal-body.form-grid",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const roles = {};
        for (const [r, sel] of roleSels) if (sel.value) roles[r] = Number(sel.value);
        try {
          const r = await post(`/intake/leads/${full.id}/convert`, {
            contactId: clientSel.value ? Number(clientSel.value) : null,
            matterName: matterName.value,
            matterNumber: number.value || null,
            practiceAreaId: area.value ? Number(area.value) : null,
            roles,
          });
          dlg.close();
          await loadSetup();
          toast([`${full.name} is now a client`, "The matter is open, with the conflict check and intake history attached."]);
          location.hash = `#/matters/${r.matterId}`;
          await onDone?.();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h("p.small.muted", "This opens the client and the matter in one step. The matter starts in its practice area's first stage, so that stage's automatic steps run. The conflict check, parties, engagement letters and this lead's history go with it."),
    h("label", "Client", clientSel),
    h("div.form-row.two", h("label", "Practice area", area), h("label", "Matter number", number)),
    h("label", "Matter name", matterName),
    h("fieldset", h("legend", "People"), roleSels.map(([r, sel]) => h("label.inline", h("span.cap", r), sel))),
    err,
    h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Convert to client and open matter")),
  );
  const dlg = modal(`Convert ${full.name} to a client`, form, { wide: true });
}

// ------------------------------------------------------------- lead page

export async function leadView([id]) {
  const opts = await intakeOptions();
  const page = h("div.page.intake.lead-page");
  let l;

  async function refresh(next) {
    l = next ?? (await get(`/intake/leads/${id}`));
    draw();
  }
  async function act(fn, message) {
    try {
      const out = await fn();
      if (message) toast(message);
      await refresh(out && out.id === l.id && out.activity ? out : out?.lead ?? null);
    } catch (err) {
      fail(err);
    }
  }

  function stageBar() {
    const steps = opts.statuses.filter((s) => s.key !== "not_hired");
    const idx = steps.findIndex((s) => s.key === l.status);
    return h(
      "div.stage-card.lead-stage-card",
      h("div.stage-label", h("span", "Step"), h("span.stage-count", idx >= 0 ? `${idx + 1} of ${steps.length}` : l.statusLabel)),
      h(
      "ol.stage-bar.lead-stages",
      { "aria-label": "Where this lead is" },
      steps.map((s, i) =>
        h(
          "li",
          h(
            "button.stage" + (i === idx ? ".current" : idx >= 0 && i < idx ? ".past" : ""),
            {
              type: "button",
              disabled: l.status === "hired" || i === idx,
              "aria-current": i === idx ? "step" : null,
              onclick: () => (s.key === "hired" ? convertDialog(l, () => refresh()) : act(() => post(`/intake/leads/${l.id}/status`, { status: s.key }), `Moved to ${s.label}`)),
            },
            h("span.stage-n", String(i + 1)),
            h("span.stage-name", s.label),
          ),
        ),
      ),
      ),
    );
  }

  function nextAction() {
    switch (l.status) {
      case "new":
        return button("Mark contacted", { variant: "primary", icon: "phone", onclick: () => act(() => post(`/intake/leads/${l.id}/status`, { status: "contacted" }), "Marked contacted") });
      case "contacted":
        return button("Book a consultation", { variant: "primary", icon: "calendar", onclick: () => bookDialog() });
      case "consult_scheduled":
        return button("Prepare engagement letter", { variant: "primary", icon: "file-text", onclick: () => engagementDialog() });
      case "engagement_sent":
        return button("Convert to client", { variant: "primary", icon: "user-plus", onclick: () => convertDialog(l, () => refresh()) });
      case "hired":
        return l.matterId ? button("Open the matter", { variant: "primary", icon: "briefcase", href: `#/matters/${l.matterId}` }) : null;
      default:
        return button("Reopen", { icon: "rotate-ccw", onclick: () => act(() => post(`/intake/leads/${l.id}/status`, { status: "contacted" }), "Reopened") });
    }
  }

  // ---- conflict check
  function conflictCard() {
    const k = l.conflictCheck;
    const body = [];
    if (!k) body.push(h("p.lead-empty", "No conflict check has been run."));
    else {
      const who = k.decision ? `${k.decidedByName || "Someone"}, ${fmtTime(k.decidedAt)}` : null;
      const status = callout({
        tone: k.decision === "cleared" || k.decision === "waived" ? "success" : k.decision === "declined" ? "danger" : "warning",
        title: k.decision === "cleared" ? "Cleared" : k.decision === "waived" ? "Waived" : k.decision === "declined" ? "Declined: conflict of interest" : k.hitCount || l.earlierInquiries.length ? "Needs a lawyer's review" : "No matches found; needs a lawyer to clear it",
        body: [who ? `By ${who}.` : null, k.decisionNote].filter(Boolean).join(" ") || null,
      });
      status.classList.add("conflict-status", k.decision || "pending");
      body.push(
        status,
        h("p.lead-searched", `Searched ${k.terms.map((t) => `“${t.name}”${t.role === "adverse_party" ? " (other party)" : ""}`).join(", ")} against every contact, alias and matter. Run ${fmtTime(k.runAt)}.`),
      );
      if (k.results.length) {
        body.push(
          h(
            "ul.plain.hit-list",
            k.results.slice(0, 25).map((hit) =>
              h(
                "li.hit." + hit.severity,
                h(
                  "div.hit-head",
                  hit.contactId ? h("a.hit-name", { href: `#/contacts/${hit.contactId}` }, hit.name) : h("strong.hit-name", hit.name),
                  pill(`${hit.band[0].toUpperCase()}${hit.band.slice(1)} match`, hit.severity === "high" ? "danger" : hit.band === "possible" ? "warning" : "neutral", { dot: false }),
                  hit.match === "related" ? pill("Through a relationship", "neutral", { dot: false }) : null,
                ),
                hit.concerns.length ? h("div.hit-concern", icon("triangle-alert", { size: 14 }), h("span", hit.concerns.join(" "))) : null,
                hit.involvements.length ? h("ul.hit-inv", hit.involvements.slice(0, 6).map((v) => h("li", v.text))) : null,
              ),
            ),
          ),
        );
      }
      if (l.earlierInquiries.length) {
        body.push(
          h("h3.sub-h", "Earlier inquiries with a similar name"),
          h(
            "ul.plain.hit-list",
            l.earlierInquiries.map((e) =>
              h(
                "li.hit.medium",
                h("div.hit-head", h("a.hit-name", { href: `#/intake/leads/${e.leadId}` }, e.leadName), pill(e.statusLabel, "neutral", { dot: false })),
                h("div.hit-text", `“${e.term}” (${e.termAs}) is similar to “${e.matched}”, ${e.matchedAs} in an inquiry received ${fmtDate(e.receivedOn, today())}.`),
              ),
            ),
          ),
        );
      }
      if (l.status !== "hired") {
        body.push(
          h(
            "div.form-actions.conflict-actions",
            button("Run again", { size: "sm", variant: "ghost", icon: "rotate-ccw", class: "conflict-rerun", onclick: () => act(() => post(`/intake/leads/${l.id}/conflict-check`), "Conflict check run again") }),
            button("Decline", { size: "sm", onclick: () => decideDialog("declined") }),
            button("Waive", { size: "sm", onclick: () => decideDialog("waived") }),
            button("Clear", { size: "sm", variant: "primary", onclick: () => decideDialog("cleared") }),
          ),
        );
      }
    }
    return kitCard({
      title: "Conflict check",
      icon: "conflicts",
      className: "conflict-card",
      actions: k ? h("a.lead-card-link", { href: `#/conflicts/${k.id}` }, `Check no. ${k.id}`) : null,
      body,
    });
  }

  function decideDialog(decision) {
    const labels = { cleared: "Clear the conflict check", waived: "Record a waiver", declined: "Decline: conflict of interest" };
    const hint = {
      cleared: "Confirm that none of the matches is a conflict.",
      waived: "Say how the conflict was waived, for example where the written consent is filed.",
      declined: "The lead can't become a client. Say why, for the file.",
    };
    const note = h("textarea", { rows: 3, maxlength: 2000, required: decision === "waived" });
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const next = await post(`/intake/leads/${l.id}/conflict-decision`, { decision, note: note.value || null });
            dlg.close();
            toast("Decision recorded");
            await refresh(next);
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("p.lead-dialog-hint", hint[decision]),
      field(decision === "waived" ? "How it was waived" : "Note", note, { required: decision === "waived", optional: decision !== "waived" }),
      err,
      h("div.form-actions", button("Cancel", { onclick: () => dlg.close() }), button(labels[decision], { variant: decision === "declined" ? "danger" : "primary", type: "submit" })),
    );
    const dlg = modal(labels[decision], form);
    note.focus();
  }

  // ---- details
  function detailsCard() {
    const f = {
      name: h("input", { value: l.name, maxlength: 200, required: true }),
      kind: select([{ value: "person", label: "Person" }, { value: "company", label: "Business" }], l.kind),
      email: h("input", { type: "email", value: l.email || "", maxlength: 200 }),
      phone: h("input", { type: "tel", value: l.phone || "", maxlength: 40 }),
      source: h("input", { value: l.source || "", list: "intake-sources-2", maxlength: 120 }),
      area: select([{ value: "", label: "Not sure yet" }, ...state.setup.practiceAreas.map((p) => ({ value: p.id, label: p.name }))], l.practiceAreaId ?? ""),
      owner: select([{ value: "", label: "No one" }, ...users().map((u) => ({ value: u.id, label: u.name }))], l.ownerId ?? ""),
      opposing: h("textarea", { rows: 2, value: l.opposing.join("\n"), placeholder: "One name per line" }),
      summary: h("textarea", { rows: 4, value: l.summary || "", maxlength: 10000 }),
    };
    const locked = l.status === "hired";
    if (locked) Object.values(f).forEach((x) => (x.disabled = true));
    const form = h(
      "form.form-grid.lead-details-form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          act(
            () =>
              patch(`/intake/leads/${l.id}`, {
                name: f.name.value,
                kind: f.kind.value,
                email: f.email.value || null,
                phone: f.phone.value || null,
                source: f.source.value || null,
                practiceAreaId: f.area.value ? Number(f.area.value) : null,
                ownerId: f.owner.value ? Number(f.owner.value) : null,
                opposing: f.opposing.value,
                summary: f.summary.value || null,
              }),
            "Saved",
          );
        },
      },
      h("datalist#intake-sources-2", opts.sources.map((s) => h("option", { value: s }))),
      h("div.form-row.two", field("Name", f.name), field("Person or business", f.kind)),
      h("div.form-row.two", field("Email", f.email), field("Phone", f.phone)),
      h("div.form-row", field("How they heard about us", f.source), field("Practice area", f.area), field("Owner", f.owner)),
      field("Other people or businesses involved", f.opposing, { hint: "One name per line. Each is checked for conflicts." }),
      field("What they need", f.summary),
      locked ? null : h("div.form-actions", button("Save details", { variant: "primary", type: "submit" })),
    );
    return panel("Details", "user", "lead-details", form);
  }

  function answersCard() {
    if (!l.answers.length) return null;
    return panel(`Answers from “${l.formName || "intake form"}”`, "clipboard-list", "lead-answers", h("dl.answers", l.answers.flatMap((a) => [h("dt", a.label), h("dd.pre", a.value)])));
  }

  function notesCard() {
    const ta = h("textarea", { rows: 2, maxlength: 10000, placeholder: "Add a note: what was said, what happens next", "aria-label": "New note" });
    return panel(
      "Notes",
      "message-square",
      "lead-notes",
      h(
        "form.note-add",
        { onsubmit: (e) => (e.preventDefault(), ta.value.trim() && act(() => post(`/intake/leads/${l.id}/notes`, { body: ta.value }), "Note added")) },
        ta,
        h("div.note-add-actions", button("Add note", { size: "sm", type: "submit" })),
      ),
      l.notes.length
        ? h(
            "ul.plain.note-list",
            l.notes.map((n) =>
              h(
                "li",
                h(
                  "div.note-head",
                  avatar(n.userName, { size: "xs" }),
                  h("span.note-by", h("strong", n.userName || "Someone"), ` · ${fmtTime(n.at)}`),
                  iconButton("trash-2", "Delete note", { size: "sm", variant: "danger", onclick: () => confirm("Delete this note?") && act(() => del(`/intake/notes/${n.id}`), "Note deleted") }),
                ),
                h("div.pre", n.body),
              ),
            ),
          )
        : h("p.lead-empty", "No notes yet."),
    );
  }

  function historyCard() {
    return panel(
      "History",
      "activity",
      "lead-history",
      h(
        "ol.lead-timeline",
        l.activity.map((a) =>
          h(
            "li",
            h("span.lead-tl-dot", { "aria-hidden": "true" }),
            h("div.lead-tl-body", h("div.lead-tl-what", a.detail), h("div.lead-tl-meta", `${a.userName || (a.kind === "lead_created" ? "Website" : "Automatic")} · ${fmtTime(a.at)}`)),
          ),
        ),
      ),
    );
  }

  // ---- follow-ups
  function followUpsCard() {
    const date = h("input", { type: "date", value: addDaysIso(today(), 2), "aria-label": "Reminder date" });
    const title = h("input", { maxlength: 300, placeholder: `Follow up with ${l.name}`, "aria-label": "Reminder" });
    const open = l.status !== "hired" && l.status !== "not_hired";
    return panel(
      "Follow-ups",
      "clock",
      "lead-followups",
      l.tasks.length
        ? h(
            "ul.plain.mini-list",
            l.tasks.map((t) =>
              h(
                "li" + (t.status === "done" || t.status === "skipped" ? ".finished" : ""),
                h("span", t.title),
                h("span.small.muted", [t.dueDate ? relDate(t.dueDate, today()) : "No date", t.assigneeName, t.status === "done" ? "done" : t.status === "skipped" ? "no longer needed" : null].filter(Boolean).join(" · ")),
              ),
            ),
          )
        : h("p.lead-empty", "No reminders."),
      open
        ? h(
            "form.mini-form",
            { onsubmit: (e) => (e.preventDefault(), act(() => post(`/intake/leads/${l.id}/reminders`, { title: title.value || null, dueDate: date.value || null }), "Reminder added to the owner's tasks")) },
            title,
            h("div.mini-row", date, button("Add reminder", { size: "sm", type: "submit" })),
          )
        : null,
      h("h3.lead-sub-h", "Emails waiting to go out"),
      l.emails.length
        ? h(
            "ul.plain.mini-list",
            l.emails.map((m) =>
              h(
                "li" + (m.status !== "queued" ? ".finished" : ""),
                h("span", m.subject),
                h(
                  "span.small.muted",
                  `${m.status === "queued" ? "To send " + fmtDate(m.sendAfter.slice(0, 10), today()) : m.status === "sent" ? "Sent" : m.status === "failed" ? "Could not be sent" : "Cancelled"} · ${m.toAddress}`,
                ),
                m.status === "queued" ? button("Cancel", { size: "sm", variant: "ghost", onclick: () => act(() => post(`/intake/emails/${m.id}/cancel`), "Email cancelled") }) : null,
              ),
            ),
          )
        : h("p.lead-empty", "None."),
      open && l.email ? button("Write a follow-up email", { size: "sm", variant: "ghost", icon: "mail", class: "lead-inline-btn", onclick: () => emailDialog() }) : null,
      open && !l.email ? h("p.lead-empty", "Add an email address to write follow-up emails.") : null,
    );
  }

  function emailDialog() {
    const firm = opts.settings.firmNameShown;
    const subject = h("input", { maxlength: 300, required: true, value: `Following up from ${firm}` });
    const body = h("textarea", { rows: 7, required: true, value: `Dear ${l.name},\n\nThank you for contacting us. I wanted to follow up on your inquiry and see whether you would like to set up a time to talk.\n\n${firm}` });
    const when = h("input", { type: "date", value: today() });
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const next = await post(`/intake/leads/${l.id}/emails`, { subject: subject.value, body: body.value, sendAfter: when.value || null });
            dlg.close();
            toast("Email queued");
            await refresh(next);
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("p.small.muted", `To ${l.email}. It waits in the outbox until the send date.`),
      h("label", "Subject", subject),
      h("label", "Message", body),
      h("label", "Send on", when),
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Queue email")),
    );
    const dlg = modal("Follow-up email", form, { wide: true });
  }

  // ---- consultation
  function consultCard() {
    const booked = l.consultations.filter((c) => c.status === "booked");
    const link = `${location.origin}/intake/book.html?b=${encodeURIComponent(opts.settings.bookingToken)}&lead=${encodeURIComponent(l.publicToken)}`;
    const open = l.status !== "hired" && l.status !== "not_hired";
    return panel(
      "Consultation",
      "calendar",
      "lead-consult",
      booked.length
        ? h(
            "ul.plain.mini-list",
            booked.map((c) =>
              h(
                "li",
                h("span", fmtInstant(c.startAt)),
                h("span.small.muted", `with ${c.userName}${c.bookedVia === "public" ? " · booked online" : ""}`),
                open ? button("Cancel", { size: "sm", variant: "ghost", onclick: () => confirm("Cancel this consultation and remove it from the calendar?") && act(() => post(`/intake/consultations/${c.id}/cancel`), "Consultation cancelled") }) : null,
              ),
            ),
          )
        : h("p.lead-empty", "None booked."),
      open ? button("Book a consultation", { size: "sm", variant: "ghost", icon: "plus", class: "lead-inline-btn", onclick: () => bookDialog() }) : null,
      open
        ? h(
            "div.share-link",
            h("label.field-label", { for: "lead-book-link" }, "Or send them their own booking link"),
            h("input#lead-book-link", { readonly: true, value: link, onfocus: (e) => e.target.select() }),
          )
        : null,
    );
  }

  async function bookDialog() {
    const avail = await get("/intake/availability");
    const people = avail.filter((p) => p.takesConsultations && p.windows.length);
    if (!people.length) {
      const d = modal("No consultation hours set", h("div.modal-body", h("p", "Set who takes consultations and when in Settings › Booking availability."), h("div.form-actions", h("a.btn.primary", { href: "#/settings/booking", onclick: () => d.close() }, "Open booking settings"))));
      return;
    }
    const who = select([{ value: "", label: "Anyone available" }, ...people.map((p) => ({ value: p.userId, label: p.name }))], l.ownerId && people.some((p) => p.userId === l.ownerId) ? l.ownerId : "", { "aria-label": "With" });
    const slotsBox = h("div.slot-days");
    let chosen = null;
    const err = h("p.error-text", { role: "alert" });
    const confirmBtn = h("button.btn.primary", { type: "submit", disabled: true }, "Book");
    async function loadSlots() {
      chosen = null;
      confirmBtn.disabled = true;
      const days = await get(`/intake/slots${who.value ? `?person=${who.value}` : ""}`);
      slotsBox.replaceChildren(
        ...(days.length
          ? days.slice(0, 10).map((d) =>
              h(
                "div.slot-day",
                h("h3", d.label),
                h(
                  "div.slot-grid",
                  d.slots.map((s) =>
                    h(
                      "button.slot",
                      {
                        type: "button",
                        "aria-pressed": "false",
                        onclick: (e) => {
                          slotsBox.querySelectorAll(".slot").forEach((b) => b.setAttribute("aria-pressed", "false"));
                          e.currentTarget.setAttribute("aria-pressed", "true");
                          chosen = s;
                          confirmBtn.disabled = false;
                        },
                      },
                      s.time,
                      who.value ? null : h("span.slot-who", s.userName),
                    ),
                  ),
                ),
              ),
            )
          : [h("p.empty", "No open times in the booking window.")]),
      );
    }
    who.addEventListener("change", loadSlots);
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          if (!chosen) return;
          try {
            const r = await post(`/intake/leads/${l.id}/consultations`, { personId: chosen.userId, start: chosen.start });
            dlg.close();
            toast([`Consultation booked: ${r.when}`, `On ${r.userName}'s calendar.${l.email ? " A confirmation email is queued." : ""}`]);
            await refresh(r.lead);
          } catch (ex) {
            err.textContent = ex.message;
            loadSlots();
          }
        },
      },
      h("label", "With", who),
      slotsBox,
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), confirmBtn),
    );
    const dlg = modal(`Book a consultation for ${l.name}`, form, { wide: true });
    await loadSlots();
  }

  // ---- engagement letter
  function engagementCard() {
    const open = l.status !== "hired" && l.status !== "not_hired";
    const statusText = { draft: "Ready to send", sent: "Sent", signed: "Signed", declined: "Declined" };
    return panel(
      "Engagement letter",
      "file-text",
      "lead-engagement",
      l.engagements.length
        ? h(
            "ul.plain.mini-list",
            l.engagements.map((e) =>
              h(
                "li",
                h("span", e.filename),
                h("span.small.muted", `${statusText[e.status]}${e.sentAt ? " " + fmtTime(e.sentAt) : ""}${e.signatureRef ? " · out for e-signature" : ""}${e.documentId ? " · filed to the matter" : ""}`),
                h(
                  "span.mini-actions",
                  button("Download", { size: "sm", onclick: () => get(`/intake/engagements/${e.id}/download`).then(downloadFile, fail) }),
                  e.status === "draft" && open ? button("Send", { size: "sm", variant: "primary", onclick: () => sendDialog(e) }) : null,
                ),
              ),
            ),
          )
        : h("p.lead-empty", "None prepared yet."),
      open ? button("Prepare engagement letter", { size: "sm", variant: "ghost", icon: "plus", class: "lead-inline-btn", onclick: () => engagementDialog() }) : null,
    );
  }

  async function engagementDialog() {
    const list = await get("/document-templates");
    if (!list.length) {
      const d = modal("No document templates", h("div.modal-body", h("p", "Add an engagement letter template under Documents first. Templates can use {{client.name}}, {{matter.name}}, {{lead.summary}}, {{firm.name}} and {{today}}."), h("div.form-actions", h("button.btn", { type: "button", onclick: () => d.close() }, "Close"))));
      return;
    }
    const pick = list.find((t) => /engagement/i.test(t.name)) ?? list[0];
    const sel = select(list.map((t) => ({ value: t.id, label: t.name })), pick.id, { "aria-label": "Template" });
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const r = await post(`/intake/leads/${l.id}/engagement`, { templateId: Number(sel.value) });
            dlg.close();
            toast(r.unknown.length ? ["Letter prepared", `The template uses fields that don't exist: ${r.unknown.join(", ")}`] : "Letter prepared. Download it to review, then send.", { error: r.unknown.length > 0 });
            await refresh(r.lead);
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      h("label", "Template", sel),
      h("p.small.muted", "The letter is filled in with this lead's details. It stays with the lead and is filed into the matter's documents when the lead becomes a client."),
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Prepare letter")),
    );
    const dlg = modal("Prepare engagement letter", form);
  }

  function sendDialog(e) {
    const firm = opts.settings.firmNameShown;
    const msg = h("textarea", { rows: 6, value: `Dear ${l.name},\n\nThank you for speaking with us. Our engagement letter is attached. Please read it, and sign and return it if you would like us to go ahead. Call us with any questions.\n\n${firm}` });
    const err = h("p.error-text", { role: "alert" });
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: async (ev) => {
          ev.preventDefault();
          try {
            const next = await post(`/intake/engagements/${e.id}/send`, { message: msg.value });
            dlg.close();
            toast(["Engagement letter sent", "A follow-up reminder and email are scheduled."]);
            await refresh(next);
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      l.email ? h("p.small.muted", `The letter goes to ${l.email} with this message. The lead moves to “Engagement sent”.`) : h("p.small", "This lead has no email address. The letter will be marked sent; deliver it yourself."),
      l.email ? h("label", "Message", msg) : null,
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Send letter")),
    );
    const dlg = modal(`Send “${e.filename}”`, form, { wide: true });
  }

  function clientCard() {
    if (l.status !== "hired") return null;
    return panel(
      "Client",
      "user-plus",
      "client-card",
      h("p.lead-empty", `Hired ${fmtDate(l.hiredOn, today())}.`),
      l.matterId ? h("p", h("a.cell-title", { href: `#/matters/${l.matterId}` }, l.matterNumber ? h("span.matter-num", l.matterNumber) : null, " ", l.matterName || "Open the matter")) : null,
    );
  }

  function draw() {
    const open = l.status !== "hired" && l.status !== "not_hired";
    page.replaceChildren(
      pageHeader({
        title: l.name,
        breadcrumbs: [{ label: "Intake", href: "#/intake" }, { label: l.name }],
        meta: [
          leadPill(l),
          h("span.lead-head-meta", [l.status === "not_hired" && l.notHiredReason ? l.notHiredReason : null, `Received ${fmtDate(l.receivedOn, today())}`, l.source].filter(Boolean).join(" · ")),
          l.ownerName ? person(l.ownerName, null, { size: "xs" }) : h("span.lead-head-meta", "No owner"),
        ],
        actions: [
          open ? button("Not hired", { variant: "ghost", onclick: () => notHiredDialog(l, () => refresh()) }) : null,
          open && l.status !== "engagement_sent" ? button("Convert to client", { onclick: () => convertDialog(l, () => refresh()) }) : null,
          nextAction(),
        ].filter(Boolean),
      }),
      stageBar(),
      h(
        "div.lead-grid",
        h("div.lead-main", conflictCard(), detailsCard(), answersCard(), notesCard(), historyCard()),
        h("aside.lead-aside", clientCard(), followUpsCard(), consultCard(), engagementCard()),
      ),
    );
  }

  await refresh();
  return page;
}
