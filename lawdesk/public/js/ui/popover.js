// Floating panels anchored to an element: popovers (forms, pickers) and menus.
// Only one is open at a time. Esc, or a click outside, closes it and returns focus.

import { h } from "../dom.js";
import { icon } from "./icons.js";

let openPop = null;

export function closePopover() {
  if (openPop) {
    const { el, anchor } = openPop;
    openPop = null;
    el.remove();
    anchor?.setAttribute?.("aria-expanded", "false");
    if (anchor && document.contains(anchor)) anchor.focus();
  }
}

export function isPopoverOpen(anchor) {
  return !!openPop && (!anchor || openPop.anchor === anchor);
}

/**
 * Small floating panel under (or above) an element.
 * opts.align: "end" (default, right edges line up) or "start".
 */
export function popover(anchor, content, label, opts = {}) {
  closePopover();
  const el = h("div.popover" + (opts.className ? "." + opts.className : ""), { role: opts.role || "dialog", "aria-label": label }, content);
  document.body.append(el);
  place(el, anchor, opts.align || "end");
  openPop = { el, anchor };
  anchor?.setAttribute?.("aria-expanded", "true");
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePopover();
    }
  });
  if (opts.focus !== false) {
    const first = el.querySelector("input, button:not([disabled]), select, a[href], [tabindex='0']");
    if (first) first.focus();
  }
  return el;
}

function place(el, anchor, align) {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  let left = align === "start" ? r.left : r.right - w;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 6 + window.scrollY;
  if (r.bottom + el.offsetHeight + 12 > window.innerHeight && r.top > el.offsetHeight + 12) top = r.top - el.offsetHeight - 6 + window.scrollY;
  el.style.left = left + window.scrollX + "px";
  el.style.top = top + "px";
}

document.addEventListener("mousedown", (e) => {
  if (openPop && !openPop.el.contains(e.target) && !openPop.anchor?.contains?.(e.target)) {
    const p = openPop;
    openPop = null;
    p.el.remove();
    p.anchor?.setAttribute?.("aria-expanded", "false");
  }
});

/**
 * A menu of actions under a button.
 * items: [{ label, icon?, onSelect?, href?, danger?, disabled?, hint?, current? } | "-" (divider) | { heading }]
 */
export function menu(anchor, items, label = "Menu", opts = {}) {
  const list = h(
    "div.pop-list.menu-list",
    { role: "menu", "aria-label": label },
    items.filter(Boolean).map((it) => {
      if (it === "-") return h("div.menu-sep", { role: "separator" });
      if (it.heading) return h("div.menu-heading", it.heading);
      const inner = [
        it.icon ? icon(it.icon, { size: 16 }) : it.avatar || null,
        h("span.menu-label", it.label),
        it.hint ? h("span.menu-hint", it.hint) : null,
        it.current ? icon("check", { size: 16, class: "menu-check" }) : null,
      ];
      const attrs = {
        role: "menuitem",
        "aria-disabled": it.disabled ? "true" : null,
        tabindex: "-1",
        onclick: (e) => {
          if (it.disabled) return e.preventDefault();
          closePopover();
          it.onSelect?.(e);
        },
      };
      return it.href
        ? h("a.pop-item" + (it.danger ? ".danger" : "") + (it.current ? ".current" : ""), { ...attrs, href: it.href }, inner)
        : h("button.pop-item" + (it.danger ? ".danger" : "") + (it.current ? ".current" : ""), { ...attrs, type: "button", disabled: it.disabled || null }, inner);
    }),
  );
  list.addEventListener("keydown", (e) => {
    const els = [...list.querySelectorAll(".pop-item:not([disabled])")];
    const i = els.indexOf(document.activeElement);
    if (e.key === "ArrowDown") (els[i + 1] || els[0])?.focus(), e.preventDefault();
    if (e.key === "ArrowUp") (els[i - 1] || els[els.length - 1])?.focus(), e.preventDefault();
    if (e.key === "Home") els[0]?.focus(), e.preventDefault();
    if (e.key === "End") els[els.length - 1]?.focus(), e.preventDefault();
  });
  const el = popover(anchor, list, label, { ...opts, role: "presentation", focus: false });
  (list.querySelector(".pop-item.current") || list.querySelector(".pop-item:not([disabled])"))?.focus();
  return el;
}
