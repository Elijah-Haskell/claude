// Small inline-SVG charts, drawn from data with DOM calls (text goes in via textContent,
// never markup). Each chart is redrawn at its container's real width so labels stay a
// readable size on a phone. Colours come from CSS classes in css/reports.css.

import { h } from "./dom.js";

const NS = "http://www.w3.org/2000/svg";

function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

/** Wraps a draw(width) function; redraws when the box changes width. */
function responsive(className, label, draw) {
  const box = h("div.chart." + className);
  let last = 0;
  const paint = () => {
    const w = Math.floor(box.clientWidth || 0);
    if (!w || w === last) return;
    last = w;
    const svg = draw(w);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    box.replaceChildren(svg);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(paint).observe(box);
  requestAnimationFrame(paint);
  return box;
}

/** Round a maximum up to a "nice" axis top and pick tick steps (1, 2, 2.5, 5 x 10^n). */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks };
}

function fitText(text, px, size = 12) {
  const max = Math.max(3, Math.floor(px / (size * 0.56)));
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/**
 * Vertical bars, one per item: [{ label, value, title, sub }].
 * `format` labels the axis; `highlightLast` darkens the final bar (e.g. the current month).
 */
export function columnChart({ items, format, label, highlightLast = false }) {
  return responsive("column-chart", label, (W) => {
    const H = 210;
    const left = 52;
    const right = 8;
    const top = 12;
    const bottom = items.some((i) => i.sub) ? 38 : 24;
    const plotW = W - left - right;
    const plotH = H - top - bottom;
    const { top: yTop, ticks } = niceTicks(Math.max(0, ...items.map((i) => i.value)));
    const y = (v) => top + plotH - (v / yTop) * plotH;
    const band = plotW / items.length;
    const barW = Math.max(4, Math.min(34, band * 0.62));
    const every = band < 26 ? 3 : band < 34 ? 2 : 1;
    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart-svg" });
    for (const t of ticks) {
      svg.append(s("line", { x1: left, x2: W - right, y1: y(t), y2: y(t), class: t === 0 ? "axis" : "grid" }));
      svg.append(s("text", { x: left - 6, y: y(t) + 4, "text-anchor": "end", class: "tick" }, format(t)));
    }
    items.forEach((it, i) => {
      const x = left + band * i + (band - barW) / 2;
      const hgt = Math.max(0, y(0) - y(it.value));
      const cls = highlightLast && i === items.length - 1 ? "bar bar-strong" : "bar";
      const g = s("g", { class: "bar-g" }, s("title", {}, it.title ?? `${it.label}: ${format(it.value)}`));
      g.append(s("rect", { x, y: y(it.value), width: barW, height: hgt, class: cls, rx: 1 }));
      svg.append(g);
      const showLabel = (items.length - 1 - i) % every === 0;
      if (showLabel) svg.append(s("text", { x: x + barW / 2, y: H - bottom + 16, "text-anchor": "middle", class: "tick" }, it.label));
      if (showLabel && it.sub) svg.append(s("text", { x: x + barW / 2, y: H - bottom + 30, "text-anchor": "middle", class: "tick sub" }, it.sub));
    });
    return svg;
  });
}

/**
 * Horizontal bars, one row per item, with one bar per series in each row:
 * rows [{ label, values: [number...], href?, tone? }], series [{ label, cls }].
 * The value is written at the end of each bar.
 */
export function barList({ rows, series, format, label }) {
  const max = Math.max(0, ...rows.flatMap((r) => r.values));
  return responsive("bar-list", label, (W) => {
    const barH = series.length > 1 ? 12 : 16;
    const gap = series.length > 1 ? 3 : 0;
    const rowH = series.length * barH + (series.length - 1) * gap + 14;
    const labelW = Math.min(170, Math.max(100, Math.floor(W * 0.34)));
    const valueW = format(max).length * 7 + 14;
    const plotW = Math.max(30, W - labelW - valueW - 8);
    const H = rows.length * rowH + 4;
    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart-svg" });
    rows.forEach((r, i) => {
      const y0 = i * rowH + 7;
      const mid = y0 + (series.length * barH + (series.length - 1) * gap) / 2;
      const name = s("text", { x: labelW - 8, y: mid + 4, "text-anchor": "end", class: "row-label" }, fitText(r.label, labelW - 10));
      const title = s("title", {}, `${r.label}: ${r.values.map((v, k) => `${series[k].label} ${format(v)}`).join(", ")}`);
      const g = s("g", { class: "bar-g" }, title, name);
      r.values.forEach((v, k) => {
        const by = y0 + k * (barH + gap);
        const w = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * plotW) : 0;
        g.append(s("rect", { x: labelW, y: by, width: plotW, height: barH, class: "track" }));
        g.append(s("rect", { x: labelW, y: by, width: w, height: barH, class: `bar ${r.tone && k === 0 ? "bar-" + r.tone : series[k].cls || ""}`, rx: 1 }));
        g.append(s("text", { x: labelW + w + 6, y: by + barH - 2, class: "val" }, format(v)));
      });
      if (r.href) {
        const a = s("a", { href: r.href, class: "bar-link" });
        a.append(g);
        svg.append(a);
      } else svg.append(g);
    });
    return svg;
  });
}

/** Legend for a multi-series chart. */
export function legend(series) {
  return h("ul.legend", series.map((x) => h("li", h("span.swatch." + x.cls, { "aria-hidden": "true" }), x.label)));
}
