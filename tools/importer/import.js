/* global WebImporter */ // eslint-disable-line no-unused-vars
/* eslint-disable no-console */
/*
 * Single-file aem-importer entry point.
 *
 * Two modes:
 *   1. Loaded by the AEM Importer (https://tools.aem.page/importer/) as an
 *      ESM module — the `export default { transform }` below is what the
 *      importer calls in a browser to convert a live page into a docx.
 *   2. Run via Node CLI — `node tools/importer/import.js --url <URL>` —
 *      launches headless Chrome via puppeteer, captures site-wide tokens
 *      + per-block computed styles + @font-face + state rules, fetches
 *      the source HTML, extracts <form> field definitions, and writes:
 *        styles/imported-tokens.css
 *        blocks/<name>/<name>.imported.css           (boilerplate / Block Party)
 *        blocks/<name>/<name>.css                    (custom)
 *        forms/<id>.json                              (Sheet format)
 *        tools/importer/.font-inventory.md
 *        tools/importer/.css-capture.json            (intermediate JSON)
 *
 *      Browser parsing is unaffected: the CLI guard `typeof process !==
 *      'undefined'` is false in the AEM Importer iframe, so the Node code
 *      below is parsed but never executed there.
 */

// ============================================================================
// PART 1 — AEM Importer transform (runs in browser inside tools.aem.page)
// ============================================================================

// ---------------------------------------------------------------------------
// Null-safe DOM helpers
// ---------------------------------------------------------------------------
function qs(root, sel) {
  if (!root || typeof root.querySelector !== 'function') return null;
  try { return root.querySelector(sel); } catch (_) { return null; }
}

function qsa(root, sel) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  try { return [...root.querySelectorAll(sel)]; } catch (_) { return []; }
}

const STEP_LOG = [];
function step(label, fn) {
  try {
    const out = fn();
    STEP_LOG.push(`${label}: ok${out == null ? ' (null result)' : ''}`);
    return out;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    STEP_LOG.push(`${label}: FAIL — ${msg}`);
    console.warn(`[importer] step "${label}" failed:`, msg);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Block builder
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
      if (Array.isArray(cell)) {
        cell.forEach((c) => {
          if (c && c.nodeType) td.appendChild(c);
          else if (c != null) td.insertAdjacentHTML('beforeend', String(c));
        });
      } else if (cell && cell.nodeType) {
        td.appendChild(cell);
      } else {
        td.innerHTML = String(cell ?? '');
      }
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  return table;
}

function wrapSection(el, doc) {
  const div = (doc || document).createElement('div');
  if (el) div.appendChild(el);
  return div;
}

function makeButton(doc, href, text) {
  const p = doc.createElement('p');
  const strong = doc.createElement('strong');
  const a = doc.createElement('a');
  a.href = href;
  a.textContent = (text || 'Learn more').trim();
  strong.appendChild(a);
  p.appendChild(strong);
  return p;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
function buildMetadata(doc) {
  const meta = {};
  const get = (sel, attr = 'content') => {
    const el = qs(doc, sel);
    return el ? el.getAttribute(attr) : null;
  };

  const title = qs(doc, 'title');
  if (title) meta.Title = title.textContent.trim();

  const desc = get('meta[name="description"]');
  if (desc) meta.Description = desc;

  const ogImg = get('meta[property="og:image"]');
  if (ogImg) meta.Image = ogImg;

  const ogTitle = get('meta[property="og:title"]');
  if (ogTitle) meta['OG Title'] = ogTitle;

  const ogType = get('meta[property="og:type"]');
  if (ogType) meta['OG Type'] = ogType;

  const ogUrl = get('meta[property="og:url"]');
  if (ogUrl) meta['OG URL'] = ogUrl;

  const twitterCard = get('meta[name="twitter:card"]') || get('meta[property="twitter:card"]');
  if (twitterCard) meta['Twitter Card'] = twitterCard;

  const twitterTitle = get('meta[name="twitter:title"]') || get('meta[property="twitter:title"]');
  if (twitterTitle) meta['Twitter Title'] = twitterTitle;

  const canonical = get('link[rel="canonical"]', 'href');
  if (canonical) meta['Canonical URL'] = canonical;

  const robots = get('meta[name="robots"]');
  if (robots) meta.Robots = robots;

  const hreflangs = qsa(doc, 'link[rel="alternate"][hreflang]');
  if (hreflangs.length > 0) {
    meta.hreflang = hreflangs
      .map((l) => `${l.getAttribute('hreflang')}: ${l.getAttribute('href')}`)
      .join('\n');
  }

  return block('Metadata', Object.entries(meta).map(([k, v]) => [k, v ?? '']), doc);
}

// ---------------------------------------------------------------------------
// Image / link normalisation
// ---------------------------------------------------------------------------
function fixLazyImages(root) {
  qsa(root, 'img[data-src], img[data-lazy-src], img[data-original]').forEach((img) => {
    img.src = img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.src;
  });
}

function fixLinks(root, url) {
  let origin;
  let hostname;
  try {
    const u = new URL(url);
    origin = u.origin;
    hostname = u.hostname;
  } catch (_) { return; }

  qsa(root, 'a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    // eslint-disable-next-line no-script-url
    const JS_URL = 'javascript:';
    if (!href || href.startsWith(JS_URL) || href.startsWith('#')) return;
    try {
      const abs = new URL(href, origin);
      a.href = abs.hostname === hostname
        ? abs.pathname + abs.search + abs.hash
        : abs.href;
    } catch (_) { /* skip */ }
  });

  qsa(root, 'img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src || src === '//:0') return;
    try { img.src = new URL(src, origin).href; } catch (_) { /* skip */ }
  });
}

