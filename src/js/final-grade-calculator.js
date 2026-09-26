(function (root) {
  'use strict';

  // All values in percent. Returns the final-exam percentage needed, or NaN if inputs are invalid.
  function needed(current, weight, target) {
    var w = weight / 100;
    if (!isFinite(current) || !isFinite(target) || !(w > 0) || w > 1) return NaN;
    return (target - current * (1 - w)) / w;
  }

  var LETTERS = [['A', 90], ['B', 80], ['C', 70], ['D', 60]];

  var api = { needed: needed, LETTERS: LETTERS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  var TK = root.TK;
  var cur = TK.$('#fg-current'), wt = TK.$('#fg-weight'), tgt = TK.$('#fg-target');

  function describe(n) {
    if (!isFinite(n)) return { text: '—', cls: '' };
    if (n > 100) return { text: TK.fmt(n, 1) + '%', cls: 'bad' };
    if (n <= 0) return { text: '0% (already locked in)', cls: 'good' };
    return { text: TK.fmt(n, 1) + '%', cls: n > 90 ? 'warn' : 'good' };
  }

  function update() {
    var c = TK.num(cur.value), w = TK.num(wt.value), t = TK.num(tgt.value);
    var n = needed(c, w, t);
    var d = describe(n);
    var out = TK.$('#fg-needed');
    out.textContent = d.text;
    out.className = 'result-big ' + d.cls;
    var note = '';
    if (isFinite(n) && n > 100) note = 'Above 100% — not reachable on the final alone unless there is extra credit.';
    else if (isFinite(w) && (w <= 0 || w > 100)) note = 'The final weight must be between 0 and 100%.';
    TK.$('#fg-note').textContent = note;

    var body = TK.$('#fg-table');
    body.innerHTML = '';
    LETTERS.forEach(function (pair) {
      var d2 = describe(needed(c, w, pair[1]));
      var td = TK.el('td', { text: d2.text });
      td.className = d2.cls;
      body.appendChild(TK.el('tr', {}, [TK.el('td', { text: pair[0] + ' (' + pair[1] + '%)' }), td]));
    });
    TK.save('fg', { c: cur.value, w: wt.value, t: tgt.value });
  }

  var saved = TK.load('fg', null);
  if (saved) { cur.value = saved.c || ''; wt.value = saved.w || ''; tgt.value = saved.t || ''; }
  TK.$('#fg-tool').addEventListener('input', update);
  update();
})(this);
