# Lawdesk design system

Lawdesk should look like one calm, professional product: a desk for a small law firm, not a developer
tool. Every screen is built from the same small kit (`public/js/ui/`) and the same tokens
(`public/app.css`). If you are adding a module, read "Building a new screen" and "Module checklist" at
the end. They are enough to get started.

## Principles

1. **Plain words, quiet chrome.** Write labels the way a lawyer or paralegal would say them ("Next key date",
   "Responsible attorney"). Use no jargon and no emoji. Use icons only to help scanning, never instead of words.
2. **Colour means something.** Colour is spent on status, not on decoration. Red means late or
   destructive. Amber means today or needs attention. Green means done. Blue means information or a link. Navy is the brand and
   marks primary actions. Gold appears only in the brand mark and as the active-nav accent.
3. **One way to do each thing.** Use one table component, one card, one button, one empty state and one pill.
   If something you need is missing, add it to the kit rather than styling it locally.
4. **Dense but readable.** The base text size is 14px, with 13px for secondary text and tabular figures in numeric columns.
5. **Works on a phone.** Every screen is tested at 390px wide, and the page must never scroll sideways. Tables
   turn into cards on narrow screens.
6. **Accessible by default.** Every control is a real button, link or input. Focus rings are visible. Icons are
   `aria-hidden` unless they carry a `label`. Text contrast meets WCAG AA, and motion is reduced when the
   user asks for it.

## Brand

| Asset | File |
|---|---|
| Mark (light backgrounds) | `public/brand/lawdesk-mark.svg` |
| Mark (navy sidebar) | `public/brand/lawdesk-mark-on-dark.svg` |
| Logo (mark and wordmark) | `public/brand/lawdesk-logo.svg`, `lawdesk-logo-on-dark.svg` |
| Favicon | `public/favicon.svg` |

The mark is a navy rounded square holding a white "L", which reads as the corner of a desk or a page.
Next to it sits a small brass square, which reads as a seal or tab. The wordmark is Inter Semibold. Never
recolour the mark, and never put the light mark on navy.

**Typeface:** Inter (variable, weights 100–900) is self-hosted from `public/fonts/` under the SIL Open Font
License 1.1 (`public/fonts/LICENSE-Inter-OFL.txt`). Nothing loads from a CDN, because the CSP allows only
`'self'`.

**Icons:** Lucide (ISC license, `public/js/ui/LICENSE-lucide.txt`). Only the icons used are bundled, as
data in `public/js/ui/icons.js`, so no network or sprite files are needed.

## Tokens (`public/app.css`, `:root`)

Always use a token. Never write a hex value in module CSS.

| Group | Tokens | Notes |
|---|---|---|
| Brand navy | `--brand-50` … `--brand-950` | `--brand-800` is the primary colour |
| Warm grays | `--gray-0` … `--gray-900` | A slightly warm paper tone, not blue-grey |
| Accent (brass) | `--accent-300/500/600/700` | Brand only, used sparingly |
| Semantic | `--success`, `--warning`, `--danger`, `--info`, each with `-bg` and `-border` | Status colours |
| Surfaces | `--bg` (page), `--surface` (cards), `--surface-2`, `--surface-3`, `--surface-hover` | |
| Lines | `--border`, `--border-strong`, `--border-input` | |
| Text | `--text`, `--text-2`, `--muted`, `--faint`, `--link` | `--faint` is for placeholders and dashes only |
| Focus | `--focus`, `--focus-ring` | Use `box-shadow: var(--focus-ring)` |
| Type | `--font`, `--mono`, `--fs-xs` 12 · `--fs-sm` 13 · `--fs-md` 14 · `--fs-lg` 16 · `--fs-xl` 18 · `--fs-2xl` 22 · `--fs-3xl` 28 | |
| Space | `--sp-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-8` 32 · `-10` 40 · `-12` 48 | A 4px grid |
| Radius | `--r-xs` 4 · `--r-sm` 6 · `--r-md` 8 (controls) · `--r-lg` 12 (cards) · `--r-full` | |
| Shadow | `--shadow-xs`, `-sm`, `-md`, `-lg` | Cards use xs and sm; popovers and modals use lg |
| Layers | `--z-sticky`, `--z-topbar`, `--z-sidebar`, `--z-dropdown`, `--z-drawer`, `--z-modal`, `--z-toast` | |
| Shell | `--side-w`, `--side-w-collapsed`, `--top-h` | |