// ---------------------------------------------------------------------------
// Cleanup — site-agnostic chrome + framework-specific selectors
// ---------------------------------------------------------------------------
const NOISE_SELECTORS = [
  // Semantic chrome
  'header', 'nav', 'footer', 'aside',
  '[role="banner"]', '[role="navigation"]', '[role="contentinfo"]',
  // Scripts / styles / tracking
  'script', 'style', 'noscript', 'link[rel="stylesheet"]', 'iframe',
  'img[width="1"]', 'img[height="1"]',
  // Cookie / consent
  '#onetrust-consent-sdk', '.cookie-banner',
  '[id*="cookie"]', '[class*="cookie-"]',
  // Modals / overlays / popups
  '[id*="modal"]', '[class*="modal"]',
  '[id*="overlay"]', '[class*="overlay"]',
  '[id*="popup"]', '[class*="popup"]',
  // Next.js / component-library chrome
  '[class*="header-component-module__header"]',
  '[class*="footer-component-module__footer"]',
  '[class*="brand-logo-component-module__brandLogo"]',
  '[class*="tertiary-navigation-component"]',
  '[class*="quaternary-nav-item-component"]',
  '[class*="accordion-menu-component"]',
  '[class*="menu-item-component-module__menuItem"]',
  '[class*="pop-over-component-module__popOverItem"]',
  // Decorative blanket overlays / icons
  '[class*="_blanket_"]', '[data-testid="blanket-component"]',
  '[data-testid="icon-component"]',
];

function cleanup(doc) {
  NOISE_SELECTORS.forEach((sel) => {
    qsa(doc, sel).forEach((el) => {
      try { el.remove(); } catch (_) { /* skip */ }
    });
  });
}

// ---------------------------------------------------------------------------
// Section transformers
// ---------------------------------------------------------------------------
function heroFromSection(section, doc) {
  const desktopImg = qs(section, '[class*="_desktopImage_"] img, picture img, img');
  const heading = qs(section, 'h1, h2');
  const body = qs(section, '[class*="_text_"] p, [data-testid="sanitise-html-component"]');
  const cta = qs(section, '[data-testid="button-component"][href], a[class*="_button_"][href]');

  if (!desktopImg && !heading) return null;

  const imageCell = doc.createElement('div');
  if (desktopImg) {
    const img = doc.createElement('img');
    img.src = desktopImg.getAttribute('src') || '';
    img.alt = desktopImg.getAttribute('alt') || '';
    imageCell.appendChild(img);
  }

  const contentCell = doc.createElement('div');
  if (heading) {
    const h = doc.createElement('h1');
    h.textContent = (heading.textContent || '').replace(/\s+/g, ' ').trim();
    contentCell.appendChild(h);
  }
  if (body) {
    const p = doc.createElement('p');
    p.textContent = (body.textContent || '').replace(/\s+/g, ' ').trim();
    contentCell.appendChild(p);
  }
  if (cta && cta.href) {
    contentCell.appendChild(makeButton(doc, cta.href, cta.textContent));
  }

  return block('Hero', [[imageCell, contentCell]], doc);
}

function transformSlideshow(main, doc) {
  const slideshow = qs(main, '[data-testid="slide-show__wrapper"], [class*="slide-show_component_slide-show"]');
  if (!slideshow) return null;

  const slides = qsa(slideshow, '[data-testid="hero-banner-component"]');
  if (slides.length === 0) return null;

  const rows = slides.map((slide) => {
    const desktopImg = qs(slide, '[class*="_desktopImage_"] img, img');
    const heading = qs(slide, 'h1, h2');
    const body = qs(slide, '[class*="_text_"] p, [data-testid="sanitise-html-component"]');
    const cta = qs(slide, '[data-testid="button-component"][href]');

    const left = doc.createElement('div');
    if (desktopImg) {
      const img = doc.createElement('img');
      img.src = desktopImg.getAttribute('src') || '';
      img.alt = desktopImg.getAttribute('alt') || '';
      left.appendChild(img);
    }

    const right = doc.createElement('div');
    if (heading) {
      const h = doc.createElement('h2');
      h.textContent = (heading.textContent || '').replace(/\s+/g, ' ').trim();
      right.appendChild(h);
    }
    if (body) {
      const p = doc.createElement('p');
      p.textContent = (body.textContent || '').replace(/\s+/g, ' ').trim();
      right.appendChild(p);
    }
    if (cta && cta.href) {
      right.appendChild(makeButton(doc, cta.href, cta.textContent));
    }
    return [left, right];
  });

  const carousel = block('Carousel', rows, doc);
  if (slideshow.parentNode) slideshow.parentNode.replaceChild(carousel, slideshow);
  return carousel;
}

function transformStandaloneHeroes(main, doc) {
  const heroes = qsa(main, '[data-testid="hero-banner-component"]');
  let count = 0;
  heroes.forEach((section) => {
    if (qs(section.parentNode, '[class*="slide-show_component"]')) return;
    const hero = heroFromSection(section, doc);
    if (!hero) return;
    if (section.parentNode) {
      section.parentNode.replaceChild(hero, section);
      count += 1;
    }
  });
  return count;
}

function transformPromoPanels(main, doc) {
  const panels = qsa(main, '[class*="promo-panel-component-module__promoPanel"]');
  if (panels.length === 0) return null;

  const groups = new Map();
  panels.forEach((panel) => {
    const parent = panel.closest('[class*="promo-navigation-component"]')?.parentElement
      || panel.parentElement;
    if (!parent) return;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(panel);
  });

  let emitted = 0;
  groups.forEach((cards, parent) => {
    if (cards.length < 2) return;
    const rows = cards.map((card) => {
      const img = qs(card, 'img');
      const heading = qs(card, 'h2, h3');
      const link = qs(card, 'a[href]');

      const left = doc.createElement('div');
      if (img && img.getAttribute('src')) {
        const i = doc.createElement('img');
        i.src = img.getAttribute('src');
        i.alt = img.getAttribute('alt') || '';
        left.appendChild(i);
      }

      const right = doc.createElement('div');
      if (heading) {
        const h = doc.createElement('h3');
        h.textContent = (heading.textContent || '').replace(/\s+/g, ' ').trim();
        right.appendChild(h);
      }
      if (link && link.href) {
        right.appendChild(makeButton(doc, link.href, 'Read more'));
      }
      return [left, right];
    });
    const tbl = block('Cards', rows, doc);
    parent.parentNode.replaceChild(tbl, parent);
    emitted += 1;
  });
  return emitted;
}

