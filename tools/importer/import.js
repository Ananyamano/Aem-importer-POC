/* global WebImporter */ // eslint-disable-line no-unused-vars

// ---------------------------------------------------------------------------
// Shared helpers
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
      if (cell && cell.nodeType) td.appendChild(cell);
      else td.innerHTML = String(cell ?? '');
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  return table;
}

function buildMetadata(doc) {
  const meta = {};

  const title = doc.querySelector('title');
  if (title) meta.Title = title.textContent.trim();

  const desc = doc.querySelector('meta[name="description"]');
  if (desc) meta.Description = desc.getAttribute('content');

  const ogImg = doc.querySelector('meta[property="og:image"]');
  if (ogImg) meta.Image = ogImg.getAttribute('content');

  const ogTitle = doc.querySelector('meta[property="og:title"]');
  if (ogTitle) meta['OG Title'] = ogTitle.getAttribute('content');

  const twitterTitle = doc.querySelector('meta[name="twitter:title"]');
  if (twitterTitle) meta['Twitter Title'] = twitterTitle.getAttribute('content');

  const twitterDesc = doc.querySelector('meta[name="twitter:description"]');
  if (twitterDesc) meta['Twitter Description'] = twitterDesc.getAttribute('content');

  const canonical = doc.querySelector('link[rel="canonical"]');
  if (canonical) meta['Canonical URL'] = canonical.getAttribute('href');

  const robots = doc.querySelector('meta[name="robots"]');
  if (robots) meta.Robots = robots.getAttribute('content');

  const hreflangs = [...doc.querySelectorAll('link[rel="alternate"][hreflang]')];
  if (hreflangs.length > 0) {
    meta.hreflang = hreflangs
      .map((l) => `${l.getAttribute('hreflang')}: ${l.getAttribute('href')}`)
      .join('\n');
  }

  const jsonLd = doc.querySelector('script[type="application/ld+json"]');
  if (jsonLd) {
    try {
      const parsed = JSON.parse(jsonLd.textContent);
      if (parsed['@type']) meta['Schema Type'] = parsed['@type'];
    } catch (_) { /* ignore */ }
  }

  return block('Metadata', Object.entries(meta).map(([k, v]) => [k, v ?? '']), doc);
}

