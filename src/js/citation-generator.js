(function (root) {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MLA_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function endsWithPunct(s) { return /[.?!]$/.test(s); }
  function period(s) { return endsWithPunct(s) ? s : s + '.'; }
  function pages(p) { return clean(p).replace(/\s*[-‐‑‒–—]+\s*/g, '–'); }

  // "Jane Q. Public" or "Public, Jane Q." -> {last, given: ['Jane', 'Q.']}
  function parseName(raw) {
    raw = clean(raw);
    if (!raw) return null;
    var last, given;
    if (raw.indexOf(',') !== -1) {
      var parts = raw.split(',');
      last = clean(parts[0]);
      given = clean(parts.slice(1).join(' ')).split(' ').filter(Boolean);
    } else {
      var words = raw.split(' ');
      last = words.pop();
      given = words;
    }
    return { last: last, given: given };
  }

  function initials(given) {
    return given.map(function (g) {
      return g.split('-').filter(Boolean).map(function (p) { return p.charAt(0).toUpperCase() + '.'; }).join('-');
    }).join(' ');
  }

  function parseAuthors(text, isOrg) {
    var lines = String(text || '').split(/\n/).map(clean).filter(Boolean);
    if (isOrg) return lines.length ? [{ org: lines[0] }] : [];
    return lines.map(parseName).filter(Boolean);
  }

  function doiUrl(doi) {
    var d = clean(doi).replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
    return d ? 'https://doi.org/' + d : '';
  }

  // ---------- APA 7 ----------
  function apaName(a) {
    if (a.org) return a.org;
    var ini = initials(a.given);
    return ini ? a.last + ', ' + ini : a.last;
  }

  function apaAuthors(list) {
    var names = list.map(apaName);
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ', & ' + names[1];
    if (names.length <= 20) return names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1];
    return names.slice(0, 19).join(', ') + ', . . . ' + names[names.length - 1];
  }

  function apaDate(d, withDay) {
    var y = clean(d.year);
    if (!y) return 'n.d.';
    if (!withDay) return y;
    var m = Number(d.month);
    var out = y;
    if (m >= 1 && m <= 12) {
      out += ', ' + MONTHS[m - 1];
      if (clean(d.day)) out += ' ' + clean(d.day);
    }
    return out;
  }

  function apa(type, f) {
    var authors = parseAuthors(f.authors, f.isOrg);
    var authorStr = esc(apaAuthors(authors));
    var title = clean(f.title);
    var date = '(' + esc(apaDate(f, type === 'web')) + ').';
    var link = f.doi ? doiUrl(f.doi) : clean(f.url);
    var tail = link ? ' ' + esc(link) : '';

    if (type === 'book') {
      var t = '<i>' + esc(period(title)) + '</i>';
      var pub = clean(f.publisher) ? ' ' + esc(period(clean(f.publisher))) : '';
      var head = authorStr ? period(authorStr) + ' ' + date + ' ' + t : t + ' ' + date;
      return head + pub + tail;
    }

    if (type === 'journal') {
      var at = esc(period(title));
      var src = '';
      if (clean(f.journal)) {
        src = '<i>' + esc(clean(f.journal)) + '</i>';
        if (clean(f.volume)) {
          src += ', <i>' + esc(clean(f.volume)) + '</i>';
          if (clean(f.issue)) src += '(' + esc(clean(f.issue)) + ')';
        }
        if (clean(f.pages)) src += ', ' + esc(pages(f.pages));
        src += '.';
      }
      var h = authorStr ? period(authorStr) + ' ' + date + ' ' + at : at + ' ' + date;
      return h + (src ? ' ' + src : '') + tail;
    }

    // web page
    var wt = '<i>' + esc(period(title)) + '</i>';
    var site = clean(f.site);
    var orgName = authors.length === 1 && authors[0].org ? authors[0].org : '';
    var siteStr = site && site.toLowerCase() !== orgName.toLowerCase() ? ' ' + esc(period(site)) : '';
    var wh = authorStr ? period(authorStr) + ' ' + date + ' ' + wt : wt + ' ' + date;
    return wh + siteStr + tail;
  }

  // ---------- MLA 9 ----------
  function mlaAuthors(list) {
    if (list.length === 0) return '';
    var first = list[0].org ? list[0].org : list[0].last + (list[0].given.length ? ', ' + list[0].given.join(' ') : '');
    if (list.length === 1) return first;
    if (list.length === 2) {
      var b = list[1];
      return first + ', and ' + (b.org ? b.org : b.given.concat([b.last]).join(' '));
    }
    return first + ', et al';
  }

  function mlaDate(d) {
    var y = clean(d.year);
    if (!y) return '';
    var m = Number(d.month), day = clean(d.day);
    if (m >= 1 && m <= 12) return (day ? day + ' ' : '') + MLA_MONTHS[m - 1] + ' ' + y;
    return y;
  }

  function mlaAccess(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(iso));
    if (!m) return '';
    return Number(m[3]) + ' ' + MLA_MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  }

  function quoted(title) {
    return '“' + esc(period(title)) + '”';
  }

  function mla(type, f) {
    var authors = parseAuthors(f.authors, f.isOrg);
    var a = mlaAuthors(authors);
    var lead = a ? esc(period(a)) + ' ' : '';
    var title = clean(f.title);

    if (type === 'book') {
      var parts = [];
      if (clean(f.publisher)) parts.push(esc(clean(f.publisher)));
      if (clean(f.year)) parts.push(esc(clean(f.year)));
      return lead + '<i>' + esc(period(title)) + '</i>' + (parts.length ? ' ' + parts.join(', ') + '.' : '');
    }

    if (type === 'journal') {
      var c = [];
      if (clean(f.journal)) c.push('<i>' + esc(clean(f.journal)) + '</i>');
      if (clean(f.volume)) c.push('vol. ' + esc(clean(f.volume)));
      if (clean(f.issue)) c.push('no. ' + esc(clean(f.issue)));
      if (clean(f.year)) c.push(esc(clean(f.year)));
      if (clean(f.pages)) {
        var p = pages(f.pages);
        c.push((p.indexOf('–') !== -1 ? 'pp. ' : 'p. ') + esc(p));
      }
      var out = lead + quoted(title) + (c.length ? ' ' + c.join(', ') + '.' : '');
      var link = f.doi ? doiUrl(f.doi) : clean(f.url).replace(/^https?:\/\//i, '');
      return out + (link ? ' ' + esc(period(link)) : '');
    }

    // web page
    var w = [];
    if (clean(f.site)) w.push('<i>' + esc(clean(f.site)) + '</i>');
    var md = mlaDate(f);
    if (md) w.push(esc(md));
    var url = clean(f.url).replace(/^https?:\/\//i, '');
    if (url) w.push(esc(url));
    var res = lead + quoted(title) + (w.length ? ' ' + w.join(', ') + '.' : '');
    var acc = mlaAccess(f.accessed);
    return res + (acc ? ' Accessed ' + esc(acc) + '.' : '');
  }

  function toPlain(html) {
    return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  var api = { apa: apa, mla: mla, parseName: parseName, apaAuthors: apaAuthors, mlaAuthors: mlaAuthors, parseAuthors: parseAuthors, doiUrl: doiUrl, toPlain: toPlain };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  var TK = root.TK;
  var tool = TK.$('#cite-tool');
  var type = 'book';

  function fields() {
    var f = {};
    TK.$$('[data-f]', tool).forEach(function (el) {
      f[el.getAttribute('data-f')] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return f;
  }

  function showFields() {
    TK.$$('[data-types]', tool).forEach(function (el) {
      el.hidden = el.getAttribute('data-types').split(' ').indexOf(type) === -1;
    });
    TK.$$('.tabs button', tool).forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-type') === type ? 'true' : 'false');
    });
  }

  function update() {
    var f = fields();
    var hasAny = clean(f.title) || clean(f.authors);
    TK.$('#cite-apa').innerHTML = hasAny ? apa(type, f) : '<span class="hint">Fill in the fields above.</span>';
    TK.$('#cite-mla').innerHTML = hasAny ? mla(type, f) : '<span class="hint">Fill in the fields above.</span>';
  }

  function copy(id, btn) {
    var html = TK.$(id).innerHTML;
    var plain = toPlain(html);
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    try {
      if (root.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        navigator.clipboard.write([new root.ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        })]).then(done, function () { navigator.clipboard.writeText(plain).then(done); });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(plain).then(done);
      }
    } catch (e) { /* clipboard unavailable */ }
  }

  TK.$$('.tabs button', tool).forEach(function (b) {
    b.addEventListener('click', function () { type = b.getAttribute('data-type'); showFields(); update(); });
  });
  tool.addEventListener('input', update);
  tool.addEventListener('change', update);
  TK.$('#copy-apa').addEventListener('click', function (e) { copy('#cite-apa', e.currentTarget); });
  TK.$('#copy-mla').addEventListener('click', function (e) { copy('#cite-mla', e.currentTarget); });
  showFields();
  update();
})(this);