function transformContentCardContainer(main, doc) {
  const cards = qsa(main, '[class*="content-card-container_component_card-wrapper"]');
  if (cards.length === 0) return null;

  const groups = new Map();
  cards.forEach((c) => {
    const p = c.parentElement;
    if (!p) return;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(c);
  });

  let emitted = 0;
  groups.forEach((cardList, parent) => {
    if (cardList.length < 2) return;
    const rows = cardList.map((card) => {
      const img = qs(card, 'img');
      const heading = qs(card, '[class*="table-card__heading"], h2, h3');
      const sub = qs(card, '[class*="table-card__subheading"], [class*="_body-size"]');
      const link = qs(card, 'a[href]');

      const left = doc.createElement('div');
      if (img && img.getAttribute('src')) {
        const i = doc.createElement('img');
        i.src = img.getAttribute('src');
        i.alt = img.getAttribute('alt') || '';
        left.appendChild(i);
      }

      const right = doc.createElement('div');
      if (heading) {
        const h = doc.createElement('h3');
        h.textContent = (heading.textContent || '').replace(/\s+/g, ' ').trim();
        if (h.textContent) right.appendChild(h);
      }
      if (sub) {
        const p = doc.createElement('p');
        p.textContent = (sub.textContent || '').replace(/\s+/g, ' ').trim();
        if (p.textContent) right.appendChild(p);
      }
      if (link && link.href) {
        right.appendChild(makeButton(doc, link.href, link.textContent));
      }
      return [left, right];
    });
    const tbl = block('Cards', rows, doc);
    parent.parentNode.replaceChild(tbl, parent);
    emitted += 1;
  });
  return emitted;
}

function transformForms(main, doc) {
  const tables = [];
  qsa(main, 'form').forEach((form) => {
    const rawId = form.id || form.getAttribute('name') || 'flight-search';
    const formId = rawId.toLowerCase().replace(/_/g, '-');
    const t = block('Form', [[`/forms/${formId}.json`]], doc);
    try {
      if (form.parentNode) form.replaceWith(t);
    } catch (_) { /* skip */ }
    tables.push(t);
  });
  return tables;
}

// ---------------------------------------------------------------------------
// Main export — what tools.aem.page/importer calls.
// ---------------------------------------------------------------------------
export default {
  transform({ document: doc, url }) {
    if (!doc || !doc.body) {
      console.warn('[importer] aborted: doc or doc.body is null');
      return [];
    }

    step('cleanup', () => cleanup(doc));

    const main = doc.body;
    STEP_LOG.push(`main: tag=${main.tagName}, body=${!!doc.body}`);

    step('fixLazyImages', () => fixLazyImages(main));
    step('fixLinks', () => fixLinks(main, url));

    const carousel = step('transformSlideshow', () => transformSlideshow(main, doc));
    const standaloneCount = step('transformStandaloneHeroes', () => transformStandaloneHeroes(main, doc));
    const promoCount = step('transformPromoPanels', () => transformPromoPanels(main, doc));
    const cardCount = step('transformContentCardContainer', () => transformContentCardContainer(main, doc));
    const formTables = step('transformForms', () => transformForms(main, doc)) || [];

    STEP_LOG.push(`slideshow=${!!carousel} standaloneHeroes=${standaloneCount} promoGroups=${promoCount} cardGroups=${cardCount} formTables=${formTables.length}`);

    const staging = doc.createElement('div');
    if (carousel) staging.appendChild(wrapSection(carousel, doc));

    qsa(main, 'table').forEach((t) => {
      const head = qs(t, 'tr > th');
      const name = head ? (head.textContent || '').trim() : '';
      if (/^(Hero|Cards|Form)$/i.test(name) && t.parentElement !== staging) {
        if (name.toLowerCase() === 'carousel') return;
        staging.appendChild(wrapSection(t, doc));
      }
    });

    formTables.forEach((t) => {
      if (!t.isConnected || !staging.contains(t)) {
        if (!t.parentElement || t.parentElement !== staging) {
          staging.appendChild(wrapSection(t, doc));
        }
      }
    });

    staging.appendChild(wrapSection(buildMetadata(doc), doc));

    const debugWrap = doc.createElement('div');
    const dh = doc.createElement('h4');
    dh.textContent = 'Importer debug';
    debugWrap.appendChild(dh);
    STEP_LOG.forEach((line) => {
      const p = doc.createElement('p');
      p.textContent = line;
      debugWrap.appendChild(p);
    });
    staging.appendChild(wrapSection(debugWrap, doc));

    const restaged = step('restage body', () => {
      const target = doc.body;
      if (!target) return false;
      while (target.firstChild) target.removeChild(target.firstChild);
      while (staging.firstChild) target.appendChild(staging.firstChild);
      return true;
    });

    let path = '/index';
    try {
      const p = new URL(url).pathname.replace(/\/$/, '');
      path = p || '/index';
    } catch (_) { /* keep default */ }

    const finalElement = (restaged && doc.body && doc.body.firstChild) ? doc.body : staging;
    return [{ element: finalElement, path }];
  },
};

// ============================================================================
// PART 2 — Node CLI (runs only when invoked via `node tools/importer/import.js`)
//
// In the AEM Importer iframe the global `process` is undefined, so the guard
// below is false and none of the CLI code below runs in the browser.
// ============================================================================