function fixLazyImages(root) {
  root.querySelectorAll('img[data-src], img[data-lazy-src], img[data-original]').forEach((img) => {
    img.src = img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.src;
  });
  root.querySelectorAll('img[data-srcset]').forEach((img) => {
    img.srcset = img.dataset.srcset;
  });
  // background-image style → <img> (handles AEM \2f encoding)
  root.querySelectorAll('[style*="background-image"]').forEach((el) => {
    const m = el.getAttribute('style').match(/background-image:\s*url\(([^)]+)\)/i);
    if (!m) return;
    const raw = m[1]
      .replace(/\\2f/gi, '/')
      .replace(/\s+/g, '')
      .replace(/['"]/g, '')
      .trim();
    if (!raw) return;
    const existing = el.querySelector('img');
    if (!existing) {
      const img = el.ownerDocument.createElement('img');
      img.src = raw;
      img.alt = '';
      el.prepend(img);
    }
  });
}

function fixLinks(root, url) {
  const { origin, hostname } = new URL(url);
  root.querySelectorAll('a[href]').forEach((a) => {
    try {
      const abs = new URL(a.getAttribute('href'), origin);
      a.href = abs.hostname === hostname
        ? abs.pathname + abs.search + abs.hash
        : abs.href;
    } catch (_) { /* leave malformed */ }
  });
  root.querySelectorAll('img[src]').forEach((img) => {
    try {
      const resolved = new URL(img.getAttribute('src'), origin);
      // Importer proxies through localhost — rewrite to real origin
      if (resolved.hostname === 'localhost') {
        img.src = `${origin}${resolved.pathname}${resolved.search}`;
      } else {
        img.src = resolved.href;
      }
    } catch (_) { /* skip */ }
  });
}

// ---------------------------------------------------------------------------
// Noise removal — site-agnostic selectors covering common CMS chrome patterns
// ---------------------------------------------------------------------------
const NOISE_SELECTORS = [
  // Semantic structural chrome
  'header', 'nav', 'footer', 'aside',
  '[role="banner"]', '[role="navigation"]', '[role="contentinfo"]',
  // Scripts / styles / tracking pixels
  'script', 'style', 'noscript', 'link[rel="stylesheet"]',
  'img[width="1"]', 'img[height="1"]',
  // Cookie / consent banners
  '#onetrust-consent-sdk', '#consent_blackbar',
  '.cookie-banner', '[id*="cookie"]', '[class*="cookie-"]',
  // Modals / overlays / popups
  '[id*="modal"]', '[class*="modal"]',
  '[id*="overlay"]', '[class*="overlay"]',
  '[id*="popup"]', '[class*="popup"]',
  // Generic id/class-based chrome
  '[id="header"]', '[id="footer"]',
  '[class*="site-header"]', '[class*="site-footer"]',
  '[class*="sticky-"]', '[class*="notification-bar"]',
  // AEM Experience Fragment headers/footers
  '[class*="experiencefragment"][class*="header"]',
  '[class*="experiencefragment"][class*="footer"]',
  // Accessibility-hidden decorative elements
  '[aria-hidden="true"]',
];

function removeNoise(doc) {
  NOISE_SELECTORS.forEach((sel) => {
    try {
      doc.querySelectorAll(sel).forEach((el) => el.remove());
    } catch (_) { /* skip invalid selectors in edge-case browsers */ }
  });
  // Scrub leftover empty containers
  doc.querySelectorAll('div:empty, span:empty, p:empty').forEach((el) => el.remove());
}

// ---------------------------------------------------------------------------
// Generic content detection — finds the richest main content area
// ---------------------------------------------------------------------------
function findMainContent(doc) {
  // Priority list: semantic > role > id/class heuristics > body
  const candidates = [
    doc.querySelector('main'),
    doc.querySelector('[role="main"]'),
    doc.querySelector('article'),
    doc.querySelector('#content'),
    doc.querySelector('#main-content'),
    doc.querySelector('.main-content'),
    doc.querySelector('.content'),
    doc.querySelector('.page-content'),
    doc.querySelector('.container:not([class*="header"]):not([class*="footer"])'),
  ];
  const valid = candidates.filter(Boolean);
  if (valid.length === 0) return doc.body;
  // Prefer the candidate with the most text content
  return valid.reduce((best, el) => (
    el.textContent.length > best.textContent.length ? el : best
  ));
}

// ---------------------------------------------------------------------------
// Block builders — applied generically where recognisable patterns are found
// ---------------------------------------------------------------------------

/**
 * Convert hero-like sections (large image + heading + CTA) into Hero blocks.
 * Covers AEM cmp-generic-hero, Bootstrap jumbotron, section[has-background-img], etc.
 */
function buildHeroBlocks(content, doc) {
  const heroSelectors = [
    '.cmp-generic-hero',
    '.hero',
    '.jumbotron',
    '[class*="hero-section"]',
    '[class*="banner-section"]',
    'section[class*="has-background-img"]:first-of-type',
  ];

  heroSelectors.forEach((sel) => {
    try {
      content.querySelectorAll(sel).forEach((hero) => {
        const img = hero.querySelector('img') || hero.querySelector('picture');
        const heading = hero.querySelector('h1, h2');
        const text = hero.querySelector('p, [class*="supporting-text"], [class*="description"]');
        const cta = hero.querySelector('a[class*="button"], a[class*="btn"], a[class*="cta"]');

        if (!img && !heading) return; // not enough to be a hero

        const imageCell = doc.createElement('div');
        if (img) imageCell.appendChild(img.cloneNode(true));

        const contentCell = doc.createElement('div');
        if (heading) contentCell.appendChild(heading.cloneNode(true));
        if (text) contentCell.appendChild(text.cloneNode(true));
        if (cta) {
          const p = doc.createElement('p');
          const strong = doc.createElement('strong');
          const a = doc.createElement('a');
          a.href = cta.href;
          a.textContent = cta.textContent.trim();
          strong.appendChild(a);
          p.appendChild(strong);
          contentCell.appendChild(p);
        }

        hero.replaceWith(block('Hero', [[imageCell, contentCell]], doc));
      });
    } catch (_) { /* skip bad selectors */ }
  });
}

/**
 * Convert card grids (2+ similar sibling elements with image + heading) into Cards blocks.
 */
function buildCardBlocks(content, doc) {
  const cardSelectors = [
    '.card-item',
    '.cmp-call-out-set__item',
    '[class*="card-item"]',
    '[class*="callout-item"]',
    '[class*="card__item"]',
  ];

  const processed = new Set();

  cardSelectors.forEach((sel) => {
    try {
      content.querySelectorAll(sel).forEach((card) => {
        const parent = card.parentElement;
        if (!parent || processed.has(parent)) return;

        const siblings = [...parent.querySelectorAll(sel)];
        if (siblings.length < 2) return;
        processed.add(parent);

        const rows = siblings.map((c) => {
          const img = c.querySelector('img, picture');
          const heading = c.querySelector('h2, h3, h4, h5, [class*="title"]');
          const text = c.querySelector('p, [class*="description"], [class*="body"]');
          const link = c.querySelector('a');

          const cell = doc.createElement('div');
          if (img) cell.appendChild(img.cloneNode(true));
          if (heading) cell.appendChild(heading.cloneNode(true));
          if (text) cell.appendChild(text.cloneNode(true));
          if (link && !heading && !img) {
            const p = doc.createElement('p');
            const a = doc.createElement('a');
            a.href = link.href;
            a.textContent = link.textContent.trim();
            p.appendChild(a);
            cell.appendChild(p);
          }
          return [cell];
        });

        parent.replaceWith(block('Cards', rows, doc));
      });
    } catch (_) { /* skip bad selectors */ }
  });
}

// ---------------------------------------------------------------------------
// Generic transform — works for any URL
// ---------------------------------------------------------------------------
function transformGeneric(doc, url) {
  // 1. Remove all noise (nav, footer, AEM XF header/footer, scripts, modals, etc.)
  removeNoise(doc);

  // 2. Resolve lazy images and make links absolute before moving nodes
  fixLazyImages(doc.body);
  fixLinks(doc.body, url);

  // 3. Find the richest main content area
  const content = findMainContent(doc);

  // 4. Convert recognisable patterns into EDS blocks
  buildHeroBlocks(content, doc);
  buildCardBlocks(content, doc);

  // 5. Assemble output: content children + metadata section
  const staging = doc.createElement('div');
  [...content.childNodes].forEach((node) => staging.appendChild(node.cloneNode(true)));

  const metaSection = doc.createElement('div');
  metaSection.appendChild(buildMetadata(doc));
  staging.appendChild(metaSection);

  // 6. Wipe body completely — the importer clones the full live document
  // (header + nav + main + footer) before calling transform. Simply returning
  // a sub-element is not enough; we must clear body so nothing else leaks.
  while (doc.body.firstChild) doc.body.removeChild(doc.body.firstChild);
  while (staging.firstChild) doc.body.appendChild(staging.firstChild);

  // 7. Resolve the real output path (importer proxies via localhost?host=...)
  const parsed = new URL(url);
  const hostParam = parsed.searchParams.get('host');
  const realPath = hostParam
    ? new URL(parsed.pathname, hostParam).pathname
    : parsed.pathname;

  return [{
    element: doc.body,
    path: realPath.replace(/\/$/, '') || '/index',
  }];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default {
  transform({ document: doc, url }) {
    return transformGeneric(doc, url);
  },
};
