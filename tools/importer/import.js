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
      if (cell && cell.nodeType) td.appendChild(cell);
      else td.innerHTML = String(cell ?? '');
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  return table;
}

function wrapSection(el, doc) {
  const div = doc.createElement('div');
  div.appendChild(el);
  return div;
}

function primaryButton(doc, href, text) {
  const p = doc.createElement('p');
  const strong = doc.createElement('strong');
  const a = doc.createElement('a');
  a.href = href;
  a.textContent = text;
  strong.appendChild(a);
  p.appendChild(strong);
  return p;
}

function fixLazyImages(root) {
  root.querySelectorAll('img[data-src], img[data-lazy-src], img[data-original]').forEach((img) => {
    img.src = img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.src;
  });
  root.querySelectorAll('img[data-srcset]').forEach((img) => {
    img.srcset = img.dataset.srcset;
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// Removes Colgate-specific cruft: header, nav, footer, analytics trackers,
// inline responsive-element scripts, AEM-specific aria anchors, spacers,
// consent banners, and chat widgets.
// ---------------------------------------------------------------------------
function cleanup(doc) {
  WebImporter.DOMUtils.remove(doc, [
    // Site chrome
    '#header',
    '#footer',
    // AEM invisible aria anchors
    'a[aria-hidden="true"]',
    // Inline analytics / tracking helpers
    '.analytics-image-tracking',
    // Responsive-element JS-driven spacers & overlays
    '.vertical-spacer',
    '[class*="reference-vertical-spacer"]',
    // Consent / cookie banners
    '#onetrust-consent-sdk',
    '#consent_blackbar',
    '.cookie-banner',
    '[id*="cookie"]',
    // Exit notification overlay
    '#exit-notification',
    // Boomerang performance script artefact
    '#boomr-scr-as',
    // Box-more "Read more" cover links (duplicates of .cta links)
    '.box-more-title',
    '.box-more-arrow',
    // IE conditional comments are already stripped by the parser
  ]);

  // Strip inline <style> and <script> blocks injected by responsive-element component
  doc.querySelectorAll('.responsive-element script, .responsive-element style').forEach((el) => el.remove());

  // Unwrap SS-* span wrappers (purely presentational inline-style utility classes)
  doc.querySelectorAll('[class*="ss--"], [class*="ss-max"]').forEach((span) => {
    span.replaceWith(...span.childNodes);
  });
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
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

  // hreflang
  const hreflangs = [...doc.querySelectorAll('link[rel="alternate"][hreflang]')];
  if (hreflangs.length > 0) {
    meta.hreflang = hreflangs
      .map((l) => `${l.getAttribute('hreflang')}: ${l.getAttribute('href')}`)
      .join('\n');
  }

  // JSON-LD schema type
  const jsonLd = doc.querySelector('script[type="application/ld+json"]');
  if (jsonLd) {
    try {
      const parsed = JSON.parse(jsonLd.textContent);
      if (parsed['@type']) meta['Schema Type'] = parsed['@type'];
    } catch (_) { /* ignore */ }
  }

  return block('Metadata', Object.entries(meta).map(([k, v]) => [k, v ?? '']), doc);
}

// ---------------------------------------------------------------------------
// Fix links and image srcs to absolute
// ---------------------------------------------------------------------------
function fixLinks(main, url) {
  const { origin, hostname } = new URL(url);
  main.querySelectorAll('a[href]').forEach((a) => {
    try {
      const abs = new URL(a.getAttribute('href'), origin);
      a.href = abs.hostname === hostname
        ? abs.pathname + abs.search + abs.hash
        : abs.href;
    } catch (_) { /* leave malformed */ }
  });
  main.querySelectorAll('img[src]').forEach((img) => {
    try {
      const resolved = new URL(img.getAttribute('src'), origin);
      // AEM Importer proxies through localhost — rewrite to real origin
      if (resolved.hostname === 'localhost') {
        img.src = `${origin}${resolved.pathname}${resolved.search}`;
      } else {
        img.src = resolved.href;
      }
    } catch (_) { /* skip */ }
  });
}

// ---------------------------------------------------------------------------
// Hero Banner Carousel
// Selector: .carousel-slick.image-banner-carousel
// Each slide is a .richText-largeText-carousel containing:
//   - .image component (picture) as first child
//   - .richText component (h1 + p + .cta link) as second child
// ---------------------------------------------------------------------------
function transformHeroCarousel(main, doc) {
  const container = main.querySelector('.carousel-slick.image-banner-carousel');
  if (!container) return;

  const slides = container.querySelectorAll('.richText-largeText-carousel');
  if (!slides.length) return;

  const rows = [];
  slides.forEach((slide) => {
    const pic = slide.querySelector('picture');
    const heading = slide.querySelector('h1, h2, h3, h4');
    const bodyText = slide.querySelector('.richText-content p:not(:last-child)');
    const ctaLink = slide.querySelector('a.cta');

    const imageCell = doc.createElement('div');
    if (pic) imageCell.appendChild(pic.cloneNode(true));

    const contentCell = doc.createElement('div');
    if (heading) contentCell.appendChild(heading.cloneNode(true));
    if (bodyText) contentCell.appendChild(bodyText.cloneNode(true));
    if (ctaLink) {
      contentCell.appendChild(primaryButton(doc, ctaLink.href, ctaLink.textContent.trim()));
    }

    rows.push([imageCell, contentCell]);
  });

  if (!rows.length) return;
  const carouselTable = block('Carousel', rows, doc);
  container.replaceWith(carouselTable);
}

// ---------------------------------------------------------------------------
// Our Brands Carousel
// Selector: .carousel-slick.our-brands-carousel
// Each brand is an image wrapped in an <a> link.
// ---------------------------------------------------------------------------
function transformBrandsCarousel(main, doc) {
  const container = main.querySelector('.carousel-slick.our-brands-carousel');
  if (!container) return;

  const brandItems = container.querySelectorAll('.image.component a > picture, .image.component > picture');
  if (!brandItems.length) return;

  const rows = [];
  brandItems.forEach((item) => {
    const link = item.closest('a');
    const img = item.querySelector('img');

    const cell = doc.createElement('div');
    if (link) {
      const a = doc.createElement('a');
      a.href = link.href;
      a.appendChild(item.cloneNode(true));
      cell.appendChild(a);
    } else {
      cell.appendChild(item.cloneNode(true));
    }

    if (img?.alt) {
      const caption = doc.createElement('p');
      caption.textContent = img.alt;
      cell.appendChild(caption);
    }

    rows.push([cell]);
  });

  if (!rows.length) return;

  const heading = doc.createElement('h2');
  heading.textContent = 'Our Brands';

  const carouselTable = block('Carousel', rows, doc);
  const section = doc.createElement('div');
  section.appendChild(heading);
  section.appendChild(carouselTable);
  container.replaceWith(section);
}

// ---------------------------------------------------------------------------
// Content Feature Cards
// Selector: .link-covers-element.bottom-to-top
// Each card has: picture + h4 (title) + p (subtitle) + .cta link
// ---------------------------------------------------------------------------
function transformFeatureCards(main, doc) {
  const cards = main.querySelectorAll('.link-covers-element.bottom-to-top');
  if (!cards.length) return;

  const rows = [];
  cards.forEach((card) => {
    const pic = card.querySelector('picture');
    const heading = card.querySelector('h4, h3, h2');
    const subtitle = card.querySelector('.richText-content p:not(:last-child)');
    const ctaLink = card.querySelector('a.cta');

    const imageCell = doc.createElement('div');
    if (pic) imageCell.appendChild(pic.cloneNode(true));

    const contentCell = doc.createElement('div');
    if (heading) contentCell.appendChild(heading.cloneNode(true));
    if (subtitle) contentCell.appendChild(subtitle.cloneNode(true));
    if (ctaLink) {
      contentCell.appendChild(primaryButton(doc, ctaLink.href, ctaLink.textContent.trim()));
    }

    rows.push([imageCell, contentCell]);
  });

  if (!rows.length) return;

  const cardsTable = block('Cards', rows, doc);

  // Replace the parent wrapper that holds all 4 cards
  const wrapper = cards[0].closest('.paragraphSystem, [class*="wrapper-max-width"]') || cards[0].parentElement;
  wrapper.replaceWith(cardsTable);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default {
  transform({ document: doc, url }) {
    cleanup(doc);

    const main = doc.querySelector('#content')
      || doc.querySelector('[role="main"]')
      || doc.body;

    fixLinks(main, url);
    fixLazyImages(main);

    transformHeroCarousel(main, doc);
    transformBrandsCarousel(main, doc);
    transformFeatureCards(main, doc);

    main.appendChild(wrapSection(buildMetadata(doc), doc));

    return [{
      element: main,
      path: new URL(url).pathname.replace(/\/$/, '') || '/index',
    }];
  },
};
