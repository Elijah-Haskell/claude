(function (root) {
  'use strict';

  var SCALE = {
    'A+': 4.0, 'A': 4.0, 'A-': 3.7,
    'B+': 3.3, 'B': 3.0, 'B-': 2.7,
    'C+': 2.3, 'C': 2.0, 'C-': 1.7,
    'D+': 1.3, 'D': 1.0, 'D-': 0.7,
    'F': 0.0
  };

  // courses: [{credits: number, grade: 'A-'}]; rows missing credits or grade are ignored.
  function semester(courses) {
    var points = 0, credits = 0;
    courses.forEach(function (c) {
      var cr = Number(c.credits);
      if (!(cr > 0) || !(c.grade in SCALE)) return;
      points += SCALE[c.grade] * cr;
      credits += cr;
    });
    return { points: points, credits: credits, gpa: credits > 0 ? points / credits : NaN };
  }

  function cumulative(sem, priorGpa, priorCredits) {
    var pc = Number(priorCredits), pg = Number(priorGpa);
    if (!(pc > 0) || !isFinite(pg)) return sem.gpa;
    var total = pc + sem.credits;
    return total > 0 ? (pg * pc + sem.points) / total : NaN;
  }

  var api = { SCALE: SCALE, semester: semester, cumulative: cumulative };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  var TK = root.TK;
  var rowsEl = TK.$('#gpa-rows');
  var priorEl = TK.$('#gpa-prior');
  var priorCrEl = TK.$('#gpa-prior-credits');
  var STORE = 'gpa';

  function gradeSelect(value) {
    var sel = TK.el('select', { 'aria-label': 'Grade' });
    sel.appendChild(TK.el('option', { value: '', text: '—' }));
    Object.keys(SCALE).forEach(function (g) {
      var o = TK.el('option', { value: g, text: g.replace('-', '−') });
      if (g === value) o.selected = true;
      sel.appendChild(o);
    });
    return sel;
  }

  function addRow(data) {
    data = data || {};
    var name = TK.el('input', { type: 'text', 'aria-label': 'Course name', placeholder: 'Course' });
    name.value = data.name || '';
    var cr = TK.el('input', { type: 'number', 'aria-label': 'Credits', min: '0', step: '0.5', inputmode: 'decimal', placeholder: '3' });
    cr.value = data.credits || '';
    var del = TK.el('button', { type: 'button', 'class': 'icon-btn', 'aria-label': 'Remove course', text: '×' });
    var tr = TK.el('tr', {}, [
      TK.el('td', {}, [name]), TK.el('td', {}, [cr]), TK.el('td', {}, [gradeSelect(data.grade)]), TK.el('td', {}, [del])
    ]);
    del.addEventListener('click', function () { tr.remove(); update(); });
    rowsEl.appendChild(tr);
  }

  function read() {
    return TK.$$('tr', rowsEl).map(function (tr) {
      var inputs = TK.$$('input, select', tr);
      return { name: inputs[0].value, credits: TK.num(inputs[1].value), grade: inputs[2].value };
    });
  }

  function update() {
    var courses = read();
    var sem = semester(courses);
    var cum = cumulative(sem, TK.num(priorEl.value), TK.num(priorCrEl.value));
    TK.$('#gpa-sem').textContent = isFinite(sem.gpa) ? sem.gpa.toFixed(2) : '—';
    TK.$('#gpa-cum').textContent = isFinite(cum) ? cum.toFixed(2) : '—';
    TK.$('#gpa-credits').textContent = TK.fmt(sem.credits, 1);
    TK.save(STORE, { courses: courses, prior: priorEl.value, priorCredits: priorCrEl.value });
  }

  function init(saved) {
    rowsEl.innerHTML = '';
    var courses = saved && saved.courses && saved.courses.length ? saved.courses : [{}, {}, {}, {}];
    courses.forEach(addRow);
    priorEl.value = (saved && saved.prior) || '';
    priorCrEl.value = (saved && saved.priorCredits) || '';
    update();
  }

  TK.$('#gpa-tool').addEventListener('input', update);
  TK.$('#gpa-tool').addEventListener('change', update);
  TK.$('#gpa-add').addEventListener('click', function () { addRow(); update(); });
  TK.$('#gpa-reset').addEventListener('click', function () { init(null); });
  init(TK.load(STORE, null));
})(this);
