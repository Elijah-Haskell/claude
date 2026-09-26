(function (root) {
  'use strict';

  function percentOf(p, y) { return p / 100 * y; }
  function whatPercent(x, y) { return y === 0 ? NaN : x / y * 100; }
  function change(from, to) { return from === 0 ? NaN : (to - from) / Math.abs(from) * 100; }

  var api = { percentOf: percentOf, whatPercent: whatPercent, change: change };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  var TK = root.TK;
  function v(id) { return TK.num(TK.$(id).value); }
  function show(id, n, suffix) { TK.$(id).textContent = isFinite(n) ? TK.fmt(n, 4) + (suffix || '') : '—'; }

  function update() {
    show('#pc-a-out', percentOf(v('#pc-a-p'), v('#pc-a-y')));
    show('#pc-b-out', whatPercent(v('#pc-b-x'), v('#pc-b-y')), '%');
    var c = change(v('#pc-c-from'), v('#pc-c-to'));
    var out = TK.$('#pc-c-out');
    if (!isFinite(c)) out.textContent = '—';
    else out.textContent = (c > 0 ? '+' : '') + TK.fmt(c, 4) + '% ' + (c > 0 ? '(increase)' : c < 0 ? '(decrease)' : '(no change)');
  }

  TK.$('#pc-tool').addEventListener('input', update);
  update();
})(this);
