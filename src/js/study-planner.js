(function (root) {
  'use strict';

  var DAY = 86400000;

  // "YYYY-MM-DD" -> UTC midnight ms (so day math ignores time zones and DST).
  function parse(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }

  function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }

  // Study days run from start up to (not including) the exam day, skipping weekdays in daysOff (0 = Sunday).
  function plan(startIso, examIso, hours, daysOff) {
    var start = parse(startIso), exam = parse(examIso);
    if (!isFinite(start) || !isFinite(exam)) return null;
    var daysLeft = Math.round((exam - start) / DAY);
    var dates = [];
    for (var t = start; t < exam; t += DAY) {
      if ((daysOff || []).indexOf(new Date(t).getUTCDay()) === -1) dates.push(iso(t));
    }
    var h = Number(hours);
    return {
      daysLeft: daysLeft,
      studyDays: dates.length,
      perDay: dates.length && h > 0 ? h / dates.length : NaN,
      dates: dates
    };
  }

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function hm(hours) {
    if (!isFinite(hours)) return '—';
    var mins = Math.round(hours * 60);
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h ? h + ' h' : '') + (h && m ? ' ' : '') + (m ? m + ' min' : '') || '0 min';
  }

  var api = { plan: plan, parse: parse, hm: hm };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  var TK = root.TK;
  var startEl = TK.$('#sp-start'), examEl = TK.$('#sp-exam'), hoursEl = TK.$('#sp-hours');
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function daysOff() {
    return TK.$$('input[name="sp-off"]:checked').map(function (c) { return Number(c.value); });
  }

  function update() {
    var p = plan(startEl.value, examEl.value, TK.num(hoursEl.value), daysOff());
    var body = TK.$('#sp-table');
    body.innerHTML = '';
    var note = '';
    if (!p) {
      TK.$('#sp-days').textContent = '—';
      TK.$('#sp-study').textContent = '—';
      TK.$('#sp-per').textContent = '—';
    } else {
      TK.$('#sp-days').textContent = p.daysLeft < 0 ? 'Past' : p.daysLeft;
      TK.$('#sp-study').textContent = Math.max(0, p.studyDays);
      TK.$('#sp-per').textContent = hm(p.perDay);
      if (p.daysLeft < 0) note = 'That exam date has already passed.';
      else if (p.daysLeft === 0) note = 'The exam is today — good luck!';
      else if (p.studyDays === 0) note = 'No study days left once your days off are skipped.';
      else if (p.perDay > 8) note = 'That\'s a lot per day. Consider starting earlier or fewer days off.';
      p.dates.slice(0, 90).forEach(function (d, i) {
        var wd = WD[new Date(parse(d)).getUTCDay()];
        body.appendChild(TK.el('tr', {}, [
          TK.el('td', { text: 'Day ' + (i + 1) }),
          TK.el('td', { text: wd + ' ' + d }),
          TK.el('td', { text: hm(p.perDay) })
        ]));
      });
    }
    TK.$('#sp-note').textContent = note;
    TK.save('sp', { exam: examEl.value, hours: hoursEl.value, off: daysOff() });
  }

  var saved = TK.load('sp', null);
  startEl.value = todayIso();
  if (saved) {
    examEl.value = saved.exam || '';
    hoursEl.value = saved.hours || '';
    TK.$$('input[name="sp-off"]').forEach(function (c) { c.checked = (saved.off || []).indexOf(Number(c.value)) !== -1; });
  }
  TK.$('#sp-tool').addEventListener('input', update);
  TK.$('#sp-tool').addEventListener('change', update);
  update();
})(this);
