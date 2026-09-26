(function (root) {
  'use strict';

  // rows: [{weight, score}] in percent. Rows without both a positive weight and a score are skipped.
  function weighted(rows) {
    var sum = 0, wsum = 0, entered = 0;
    rows.forEach(function (r) {
      var w = Number(r.weight), s = Number(r.score);
      if (w > 0 && r.weight !== null && r.weight !== '') entered += w;
      if (!(w > 0) || r.score === null || r.score === '' || !isFinite(s)) return;
      sum += s * w;
      wsum += w;
    });
    return { grade: wsum > 0 ? sum / wsum : NaN, gradedWeight: wsum, totalWeight: entered };
  }

  var api = { weighted: weighted };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  var TK = root.TK;
  var rowsEl = TK.$('#wg-rows');
  var DEFAULTS = [
    { name: 'Homework', weight: 20 }, { name: 'Quizzes', weight: 15 },
    { name: 'Midterm', weight: 25 }, { name: 'Final exam', weight: 40 }
  ];

  function numInput(label, value) {
    var i = TK.el('input', { type: 'number', 'aria-label': label, min: '0', step: '0.1', inputmode: 'decimal' });
    i.value = value === undefined || value === null ? '' : value;
    return i;
  }

  function addRow(d) {
    d = d || {};
    var name = TK.el('input', { type: 'text', 'aria-label': 'Category name', placeholder: 'Category' });
    name.value = d.name || '';
    var del = TK.el('button', { type: 'button', 'class': 'icon-btn', 'aria-label': 'Remove category', text: '×' });
    var tr = TK.el('tr', {}, [
      TK.el('td', {}, [name]), TK.el('td', {}, [numInput('Weight', d.weight)]),
      TK.el('td', {}, [numInput('Score', d.score)]), TK.el('td', {}, [del])
    ]);
    del.addEventListener('click', function () { tr.remove(); update(); });
    rowsEl.appendChild(tr);
  }

  function read() {
    return TK.$$('tr', rowsEl).map(function (tr) {
      var i = TK.$$('input', tr);
      return { name: i[0].value, weight: i[1].value === '' ? null : TK.num(i[1].value), score: i[2].value === '' ? null : TK.num(i[2].value) };
    });
  }

  function update() {
    var rows = read();
    var r = weighted(rows);
    TK.$('#wg-grade').textContent = isFinite(r.grade) ? TK.fmt(r.grade, 2) + '%' : '—';
    TK.$('#wg-letter').textContent = isFinite(r.grade) ? TK.letterFromPercent(r.grade) : '—';
    TK.$('#wg-weight').textContent = TK.fmt(r.totalWeight, 1) + '%';
    var note = '';
    if (r.totalWeight > 100.001) note = 'Your weights add up to more than 100% — check the syllabus.';
    else if (isFinite(r.grade) && r.gradedWeight < 99.999) note = 'This is your grade so far, based on ' + TK.fmt(r.gradedWeight, 1) + '% of the course.';
    TK.$('#wg-note').textContent = note;
    TK.save('wg', rows);
  }

  function init(saved) {
    rowsEl.innerHTML = '';
    (saved && saved.length ? saved : DEFAULTS).forEach(addRow);
    update();
  }

  TK.$('#wg-tool').addEventListener('input', update);
  TK.$('#wg-add').addEventListener('click', function () { addRow(); update(); });
  TK.$('#wg-reset').addEventListener('click', function () { init(null); });
  init(TK.load('wg', null));
})(this);
