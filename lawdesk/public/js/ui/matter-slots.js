// Extension points on the matter page, so modules (documents, billing, calendar,
// communications…) can add to a matter without editing views/matter.js.
//
//   import { registerMatterCard, registerMatterTab } from "../ui/matter-slots.js";
//
//   // A summary card on the Overview tab (keep it short: 3–6 rows and a "View all" link).
//   registerMatterCard({
//     id: "billing",
//     order: 20,                       // lower comes first; tasks summary is 0
//     render: async (ctx) => card({ title: "Billing", icon: "receipt", body: … }),   // return null to hide
//   });
//
//   // A full tab next to Overview / Tasks / Activity.
//   registerMatterTab({
//     id: "documents",                 // becomes #/matters/12/documents
//     label: "Documents",
//     icon: "documents",
//     order: 20,                       // Tasks is 10, Activity is 90
//     count: (ctx) => null,            // optional number shown on the tab
//     render: async (ctx) => node,
//   });
//
// ctx = { matterId, matter, data (the GET /api/matters/:id payload), refresh(), openTab(id) }
// Import the module's file from app.js (or from its view) so the registration runs.

export const matterTabs = [];
export const matterCards = [];

export function registerMatterTab(tab) {
  if (matterTabs.some((t) => t.id === tab.id)) return;
  matterTabs.push(tab);
  matterTabs.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

export function registerMatterCard(c) {
  if (matterCards.some((x) => x.id === c.id)) return;
  matterCards.push(c);
  matterCards.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}