Older names (`--accent`, `--late`, `--today`, `--good`, `--wait` and their `-soft` versions) still work and
point at the new tokens.

### Status colour meaning

| Tone | Use for | Kit |
|---|---|---|
| `danger` (red) | Overdue, failed, destructive action | `pill(x, "danger")`, `.badge.late`, `.late-text`, `button(…, {variant: "danger"})` |
| `warning` (amber) | Due today, pending, needs review | `pill(x, "warning")`, `.today-text` |
| `success` (green) | Done, paid, signed, cleared | `pill(x, "success")` |
| `info` (blue) | Open, in progress, sent, waiting on someone | `pill(x, "info")` |
| `neutral` (grey) | Draft, closed, archived | `pill(x, "neutral")` |
| `brand` (navy) | Current stage, selected | `pill(x, "brand")`, `.stage-pill` |

Use `statusPill(status)` to colour a status string through the shared `STATUS_TONES` map, so "overdue"
looks the same in billing as it does in tasks. Add new statuses to that map rather than choosing colours
locally.

## App shell (`public/js/ui/shell.js`, registered in `public/js/app.js`)

- **Sidebar:** the firm name (from `billing_settings.firm_name`), grouped sections and a collapse
  control (remembered per browser). Below 900px it becomes a drawer opened from the menu button.
- **Top bar:** global search (Ctrl/Cmd+K opens the palette, which finds matters, contacts, tasks and pages). Next to it are
  the "New" menu, notifications (overdue tasks, tasks due today and today's calendar events) and the user menu (profile, "Working as"
  switcher, My account and Sign out).
