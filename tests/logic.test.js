// Unit tests for the pure logic in each tool. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const js = (name) => require(path.join(__dirname, '..', 'src', 'js', name + '.js'));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('site helpers', () => {
  const TK = js('site');
  assert.ok(Number.isNaN(TK.num('')));
  assert.equal(TK.num('1,250.5'), 1250.5);
  assert.equal(TK.round(2.675, 2), 2.68);
  assert.equal(TK.letterFromPercent(93), 'A');
  assert.equal(TK.letterFromPercent(89.9), 'B+');
  assert.equal(TK.letterFromPercent(59.99), 'F');
});

test('GPA: semester and cumulative', () => {
  const g = js('gpa-calculator');
  const sem = g.semester([
    { credits: 3, grade: 'A' }, { credits: 4, grade: 'B+' }, { credits: 3, grade: 'C' },
    { credits: '', grade: 'A' }, { credits: 3, grade: '' }
  ]);
  near(sem.credits, 10);
  near(sem.gpa, (12 + 13.2 + 6) / 10);
  near(g.cumulative(sem, 3.5, 30), (105 + 31.2) / 40);
  near(g.cumulative(sem, NaN, NaN), sem.gpa);
  assert.ok(Number.isNaN(g.semester([]).gpa));
});

test('final grade needed', () => {
  const f = js('final-grade-calculator');
  near(f.needed(84, 25, 90), 108);
  near(f.needed(84, 25, 80), 68);
  near(f.needed(90, 100, 70), 70);
  assert.ok(Number.isNaN(f.needed(84, 0, 90)));
  assert.ok(Number.isNaN(f.needed(84, 120, 90)));
});

test('weighted grade', () => {
  const w = js('weighted-grade-calculator');
  const r = w.weighted([{ weight: 20, score: 90 }, { weight: 30, score: 80 }, { weight: 50, score: null }]);
  near(r.grade, (1800 + 2400) / 50);
  near(r.gradedWeight, 50);
  near(r.totalWeight, 100);
  assert.ok(Number.isNaN(w.weighted([{ weight: 0, score: 100 }]).grade));
});

test('percentages', () => {
  const p = js('percentage-calculator');
  near(p.percentOf(15, 80), 12);
  near(p.whatPercent(42, 50), 84);
  near(p.change(40, 50), 25);
  near(p.change(50, 40), -20);
  near(p.change(-10, -5), 50);
  assert.ok(Number.isNaN(p.whatPercent(1, 0)));
});

test('word counter', () => {
  const w = js('word-counter');
  const c = w.count('Hello world. This is a test!\n\nSecond paragraph here — really?');
  assert.equal(c.words, 10);
  assert.equal(c.sentences, 3);
  assert.equal(c.paragraphs, 2);
  assert.equal(w.count('   ').words, 0);
  assert.equal(w.duration(238, 238), '1 min');
  assert.equal(w.duration(119, 238), '30 sec');
  assert.deepEqual(w.topWords('study study study notes notes the the the', 5), [['study', 3], ['notes', 2]]);
});

test('pomodoro phases', () => {
  const p = js('pomodoro-timer');
  assert.equal(p.nextPhase('focus', 1, 4), 'short');
  assert.equal(p.nextPhase('focus', 4, 4), 'long');
  assert.equal(p.nextPhase('short', 1, 4), 'focus');
  assert.equal(p.clock(25 * 60000), '25:00');
  assert.equal(p.clock(61001), '01:02');
  assert.equal(p.clock(-5), '00:00');
});

