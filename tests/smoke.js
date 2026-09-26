// Browser smoke test: loads every built page in Chromium, exercises each tool,
// and fails on JS errors or horizontal overflow at phone width.
// Run: python3 build.py && NODE_PATH=$(npm root -g) node tests/smoke.js
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 8765;
const ROOT = path.join(__dirname, '..', 'docs');
const BASE = `http://127.0.0.1:${PORT}`;
const tools = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools.json'), 'utf8'));
const shotDir = process.env.SHOT_DIR;

const checks = {
  'gpa-calculator': async (p) => {
    const rows = p.locator('#gpa-rows tr');
    await rows.nth(0).locator('input[type=number]').fill('3');
    await rows.nth(0).locator('select').selectOption('A');
    await rows.nth(1).locator('input[type=number]').fill('4');
    await rows.nth(1).locator('select').selectOption('B');
    return expectText(p, '#gpa-sem', '3.43');
  },
  'final-grade-calculator': async (p) => {
    await p.fill('#fg-current', '84'); await p.fill('#fg-weight', '25'); await p.fill('#fg-target', '80');
    return expectText(p, '#fg-needed', '68%');
  },
  'weighted-grade-calculator': async (p) => {
    const scores = p.locator('#wg-rows tr td:nth-child(3) input');
    await scores.nth(0).fill('90'); await scores.nth(1).fill('80');
    return expectText(p, '#wg-grade', '85.71%');
  },
  'citation-generator': async (p) => {
    await p.fill('#c-authors', 'Jane Smith'); await p.fill('#c-title', 'A title'); await p.fill('#c-year', '2020');
    await p.fill('#c-publisher', 'Pub');
    await expectText(p, '#cite-apa', 'Smith, J. (2020). A title. Pub.');
    await p.click('.tabs button[data-type=web]');
    if (!(await p.isVisible('#c-site'))) throw new Error('web fields not shown');
    if (await p.isVisible('#c-publisher')) throw new Error('book fields still shown');
  },
  'word-counter': async (p) => {
    await p.fill('#wc-text', 'One two three. Four five!');
    await expectText(p, '#wc-words', '5');
    return expectText(p, '#wc-sent', '2');
  },
  'pomodoro-timer': async (p) => {
    await p.click('#pt-start');
    await p.waitForTimeout(1300);
    const t = await p.textContent('#pt-face');
    if (t === '25:00') throw new Error('timer did not tick');
    await p.click('#pt-start');
    await expectText(p, '#pt-start', 'Resume');
  },
  'study-planner': async (p) => {
    await p.fill('#sp-start', '2026-09-28'); await p.fill('#sp-exam', '2026-10-05'); await p.fill('#sp-hours', '14');
    await p.check('input[name=sp-off][value="6"]'); await p.check('input[name=sp-off][value="0"]');
    await expectText(p, '#sp-per', '2 h 48 min');
    const n = await p.locator('#sp-table tr').count();
    if (n !== 5) throw new Error('expected 5 schedule rows, got ' + n);
  },
  'percentage-calculator': async (p) => {
    await p.fill('#pc-a-p', '15'); await p.fill('#pc-a-y', '80');
    await expectText(p, '#pc-a-out', '12');
    await p.fill('#pc-c-from', '50'); await p.fill('#pc-c-to', '40');
    return expectText(p, '#pc-c-out', '-20% (decrease)');
  }
};

async function expectText(p, sel, want) {
  const got = (await p.textContent(sel)).trim();
  if (got !== want) throw new Error(`${sel}: expected "${want}", got "${got}"`);
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const failures = [];
  const pages = ['', 'about/', 'privacy/', 'contact/'].concat(tools.map((t) => t.slug + '/'));

  try {
    for (const width of [1280, 375]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      for (const rel of pages) {
        const p = await ctx.newPage();
        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        const res = await p.goto(BASE + '/' + rel);
        const label = `${rel || 'home'} @${width}`;
        try {
          if (!res.ok()) throw new Error('HTTP ' + res.status());
          const slug = rel.replace(/\/$/, '');
          if (checks[slug]) await checks[slug](p);
          const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (overflow > 1) throw new Error(`horizontal overflow of ${overflow}px`);
          if (errors.length) throw new Error('JS errors: ' + errors.join(' | '));
          if (shotDir) await p.screenshot({ path: path.join(shotDir, `${slug || 'home'}-${width}.png`), fullPage: true });
          console.log('ok   ' + label);
        } catch (e) {
          failures.push(`${label}: ${e.message}`);
          console.log('FAIL ' + label + ': ' + e.message);
        }
        await p.close();
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
  console.log('\nAll pages passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