// ---------------------------------------------------------------------------
// CSS extractor — injected into the puppeteer-controlled page via
// page.evaluate(). Defined as a regular function so puppeteer can call
// fn.toString() and run the source inside the browser. Template literals,
// `document`, `window`, `getComputedStyle` etc. resolve in the page context.
// ---------------------------------------------------------------------------
function browserExtractor() {
  /* eslint-disable no-underscore-dangle, no-restricted-syntax */
  const RESTING_PROPS = [
    'display', 'flex-direction', 'flex-wrap', 'justify-content',
    'align-items', 'align-content', 'gap',
    'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'grid-auto-rows',
    'padding', 'margin', 'width', 'max-width', 'min-height', 'height',
    'aspect-ratio', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'overflow',
    'color', 'background-color', 'background-image', 'background-size', 'background-position',
    'border', 'border-radius', 'outline', 'box-shadow',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
    'text-align', 'text-transform', 'text-decoration', 'white-space', 'opacity', 'transform',
  ];

  const TOKEN_TARGETS = {
    '--background-color': ['body', 'background-color'],
    '--text-color': ['body', 'color'],
    '--link-color': ['main a[href]:not(nav a):not(footer a), article a[href], a[href]', 'color'],
    '--body-font-family': ['body', 'font-family'],
    '--heading-font-family': ['h1, h2, h3', 'font-family'],
    '--heading-font-size-xxl': ['h1', 'font-size'],
    '--heading-font-size-xl': ['h2', 'font-size'],
    '--heading-font-size-l': ['h3', 'font-size'],
    '--heading-font-size-m': ['h4', 'font-size'],
    '--heading-font-size-s': ['h5', 'font-size'],
    '--heading-font-size-xs': ['h6', 'font-size'],
    '--body-font-size-m': ['body', 'font-size'],
  };

  const DEFAULTS = {
    display: 'block',
    margin: '0px',
    padding: '0px',
    'background-color': 'rgba(0, 0, 0, 0)',
    'background-image': 'none',
    'border-radius': '0px',
    'box-shadow': 'none',
    opacity: '1',
    transform: 'none',
    border: '0px none rgb(0, 0, 0)',
    outline: 'rgb(0, 0, 0) none 0px',
    'white-space': 'normal',
    'letter-spacing': 'normal',
    'text-decoration': 'none solid rgb(0, 0, 0)',
    'text-transform': 'none',
  };

  function isDefault(prop, val) { return DEFAULTS[prop] === val; }

  function rgbToHex(val) {
    if (!val || typeof val !== 'string') return val;
    const rgb = val.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (rgb) {
      const hex = (n) => Number(n).toString(16).padStart(2, '0');
      return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`;
    }
    const rgba = val.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/);
    if (rgba && Number(rgba[4]) === 1) {
      const hex = (n) => Number(n).toString(16).padStart(2, '0');
      return `#${hex(rgba[1])}${hex(rgba[2])}${hex(rgba[3])}`;
    }
    return val;
  }

  function normaliseFontFamily(val) {
    if (!val) return val;
    return val.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).join(', ');
  }

  function tryQuery(sel) {
    try { return document.querySelector(sel); } catch (_) { return null; }
  }

  function safeRules(sheet) {
    try { return { rules: sheet.cssRules, error: null }; } catch (e) {
      return { rules: null, error: e.name || 'SecurityError' };
    }
  }

  function recordValue(rec, prop, raw) {
    if (!raw || isDefault(prop, raw)) return;
    if (prop.includes('color')) rec[prop] = rgbToHex(raw);
    else if (prop === 'font-family') rec[prop] = normaliseFontFamily(raw);
    else rec[prop] = raw;
  }

  function captureBlock(targets) {
    const out = {};
    if (!targets) return out;
    for (const [sel, label] of Object.entries(targets)) {
      const el = tryQuery(sel);
      if (!el) { out[label] = null; } else {
        const cs = getComputedStyle(el);
        const rec = {};
        for (const p of RESTING_PROPS) recordValue(rec, p, cs.getPropertyValue(p).trim());
        out[label] = rec;
      }
    }
    return out;
  }

  function captureTokens() {
    const out = {};
    for (const [token, [selector, prop]] of Object.entries(TOKEN_TARGETS)) {
      const el = tryQuery(selector);
      if (el) {
        const raw = getComputedStyle(el).getPropertyValue(prop).trim();
        if (raw) {
          if (prop.includes('color')) out[token] = rgbToHex(raw);
          else if (prop === 'font-family') out[token] = normaliseFontFamily(raw);
          else out[token] = raw;
        }
      }
    }
    let hoverFound = false;
    for (const sheet of document.styleSheets) {
      if (hoverFound) break;
      const { rules } = safeRules(sheet);
      if (rules) {
        for (const rule of rules) {
          if (rule.selectorText
            && /^a:hover\b/.test(rule.selectorText)
            && rule.style && rule.style.color) {
            out['--link-hover-color'] = rgbToHex(rule.style.color);
            hoverFound = true;
            break;
          }
        }
      }
    }
    return out;
  }

  function captureStateRules(targetSelectors) {
    const matches = [];
    if (!Array.isArray(targetSelectors) || targetSelectors.length === 0) return matches;
    const stateRe = /:hover\b|:focus(-visible)?\b|:active\b|::?before\b|::?after\b/;
    for (const sheet of document.styleSheets) {
      const { rules, error } = safeRules(sheet);
      if (!rules) {
        matches.push({ skipped: true, href: sheet.href || null, error: error || 'unknown' });
      } else {
        for (const rule of rules) {
          if (rule.selectorText && stateRe.test(rule.selectorText)) {
            const compounds = rule.selectorText.split(',').map((s) => s.trim());
            const hit = compounds.find((c) => targetSelectors.some((t) => c.startsWith(t)));
            if (hit) {
              matches.push({
                selectorText: rule.selectorText,
                cssText: rule.cssText,
                href: sheet.href || null,
              });
            }
          }
        }
      }
    }
    return matches;
  }

  function inventoryFonts() {
    const out = [];
    const seen = new Set();
    const skipped = [];
    for (const sheet of document.styleSheets) {
      const { rules, error } = safeRules(sheet);
      if (!rules) {
        skipped.push({ href: sheet.href || null, error: error || 'unknown' });
      } else {
        for (const rule of rules) {
          const isFontFace = (typeof CSSFontFaceRule !== 'undefined' && rule instanceof CSSFontFaceRule)
            || rule.type === 5;
          if (isFontFace) {
            const family = (rule.style.getPropertyValue('font-family') || '').replace(/['"]/g, '').trim();
            const weight = (rule.style.getPropertyValue('font-weight') || '400').trim();
            const styleVal = (rule.style.getPropertyValue('font-style') || 'normal').trim();
            const src = (rule.style.getPropertyValue('src') || '').trim();
            const key = `${family}|${weight}|${styleVal}`;
            if (family && src && !seen.has(key)) {
              seen.add(key);
              out.push({
                family, weight, style: styleVal, src, href: sheet.href || null,
              });
            }
          }
        }
      }
    }
    if (document.fonts && typeof document.fonts.forEach === 'function') {
      document.fonts.forEach((f) => {
        const family = (f.family || '').replace(/['"]/g, '').trim();
        const weight = String(f.weight || '400');
        const styleVal = String(f.style || 'normal');
        const key = `${family}|${weight}|${styleVal}`;
        if (family && !seen.has(key)) {
          seen.add(key);
          out.push({
            family, weight, style: styleVal, src: '(document.fonts)', href: null, dynamic: true,
          });
        }
      });
    }
    return { fonts: out, skippedSheets: skipped };
  }

  function inventoryStylesheets() {
    return [...document.styleSheets].map((s) => {
      let count = 0;
      let sameOrigin = true;
      try {
        const rules = s.cssRules;
        count = rules ? rules.length : 0;
      } catch (_) {
        sameOrigin = false;
      }
      return { href: s.href || null, sameOrigin, ruleCount: count };
    });
  }

  window.__aemImporter = {
    captureBlock, captureTokens, captureStateRules, inventoryFonts, inventoryStylesheets,
  };
  /* eslint-enable no-underscore-dangle, no-restricted-syntax */
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
function parseCliArgs() {
  const argv = process.argv.slice(2);
  const opts = { wait: 2000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') { opts.url = argv[i + 1]; i += 1; } else if (a === '--targets') { opts.targets = argv[i + 1]; i += 1; } else if (a === '--html') { opts.html = argv[i + 1]; i += 1; } else if (a === '--wait') { opts.wait = Number(argv[i + 1]); i += 1; } else if (a === '--skip-css') opts.skipCss = true;
    else if (a === '--skip-forms') opts.skipForms = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function cliUsage() {
  process.stderr.write([
    'usage: node tools/importer/import.js --url <url> [options]',
    '',
    '  --url         source page URL (required)',
    '  --targets     selector → EDS-class map (default tools/importer/.css-targets.json)',
    '  --html        source HTML file for form extraction (default: fetched from --url)',
    '  --wait        ms to wait after networkidle2 (default 2000)',
    '  --skip-css    skip CSS capture + emission',
    '  --skip-forms  skip form Sheet JSON extraction',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// CSS emission — diff viewports, substitute tokens, write files
// ---------------------------------------------------------------------------
const NOISE_DEFAULTS = {
  display: 'block',
  position: 'static',
  top: 'auto',
  right: 'auto',
  bottom: 'auto',
  left: 'auto',
  'z-index': 'auto',
  overflow: 'visible',
  margin: '0px',
  padding: '0px',
  width: 'auto',
  height: 'auto',
  'min-height': '0px',
  'max-width': 'none',
  'aspect-ratio': 'auto',
  'flex-direction': 'row',
  'flex-wrap': 'nowrap',
  'justify-content': 'normal',
  'align-items': 'normal',
  'align-content': 'normal',
  gap: 'normal',
  'grid-template-columns': 'none',
  'grid-template-rows': 'none',
  'grid-auto-flow': 'row',
  'grid-auto-rows': 'auto',
  'background-color': '#ffffff',
  'background-image': 'none',
  'background-size': 'auto',
  'background-position': '0% 0%',
  'border-radius': '0px',
  border: '0px none rgb(0, 0, 0)',
  outline: 'rgb(0, 0, 0) none 0px',
  'box-shadow': 'none',
  opacity: '1',
  transform: 'none',
  'text-align': 'start',
  'text-decoration': 'none',
  'text-transform': 'none',
  'white-space': 'normal',
  'letter-spacing': 'normal',
};

function isNoise(prop, value) { return NOISE_DEFAULTS[prop] === value; }

const VIEWPORT_PIXEL_PROPS = new Set(['width', 'height']);
function looksLikeViewportPixel(prop, value, viewportWidth) {
  return VIEWPORT_PIXEL_PROPS.has(prop)
    && /^\d+px$/.test(value)
    && Math.abs(parseInt(value, 10) - viewportWidth) < 8;
}

function diffViewports(at375, at768, at1280) {
  const base = {}; const tablet = {}; const desktop = {};
  if (!at375 && !at768 && !at1280) return { base, tablet, desktop };
  const all = new Set([
    ...Object.keys(at375 || {}),
    ...Object.keys(at768 || {}),
    ...Object.keys(at1280 || {}),
  ]);
  all.forEach((prop) => {
    const v375 = at375 ? at375[prop] : undefined;
    const v768 = at768 ? at768[prop] : undefined;
    const v1280 = at1280 ? at1280[prop] : undefined;
    if (v375 && looksLikeViewportPixel(prop, v375, 375)) return;
    if (v768 && looksLikeViewportPixel(prop, v768, 768)) return;
    if (v1280 && looksLikeViewportPixel(prop, v1280, 1280)) return;
    if (v375 === v768 && v768 === v1280) {
      if (v375 != null && !isNoise(prop, v375)) base[prop] = v375;
    } else if (v375 === v768 && v1280 != null && v1280 !== v768) {
      if (v375 != null && !isNoise(prop, v375)) base[prop] = v375;
      if (!isNoise(prop, v1280)) desktop[prop] = v1280;
    } else if (v768 === v1280 && v375 != null && v375 !== v768) {
      if (!isNoise(prop, v375)) base[prop] = v375;
      if (v768 != null && !isNoise(prop, v768)) tablet[prop] = v768;
    } else {
      if (v375 != null && !isNoise(prop, v375)) base[prop] = v375;
      if (v768 != null && !isNoise(prop, v768) && v768 !== v375) tablet[prop] = v768;
      if (v1280 != null && !isNoise(prop, v1280) && v1280 !== v768) desktop[prop] = v1280;
    }
  });
  return { base, tablet, desktop };
}

function buildTokenLookup(tokens) {
  const map = new Map();
  Object.entries(tokens || {}).forEach(([name, value]) => { if (value) map.set(value, name); });
  return map;
}

function substituteTokens(record, tokenLookup) {
  const out = {};
  Object.entries(record).forEach(([prop, value]) => {
    const tokenName = tokenLookup.get(value);
    out[prop] = tokenName ? `var(${tokenName})` : value;
  });
  return out;
}

function emitDeclarations(record) {
  return Object.entries(record).map(([k, v]) => `  ${k}: ${v};`).join('\n');
}

function groupLabelsByBlock(targets) {
  const out = {};
  Object.entries(targets).forEach(([label, info]) => {
    const blockName = info.block || label.replace(/^\./, '').split(/\s|[.[]/)[0];
    if (!out[blockName]) out[blockName] = { kind: info.kind || 'custom', labels: [] };
    out[blockName].labels.push(label);
  });
  return out;
}

function buildBlockCss(blockName, labels, capture, tokenLookup) {
  const sections = [];
  labels.forEach((label) => {
    const at375 = capture.blocks375 && capture.blocks375[label];
    const at768 = capture.blocks768 && capture.blocks768[label];
    const at1280 = capture.blocks1280 && capture.blocks1280[label];
    if (!at375 && !at768 && !at1280) return;
    const { base, tablet, desktop } = diffViewports(at375, at768, at1280);
    sections.push({
      label,
      base: substituteTokens(base, tokenLookup),
      tablet: substituteTokens(tablet, tokenLookup),
      desktop: substituteTokens(desktop, tokenLookup),
    });
  });
  if (sections.length === 0) return null;

  const lines = [
    `/* ${blockName} block — generated from ${capture.url || '(unknown URL)'} on ${capture.capturedAt || '(unknown)'} */`,
    '/* Review and prune: position:absolute, fixed widths, and parent-relative values may not apply in EDS context. */',
    '',
  ];
  sections.forEach((sec) => {
    if (Object.keys(sec.base).length > 0) {
      lines.push(`${sec.label} {`);
      lines.push(emitDeclarations(sec.base));
      lines.push('}');
      lines.push('');
    }
  });
  const tabletEntries = sections.filter((s) => Object.keys(s.tablet).length > 0);
  if (tabletEntries.length > 0) {
    lines.push('@media (width >= 600px) {');
    tabletEntries.forEach((sec) => {
      lines.push(`  ${sec.label} {`);
      lines.push(emitDeclarations(sec.tablet).split('\n').map((l) => `  ${l}`).join('\n'));
      lines.push('  }');
    });
    lines.push('}');
    lines.push('');
  }
  const desktopEntries = sections.filter((s) => Object.keys(s.desktop).length > 0);
  if (desktopEntries.length > 0) {
    lines.push('@media (width >= 900px) {');
    desktopEntries.forEach((sec) => {
      lines.push(`  ${sec.label} {`);
      lines.push(emitDeclarations(sec.desktop).split('\n').map((l) => `  ${l}`).join('\n'));
      lines.push('  }');
    });
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

function buildImportedTokensCss(capture) {
  const desktop = capture.tokensDesktop || {};
  const mobile = capture.tokensMobile || desktop;
  const SIZE_TOKENS = new Set([
    '--body-font-size-m', '--body-font-size-s', '--body-font-size-xs',
    '--heading-font-size-xxl', '--heading-font-size-xl', '--heading-font-size-l',
    '--heading-font-size-m', '--heading-font-size-s', '--heading-font-size-xs',
  ]);
  const baseRoot = {};
  const desktopRoot = {};
  Object.entries(desktop).forEach(([token, value]) => {
    if (SIZE_TOKENS.has(token)) {
      const mobileVal = mobile[token];
      baseRoot[token] = mobileVal || value;
      if (mobileVal && mobileVal !== value) desktopRoot[token] = value;
    } else {
      baseRoot[token] = value;
    }
  });
  const lines = [
    `/* Generated by aem-importer (import.js CLI) from ${capture.url || '(unknown URL)'} on ${capture.capturedAt || '(unknown)'}. */`,
    '/* Review and merge into styles/styles.css :root if accepted, or import this file from head.html. */',
    '',
    ':root {',
    Object.entries(baseRoot).map(([k, v]) => `  ${k}: ${v};`).join('\n'),
    '}',
    '',
  ];
  if (Object.keys(desktopRoot).length > 0) {
    lines.push('@media (width >= 900px) {');
    lines.push('  :root {');
    Object.entries(desktopRoot).forEach(([k, v]) => lines.push(`    ${k}: ${v};`));
    lines.push('  }');
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

function buildFontReport(capture) {
  const fonts = (capture.fonts && capture.fonts.fonts) || [];
  if (fonts.length === 0) return '';
  const lines = [
    '# Font inventory',
    '',
    `Source: ${capture.url}`,
    `Captured: ${capture.capturedAt}`,
    '',
    '| Family | Weight | Style | Source URL |',
    '|---|---|---|---|',
  ];
  fonts.forEach((f) => {
    const src = (f.src || '').slice(0, 200).replace(/\n/g, ' ');
    lines.push(`| ${f.family} | ${f.weight} | ${f.style} | ${src} |`);
  });
  lines.push('');
  lines.push('Licensed-CDN hosts to skip downloading: use.typekit.net, p.typekit.net, fast.fonts.net, hello.myfonts.net, cloud.typography.com.');
  lines.push('');
  return lines.join('\n');
}

async function runStylelintFix(paths) {
  if (paths.length === 0) return;
  let stylelint;
  try {
    /* eslint-disable import/no-extraneous-dependencies, import/no-unresolved */
    stylelint = (await import('stylelint')).default;
    /* eslint-enable import/no-extraneous-dependencies, import/no-unresolved */
  } catch (e) {
    process.stderr.write(`stylelint not importable; skipping autofix (${e.message})\n`);
    return;
  }
  try { await stylelint.lint({ files: paths, fix: true }); } catch (e) {
    process.stderr.write(`stylelint fix failed: ${e.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Form Sheet extraction (regex-based; works without a browser)
// ---------------------------------------------------------------------------
function attrOf(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = tag.match(re);
  return m ? m[1] : null;
}

function hasAttrOf(tag, name) {
  return new RegExp(`(?:^|\\s)${name}(?:\\s|=|>|/)`, 'i').test(tag);
}

function normaliseFormId(raw) {
  return (raw || 'form')
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function findFormsIn(html) {
  const out = [];
  const re = /<form\b[\s\S]*?<\/form>/gi;
  let m = re.exec(html);
  while (m) { out.push(m[0]); m = re.exec(html); }
  return out;
}

function extractFormId(form, fallback) {
  const openTag = form.match(/<form\b[^>]*>/i)[0];
  const id = attrOf(openTag, 'id') || attrOf(openTag, 'name') || fallback || 'form';
  return normaliseFormId(id);
}

function buildLabelMap(form) {
  const map = {};
  const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let m = re.exec(form);
  while (m) {
    const forTarget = attrOf(`<x ${m[1]}>`, 'for');
    if (forTarget) {
      const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text && !map[forTarget]) map[forTarget] = text;
    }
    m = re.exec(form);
  }
  return map;
}

function fallbackLabel(tag) {
  const aria = attrOf(tag, 'aria-label');
  return aria ? aria.trim() : null;
}

function extractInputs(form, labelMap) {
  const out = [];
  const re = /<input\b[^>]*\/?>/gi;
  let m = re.exec(form);
  while (m) {
    const tag = m[0];
    const type = (attrOf(tag, 'type') || 'text').toLowerCase();
    const skipType = type === 'submit' || type === 'button' || type === 'reset' || type === 'image';
    const name = attrOf(tag, 'name');
    const id = attrOf(tag, 'id');
    const fieldName = name || id;
    if (!skipType && fieldName) {
      out.push({
        name: fieldName,
        type,
        label: (id && labelMap[id]) || fallbackLabel(tag) || '',
        placeholder: attrOf(tag, 'placeholder') || '',
        required: hasAttrOf(tag, 'required') ? 'true' : 'false',
        options: '',
        value: attrOf(tag, 'value') || '',
      });
    }
    m = re.exec(form);
  }
  return out;
}

function extractTextareas(form, labelMap) {
  const out = [];
  const re = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  let m = re.exec(form);
  while (m) {
    const tag = `<textarea ${m[1]}>`;
    const name = attrOf(tag, 'name');
    const id = attrOf(tag, 'id');
    const fieldName = name || id;
    if (fieldName) {
      out.push({
        name: fieldName,
        type: 'textarea',
        label: (id && labelMap[id]) || fallbackLabel(tag) || '',
        placeholder: attrOf(tag, 'placeholder') || '',
        required: hasAttrOf(tag, 'required') ? 'true' : 'false',
        options: '',
        value: m[2].replace(/<[^>]+>/g, '').trim(),
      });
    }
    m = re.exec(form);
  }
  return out;
}

function extractSelectOptions(innerHtml) {
  const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  const options = [];
  let selectedValue = '';
  let om = optionRe.exec(innerHtml);
  while (om) {
    const optTag = `<option ${om[1]}>`;
    const optValue = attrOf(optTag, 'value');
    const optText = om[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const display = optText || optValue || '';
    if (display) options.push(display);
    if (hasAttrOf(optTag, 'selected')) selectedValue = display;
    om = optionRe.exec(innerHtml);
  }
  return { options, selectedValue };
}

function extractSelects(form, labelMap) {
  const out = [];
  const re = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let m = re.exec(form);
  while (m) {
    const tag = `<select ${m[1]}>`;
    const name = attrOf(tag, 'name');
    const id = attrOf(tag, 'id');
    const fieldName = name || id;
    if (fieldName) {
      const { options, selectedValue } = extractSelectOptions(m[2]);
      out.push({
        name: fieldName,
        type: 'select',
        label: (id && labelMap[id]) || fallbackLabel(tag) || '',
        placeholder: '',
        required: hasAttrOf(tag, 'required') ? 'true' : 'false',
        options: options.join('|'),
        value: selectedValue,
      });
    }
    m = re.exec(form);
  }
  return out;
}

function extractFields(form) {
  const labelMap = buildLabelMap(form);
  return [
    ...extractInputs(form, labelMap),
    ...extractTextareas(form, labelMap),
    ...extractSelects(form, labelMap),
  ];
}

function buildSheet(fields) {
  return {
    total: fields.length,
    offset: 0,
    limit: fields.length,
    data: fields,
    ':type': 'sheet',
  };
}

// ---------------------------------------------------------------------------
// Main CLI orchestration
// ---------------------------------------------------------------------------
async function runCli() {
  const opts = parseCliArgs();
  if (opts.help || !opts.url) {
    cliUsage();
    process.exit(opts.help ? 0 : 2);
  }

  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;

  const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

  // ---- 1. Fetch source HTML (used for form extraction; CSS path goes via puppeteer) ----
  let html = null;
  if (opts.html) {
    try { html = fs.readFileSync(opts.html, 'utf8'); console.log(`read ${opts.html}`); } catch (e) {
      process.stderr.write(`failed to read --html ${opts.html}: ${e.message}\n`);
    }
  } else if (!opts.skipForms) {
    try {
      const res = await fetch(opts.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (res.ok) {
        html = await res.text();
        console.log(`fetched ${opts.url} (${html.length} bytes)`);
      } else {
        process.stderr.write(`form-extraction fetch returned ${res.status}; skipping form extraction\n`);
      }
    } catch (e) {
      process.stderr.write(`form-extraction fetch failed: ${e.message}; skipping form extraction\n`);
    }
  }

  // ---- 2. Extract form Sheet JSON ----
  if (!opts.skipForms && html) {
    const forms = findFormsIn(html);
    if (forms.length === 0) {
      console.log('no <form> elements found in source HTML');
    } else {
      ensureDir('forms');
      forms.forEach((form, i) => {
        const id = extractFormId(form, `form-${i}`);
        const fields = extractFields(form);
        const sheet = buildSheet(fields);
        const outPath = path.join('forms', `${id}.json`);
        fs.writeFileSync(outPath, `${JSON.stringify(sheet, null, 2)}\n`, 'utf8');
        console.log(`wrote ${outPath} — ${fields.length} fields`);
      });
    }
  }

  // ---- 3. CSS capture via puppeteer ----
  if (opts.skipCss) {
    console.log('--skip-css set: done.');
    return;
  }

  let targets = null;
  const targetsPath = opts.targets || 'tools/importer/.css-targets.json';
  if (fs.existsSync(targetsPath)) {
    try {
      targets = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
      console.log(`using targets from ${targetsPath}`);
    } catch (e) {
      process.stderr.write(`failed to read ${targetsPath}: ${e.message}\n`);
      process.exit(2);
    }
  } else {
    console.log('no .css-targets.json found — capturing site-wide tokens only (no per-block CSS)');
  }

  /* eslint-disable import/no-unresolved, import/no-extraneous-dependencies */
  const puppeteer = (await import('puppeteer')).default;
  /* eslint-enable import/no-unresolved, import/no-extraneous-dependencies */

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const capture = { url: opts.url, capturedAt: new Date().toISOString() };

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
      await page.goto(opts.url, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch (e) {
      process.stderr.write(`networkidle2 timed out (${e.message}), retrying with domcontentloaded\n`);
      await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }

    if (opts.wait > 0) {
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((r) => setTimeout(r, opts.wait));
    }

    // Inject the extractor into the page. Puppeteer stringifies browserExtractor
    // and runs it in the page context; `window.__aemImporter` is attached there.
    await page.evaluate(browserExtractor);

    const flatTargets = (m) => {
      if (!m) return null;
      const f = {};
      Object.entries(m).forEach(([label, info]) => {
        if (info && info.selector) f[info.selector] = label;
      });
      return f;
    };
    const labels = targets ? Object.keys(targets) : [];

    const evalAt = async (width, height, plan) => {
      await page.setViewport({ width, height });
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((r) => setTimeout(r, 250));
      return page.evaluate((opts2) => {
        /* eslint-disable no-underscore-dangle */
        const api = window.__aemImporter;
        const out = {};
        if (opts2.tokens) out.tokens = api.captureTokens();
        if (opts2.blocks && opts2.flatTargets) out.blocks = api.captureBlock(opts2.flatTargets);
        if (opts2.states && opts2.labels) out.states = api.captureStateRules(opts2.labels);
        if (opts2.fonts) out.fonts = api.inventoryFonts();
        if (opts2.sheets) out.sheets = api.inventoryStylesheets();
        return out;
        /* eslint-enable no-underscore-dangle */
      }, plan);
    };

    const desktop = await evalAt(1280, 800, {
      tokens: true,
      blocks: !!targets,
      states: !!targets,
      fonts: true,
      sheets: true,
      flatTargets: flatTargets(targets),
      labels,
    });
    capture.tokensDesktop = desktop.tokens || null;
    capture.blocks1280 = desktop.blocks || null;
    capture.stateRules = desktop.states || null;
    capture.fonts = desktop.fonts || null;
    capture.stylesheets = desktop.sheets || null;

    if (targets) {
      const tablet = await evalAt(768, 1024, { blocks: true, flatTargets: flatTargets(targets) });
      capture.blocks768 = tablet.blocks || null;
    }

    const mobile = await evalAt(375, 800, {
      tokens: true, blocks: !!targets, flatTargets: flatTargets(targets),
    });
    capture.tokensMobile = mobile.tokens || null;
    capture.blocks375 = mobile.blocks || null;
  } finally {
    await browser.close();
  }

  ensureDir('tools/importer');
  fs.writeFileSync('tools/importer/.css-capture.json', `${JSON.stringify(capture, null, 2)}\n`, 'utf8');
  console.log('wrote tools/importer/.css-capture.json');

  // ---- 4. Emit CSS files ----
  // EDS auto-loads only blocks/{name}/{name}.css — not arbitrary sidecar
  // files. Write directly there so the styling actually applies. Boilerplate
  // Adobe CSS gets overwritten; `git diff` is the way to recover defaults.
  const writtenPaths = [];
  ensureDir('styles');
  fs.writeFileSync('styles/imported-tokens.css', buildImportedTokensCss(capture), 'utf8');
  writtenPaths.push('styles/imported-tokens.css');
  console.log('wrote styles/imported-tokens.css');

  const tokenLookup = buildTokenLookup(capture.tokensDesktop);
  if (targets) {
    const groups = groupLabelsByBlock(targets);
    Object.entries(groups).forEach(([blockName, info]) => {
      const blockDir = path.join('blocks', blockName);
      ensureDir(blockDir);
      const css = buildBlockCss(blockName, info.labels, capture, tokenLookup);
      if (!css) return;
      const outPath = path.join(blockDir, `${blockName}.css`);
      fs.writeFileSync(outPath, css, 'utf8');
      writtenPaths.push(outPath);
      console.log(`wrote ${outPath} (${info.kind})`);
    });
  }

  // ---- 5. Wire imported-tokens.css into head.html so EDS loads it ----
  try {
    const headPath = 'head.html';
    let head = fs.readFileSync(headPath, 'utf8');
    const link = '<link rel="stylesheet" href="/styles/imported-tokens.css"/>';
    if (!head.includes('/styles/imported-tokens.css')) {
      // Insert after the styles.css link to inherit the cascade.
      const target = '<link rel="stylesheet" href="/styles/styles.css"/>';
      if (head.includes(target)) {
        head = head.replace(target, `${target}\n${link}`);
      } else {
        head += `\n${link}\n`;
      }
      fs.writeFileSync(headPath, head, 'utf8');
      console.log(`patched ${headPath} to load imported-tokens.css`);
    } else {
      console.log(`${headPath} already references imported-tokens.css — skipping`);
    }
  } catch (e) {
    process.stderr.write(`failed to patch head.html: ${e.message}\n`);
  }

  const fontReport = buildFontReport(capture);
  if (fontReport) {
    fs.writeFileSync('tools/importer/.font-inventory.md', fontReport, 'utf8');
    console.log('wrote tools/importer/.font-inventory.md');
  }

  console.log('\nrunning stylelint --fix on generated CSS...');
  await runStylelintFix(writtenPaths);

  const xorigin = (capture.stylesheets || []).filter((s) => !s.sameOrigin);
  if (xorigin.length > 0) {
    console.log(`\nWARN: ${xorigin.length} cross-origin stylesheet(s) — state/animation rules NOT captured:`);
    xorigin.forEach((s) => console.log(`  - ${s.href}`));
  } else {
    console.log('\nNo cross-origin stylesheets — state rules captured fully where present.');
  }
}

// ---------------------------------------------------------------------------
// CLI guard — fires only when import.js is the main script being run via
// `node tools/importer/import.js`. Skips:
//   - the AEM Importer browser iframe (no `process` global)
//   - any Node script that does `import('./import.js')` (argv[1] points
//     at the caller, not at this file)
// ---------------------------------------------------------------------------
if (
  typeof process !== 'undefined'
  && process.versions
  && process.versions.node
  && process.argv
  && process.argv[1]
  && /\/import\.js$/.test(process.argv[1].replace(/\\/g, '/'))
) {
  runCli().catch((e) => {
    process.stderr.write(`fatal: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
  });
}
