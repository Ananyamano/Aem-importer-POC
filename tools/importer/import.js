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
  // background-image style → <img>
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
// Noise removal — selectors that reliably indicate chrome, not content
// ---------------------------------------------------------------------------
const NOISE_SELECTORS = [
  // structural chrome
  'header', 'nav', 'footer', 'aside',
  '[role="banner"]', '[role="navigation"]', '[role="contentinfo"]',
  // scripts / styles / tracking pixels
  'script', 'style', 'noscript', 'link[rel="stylesheet"]',
  'img[width="1"]', 'img[height="1"]',
  // cookie / consent / modals
  '#onetrust-consent-sdk', '#consent_blackbar',
  '.cookie-banner', '[id*="cookie"]', '[class*="cookie-"]',
  '[id*="modal"]', '[class*="modal"]',
  '[id*="overlay"]', '[class*="overlay"]',
  '[id*="popup"]', '[class*="popup"]',
  // common CMS chrome
  '[id="header"]', '[id="footer"]',
  '[class*="site-header"]', '[class*="site-footer"]',
  '[class*="sticky-"]', '[class*="notification-"]',
  '[aria-hidden="true"]',
];

function removeNoise(doc) {
  NOISE_SELECTORS.forEach((sel) => {
    try {
      doc.querySelectorAll(sel).forEach((el) => el.remove());
    } catch (_) { /* invalid selector in some browsers */ }
  });
  // Remove empty elements that add no value
  doc.querySelectorAll('div:empty, span:empty, p:empty').forEach((el) => el.remove());
}

// ---------------------------------------------------------------------------
// Generic content extraction
// ---------------------------------------------------------------------------

/**
 * Find the best "main content" container in priority order:
 * <main>, [role="main"], <article>, largest <section>, <body>
 */
function findMainContent(doc) {
  const candidates = [
    doc.querySelector('main'),
    doc.querySelector('[role="main"]'),
    doc.querySelector('article'),
    doc.querySelector('#content'),
    doc.querySelector('#main-content'),
    doc.querySelector('.main-content'),
    doc.querySelector('.content'),
    doc.querySelector('.page-content'),
  ];
  return candidates.find(Boolean) || doc.body;
}

// ---------------------------------------------------------------------------
// Generic transform — works for any URL
// ---------------------------------------------------------------------------
function transformGeneric(doc, url) {
  // 1. Remove all noise (nav, footer, scripts, modals, etc.)
  removeNoise(doc);

  // 2. Resolve lazy images and absolute links before we move anything
  fixLazyImages(doc.body);
  fixLinks(doc.body, url);

  // 3. Find best content area
  const content = findMainContent(doc);

  // 4. Build the output: content + metadata section
  const staging = doc.createElement('div');

  // Clone content children into staging
  [...content.childNodes].forEach((node) => staging.appendChild(node.cloneNode(true)));

  // Metadata goes in its own section div at the end
  const metaSection = doc.createElement('div');
  metaSection.appendChild(buildMetadata(doc));
  staging.appendChild(metaSection);

  // 5. Wipe body completely — the importer clones the full live document
  // (header + nav + main + footer) before calling transform. Simply returning
  // a sub-element is not enough; we must clear body so nothing else leaks.
  while (doc.body.firstChild) doc.body.removeChild(doc.body.firstChild);
  while (staging.firstChild) doc.body.appendChild(staging.firstChild);

  const { pathname } = new URL(url);
  const parsed = new URL(url);
  const hostParam = parsed.searchParams.get('host');
  const realPath = hostParam
    ? new URL(parsed.pathname, hostParam).pathname
    : pathname;

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
