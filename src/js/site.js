// Shared helpers for every tool page.
(function (root) {
  'use strict';

  var TK = {
    num: function (v) {
      if (v === null || v === undefined) return NaN;
      var s = String(v).trim().replace(/,/g, '');
      if (s === '') return NaN;
      return Number(s);
    },
    round: function (n, dp) {
      var f = Math.pow(10, dp === undefined ? 2 : dp);
      return Math.round((n + Number.EPSILON) * f) / f;
    },
    fmt: function (n, dp) {
      if (!isFinite(n)) return '—';
      return TK.round(n, dp === undefined ? 2 : dp).toLocaleString(undefined, {
        maximumFractionDigits: dp === undefined ? 2 : dp
      });
    },
    load: function (key, fallback) {
      try {
        var raw = root.localStorage.getItem('stk:' + key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    save: function (key, value) {
      try { root.localStorage.setItem('stk:' + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
    },
    $: function (sel, ctx) { return (ctx || document).querySelector(sel); },
    $$: function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); },
    el: function (tag, attrs, children) {
      var node = document.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
      (children || []).forEach(function (c) { node.appendChild(c); });
      return node;
    },
    letterFromPercent: function (p) {
      if (!isFinite(p)) return '';
      if (p >= 93) return 'A';
      if (p >= 90) return 'A-';
      if (p >= 87) return 'B+';
      if (p >= 83) return 'B';
      if (p >= 80) return 'B-';
      if (p >= 77) return 'C+';
      if (p >= 73) return 'C';
      if (p >= 70) return 'C-';
      if (p >= 67) return 'D+';
      if (p >= 63) return 'D';
      if (p >= 60) return 'D-';
      return 'F';
    }
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = TK; return; }
  root.TK = TK;
})(this);
