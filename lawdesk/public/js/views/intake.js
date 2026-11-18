// Intake: people who have asked for help but are not clients yet.
//   #/intake           pipeline board (columns by status; move with the menu or by dragging)
//   #/intake/list      the same leads as a list with filters
//   #/intake/reports   leads by source, conversion rate and time to hire
//   #/intake/leads/:id one lead: conflict check, details, follow-ups, consultation,
//                      engagement letter, convert to client and matter
// Everything typed by people goes into the page as text (dom.js never uses innerHTML).

import { h, select, modal, toast, fmtDate, fmtTime, plural, relDate } from "../dom.js";
import { get, post, patch, del } from "../api.js";
import { state, today, users, initials, prefs, loadSetup } from "../state.js";

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
  if (!l.conflictCheckId) return h("span.tag", "No conflict check");
  if (l.conflictDecision === "cleared") return h("span.tag.good.intake-tag", "Conflicts cleared");
  if (l.conflictDecision === "waived") return h("span.tag.good.intake-tag", "Conflict waived");
  if (l.conflictDecision === "declined") return h("span.tag.high", "Conflict: declined");
  return l.conflictHits || l.earlierHits
    ? h("span.tag.high", `Conflicts: ${plural((l.conflictHits || 0) + (l.earlierHits || 0), "possible match", "possible matches")}`)
    : h("span.tag.blocks", "Conflicts: needs review");
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
    ["#/intake", "Pipeline", "board"],
    ["#/intake/list", "List", "list"],
    ["#/intake/reports", "Reports", "reports"],
  ];
  return h(
    "div.segmented.intake-tabs",
    { role: "group", "aria-label": "Intake view" },
    items.map(([href, label, key]) => h("a.seg-link", { href, "aria-current": key === current ? "page" : null, "aria-pressed": key === current ? "true" : "false" }, label)),
  );
}