test('study planner', () => {
  const s = js('study-planner');
  // 2026-09-28 is a Monday; exam the following Monday.
  const r = s.plan('2026-09-28', '2026-10-05', 14, [0, 6]);
  assert.equal(r.daysLeft, 7);
  assert.equal(r.studyDays, 5);
  near(r.perDay, 2.8);
  assert.deepEqual(r.dates, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.equal(s.plan('2026-09-28', '2026-09-28', 5, []).studyDays, 0);
  assert.equal(s.plan('bad', '2026-09-28', 5, []), null);
  assert.equal(s.hm(2.8), '2 h 48 min');
  assert.equal(s.hm(0.5), '30 min');
});

test('citations: APA 7', () => {
  const c = js('citation-generator');
  const plain = (h) => c.toPlain(h);

  assert.equal(
    plain(c.apa('book', { authors: 'Jane Q. Smith\nRahul Patel', title: 'Learning to learn', year: '2020', publisher: 'Penguin Books' })),
    'Smith, J. Q., & Patel, R. (2020). Learning to learn. Penguin Books.'
  );
  assert.equal(
    c.apa('journal', { authors: 'Smith, Jane', title: 'Sleep and memory', year: '2019', journal: 'Journal of Psychology', volume: '12', issue: '3', pages: '45-67', doi: 'doi:10.1037/abc123' }),
    'Smith, J. (2019). Sleep and memory. <i>Journal of Psychology</i>, <i>12</i>(3), 45–67. https://doi.org/10.1037/abc123'
  );
  assert.equal(
    plain(c.apa('web', { authors: 'World Health Organization', isOrg: true, title: 'Physical activity', year: '2024', month: '6', day: '26', site: 'World Health Organization', url: 'https://www.who.int/pa' })),
    'World Health Organization. (2024, June 26). Physical activity. https://www.who.int/pa'
  );
  assert.equal(
    plain(c.apa('web', { authors: '', title: 'Study tips', year: '', site: 'Campus Blog', url: 'https://x.edu/tips' })),
    'Study tips. (n.d.). Campus Blog. https://x.edu/tips'
  );
  assert.equal(c.apaAuthors([1, 2, 3].map((i) => ({ last: 'L' + i, given: ['F'] }))), 'L1, F., L2, F., & L3, F.');
  const many = Array.from({ length: 22 }, (_, i) => ({ last: 'L' + (i + 1), given: ['A'] }));
  const s = c.apaAuthors(many);
  assert.ok(s.startsWith('L1, A., L2, A.'));
  assert.ok(s.includes('L19, A., . . . L22, A.'));
  assert.ok(!s.includes('L20'));
  assert.equal(c.apaAuthors([c.parseName('Jean-Paul Sartre')]), 'Sartre, J.-P.');
});

test('citations: MLA 9', () => {
  const c = js('citation-generator');
  const plain = (h) => c.toPlain(h);

  assert.equal(
    plain(c.mla('book', { authors: 'Jane Q. Smith\nRahul Patel', title: 'Learning to Learn', year: '2020', publisher: 'Penguin Books' })),
    'Smith, Jane Q., and Rahul Patel. Learning to Learn. Penguin Books, 2020.'
  );
  assert.equal(
    plain(c.mla('journal', { authors: 'A B\nC D\nE F', title: 'Sleep and Memory', year: '2019', journal: 'Journal of Psychology', volume: '12', issue: '3', pages: '45-67', doi: '10.1037/abc123' })),
    'B, A, et al. “Sleep and Memory.” Journal of Psychology, vol. 12, no. 3, 2019, pp. 45–67. https://doi.org/10.1037/abc123.'
  );
  assert.equal(
    plain(c.mla('web', { authors: 'Jane Smith', title: 'Why Sleep Matters?', site: 'BBC News', year: '2024', month: '9', day: '5', url: 'https://www.bbc.com/news/x', accessed: '2026-09-26' })),
    'Smith, Jane. “Why Sleep Matters?” BBC News, 5 Sept. 2024, www.bbc.com/news/x. Accessed 26 Sept. 2026.'
  );
});

test('citations escape HTML from user input', () => {
  const c = js('citation-generator');
  const out = c.apa('book', { authors: '<img src=x onerror=alert(1)>', title: '<script>x</script>', year: '2020' });
  assert.ok(!out.includes('<script>'));
  assert.ok(!out.includes('<img'));
});
