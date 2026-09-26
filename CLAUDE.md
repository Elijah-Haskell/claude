# Semester Toolkit

A static site of free student tools, hosted on GitHub Pages from the `docs/` folder of the
`claude/eloquent-bell-x26fjv` branch. `docs/` is generated — never edit it by hand.

## Layout
- `site.json` — site name, `base_url`, `adsense_client` (blank until AdSense approves the site), optional `custom_domain`.
- `tools.json` — every tool, in display order. The build fails if a tool's source files are missing.
- `src/tools/<slug>.html` — the tool's markup plus its explainer, formula and FAQ.
- `src/js/<slug>.js` — pure logic at the top, exported for Node via `module.exports`; DOM wiring below the export.
- `src/js/site.js` — shared helpers (`TK.num`, `TK.fmt`, `TK.load`/`TK.save`, `TK.el`, …).
- `build.py` — renders everything into `docs/`, including sitemap, robots.txt, ads.txt and CNAME.

## Commands
- Build: `python3 build.py`
- Logic tests: `node --test tests/logic.test.js`
- Browser tests (every page, desktop + phone width): `NODE_PATH=$(npm root -g) node tests/smoke.js`

## Adding a tool
1. Pick the top unchecked idea in `BACKLOG.md` that isn't already covered by an existing tool.
2. Write `src/tools/<slug>.html` following an existing tool: the tool inside `<section class="card tool" id="…">`, then a
   `<div class="prose">` with "How to use", how it's calculated (with a worked example), and a short FAQ. Any factual
   claim (a statistic, a rule from a style guide) must be something you have verified.
3. Write `src/js/<slug>.js` in the same UMD shape as the others. Escape any user text inserted as HTML.
4. Add the entry to `tools.json` (`added` = today's date) and tests for the logic to `tests/logic.test.js`
   and an interaction check to `checks` in `tests/smoke.js`.
5. Build and run both test suites. Only commit if everything passes; tick the idea in `BACKLOG.md`.

## Quality bar
One well-made tool beats several thin ones: each page must do something real and explain itself. Don't generate
near-duplicate pages (e.g. one page per number or per school) — that is the "scaled content" Google penalizes and
it would put the AdSense account at risk. Don't change `adsense_client`, `custom_domain` or the privacy page's ad
wording unless the owner asks.