function pageHead(current) {
  return h(
    "div.page-head",
    h("div", h("h1", "Intake"), h("p.sub", "New inquiries, from first contact to signed client.")),
    h("div.head-actions", tabs(current), h("button.btn.primary", { type: "button", onclick: () => newLeadDialog() }, "Add lead")),
  );
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
      h("div.lead-meta.muted.small", [l.practiceArea, l.source].filter(Boolean).join(" · ") || "No practice area yet"),
      h(
        "div.lead-foot",
        l.status === "not_hired" ? null : conflictTag(l),
        l.consultAt && l.status === "consult_scheduled" ? h("span.small", "Consultation " + fmtInstant(l.consultAt)) : null,
        l.nextFollowUp && OPEN_STATUSES.includes(l.status)
          ? h("span.small" + (l.nextFollowUp < today() ? ".late-text" : ""), "Follow up " + relDate(l.nextFollowUp, today()))
          : null,
      ),
      h(
        "div.lead-foot",
        h("span.avatar", { title: l.ownerName || "No one", "aria-label": `Owner: ${l.ownerName || "no one"}` }, l.ownerName ? initials(l.ownerName) : "–"),
        h("span.muted.small", l.status === "not_hired" ? l.notHiredReason || "" : ageText(l.ageDays)),
        l.status === "hired" ? (l.matterId ? h("a.small", { href: `#/matters/${l.matterId}` }, "Open matter") : null) : mover,
      ),
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
    const body = h("div.intake-col-body", list.length ? list.map(card) : h("p.empty.small", s.key === "new" ? "No new inquiries." : "None"));
    const col = h(
      "section.intake-col",
      { dataset: { status: s.key }, "aria-label": s.label },
      h("h2.intake-col-head", h("span", s.label), h("span.count.muted", String(list.length))),
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
    h("div.filters", ownerSel, h("p.muted.small.intake-hint", "Drag a lead to another column, or use its “Move to” menu. Hired and Not hired show the last 30 days.")),
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
  let leads = [];
  let q = "";
  let status = prefs.get("intake.listStatus", "open");
  let owner = "";
  const tbody = h("tbody");
  const count = h("p.result-count.muted");

  async function load() {
    const params = new URLSearchParams();
    if (status === "open") params.set("open", "1");
    else if (status) params.set("status", status);
    if (owner) params.set("owner", owner);
    leads = await get(`/intake/leads?${params}`);
    draw();
  }

  function draw() {
    const needle = q.trim().toLowerCase();
    const list = leads.filter((l) => !needle || [l.name, l.email, l.phone, l.source, l.practiceArea, l.summary].some((x) => x && x.toLowerCase().includes(needle)));
    count.textContent = plural(list.length, "lead");
    tbody.replaceChildren(
      ...list.map((l) =>
        h(
          "tr.matter-row",
          {
            tabindex: "0",
            onclick: (e) => !e.target.closest("a") && (location.hash = `#/intake/leads/${l.id}`),
            onkeydown: (e) => e.key === "Enter" && (location.hash = `#/intake/leads/${l.id}`),
          },
          h("td.m-name", { "data-label": "Lead" }, h("a", { href: `#/intake/leads/${l.id}` }, l.name), h("div.muted.small", [l.email, l.phone].filter(Boolean).join(" · ") || "No contact details")),
          h("td", { "data-label": "Status" }, h("span.stage-pill", l.statusLabel), l.status === "not_hired" && l.notHiredReason ? h("div.muted.small", l.notHiredReason) : null),
          h("td", { "data-label": "Area" }, l.practiceArea || h("span.muted", "—"), h("div.muted.small", l.source || "Source not given")),
          h("td", { "data-label": "Owner" }, l.ownerName || h("span.muted", "No one")),
          h("td", { "data-label": "Received" }, fmtDate(l.receivedOn, today())),
          h("td", { "data-label": "Conflicts" }, conflictTag(l)),
        ),
      ),
    );
    if (!list.length) tbody.append(h("tr", h("td", { colspan: "6" }, h("p.empty", "No leads match."))));
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
  await load();
  return h(
    "div.page.intake",
    pageHead("list"),
    h(
      "div.filters",
      statusSel,
      ownerSel,
      h("input.search", { type: "search", placeholder: "Search leads", "aria-label": "Search leads", "data-search": "", oninput: (e) => ((q = e.target.value), draw()) }),
    ),
    count,
    h(
      "table.matters.leads-table",
      h("thead", h("tr", h("th", "Lead"), h("th", "Status"), h("th", "Practice area and source"), h("th", "Owner"), h("th", "Received"), h("th", "Conflicts"))),
      tbody,
    ),
  );
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

  function table(head, rows) {
    return h("div.table-scroll", h("table.report-table", h("thead", h("tr", head.map((x, i) => h(i ? "th.num-cell" : "th", x)))), h("tbody", rows.length ? rows : h("tr", h("td", { colspan: String(head.length) }, h("p.empty", "Nothing in this period."))))));
  }

  function draw(r) {
    const t = r.totals;
    body.replaceChildren(
      h(
        "div.stats.report-stats",
        h("div.stat", h("span.stat-n", String(t.leads)), h("span.stat-label", "Leads received")),
        h("div.stat.good", h("span.stat-n", String(t.hired)), h("span.stat-label", "Became clients")),
        h("div.stat", h("span.stat-n", pct(t.conversionPct)), h("span.stat-label", "Conversion rate")),
        h("div.stat", h("span.stat-n", pct(t.decidedConversionPct)), h("span.stat-label", "Of decided leads")),
        h("div.stat", h("span.stat-n", days(r.timeToHire.medianDays)), h("span.stat-label", "Typical time to hire")),
      ),
      h(
        "dl.definitions.card",
        h("h2", "What these numbers mean"),
        ...["leads", "conversion", "decidedConversion", "timeToHire"].map((k) => h("p.small", r.definitions[k])),
        r.timeToHire.count
          ? h("p.small.muted", `Time to hire is based on ${plural(r.timeToHire.count, "lead")} hired in this period: average ${days(r.timeToHire.averageDays)}, fastest ${days(r.timeToHire.fastestDays)}, slowest ${days(r.timeToHire.slowestDays)}.`)
          : null,
      ),
      h("h2.report-h", "Leads by source"),
      h("p.small.muted", r.definitions.bySource),
      table(
        ["Source", "Leads", "Hired", "Not hired", "In progress", "Conversion"],
        r.bySource.map((s) => h("tr", h("td", s.source), h("td.num-cell", String(s.leads)), h("td.num-cell", String(s.hired)), h("td.num-cell", String(s.notHired)), h("td.num-cell", String(s.open)), h("td.num-cell", pct(s.conversionPct)))),
      ),
      h("h2.report-h", "Leads by practice area"),
      table(["Practice area", "Leads", "Hired", "Conversion"], r.byArea.map((a) => h("tr", h("td", a.area), h("td.num-cell", String(a.leads)), h("td.num-cell", String(a.hired)), h("td.num-cell", pct(a.conversionPct))))),
      h("h2.report-h", "Why leads did not hire the firm"),
      h("p.small.muted", r.definitions.notHired),
      table(["Reason", "Leads"], r.notHiredReasons.map((x) => h("tr", h("td", x.reason), h("td.num-cell", String(x.count))))),
      h("h2.report-h", "Pipeline today"),
      table(["Status", "Leads"], r.pipeline.map((p) => h("tr", h("td", p.label), h("td.num-cell", String(p.count))))),
    );
  }

  await load();
  return h(
    "div.page.intake",
    pageHead("reports"),
    h("form.filters", { onsubmit: (e) => (e.preventDefault(), load()) }, h("label.inline-label", "From ", from), h("label.inline-label", "to ", to), h("button.btn", { type: "submit" }, "Show")),
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
    );
  }

  function nextAction() {
    switch (l.status) {
      case "new":
        return h("button.btn.primary", { type: "button", onclick: () => act(() => post(`/intake/leads/${l.id}/status`, { status: "contacted" }), "Marked contacted") }, "Mark contacted");
      case "contacted":
        return h("button.btn.primary", { type: "button", onclick: () => bookDialog() }, "Book a consultation");
      case "consult_scheduled":
        return h("button.btn.primary", { type: "button", onclick: () => engagementDialog() }, "Prepare engagement letter");
      case "engagement_sent":
        return h("button.btn.primary", { type: "button", onclick: () => convertDialog(l, () => refresh()) }, "Convert to client");
      case "hired":
        return l.matterId ? h("a.btn.primary", { href: `#/matters/${l.matterId}` }, "Open the matter") : null;
      default:
        return h("button.btn", { type: "button", onclick: () => act(() => post(`/intake/leads/${l.id}/status`, { status: "contacted" }), "Reopened") }, "Reopen");
    }
  }

  // ---- conflict check
  function conflictCard() {
    const k = l.conflictCheck;
    const body = [];
    if (!k) body.push(h("p.empty", "No conflict check has been run."));
    else {
      const who = k.decision ? `${k.decidedByName || "Someone"}, ${fmtTime(k.decidedAt)}` : null;
      body.push(
        h(
          "div.conflict-status." + (k.decision || "pending"),
          h(
            "strong",
            k.decision === "cleared" ? "Cleared" : k.decision === "waived" ? "Waived" : k.decision === "declined" ? "Declined: conflict of interest" : k.hitCount || l.earlierInquiries.length ? "Needs a lawyer's review" : "No matches found; needs a lawyer to clear it",
          ),
          who ? h("span.small.muted", ` by ${who}`) : null,
          k.decisionNote ? h("div.small", k.decisionNote) : null,
        ),
        h("p.small.muted", `Searched ${k.terms.map((t) => `“${t.name}”${t.role === "adverse_party" ? " (other party)" : ""}`).join(", ")} against every contact, alias and matter. Run ${fmtTime(k.runAt)}.`),
      );
      if (k.results.length) {
        body.push(
          h(
            "ul.plain.hit-list",
            k.results.slice(0, 25).map((hit) =>
              h(
                "li.hit." + hit.severity,
                h("div.hit-head", h("strong", hit.name), h("span.tag" + (hit.severity === "high" ? ".high" : ""), `${hit.band} match`), hit.match === "related" ? h("span.tag", "related") : null),
                hit.concerns.length ? h("div.small", hit.concerns.join(" ")) : null,
                hit.involvements.length ? h("ul.small.hit-inv", hit.involvements.slice(0, 6).map((v) => h("li", v.text))) : null,
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
                h("div.hit-head", h("a", { href: `#/intake/leads/${e.leadId}` }, e.leadName), h("span.tag", e.statusLabel)),
                h("div.small", `“${e.term}” (${e.termAs}) is similar to “${e.matched}”, ${e.matchedAs} in an inquiry received ${fmtDate(e.receivedOn, today())}.`),
              ),
            ),
          ),
        );
      }
      if (l.status !== "hired") {
        body.push(
          h(
            "div.form-actions.conflict-actions",
            h("button.btn.small", { type: "button", onclick: () => act(() => post(`/intake/leads/${l.id}/conflict-check`), "Conflict check run again") }, "Run again"),
            h("button.btn.small", { type: "button", onclick: () => decideDialog("declined") }, "Decline"),
            h("button.btn.small", { type: "button", onclick: () => decideDialog("waived") }, "Waive"),
            h("button.btn.small.primary", { type: "button", onclick: () => decideDialog("cleared") }, "Clear"),
          ),
        );
      }
    }
    return h("section.card.conflict-card", h("h2", "Conflict check"), body);
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
      h("p.small.muted", hint[decision]),
      h("label", decision === "waived" ? "How it was waived" : "Note (optional)", note),
      err,
      h("div.form-actions", h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, labels[decision])),
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
    return h(
      "form.card.form-grid.lead-details",
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
      h("h2", "Details"),
      h("datalist#intake-sources-2", opts.sources.map((s) => h("option", { value: s }))),
      h("div.form-row.two", h("label", "Name", f.name), h("label", "Person or business", f.kind)),
      h("div.form-row.two", h("label", "Email", f.email), h("label", "Phone", f.phone)),
      h("div.form-row", h("label", "How they heard about us", f.source), h("label", "Practice area", f.area), h("label", "Owner", f.owner)),
      h("label", "Other people or businesses involved", f.opposing),
      h("label", "What they need", f.summary),
      locked ? null : h("div.form-actions", h("button.btn.primary", { type: "submit" }, "Save details")),
    );
  }

  function answersCard() {
    if (!l.answers.length) return null;
    return h(
      "section.card",
      h("h2", `Answers from “${l.formName || "intake form"}”`),
      h("dl.answers", l.answers.flatMap((a) => [h("dt", a.label), h("dd.pre", a.value)])),
    );
  }

  function notesCard() {
    const ta = h("textarea", { rows: 2, maxlength: 10000, placeholder: "Add a note: what was said, what happens next", "aria-label": "New note" });
    return h(
      "section.card",
      h("h2", "Notes"),
      h(
        "form.note-add",
        { onsubmit: (e) => (e.preventDefault(), ta.value.trim() && act(() => post(`/intake/leads/${l.id}/notes`, { body: ta.value }), "Note added")) },
        ta,
        h("div.form-actions", h("button.btn.small", { type: "submit" }, "Add note")),
      ),
      l.notes.length
        ? h(
            "ul.plain.note-list",
            l.notes.map((n) =>
              h(
                "li",
                h("div.small.muted", `${n.userName || "Someone"}, ${fmtTime(n.at)}`, h("button.icon-btn.danger", { type: "button", "aria-label": "Delete note", title: "Delete note", onclick: () => confirm("Delete this note?") && act(() => del(`/intake/notes/${n.id}`), "Note deleted") }, "×")),
                h("div.pre", n.body),
              ),
            ),
          )
        : h("p.empty.small", "No notes yet."),
    );
  }

  function historyCard() {
    return h(
      "section.card.activity",
      h("h2", "History"),
      h("ol.activity-list", l.activity.map((a) => h("li", h("span.act-time", fmtTime(a.at)), h("span.act-who", a.userName || (a.kind === "lead_created" ? "Website" : "Automatic")), h("span.act-what", a.detail)))),
    );
  }

  // ---- follow-ups
  function followUpsCard() {
    const date = h("input", { type: "date", value: addDaysIso(today(), 2), "aria-label": "Reminder date" });
    const title = h("input", { maxlength: 300, placeholder: `Follow up with ${l.name}`, "aria-label": "Reminder" });
    const open = l.status !== "hired" && l.status !== "not_hired";
    return h(
      "section.card",
      h("h2", "Follow-ups"),
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
        : h("p.empty.small", "No reminders."),
      open
        ? h(
            "form.mini-form",
            { onsubmit: (e) => (e.preventDefault(), act(() => post(`/intake/leads/${l.id}/reminders`, { title: title.value || null, dueDate: date.value || null }), "Reminder added to the owner's tasks")) },
            title,
            h("div.mini-row", date, h("button.btn.small", { type: "submit" }, "Add reminder")),
          )
        : null,
      h("h3.sub-h", "Emails waiting to go out"),
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
                m.status === "queued" ? h("button.btn.small.danger-text", { type: "button", onclick: () => act(() => post(`/intake/emails/${m.id}/cancel`), "Email cancelled") }, "Cancel") : null,
              ),
            ),
          )
        : h("p.empty.small", "None."),
      open && l.email ? h("button.btn.small", { type: "button", onclick: () => emailDialog() }, "Write a follow-up email") : null,
      open && !l.email ? h("p.small.muted", "Add an email address to write follow-up emails.") : null,
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
    return h(
      "section.card",
      h("h2", "Consultation"),
      booked.length
        ? h(
            "ul.plain.mini-list",
            booked.map((c) =>
              h(
                "li",
                h("span", fmtInstant(c.startAt)),
                h("span.small.muted", `with ${c.userName}${c.bookedVia === "public" ? " · booked online" : ""}`),
                open ? h("button.btn.small.danger-text", { type: "button", onclick: () => confirm("Cancel this consultation and remove it from the calendar?") && act(() => post(`/intake/consultations/${c.id}/cancel`), "Consultation cancelled") }, "Cancel") : null,
              ),
            ),
          )
        : h("p.empty.small", "None booked."),
      open ? h("button.btn.small", { type: "button", onclick: () => bookDialog() }, "Book a consultation") : null,
      open
        ? h(
            "div.share-link",
            h("label.small.muted", { for: "lead-book-link" }, "Or send them their own booking link:"),
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
    return h(
      "section.card",
      h("h2", "Engagement letter"),
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
                  h("button.btn.small", { type: "button", onclick: () => get(`/intake/engagements/${e.id}/download`).then(downloadFile, fail) }, "Download"),
                  e.status === "draft" && open ? h("button.btn.small.primary", { type: "button", onclick: () => sendDialog(e) }, "Send") : null,
                ),
              ),
            ),
          )
        : h("p.empty.small", "None prepared yet."),
      open ? h("button.btn.small", { type: "button", onclick: () => engagementDialog() }, "Prepare engagement letter") : null,
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
    return h(
      "section.card.client-card",
      h("h2", "Client"),
      h("p", `Hired ${fmtDate(l.hiredOn, today())}.`),
      l.matterId ? h("p", h("a", { href: `#/matters/${l.matterId}` }, l.matterNumber ? `${l.matterNumber} ` : "", l.matterName || "Open the matter")) : null,
    );
  }

  function draw() {
    const open = l.status !== "hired" && l.status !== "not_hired";
    page.replaceChildren(
      h("a.back", { href: "#/intake" }, "← Intake"),
      h(
        "div.page-head",
        h(
          "div",
          h("h1", l.name),
          h("p.sub", [l.statusLabel + (l.status === "not_hired" && l.notHiredReason ? `: ${l.notHiredReason}` : ""), `received ${fmtDate(l.receivedOn, today())}`, l.source, l.ownerName ? `owner ${l.ownerName}` : "no owner"].filter(Boolean).join(" · ")),
        ),
        h(
          "div.head-actions",
          open ? h("button.btn", { type: "button", onclick: () => notHiredDialog(l, () => refresh()) }, "Not hired") : null,
          open && l.status !== "engagement_sent" ? h("button.btn", { type: "button", onclick: () => convertDialog(l, () => refresh()) }, "Convert to client") : null,
          nextAction(),
        ),
      ),
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
