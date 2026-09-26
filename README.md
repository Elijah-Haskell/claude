# Semester Toolkit

Free calculators and study tools for students — GPA, final grade, weighted grade, APA/MLA citations,
word count, Pomodoro timer, study planner and percentages. Every tool runs in the browser; nothing is uploaded.

The live site is built into `docs/` and served by GitHub Pages. See `CLAUDE.md` for how the site is built,
tested and extended.

```sh
python3 build.py                                   # build into docs/
node --test tests/logic.test.js                    # logic tests
NODE_PATH=$(npm root -g) node tests/smoke.js       # browser tests (needs Playwright)
```

## Turning on ads
1. Get approved for Google AdSense (see the setup guide shared with the owner).
2. Put the publisher ID in `site.json`, e.g. `"adsense_client": "ca-pub-1234567890123456"`.
3. If you bought a domain, also set `"custom_domain": "yourdomain.com"` and change `base_url` to `https://yourdomain.com`.
4. Run `python3 build.py`, commit and push. The build adds the AdSense script to every page and writes `ads.txt`.
