(function (root) {
  'use strict';

  var STOP = ('a an and are as at be but by for from has have he her his i in is it its of on or our she so that the their them there they this to was we were what when which who will with you your not can do if my me than then also into about more one all been would could should had any our us').split(' ');

  function count(text) {
    text = String(text || '');
    var trimmed = text.trim();
    var words = trimmed ? trimmed.split(/\s+/).filter(function (w) { return /[\p{L}\p{N}]/u.test(w); }) : [];
    var sentences = trimmed ? (trimmed.match(/[^.!?]*[\p{L}\p{N}][^.!?]*(?:[.!?]+|$)/gu) || []).length : 0;
    var paragraphs = trimmed ? trimmed.split(/\n\s*\n/).filter(function (p) { return p.trim(); }).length : 0;
    return {
      words: words.length,
      chars: text.length,
      charsNoSpaces: text.replace(/\s/g, '').length,
      sentences: sentences,
      paragraphs: paragraphs
    };
  }

  function topWords(text, n) {
    var freq = {};
    (String(text || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).forEach(function (w) {
      w = w.replace(/^'+|'+$/g, '');
      if (w.length < 3 || STOP.indexOf(w) !== -1) return;
      freq[w] = (freq[w] || 0) + 1;
    });
    return Object.keys(freq).map(function (k) { return [k, freq[k]]; })
      .filter(function (p) { return p[1] > 1; })
      .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); })
      .slice(0, n || 5);
  }

  function duration(words, wpm) {
    if (!(wpm > 0) || !words) return '0 sec';
    var secs = Math.round(words / wpm * 60);
    if (secs < 60) return secs + ' sec';
    var m = Math.floor(secs / 60), s = secs % 60;
    if (m < 60) return m + ' min' + (s ? ' ' + s + ' sec' : '');
    return Math.floor(m / 60) + ' hr ' + (m % 60) + ' min';
  }

  var api = { count: count, topWords: topWords, duration: duration };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  var TK = root.TK;
  var ta = TK.$('#wc-text'), rw = TK.$('#wc-read-wpm'), sw = TK.$('#wc-speak-wpm');

  function update() {
    var c = count(ta.value);
    TK.$('#wc-words').textContent = c.words.toLocaleString();
    TK.$('#wc-chars').textContent = c.chars.toLocaleString();
    TK.$('#wc-chars-ns').textContent = c.charsNoSpaces.toLocaleString();
    TK.$('#wc-sent').textContent = c.sentences.toLocaleString();
    TK.$('#wc-para').textContent = c.paragraphs.toLocaleString();
    TK.$('#wc-read').textContent = duration(c.words, TK.num(rw.value));
    TK.$('#wc-speak').textContent = duration(c.words, TK.num(sw.value));
    var top = topWords(ta.value, 5);
    TK.$('#wc-top').textContent = top.length ? top.map(function (p) { return p[0] + ' (' + p[1] + ')'; }).join(', ') : '—';
    TK.save('wc', { r: rw.value, s: sw.value });
  }

  var saved = TK.load('wc', null);
  if (saved) { rw.value = saved.r || rw.value; sw.value = saved.s || sw.value; }
  TK.$('#wc-tool').addEventListener('input', update);
  TK.$('#wc-clear').addEventListener('click', function () { ta.value = ''; update(); ta.focus(); });
  update();
})(this);