- **Demo banner:** shown while the database holds seed data (any contact whose notes say "Fictional
  demo data"). It can be dismissed.

### Adding a page to the navigation

`NAV` and `ROUTES` in `public/js/app.js` are still the only registration point:

```js
// NAV entry: label, href, keyboard shortcut key, plus the optional icon and section
{ label: "Billing", href: "#/billing", key: "b", icon: "billing", section: "Finance" },

// ROUTES entry
[/^#\/billing$/, billingView],
```

- `section` is one of `Work`, `Practice`, `Finance` or `Admin`. Items are ordered by a canonical list in
  `shell.js` (`ORDER`), so parallel modules don't fight over array position.
- `icon` is any icon name or alias (see below). Unknown or missing icons fall back to a neutral dot.
- The Account and Sign-out items are placeholders. The sign-in module calls
  `setAccountActions({ account, signOut })` from `ui/shell.js` to turn them on.

## Kit reference

Import from `public/js/ui/components.js` unless noted otherwise.

### Layout

- `pageHeader({ title, subtitle, breadcrumbs, actions, meta, eyebrow })`: the top of every page. Put
  primary actions on the right, with at most one primary button.
- `breadcrumbs([{ label, href }, …, { label }])`.
- `card({ title, subtitle, icon, actions, body, footer, flush, id, headingLevel })`: the standard white
  panel. Use `flush: true` when the body is a table or list that should run edge to edge.
- `sectionTitle(text, aside)`: a heading between groups of cards.
- `field(label, control, { hint, required, optional })`: a labelled form control. Put `div.form-row` around
  fields to place them side by side.
- `useStyles("billing")`: loads `public/css/billing.css` once. Module CSS goes there, not in
  `app.css`.

### Actions

- `button(label, { variant: "primary" | "secondary" | "ghost" | "danger", size: "sm" | "md" | "lg", icon, iconRight, href, onclick, loading })`.
- `iconButton(icon, label, opts)`: an icon-only button. The label becomes `aria-label` and a tooltip.
- `withLoading(btn, async () => …)`: disables the button and shows a spinner while the work runs.
- `menu(anchor, items, label)` from `ui/popover.js`: a dropdown menu. Each item looks like
  `{ label, icon, onSelect, href, danger, disabled, hint }`, or is `"-"` for a divider or `{ heading }` for a heading. Arrow keys work.
- `popover(anchor, content, label, { align })` from `ui/popover.js`: an anchored panel, used for inline editors.
- `modal(title, body, { wide, drawer, subtitle })` from `dom.js` opens a dialog. `toast(text, { action: { label, run }, error, ms })`
  from `dom.js` shows a confirmation (with an Undo action where possible).

### Data display

- `dataTable(opts)` from `ui/table.js` is **the** table. It provides search, filters, sortable columns,
  grouping, a sticky header, keyboard rows (j/k, Enter), "Show more" paging, an empty state and phone cards. The main
  options:
  - `columns`: an array of `{ key, label, render(row), sort(row), align: "right", className, primary, hideOnPhone, phoneLabel, sortable, defaultDir }`.
    Use `className: "nowrap"` for dates and names.
  - `rows`, `rowKey`, `rowHref(row)` or `onRowClick`, `rowClass`, `rowAttrs`.
  - `search: { placeholder, text: (row) => [strings] }`, `filters: [nodes]`, `toolbarEnd: [nodes]`.
  - `groupBy(row) => label`, `groupOrder` (an array or a compare function), `groupTone(label)`.
  - `sort: { key, dir }`, and `prefsKey` to remember the user's sort.
  - `noun: ["matter", "matters"]`, `empty` (node or function), `pageSize` (default 50).
  - It returns an element with `.setRows(rows)`, `.setQuery(text)` and `.redraw()`.
  Wrap it in `card({ flush: true, body: table })`, or in `div.card.flush.table-card`.
  Inside a cell, use `div.cell-stack` with `a.cell-title` and `span.cell-sub` for a two-line primary cell.
- `stat({ label, value, tone, icon, hint, href })`: a summary number. Put up to four in a `div.stats` row.
- `pill(text, tone)` and `statusPill(status)` show status. `span.badge` shows counts, and `span.matter-num` shows a matter number.
- `avatar(name, { size: "xs" | "sm" | "md" | "lg" })` and `person(name, sub)`: initials with a stable colour per
  person.
- `kv([[label, value], …])`: a definition list for details.
- `progressBar(done, total)`, `callout({ tone, title, body, action })` and `tabs(items, current, onChange)`
  (ARIA tabs with arrow keys). `segmented(options, value, onChange)` is for two to four mutually exclusive filters.
- `activityText(detail)` makes an activity-log line readable: it turns dates into "Mon Nov 23" and removes
  internal ids.

### States

- `emptyState({ icon, title, body, action, compact })`: every list needs one. Say what will appear here
  and how to make it appear.
- `loadingBlock(label)`, `skeleton(kind, n)`, `spinner(label)`.
- On errors, show `callout({ tone: "danger", … })` with what failed and how to retry. Never leave a blank page.

### Icons (`public/js/ui/icons.js`)

`icon(name, { size = 16, label, strokeWidth, class })`. Pass `label` only when the icon is the only
content, as in an icon button. Otherwise it is decorative and hidden from screen readers. The aliases are
`home`, `tasks`, `my-tasks`, `firm-tasks`, `matters`, `contacts`, `documents`, `intake`, `leads`, `billing`,
`trust`, `reports`, `email`, `payments`, `signatures`, `import`, `checklists`, `automations`, `people`,
`court`, `law`, `more`, `close`, `warning`, `error`, `success` and `spinner`. Any bundled Lucide name also works. To bundle
another icon, copy its entry from lucide-static's `icon-nodes.json` (`npm pack lucide-static`) into
`ICONS`. The format is the same `[tag, attrs]` list.

### Matter page extension points (`public/js/ui/matter-slots.js`)

A matter is the case file, so modules add to it without editing `views/matter.js`:

```js
import { registerMatterTab, registerMatterCard } from "../ui/matter-slots.js";

registerMatterTab({ id: "notes", label: "Notes", icon: "file-text", order: 60,
  count: (ctx) => null, render: async (ctx) => node });

registerMatterCard({ id: "billing", order: 20,
  render: async (ctx) => card({ title: "Billing", icon: "billing", body: … }) }); // return null to hide
```

`ctx` is `{ matterId, matter, data, refresh, openTab }`. Tabs get their own URL
(`#/matters/12/notes`). Cards appear on the Overview tab below the built-in ones. Keep them
short (3–6 rows) and end them with a "View all" link to your tab.

The tabs today: Overview, Tasks, Calendar (`calendar`), Documents (`files`), Billing (`billing`),
Communications (`communications`) and Activity. The module tabs are registered in
`views/matter-tabs.js` and show each module's own matter card. Don't use `documents` as a tab id:
`#/matters/12/documents` is the full documents page. Overview is a summary (`views/matter-summary.js`):
its rows are links, never `taskRow`s, so `.task` only matches the Tasks tab. The right rail holds
People, "Who can see this matter" (`views/matter-access.js`), Parties, Key dates and Checklists;
the conflict check card sits on Overview. Matter page styles are in `public/css/matter.css`.

## Building a new screen

```js
import { h } from "../dom.js";
import { get } from "../api.js";
import { pageHeader, card, button, emptyState, useStyles } from "../ui/components.js";
import { dataTable } from "../ui/table.js";

export async function invoicesView(main) {
  useStyles("billing");
  const rows = await get("/billing/invoices");
  const page = h("div.page");
  page.append(
    pageHeader({
      title: "Invoices",
      subtitle: "Bills sent to clients and what is still owed",
      actions: [button("New invoice", { variant: "primary", icon: "plus", onclick: openNew })],
    }),
    card({
      flush: true,
      body: dataTable({
        columns: [ … ],
        rows,
        rowHref: (r) => `#/billing/invoices/${r.id}`,
        search: { placeholder: "Search invoices", text: (r) => [r.number, r.client_name] },
        noun: ["invoice", "invoices"],
        empty: emptyState({ icon: "billing", title: "No invoices yet", body: "Invoices you create from a matter's time entries appear here." }),
      }),
    }),
  );
  main.replaceChildren(page);
}
```

Layout helpers: `div.page` (max width and padding), `div.page.wide` (full width), `div.stats` (stat row),
`div.grid-2` and `div.grid-3` (card grids that collapse on phones), and `div.form-row` (inline fields).

## Module checklist

Before you open a PR for a module screen:

- [ ] The page starts with `pageHeader`, has at most one primary button, and actions sit on the right.
- [ ] Lists use `dataTable` (or `taskRow` for tasks) inside a flush card, with an `emptyState`.
- [ ] Status colours go through `pill` or `statusPill`, with no hand-picked colours.
- [ ] Module CSS lives in `public/css/<module>.css`, loaded with `useStyles`, and uses tokens only. Class
      names are prefixed with the module name (`.billing-…`).
- [ ] NAV has an `icon` and `section`. Matter additions use `registerMatterTab` or `registerMatterCard`.
- [ ] Every input has a label (`field()` or `aria-label`), and every icon-only button has a label.
- [ ] Checked at 1440px and 390px: nothing scrolls sideways. `npm run test:browser` fails the run if the page does.
- [ ] Dates use `fmtDate` and `relDate` from `dom.js`. Money is integer cents, formatted for display only.

## Dev helper

`tests/browser/look.ts` seeds a throwaway database, opens one URL at a given width and saves a screenshot. It also
prints HTTP errors, console errors and any element that makes the page scroll sideways:

```
NODE_PATH=$(npm root -g) node tests/browser/look.ts "#/matters" 390 out.png [scale] [palette|bell|user|drawer|newmatter]
```
