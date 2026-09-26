#!/usr/bin/env python3
"""Builds the static site into docs/ (the folder GitHub Pages serves).

Inputs:
  site.json            site-wide settings (name, base_url, adsense_client, ...)
  tools.json           the list of tools, in display order
  src/tools/<slug>.html  the body of each tool page
  src/js/<slug>.js       the script for each tool
  src/assets/*           copied as-is

Run:  python3 build.py
"""
import html
import json
import shutil
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "docs"
SRC = ROOT / "src"

site = json.loads((ROOT / "site.json").read_text())
tools = json.loads((ROOT / "tools.json").read_text())
BASE = site["base_url"].rstrip("/")
ADS = site.get("adsense_client", "").strip()
YEAR = date.today().year


def e(s):
    return html.escape(str(s), quote=True)


def head(title, description, canonical, prefix, extra=""):
    ads = ""
    if ADS:
        ads = (
            f'<meta name="google-adsense-account" content="{e(ADS)}">\n'
            f'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={e(ADS)}" crossorigin="anonymous"></script>\n'
        )
    return f"""<!doctype html>
<html lang="{e(site.get('lang', 'en'))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(description)}">
<link rel="canonical" href="{e(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="{e(canonical)}">
<meta property="og:site_name" content="{e(site['name'])}">
<meta name="theme-color" content="#2f5bd3">
<link rel="icon" href="{prefix}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{prefix}assets/style.css">
{ads}{extra}</head>
<body>
<header class="site-header"><div class="wrap">
  <a class="brand" href="{prefix}"><span class="brand-mark" aria-hidden="true">ST</span>{e(site['name'])}</a>
  <nav class="site-nav" aria-label="Main"><a href="{prefix}#tools">All tools</a><a href="{prefix}about/">About</a></nav>
</div></header>
<main><div class="wrap">
"""


def foot(prefix, scripts=()):
    tags = "".join(f'<script src="{prefix}assets/js/{s}.js"></script>\n' for s in scripts)
    return f"""</div></main>
<footer class="site-footer"><div class="wrap">
  <a href="{prefix}about/">About</a><a href="{prefix}privacy/">Privacy</a><a href="{prefix}contact/">Contact</a>
  <p style="margin:10px 0 0">© {YEAR} {e(site['name'])}. Free tools that run in your browser.</p>
</div></footer>
{tags}</body>
</html>
"""


def jsonld(obj):
    return '<script type="application/ld+json">' + json.dumps(obj, ensure_ascii=False) + "</script>\n"


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def related(tool):
    same = [t for t in tools if t["category"] == tool["category"] and t["slug"] != tool["slug"]]
    other = [t for t in tools if t["category"] != tool["category"]]
    return (same + other)[:4]


def build_tool(tool):
    slug = tool["slug"]
    body = (SRC / "tools" / f"{slug}.html").read_text()
    url = f"{BASE}/{slug}/"
    ld = jsonld({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": tool["h1"],
        "url": url,
        "description": tool["description"],
        "applicationCategory": "EducationalApplication",
        "operatingSystem": "Any",
        "isAccessibleForFree": True,
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
    })
    rel = "".join(
        f'<li><a href="../{t["slug"]}/">{e(t["h1"])}</a> — {e(t["blurb"])}</li>' for t in related(tool)
    )
    page = (
        head(f'{tool["title"]} | {site["name"]}', tool["description"], url, "../", ld)
        + f'<div class="crumbs"><a href="../">{e(site["name"])}</a> › {e(tool["category"])}</div>\n'
        + f'<h1>{e(tool["h1"])}</h1>\n<p class="lede">{e(tool["description"])}</p>\n'
        + body
        + f'\n<section class="related"><h2>More free tools</h2><ul>{rel}</ul></section>\n'
        + foot("../", ["site", slug])
    )
    write(OUT / slug / "index.html", page)


def build_index():
    cats = []
    for t in tools:
        if t["category"] not in cats:
            cats.append(t["category"])
    sections = ""
    for c in cats:
        cards = "".join(
            f'<a class="card tool-card" href="{t["slug"]}/"><h3>{e(t["h1"])}</h3><p>{e(t["blurb"])}</p></a>'
            for t in tools if t["category"] == c
        )
        sections += f'<h2 class="cat-title">{e(c)}</h2>\n<div class="grid">{cards}</div>\n'
    ld = jsonld({"@context": "https://schema.org", "@type": "WebSite", "name": site["name"], "url": BASE + "/"})
    page = (
        head(f'{site["name"]} — {site["tagline"]}', site["description"], BASE + "/", "", ld)
        + f'<h1>{e(site["tagline"])}</h1>\n'
        + '<p class="lede">No sign-up, no downloads. Every tool runs in your browser, and nothing you type is uploaded.</p>\n'
        + f'<div id="tools">{sections}</div>\n'
        + foot("")
    )
    write(OUT / "index.html", page)


def build_page(slug, title, description, inner):
    url = f"{BASE}/{slug}/"
    page = head(f"{title} | {site['name']}", description, url, "../") + f"<h1>{e(title)}</h1>\n<div class=\"prose\">{inner}</div>\n" + foot("../")
    write(OUT / slug / "index.html", page)


