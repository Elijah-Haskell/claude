// The case file's module tabs: Calendar, Documents, Billing and Communications. Each tab
// shows the module's own matter card (owned and styled by that module) plus the related
// pieces, so the Overview can stay a short summary. Tabs get their own URLs
// (#/matters/12/billing). The documents tab's id is "files": #/matters/12/documents is the
// full documents page (matterDocumentsView), routed before the matter page in app.js.

import { h } from "../dom.js";
import { get } from "../api.js";
import { state, today } from "../state.js";
import { card, button, emptyState, statusPill } from "../ui/components.js";
import { dataTable } from "../ui/table.js";
import { fmtDate } from "../dom.js";
import { registerMatterTab } from "../ui/matter-slots.js";
import { upcomingCard } from "../cal.js";
import { billingCard } from "../billing/matter-card.js";
import { money } from "../billing/format.js";
import { communicationsCard } from "./communications.js";
import { matterDocumentsCard } from "./documents.js";
import { matterPaymentsCard, matterSignaturesCard } from "./pay-esign.js";

const stack = (...nodes) => h("div.matter-tab-stack", nodes);

registerMatterTab({
  id: "calendar",
  label: "Calendar",
  icon: "calendar",
  order: 20,
  render: (ctx) =>
    stack(
      upcomingCard(ctx.matterId),
      h(
        "p.matter-tab-note",
        "Key dates (closing, filing, trial) are set in the right-hand panel; tasks that follow them move when they change. ",
        h("a", { href: `#/deadlines/${ctx.matterId}` }, "Work out a court deadline"),
      ),
    ),
});

registerMatterTab({
  id: "files",
  label: "Documents",
  icon: "documents",
  order: 30,
  render: (ctx) => {
    const client = state.setup.contacts.find((c) => c.id === ctx.matter.client_id);
    return stack(
      matterDocumentsCard(ctx.matterId),
      matterSignaturesCard({ id: ctx.matterId, client_name: ctx.matter.client_name, client_email: client?.email ?? null }),
    );
  },
});

registerMatterTab({
  id: "billing",
  label: "Billing",
  icon: "billing",
  order: 40,
  render: async (ctx) => {
    const invoices = h("div");
    const node = stack(h("div.matter-tab-pair", billingCard(ctx.matterId, { onChange: () => ctx.refresh() }), matterPaymentsCard(ctx.matterId)), invoices);
    try {
      const rows = await get(`/billing/invoices?matterId=${ctx.matterId}`);
      invoices.append(invoiceTable(rows));
    } catch (err) {
      invoices.append(emptyState({ icon: "circle-alert", title: "Couldn't load the invoices", body: err.message, compact: true }));
    }
    return node;
  },
});

registerMatterTab({
  id: "communications",
  label: "Communications",
  icon: "message-square",
  order: 50,
  render: (ctx) => stack(communicationsCard(ctx.matterId, { onChange: () => ctx.refresh().catch(() => {}) })),
});

function invoiceTable(rows) {
  const now = today();
  return card({
    title: "Invoices on this matter",
    icon: "receipt",
    flush: true,
    actions: button("All invoices", { variant: "ghost", size: "sm", iconRight: "arrow-right", href: "#/billing/invoices" }),
    body: dataTable({
      columns: [
        { key: "number", label: "No.", className: "nowrap", primary: true, render: (r) => h("a.cell-title", { href: `#/billing/invoices/${r.id}` }, r.status === "draft" ? "Draft" : `No. ${r.number}`), sort: (r) => r.number ?? 0 },
        { key: "issued_on", label: "Issued", className: "nowrap", render: (r) => (r.issued_on ? fmtDate(r.issued_on, now) : "—"), sort: (r) => r.issued_on || "" },
        { key: "due_on", label: "Due", className: "nowrap", hideOnPhone: true, render: (r) => (r.due_on ? fmtDate(r.due_on, now) : "—"), sort: (r) => r.due_on || "" },
        { key: "status", label: "Status", render: (r) => statusPill(r.status === "final" && r.balance_cents > 0 && r.due_on < now ? "overdue" : r.status === "final" && !r.balance_cents ? "paid" : r.status) },
        { key: "total_cents", label: "Total", align: "right", render: (r) => money(r.total_cents), sort: (r) => r.total_cents },
        { key: "balance_cents", label: "Balance", align: "right", render: (r) => (r.status === "final" ? money(r.balance_cents) : "—"), sort: (r) => r.balance_cents ?? 0 },
      ],
      rows,
      rowKey: (r) => r.id,
      rowHref: (r) => `#/billing/invoices/${r.id}`,
      sort: { key: "issued_on", dir: "desc" },
      noun: ["invoice", "invoices"],
      pageSize: 10,
      empty: emptyState({ icon: "receipt", title: "No invoices yet", body: "Start one from the Billing card above when there is time or expenses to bill.", compact: true }),
    }),
  });
}
