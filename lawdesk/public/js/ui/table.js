// dataTable: the one table component. Toolbar (search, filters, count), sticky header,
// sortable columns, optional grouping, keyboard row navigation, "Show more" paging, and
// a card layout on phones (each cell shows its column label).
//
//   const table = dataTable({
//     columns: [
//       { key: "name", label: "Matter", render: (m) => h("a", { href: … }, m.name), sort: (m) => m.name },
//       { key: "open", label: "Open tasks", align: "right", sort: (m) => m.open_tasks },
//     ],
//     rows,                                  // array of plain objects
//     rowHref: (m) => `#/matters/${m.id}`,   // click / Enter opens it
//     search: { placeholder: "Search matters", text: (m) => [m.name, m.client_name] },
//     filters: [segmentedControl],           // any nodes, shown in the toolbar
//     noun: ["matter", "matters"],
//     sort: { key: "name", dir: "asc" },
//   });
//   page.append(table);          // it's an element
//   table.setRows(newRows);      // redraw with new data, keeping search, sort and paging

import { h } from "../dom.js";
import { icon } from "./icons.js";
import { emptyState } from "./components.js";
import { prefs } from "../state.js";

const INTERACTIVE = "a, button, input, select, textarea, label, summary, [role=button], [contenteditable]";

export function dataTable(opts) {
  const {
    columns,
    rowKey = (r) => r.id,
    rowClass = null,
    rowAttrs = null,
    rowHref = null,
    onRowClick = null,
    search = null,
    filters = [],
    toolbarEnd = [],
    groupBy = null,
    groupOrder = null,
    groupTone = null,
    pageSize = 50,
    empty = null,
    tableClass = "",
    label = "Table",
    noun = ["row", "rows"],
    prefsKey = null,
    toolbar = true,
    countText = null,
  } = opts;

  let rows = opts.rows || [];
  let q = "";
  let shown = pageSize;
  const saved = prefsKey ? safeJSON(prefs.get(prefsKey + ".sort")) : null;
  let sort = saved || opts.sort || null;

  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table.data-table" + (tableClass ? "." + tableClass.split(" ").join(".") : ""), { "aria-label": label }, thead, tbody);
  const count = h("span.dt-count", { "aria-live": "polite" });
  const more = h("div.dt-footer");
  const emptyBox = h("div.dt-empty");

  const searchInput = search
    ? h("input.search.dt-search-input", {
        type: "search",
        placeholder: search.placeholder || "Search",
        "aria-label": search.placeholder || "Search",
        "data-search": "",
        value: search.initial || "",
        oninput: (e) => {
          q = e.target.value;
          shown = pageSize;
          draw();
        },
      })
    : null;
  if (search?.initial) q = search.initial;

  const bar = toolbar
    ? h(
        "div.dt-toolbar",
        searchInput ? h("div.dt-search", icon("search", { size: 16, class: "dt-search-icon" }), searchInput) : null,
        filters.length ? h("div.dt-filters", filters) : null,
        h("div.dt-toolbar-end", count, toolbarEnd),
      )
    : null;

  function drawHead() {
    thead.replaceChildren(
      h(
        "tr",
        columns.map((c) => {
          const sortable = c.sortable !== false && (c.sort || c.key) && opts.sortable !== false;
          const active = sort && sort.key === c.key;
          const th = h("th", {
            scope: "col",
            class: [c.align === "right" ? "num-cell" : "", c.className || "", c.hideOnPhone ? "hide-phone" : ""].join(" "),
            style: c.width ? { width: c.width } : null,
            "aria-sort": active ? (sort.dir === "asc" ? "ascending" : "descending") : sortable ? "none" : null,
          });
          if (!sortable || !c.label) {
            th.append(c.label ? h("span.th-text", c.label) : h("span.visually-hidden", c.srLabel || ""));
            return th;
          }
          th.append(
            h(
              "button.th-sort" + (active ? ".active" : ""),
              {
                type: "button",
                onclick: () => {
                  sort = active ? { key: c.key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: c.defaultDir || "asc" };
                  if (prefsKey) prefs.set(prefsKey + ".sort", JSON.stringify(sort));
                  drawHead();
                  draw();
                },
              },
              h("span", c.label),
              icon(active ? (sort.dir === "asc" ? "arrow-up" : "arrow-down") : "arrow-up-down", { size: 13, class: "sort-ind" }),
            ),
          );
          return th;
        }),
      ),
    );
  }

  function valueFor(c, r) {
    if (c.sort) return c.sort(r);
    return r[c.key];
  }

  function filtered() {
    const needle = q.trim().toLowerCase();
    let list = rows;
    if (needle && search) {
      const words = needle.split(/\s+/);
      list = list.filter((r) => {
        const hay = (search.text ? search.text(r) : Object.values(r)).filter((x) => x != null).join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    if (sort) {
      const c = columns.find((x) => x.key === sort.key);
      if (c) {
        const dir = sort.dir === "desc" ? -1 : 1;
        list = list
          .map((r, i) => [r, valueFor(c, r), i])
          .sort((a, b) => {
            const x = a[1];
            const y = b[1];
            // Blanks always sort last.
            if (x == null || x === "") return y == null || y === "" ? a[2] - b[2] : 1;
            if (y == null || y === "") return -1;
            const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
            return cmp * dir || a[2] - b[2];
          })
          .map(([r]) => r);
      }
    }
    return list;
  }

  function rowEl(r) {
    const href = rowHref ? rowHref(r) : null;
    const extra = rowAttrs ? rowAttrs(r) : {};
    const tr = h(
      "tr.dt-row",
      {
        tabindex: href || onRowClick ? "0" : null,
        dataset: { key: String(rowKey(r)) },
        ...extra,
        class: [rowClass ? rowClass(r) : "", href || onRowClick ? "clickable" : "", extra.class || ""].join(" "),
      },
      columns.map((c) =>
        h(
          "td",
          {
            class: [c.align === "right" ? "num-cell" : "", c.className || "", c.primary ? "dt-primary" : "", c.hideOnPhone ? "hide-phone" : ""].join(" "),
            "data-label": c.phoneLabel ?? c.label ?? "",
          },
          c.render ? c.render(r) : r[c.key] == null || r[c.key] === "" ? h("span.muted", "—") : String(r[c.key]),
        ),
      ),
    );
    if (href || onRowClick) {
      tr.addEventListener("click", (e) => {
        if (e.target.closest(INTERACTIVE)) return;
        if (onRowClick) onRowClick(r, e);
        else location.hash = href;
      });
    }
    tr.addEventListener("keydown", (e) => {
      if (e.target !== tr) return;
      if (e.key === "Enter" && (href || onRowClick)) (onRowClick ? onRowClick(r, e) : (location.hash = href));
      const go = (el) => {
        while (el && !el.classList?.contains("dt-row")) el = el[e.key === "j" || e.key === "ArrowDown" ? "nextElementSibling" : "previousElementSibling"];
        if (el) (e.preventDefault(), el.focus());
      };
      if (e.key === "j" || e.key === "ArrowDown") go(tr.nextElementSibling);
      if (e.key === "k" || e.key === "ArrowUp") go(tr.previousElementSibling);
    });
    return tr;
  }

  function draw() {
    const list = filtered();
    const page = list.slice(0, shown);
    const total = rows.length;
    const [one, many] = noun;
    count.textContent = countText
      ? countText(list.length, total)
      : list.length === total
        ? `${total} ${total === 1 ? one : many}`
        : `${list.length} of ${total} ${total === 1 ? one : many}`;

    if (groupBy) {
      const groups = new Map();
      for (const r of page) {
        const g = groupBy(r);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(r);
      }
      let keys = [...groups.keys()];
      if (Array.isArray(groupOrder)) keys = groupOrder.filter((k) => groups.has(k)).concat(keys.filter((k) => !groupOrder.includes(k)));
      else if (typeof groupOrder === "function") keys.sort(groupOrder);
      const counts = new Map();
      for (const r of list) counts.set(groupBy(r), (counts.get(groupBy(r)) || 0) + 1);
      tbody.replaceChildren(
        ...keys.flatMap((k) => [
          h(
            "tr.group-row" + (groupTone && groupTone(k) ? ".tone-" + groupTone(k) : ""),
            h("th", { colspan: String(columns.length), scope: "colgroup" }, h("span.group-label", k), h("span.count", String(counts.get(k)))),
          ),
          ...groups.get(k).map(rowEl),
        ]),
      );
    } else tbody.replaceChildren(...page.map(rowEl));

    const isEmpty = list.length === 0;
    table.hidden = isEmpty;
    emptyBox.replaceChildren(
      isEmpty
        ? typeof empty === "function"
          ? empty({ searching: !!q.trim(), total })
          : q.trim() && total
            ? emptyState({ icon: "search", title: "No matches", body: `Nothing matches “${q.trim()}”. Try a different word.`, compact: true })
            : empty || emptyState({ icon: "inbox", title: `No ${many} yet`, compact: true })
        : "",
    );
    more.replaceChildren(
      list.length > shown
        ? h(
            "button.btn.small.ghost",
            {
              type: "button",
              onclick: () => {
                shown += pageSize;
                draw();
              },
            },
            `Show ${Math.min(pageSize, list.length - shown)} more`,
            h("span.muted", ` · ${shown} of ${list.length} shown`),
          )
        : "",
    );
    more.hidden = list.length <= shown;
  }

  const root = h("div.dt" + (opts.className ? "." + opts.className : ""), bar, h("div.dt-scroll", table), emptyBox, more);
  root.setRows = (next) => {
    rows = next || [];
    draw();
  };
  root.setQuery = (text) => {
    q = text || "";
    if (searchInput) searchInput.value = q;
    draw();
  };
  root.redraw = draw;
  root.searchInput = searchInput;
  drawHead();
  draw();
  return root;
}

function safeJSON(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