def build_static_pages():
    name = e(site["name"])
    build_page("about", "About", f"About {site['name']}: free calculators and study tools for students.", f"""
<p>{name} is a collection of free, simple tools for students — grade calculators, citation help, a word counter, a study timer and more.</p>
<p>Every tool:</p>
<ul>
  <li><strong>Runs in your browser.</strong> Nothing you type is sent to a server.</li>
  <li><strong>Is free</strong> and needs no account. The site is supported by advertising.</li>
  <li><strong>Shows its working.</strong> Each page explains the formula or rules it uses, so you can check the result yourself.</li>
</ul>
<p>New tools are added regularly. If a result looks wrong or there's a tool you'd like, please <a href="../contact/">get in touch</a>.</p>
""")

    if ADS:
        ads_para = "<p>This site shows ads served by Google AdSense.</p>"
    else:
        ads_para = "<p>This site may show ads served by Google AdSense.</p>"
    consent_para = (
        "<p>Visitors in the European Economic Area, the UK and Switzerland are asked for consent before personalized ads are shown.</p>"
        if ADS else ""
    )
    build_page("privacy", "Privacy Policy", f"How {site['name']} handles your data, cookies and advertising.", f"""
<p><em>Last updated: {date.today().isoformat()}</em></p>
<h2>What we collect</h2>
<p>The tools on this site run entirely in your web browser. Text, grades, dates and other information you enter are <strong>not sent to us</strong> or stored on any server.</p>
<p>Some tools remember your last inputs using your browser's local storage so they're still there when you come back. This data stays on your device. You can clear it at any time by clearing your browser's site data.</p>
<h2>Advertising and cookies</h2>
{ads_para}
<ul>
  <li>Third-party vendors, including Google, use cookies to serve ads based on a user's prior visits to this website or other websites.</li>
  <li>Google's use of advertising cookies enables it and its partners to serve ads to users based on their visit to this site and/or other sites on the Internet.</li>
  <li>You may opt out of personalized advertising by visiting <a href="https://www.google.com/settings/ads" rel="nofollow">Google Ads Settings</a>. You can also opt out of some third-party vendors' use of cookies for personalized advertising at <a href="https://www.aboutads.info/choices/" rel="nofollow">www.aboutads.info</a>.</li>
  <li>Learn more about <a href="https://policies.google.com/technologies/partner-sites" rel="nofollow">how Google uses information from sites that use its services</a>.</li>
</ul>
{consent_para}
<h2>Hosting</h2>
<p>This site is hosted on GitHub Pages. GitHub may log technical information such as IP addresses for security purposes; see the <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" rel="nofollow">GitHub Privacy Statement</a>.</p>
<h2>Children</h2>
<p>This site is intended for a general audience of students and is not directed at children under 13.</p>
<h2>Contact</h2>
<p>Questions about this policy? See the <a href="../contact/">contact page</a>.</p>
""")

    build_page("contact", "Contact", f"Contact {site['name']}: report a problem or suggest a tool.", f"""
<p>Found a wrong result, a bug, or have an idea for a new tool?</p>
<p><a class="btn btn-primary" href="{e(site['repo_url'])}/issues/new" rel="nofollow">Open a request on GitHub</a></p>
<p class="hint">You'll need a free GitHub account. Please include which tool you used and what you entered.</p>
""")

    notfound = (
        head(f"Page not found | {site['name']}", "Page not found.", BASE + "/404.html", BASE + "/")
        + f'<h1>Page not found</h1>\n<p class="lede">That page doesn\'t exist. <a href="{BASE}/">See all tools</a>.</p>\n'
        + foot(BASE + "/")
    )
    write(OUT / "404.html", notfound)


def build_meta_files():
    urls = [BASE + "/"] + [f"{BASE}/{t['slug']}/" for t in tools] + [f"{BASE}/{p}/" for p in ("about", "privacy", "contact")]
    today = date.today().isoformat()
    sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    sm += "".join(f"  <url><loc>{e(u)}</loc><lastmod>{today}</lastmod></url>\n" for u in urls)
    sm += "</urlset>\n"
    write(OUT / "sitemap.xml", sm)
    write(OUT / "robots.txt", f"User-agent: *\nAllow: /\n\nSitemap: {BASE}/sitemap.xml\n")
    if ADS:
        pub = ADS.replace("ca-", "", 1)
        write(OUT / "ads.txt", f"google.com, {pub}, DIRECT, f08c47fec0942fa0\n")
    domain = site.get("custom_domain", "").strip()
    if domain:
        write(OUT / "CNAME", domain + "\n")
    write(OUT / ".nojekyll", "")


def copy_assets():
    (OUT / "assets" / "js").mkdir(parents=True, exist_ok=True)
    for f in (SRC / "assets").iterdir():
        shutil.copy(f, OUT / "assets" / f.name)
    for f in (SRC / "js").glob("*.js"):
        shutil.copy(f, OUT / "assets" / "js" / f.name)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    for t in tools:
        for need in (SRC / "tools" / f"{t['slug']}.html", SRC / "js" / f"{t['slug']}.js"):
            if not need.exists():
                raise SystemExit(f"Missing {need.relative_to(ROOT)} for tool '{t['slug']}'")
    copy_assets()
    build_index()
    for t in tools:
        build_tool(t)
    build_static_pages()
    build_meta_files()
    print(f"Built {len(tools)} tools into {OUT.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
