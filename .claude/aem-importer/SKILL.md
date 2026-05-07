---
name: aem-importer
description: >
  Use this skill whenever the user wants to migrate, import, or convert an existing website page into
  AEM Edge Delivery Services (EDS) format. Triggers include: "create an import.js", "generate import script",
  "migrate this page to EDS", "import content from [URL]", "write an importer for [URL]",
  "how do I import [URL] into AEM", "set up page migration", "create a Franklin importer",
  "import this site into EDS", "migrate this site", "crawl this sitemap", "migrate multiple pages",
  or any mention of tools.aem.page/importer. Always use this skill when a URL is provided alongside
  any intent to migrate or import into AEM EDS — even if the user doesn't explicitly say "import.js".
  Also triggers when user asks to "create a custom block" for a migrated page, or to "update" or
  "extend" an existing import.js. Works for ALL page types: server-rendered (AEM, WordPress, Drupal,
  static HTML) AND JavaScript-rendered SPAs (React, Angular, Vue, Next.js, Gatsby).
---

# AEM EDS Import Script Generator

Generates `tools/importer/import.js`, required custom blocks, and supporting content files
(nav.md, footer.md) for the [AEM Importer tool](https://tools.aem.page/importer/).

Works for **any page type** — server-rendered pages and JavaScript SPAs alike.
Works in **single-page** or **multi-template/sitemap** mode.
Supports **incremental updates** to existing import.js files.

---

## Step 0 — Determine operating mode

Before fetching any HTML, check for existing work and understand the scope:

### 0a. Incremental update check

```bash
cat tools/importer/import.js 2>/dev/null | head -20
```

- If `import.js` exists → **incremental mode**: read the full file, understand what sections it already handles, and only add/replace the sections the user is requesting. Never overwrite working transformers.
- If `import.js` does not exist → **fresh mode**: generate from scratch.

### 0b. Scope detection

Determine from the user's input:

| Input | Mode |
|---|---|
| Single URL | Single-page mode → Steps 1–8 for that URL |
| Multiple URLs (list) | Multi-template mode → Step 0c first |
| Sitemap URL | Multi-template mode → Step 0c first |
| "migrate the whole site" | Multi-template mode → Step 0c first |

### 0c. Multi-template sitemap crawl

When given a sitemap or multiple URLs:

```bash
# Fetch sitemap
curl -s -L "<sitemap-url>" > /tmp/sitemap.xml

# Extract all page URLs
grep -oP '(?<=<loc>)[^<]+' /tmp/sitemap.xml | head -100
```

Group URLs into template types by URL pattern (e.g. `/blog/`, `/product/`, `/about/`). Pick one representative URL per template. Run Steps 1–7 for each representative. Generate a single import.js with conditional logic:

```js
export default {
  transform({ document: doc, url }) {
    cleanup(doc);
    const main = doc.querySelector('main') || doc.body;
    fixLinks(main, url);

    if (url.includes('/blog/')) {
      transformBlogHero(main, doc);
      transformBlogBody(main, doc);
    } else if (url.includes('/product/')) {
      transformProductHero(main, doc);
      transformProductFeatures(main, doc);
    } else {
      // homepage / default
      transformHero(main, doc);
      transformCards(main, doc);
    }

    main.appendChild(wrapSection(buildMetadata(doc)));
    return [{ element: main, path: new URL(url).pathname.replace(/\/$/, '') || '/index' }];
  },
};
```

---

## Step 1 — Fetch and detect page type

### 1a. Attempt curl fetch

```bash
curl -s -L --max-time 30 \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "<URL>" > /tmp/page.html

wc -l /tmp/page.html
wc -c /tmp/page.html
```

**If the page is behind authentication (401, 403, or redirects to a login page):**
- Check the HTTP status:
  ```bash
  curl -s -o /dev/null -w "%{http_code}" -L "<URL>"
  ```
- If 401/403 or the HTML contains a login form / "sign in" CTA with no main content → inform the user they must either:
  1. Provide cookie headers: `curl -H "Cookie: session=<value>" ...`
  2. Use the browser fallback (Step 1c) with an already-authenticated Chrome session
- Do not guess or fabricate selectors for pages you cannot read.

### 1b. SPA detection

A page is a **JavaScript SPA** if ANY of the following are true:

```bash
# Check file size
wc -l /tmp/page.html   # < 100 lines = likely SPA

# Check visible text density (lines that are not tags/scripts/styles)
grep -v '<script\|<style\|<link\|<meta\|<!DOCTYPE\|<html\|<head\|<body' /tmp/page.html \
  | grep -v '^\s*$' | wc -l   # < 20 = SPA

# Check for empty root mount points
grep -iE '<div\s+id="(root|app|__next|gatsby-focus-wrapper|app-root|ng-app)"[^>]*>\s*</div>' /tmp/page.html

# Check for SPA global state markers
grep -iE 'window\.__(?:NEXT|GATSBY|NUXT|REACT|VUE|ANGULAR|hzGlobals|initialState|APP_STATE|REDUX_STATE)__' /tmp/page.html | head -3
```

**SPA detected → Step 1c**
**Server-rendered → Step 1d**

### 1c. Browser fallback for SPAs (and authenticated pages)

1. Get or create a browser tab:
   ```
   mcp__Claude_in_Chrome__tabs_context_mcp (createIfEmpty: true)
   ```

2. Navigate and wait for full render:
   ```
   mcp__Claude_in_Chrome__navigate (url: "<URL>", tabId: <id>)
   mcp__Claude_in_Chrome__computer (action: "screenshot") → confirm page loaded
   ```

3. Scroll to trigger lazy-loaded sections:
   ```
   mcp__Claude_in_Chrome__computer (action: "scroll", coordinate: [760, 400], scroll_direction: "down", scroll_amount: 5)
   ```
   Repeat 3–4 times, taking a screenshot after each scroll to capture all sections before analysing.

4. Extract class inventory from rendered DOM:
   ```
   mcp__Claude_in_Chrome__javascript_tool:
   const classMap = {};
   document.querySelectorAll('[class]').forEach(el => {
     el.className.toString().split(/\s+/).filter(Boolean).forEach(c => {
       classMap[c] = (classMap[c] || 0) + 1;
     });
   });
   JSON.stringify(Object.entries(classMap).sort((a,b) => b[1]-a[1]).slice(0,80))
   ```

5. Extract IDs:
   ```
   mcp__Claude_in_Chrome__javascript_tool:
   JSON.stringify([...document.querySelectorAll('[id]')].map(el => ({
     id: el.id, tag: el.tagName.toLowerCase(), classes: el.className.toString().trim()
   })).slice(0, 40))
   ```

6. Extract structural sections:
   ```
   mcp__Claude_in_Chrome__javascript_tool:
   const sections = [];
   ['header','nav','main','footer','section','article'].forEach(tag => {
     document.querySelectorAll(tag).forEach(el => {
       sections.push({tag, id: el.id, classes: el.className.toString().trim(), children: el.children.length});
     });
   });
   JSON.stringify(sections.slice(0, 50))
   ```

7. Get rendered main content HTML:
   ```
   mcp__Claude_in_Chrome__javascript_tool:
   const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
   main.innerHTML.substring(0, 20000)
   ```

8. Get visible text for content understanding:
   ```
   mcp__Claude_in_Chrome__get_page_text (tabId: <id>)
   ```

Continue to Step 2 using extracted data as your selector inventory.

### 1d. Server-rendered grep analysis

```bash
# Top class names by frequency
grep -oP 'class="[^"]*"' /tmp/page.html | sort | uniq -c | sort -rn | head -60

# Top IDs
grep -oP 'id="[^"]*"' /tmp/page.html | sort | uniq -c | sort -rn | head -30

# Structural sections
grep -oiP '<[a-z][^>]*(?:class|id)="[^"]*(?:banner|hero|nav|footer|card|carousel|accordion|tabs|modal|form|teaser)[^"]*"[^>]*>' /tmp/page.html | head -40

# AEM Core Component patterns
grep -oP 'cmp-[a-z][a-z0-9-]*' /tmp/page.html | sort | uniq -c | sort -rn | head -30

# Experience Fragments
grep -oP 'cmp-experiencefragment--[a-z0-9_-]+' /tmp/page.html | sort -u

# Lazy-loaded images (data-src / data-lazy-src)
grep -oP 'data-(?:src|lazy-src|original)="[^"]*"' /tmp/page.html | head -20

# Inline JSON-LD structured data
grep -A5 'application/ld\+json' /tmp/page.html | head -40

# hreflang / alternate language links
grep -oP 'hreflang="[^"]*"' /tmp/page.html | sort -u

# Forms
grep -oiP '<form[^>]*>' /tmp/page.html | head -10
```

---

## Step 2 — Inventory existing project blocks

```bash
ls blocks/
```

Boilerplate blocks (always available): `hero`, `cards`, `columns`, `header`, `footer`, `fragment`

Block Party blocks (copy from GitHub): `embed`, `table`, `video`, `accordion`, `breadcrumbs`, `carousel`, `modal`, `quote`, `search`, `tabs`

Block Party source: `https://github.com/adobe/aem-block-collection/tree/main/blocks/<blockname>/`

---

## Step 3 — Block decision matrix

For **each distinct content section**, apply in order:

```
Section identified
       │
       ▼
Does a block in blocks/ already handle it?
  YES → use that block name
  NO  ▼
Does a Block Party block handle it?
  YES → note "add from Block Party: <name>", use that block name
  NO  ▼
Create a custom block → scaffold blocks/<name>/<name>.js + <name>.css
```

**Matching rules:**
- Hero / full-width banner → `hero` (boilerplate)
- Grid of similar cards → `cards` (boilerplate)
- Two-column layout → `columns` (boilerplate)
- Expandable FAQ → `accordion` (Block Party)
- Sliding content → `carousel` (Block Party)
- In-page navigation tabs → `tabs` (Block Party)
- Embedded video / iframe → `embed` (Block Party)
- Pull-quote / testimonial → `quote` (Block Party)
- Popup / overlay → `modal` (Block Party)
- Bread crumb trail → `breadcrumbs` (Block Party)
- **Anything else** → custom block

Common custom block candidates:
- Stats / counters strip
- Logo / partner marquee
- Timeline / process steps
- Pricing table
- Featured article with category + image + body
- Map / location section
- Newsletter / contact form (non-generic)
- Sticky CTA bar
- SPA feature grids, marketing sections, product showcases, comparison tables

### Fragment detection (repeated patterns)

Before finalising the block list, check if any section appears identically on multiple pages (e.g. newsletter signup, promo banner, site-wide CTA). These should be EDS Fragments, not inline blocks:

```bash
# For multi-template mode: compare section HTML across representative URLs
grep -oP '(?<=id=")[^"]+' /tmp/page.html | sort > /tmp/ids_page1.txt
# repeat for page2, then: diff /tmp/ids_page1.txt /tmp/ids_page2.txt
```

If a section is repeated across ≥2 templates, output a note:
> **Fragment candidate**: `newsletter-signup` appears on homepage and blog listing. Create `/fragments/newsletter-signup` and reference it via a `Fragment` block instead of embedding per-page.

---

## Step 4 — Scaffold custom blocks

### 4a. Name (kebab-case, max 3 words)

### 4b. Authored content structure (Google Doc table contract)

```
| block-name        |                    |
| [image or icon]   | Heading text       |
|                   | Body text          |
|                   | [CTA link]         |
```

### 4c. blocks/{name}/{name}.js

```js
import { createOptimizedPicture } from '../../scripts/aem.js';

export default function decorate(block) {
  const rows = [...block.children];

  rows.forEach((row) => {
    const [left, right] = [...row.children];
    if (left) left.classList.add('{name}-media');
    if (right) right.classList.add('{name}-content');
  });

  // Remap lazy-loaded images (data-src → src)
  block.querySelectorAll('img[data-src]').forEach((img) => {
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
  });

  block.querySelectorAll('picture > img').forEach((img) =>
    img.closest('picture').replaceWith(
      createOptimizedPicture(img.src, img.alt, false, [{ width: '750' }])
    )
  );
}
```

### 4d. blocks/{name}/{name}.css

```css
/* {name} block */
.{name} { /* mobile-first */ }
.{name} .{name}-media { /* image/icon */ }
.{name} .{name}-content { /* text/CTA */ }

@media (min-width: 600px) { .{name} { /* tablet */ } }
@media (min-width: 900px) { .{name} { /* desktop */ } }
```

Rules:
- Mobile-first, `min-width` queries at 600px / 900px / 1200px
- Every selector scoped to `.{name}`
- No Tailwind, no CSS frameworks
- Avoid `.{name}-container` and `.{name}-wrapper`

---

## Step 5 — Extract nav and footer

EDS requires authored nav and footer content. Extract and scaffold these when they exist on the page.

### 5a. Nav extraction

```bash
# Server-rendered
grep -A50 '<header\|<nav' /tmp/page.html | head -80
```

Or for SPAs:
```
mcp__Claude_in_Chrome__javascript_tool:
const nav = document.querySelector('header nav') || document.querySelector('nav');
nav ? nav.innerHTML.substring(0, 5000) : 'not found'
```

Extract the nav link structure and output a `nav.md` scaffold:

```markdown
# Nav

- [Home](/)
- [About](/about)
- Products
  - [Product A](/products/a)
  - [Product B](/products/b)
- [Contact](/contact)

---

[CTA Label](/cta-path)
```

In `import.js`, skip nav from the main transform — it gets its own path:

```js
// Add to transform return array if nav path is known:
return [
  { element: main, path: '/index' },
  // nav and footer are authored separately in the CMS
];
```

### 5b. Footer extraction

```bash
grep -A100 '<footer' /tmp/page.html | head -120
```

Extract footer columns (links, legal text, social icons) and scaffold a `footer.md`:

```markdown
# Footer

## Column 1 — Company
- [About Us](/about)
- [Careers](/careers)

## Column 2 — Resources
- [Blog](/blog)
- [Docs](/docs)

---

© 2024 Company Name. [Privacy Policy](/privacy) | [Terms](/terms)
```

---

## Step 6 — Generate import.js

### Required skeleton

```js
/* global WebImporter */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function block(name, rows, doc) {
  const table = doc.createElement('table');
  const thead = doc.createElement('tr');
  const th = doc.createElement('th');
  th.setAttribute('colspan', String(Math.max(...rows.map((r) => r.length), 1)));
  th.textContent = name;
  thead.appendChild(th);
  table.appendChild(thead);
  rows.forEach((row) => {
    const tr = doc.createElement('tr');
    row.forEach((cell) => {
      const td = doc.createElement('td');
      // CRITICAL: nodeType check — instanceof Node fails in AEM Importer sandbox
      if (cell && cell.nodeType) td.appendChild(cell);
      else td.innerHTML = String(cell ?? '');
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  return table;
}

function wrapSection(el) {
  const div = document.createElement('div');
  div.appendChild(el);
  return div;
}

function primaryButton(doc, href, text) {
  const p = doc.createElement('p');
  const strong = doc.createElement('strong');
  const a = doc.createElement('a');
  a.href = href; a.textContent = text;
  strong.appendChild(a); p.appendChild(strong);
  return p;
}

function extractBgImage(el) {
  // AEM encodes '/' as '\2f' in background-image style attributes
  const m = (el?.getAttribute('style') ?? '').match(/background-image:\s*url\(([^)]+)\)/i);
  return m ? m[1].replace(/\\2f/gi, '/').replace(/['"]/g, '').trim() : null;
}

function fixLazyImages(root) {
  // Remap data-src / data-lazy-src / data-original → src
  root.querySelectorAll('img[data-src], img[data-lazy-src], img[data-original]').forEach((img) => {
    img.src = img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.src;
  });
  // Remap data-srcset → srcset
  root.querySelectorAll('img[data-srcset]').forEach((img) => {
    img.srcset = img.dataset.srcset;
  });
}

// ---------------------------------------------------------------------------
// Cleanup — exact selectors from page analysis
// ---------------------------------------------------------------------------
function cleanup(doc) {
  WebImporter.DOMUtils.remove(doc, [
    'header', 'nav', 'footer',
    // Cookie / consent banners
    '#onetrust-consent-sdk', '.cookie-banner', '[id*="cookie"]', '[class*="consent"]',
    // Chat widgets
    '[class*="chat-widget"]', '#drift-widget', '#intercom-container',
    // Sticky bars / overlays
    '.sticky-header', '[data-sticky]', '#app-loading', '.loading-overlay',
    // Skip links
    '.skip-to-content', '#skip-link',
    // ADD page-specific confirmed selectors here
  ]);
}

// ---------------------------------------------------------------------------
// Metadata — enriched with OG, Twitter, hreflang, JSON-LD
// ---------------------------------------------------------------------------
function buildMetadata(doc) {
  const meta = {};

  const title = doc.querySelector('title');
  if (title) meta.Title = title.textContent.trim();

  const desc = doc.querySelector('meta[name="description"]');
  if (desc) meta.Description = desc.getAttribute('content');

  const ogImg = doc.querySelector('meta[property="og:image"]');
  if (ogImg) meta.Image = ogImg.getAttribute('content');

  const canonical = doc.querySelector('link[rel="canonical"]');
  if (canonical) meta['Canonical URL'] = canonical.getAttribute('href');

  // Open Graph
  const ogType = doc.querySelector('meta[property="og:type"]');
  if (ogType) meta['OG Type'] = ogType.getAttribute('content');

  const ogTitle = doc.querySelector('meta[property="og:title"]');
  if (ogTitle) meta['OG Title'] = ogTitle.getAttribute('content');

  // Twitter Card
  const twitterCard = doc.querySelector('meta[name="twitter:card"]');
  if (twitterCard) meta['Twitter Card'] = twitterCard.getAttribute('content');

  const twitterTitle = doc.querySelector('meta[name="twitter:title"]');
  if (twitterTitle) meta['Twitter Title'] = twitterTitle.getAttribute('content');

  // Robots
  const robots = doc.querySelector('meta[name="robots"]');
  if (robots) meta.Robots = robots.getAttribute('content');

  // hreflang — collect all language alternates
  const hreflangs = [...doc.querySelectorAll('link[rel="alternate"][hreflang]')];
  if (hreflangs.length > 0) {
    meta.hreflang = hreflangs
      .map((l) => `${l.getAttribute('hreflang')}: ${l.getAttribute('href')}`)
      .join('\n');
  }

  // JSON-LD structured data — preserve as-is in a code block
  const jsonLd = doc.querySelector('script[type="application/ld+json"]');
  if (jsonLd) {
    try {
      const parsed = JSON.parse(jsonLd.textContent);
      meta['Schema Type'] = parsed['@type'] || '';
    } catch (_) { /* ignore malformed JSON-LD */ }
  }

  return block('Metadata', Object.entries(meta).map(([k, v]) => [k, v ?? '']), doc);
}

// ---------------------------------------------------------------------------
// Fix links and image srcs
// ---------------------------------------------------------------------------
function fixLinks(main, url) {
  const { origin, hostname } = new URL(url);
  main.querySelectorAll('a[href]').forEach((a) => {
    try {
      const abs = new URL(a.getAttribute('href'), origin);
      a.href = abs.hostname === hostname
        ? abs.pathname + abs.search + abs.hash : abs.href;
    } catch (_) { /* leave malformed hrefs */ }
  });
  main.querySelectorAll('img[src]').forEach((img) => {
    try { img.src = new URL(img.getAttribute('src'), origin).href; } catch (_) { /* skip */ }
  });
}

// ---------------------------------------------------------------------------
// Section transformers — one per identified section
// ---------------------------------------------------------------------------
function transformHero(main, doc) { /* ... */ }
function transformCards(main, doc) { /* ... */ }
// function transformStatsStrip(main, doc) { /* custom block */ }

// ---------------------------------------------------------------------------
// Forms — scaffold as EDS form reference block (do not drop silently)
// ---------------------------------------------------------------------------
function transformForms(main, doc) {
  main.querySelectorAll('form').forEach((form) => {
    // Replace form with a Forms block pointing to a future /forms/ path
    const formId = form.id || form.getAttribute('name') || 'contact';
    const formTable = block('Form', [[`/forms/${formId}`]], doc);
    form.replaceWith(formTable);
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default {
  transform({ document: doc, url }) {
    cleanup(doc);
    const main = doc.querySelector('main') || doc.body;
    fixLinks(main, url);
    fixLazyImages(main);

    // Section transformers — call in page order
    transformHero(main, doc);
    transformCards(main, doc);
    transformForms(main, doc);
    // transformStatsStrip(main, doc);

    main.appendChild(wrapSection(buildMetadata(doc)));

    return [{ element: main, path: new URL(url).pathname.replace(/\/$/, '') || '/index' }];
  },
};
```

---

## Step 7 — Post-import validation checklist

After generating import.js, run it in [tools.aem.page/importer](https://tools.aem.page/importer) and verify each item:

| Check | Pass criteria |
|---|---|
| No `[object HTML*Element]` strings | Search output markdown for `[object` — must be zero results |
| No empty block cells | Every `<td>` in block tables has content |
| Images load | All `<img>` have valid absolute `src` URLs; no `data-src` remaining |
| Background images extracted | No sections are missing their hero/banner imagery |
| Links are relative for same-domain | Internal links use `/path` not `https://domain/path` |
| Forms handled | No raw `<form>` elements in output; replaced with Form block or removed intentionally |
| Cookie/chat/sticky bars removed | No `.cookie-banner`, `#drift-widget`, etc. in output |
| Metadata block present | Last section is a Metadata block with Title and Description |
| OG/Twitter meta populated | Metadata block includes Image, OG Type, Twitter Card |
| hreflang captured | Multilingual pages have hreflang entries in Metadata |
| Nav/footer extracted | `nav.md` and `footer.md` scaffolds provided (or noted as manual) |
| PageSpeed target | Run [PageSpeed Insights](https://pagespeed.web.dev/) against the preview URL after publishing — target score: 100 |

Output this checklist in the migration report. Mark each item ✅ (verified), ⚠️ (needs manual check), or ❌ (failed — fix before merging).

---

## Step 8 — Save all files and report

Save:
- `tools/importer/import.js`
- `blocks/{custom-name}/{custom-name}.js` (one per custom block)
- `blocks/{custom-name}/{custom-name}.css` (one per custom block)
- `nav.md` scaffold (if nav was extractable)
- `footer.md` scaffold (if footer was extractable)

Output the **migration report**:

### Block mapping table

| Page section | Selector used | EDS block | Source | Page type |
|---|---|---|---|---|
| Hero banner | `.hero-wrapper` | `Hero` | Boilerplate | SPA (React) |
| Feature cards | `.feature-grid .card` | `Cards` | Boilerplate | SPA (React) |
| Stats strip | `.stats-container` | `stats-strip` | **Custom (created)** | SPA (React) |
| FAQ section | `.accordion` | `Accordion` | Block Party | Server-rendered |
| Contact form | `form#contact` | `Form` | **Scaffolded** | Server-rendered |

### Fragment candidates
> Any sections flagged as repeated across templates

### Block Party blocks needed
> Copy from https://github.com/adobe/aem-block-collection/tree/main/blocks/ into `blocks/`: `accordion`, `carousel`

### Post-import validation checklist
> (See Step 7 — mark each item ✅ / ⚠️ / ❌)

---

## Reference: Common class patterns

### AEM server-rendered
- `cmp-` — Core Components (`cmp-teaser`, `cmp-image`, `cmp-text`, `cmp-button`)
- `cmp-teaser__*` — `__title`, `__description`, `__pretitle`, `__image`, `__action-link`
- `cmp-experiencefragment--*` — Experience Fragment; suffix = fragment name
- `cmp-container-full` — Full-width container; may have background-image in style
- `aem-Grid` — Responsive grid wrapper (safe to unwrap)

### SPA / React / Next.js
- `__next`, `_app`, `.css-[hash]` (styled-components/emotion)
- Tailwind: `flex`, `grid`, `container`, `mx-auto`, `text-*`, `bg-*`
- BEM-like: `[component]__[element]--[modifier]`
- Data attributes: `data-testid`, `data-component`, `data-section`

### Vue / Angular
- Vue: `[data-v-hash]` scoped attribute selectors
- Angular: `_nghost-*`, `_ngcontent-*`

For Tailwind-heavy SPAs, identify sections by **structural role** and DOM position rather than class names. Use `data-testid`, `aria-label`, or `nth-child` selectors.

---

## Pitfalls

- Never use `instanceof Node` — use `cell.nodeType`
- Never remove `main` — the importer needs it as the root
- AEM encodes `/` as `\2f` in style background URLs — always use `extractBgImage()`
- Experience Fragments render inline — treat as regular DOM, not as separate requests
- Block CSS must scope every selector to `.{blockname}` — never bare class names
- SPA lazy-loaded content: scroll in the browser tool before extracting selectors — sections below the fold may not exist in the initial DOM snapshot
- SPA pages: AEM Importer runs in a real browser so JS executes — your selectors target the rendered DOM, same as Step 1c output
- In incremental mode: read the existing import.js fully before editing — never accidentally drop a working transformer
- Forms: never silently drop forms — scaffold a Form block pointing to `/forms/<id>` so the author can wire it up later
