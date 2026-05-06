/* global WebImporter */

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

// ===========================================================================
// COLGATE PALMOLIVE — https://www.colgatepalmolive.co.in/
// ===========================================================================

function cleanup(doc) {
  WebImporter.DOMUtils.remove(doc, [
    '#header',
    '#footer',
    'a[aria-hidden="true"]',
    '.analytics-image-tracking',
    '.vertical-spacer',
    '[class*="reference-vertical-spacer"]',
    '#onetrust-consent-sdk',
    '#consent_blackbar',
    '.cookie-banner',
    '[id*="cookie"]',
    '#exit-notification',
    '#boomr-scr-as',
    '.box-more-title',
    '.box-more-arrow',
  ]);
  doc.querySelectorAll('.responsive-element script, .responsive-element style').forEach((el) => el.remove());
  doc.querySelectorAll('[class*="ss--"], [class*="ss-max"]').forEach((span) => {
    span.replaceWith(...span.childNodes);
  });
}

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
  container.replaceWith(block('Carousel', rows, doc));
}

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

  const section = doc.createElement('div');
  section.appendChild(heading);
  section.appendChild(block('Carousel', rows, doc));
  container.replaceWith(section);
}

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

  const wrapper = cards[0].closest('.paragraphSystem, [class*="wrapper-max-width"]') || cards[0].parentElement;
  wrapper.replaceWith(block('Cards', rows, doc));
}

function transformAwardsCertifications(main, doc) {
  const container = main.querySelector('[class*="bg-grey"][class*="wrapper-max-width-1024px"]');
  if (!container) return;

  const heading = container.querySelector('h3');
  const awardCols = container.querySelectorAll('[class*="col-md-4"]');
  if (!awardCols.length) return;

  const rows = [];
  awardCols.forEach((col) => {
    const h4 = col.querySelector('h4');
    const p = col.querySelector('p');
    const cell = doc.createElement('div');
    if (h4) cell.appendChild(h4.cloneNode(true));
    if (p) cell.appendChild(p.cloneNode(true));
    rows.push([cell]);
  });

  const seeMore = container.querySelector('a[href*="/who-we-are/awards"]');

  const section = doc.createElement('div');
  if (heading) section.appendChild(heading.cloneNode(true));
  section.appendChild(block('Cards', rows, doc));
  if (seeMore) {
    section.appendChild(primaryButton(doc, seeMore.getAttribute('href'), seeMore.textContent.trim()));
  }

  container.replaceWith(section);
}

function transformCareersCTA(main, doc) {
  const allContainers = main.querySelectorAll('[class*="wrapper-max-width-1024px"]');
  const container = [...allContainers].find((el) => !el.classList.contains('bg-grey'));
  if (!container) return;

  const richTextCol = container.querySelector('.richText.component');
  const imageCol = container.querySelector('[class*="reference-responsive-image"]');
  if (!richTextCol && !imageCol) return;

  const textCell = doc.createElement('div');
  if (richTextCol) {
    const content = richTextCol.querySelector('.richText-content');
    if (content) textCell.appendChild(content.cloneNode(true));
  }

  const imageCell = doc.createElement('div');
  if (imageCol) {
    const img = imageCol.querySelector('img');
    if (img) imageCell.appendChild(img.cloneNode(true));
  }

  container.replaceWith(block('Columns', [[textCell, imageCell]], doc));
}

function transformColgate(doc, url) {
  cleanup(doc);

  const main = doc.querySelector('#content')
    || doc.querySelector('[role="main"]')
    || doc.body;

  fixLinks(main, url);
  fixLazyImages(main);

  transformHeroCarousel(main, doc);
  transformBrandsCarousel(main, doc);
  transformFeatureCards(main, doc);
  transformAwardsCertifications(main, doc);
  transformCareersCTA(main, doc);

  main.appendChild(wrapSection(buildMetadata(doc), doc));

  return [{ element: main, path: new URL(url).pathname.replace(/\/$/, '') || '/index' }];
}

// ===========================================================================
// COGNIZANT — https://www.cognizant.com/in/en
// ===========================================================================

// Decode AEM's \2f-encoded background-image URL and create an <img> element.
function extractBgImage(el, doc) {
  const style = el?.getAttribute('style') ?? '';
  const m = style.match(/background-image:\s*url\(([^)]+)\)/i);
  if (!m) return null;
  const raw = m[1].replace(/\\2f/gi, '/').replace(/\s+/g, '').replace(/['"]/g, '').trim();
  const img = doc.createElement('img');
  img.src = raw;
  img.alt = '';
  return img;
}

function cleanupCognizant(doc) {
  ['script', 'style', '#onetrust-consent-sdk', '.cookie-banner', '[id*="cookie"]',
    '#sticky-modal', '#sticky-model'].forEach((sel) => {
    doc.querySelectorAll(sel).forEach((el) => el.remove());
  });
  doc.querySelectorAll('[data-cmp-data-layer]').forEach((el) => el.removeAttribute('data-cmp-data-layer'));
}

// Earnings ticker bar: h3/link text line
function buildCognizantEarnings(root, doc) {
  const xf = root.querySelector('.cmp-experiencefragment--homepage-earnings');
  const textEl = xf?.querySelector('.cmp-text');
  if (!textEl) return null;
  const p = doc.createElement('p');
  p.innerHTML = textEl.innerHTML;
  return p;
}

// Hero banner: background image + h1/h4 heading + CTA button + 4 mini-teaser cards
function buildCognizantHero(root, doc) {
  const xf = root.querySelector('.cmp-experiencefragment--homepage_banner');
  if (!xf) return null;

  const bgEl = xf.querySelector('.cmp-container-full[style*="background-image"]');
  const textCmp = xf.querySelector('.cmp-text');
  const ctaAnchor = xf.querySelector('.button .cmp-button');

  const imageCell = doc.createElement('div');
  const bgImg = bgEl ? extractBgImage(bgEl, doc) : null;
  if (bgImg) imageCell.appendChild(bgImg);

  const contentCell = doc.createElement('div');
  if (textCmp) contentCell.appendChild(textCmp.cloneNode(true));
  if (ctaAnchor) {
    const btnText = ctaAnchor.querySelector('.cmp-button__text')?.textContent?.trim() || 'Learn more';
    contentCell.appendChild(primaryButton(doc, ctaAnchor.href, btnText));
  }

  const section = doc.createElement('div');
  section.appendChild(block('Hero', [[imageCell, contentCell]], doc));

  // 4 mini-teaser cards below the hero
  const teaserGrid = xf.querySelector('[class*="col-four-3-3-3-3"]');
  if (teaserGrid) {
    const rows = [];
    teaserGrid.querySelectorAll('.cmp-teaser').forEach((teaser) => {
      const titleLink = teaser.querySelector('.cmp-teaser__title-link');
      const img = teaser.querySelector('.cmp-image__image');
      const cta = teaser.querySelector('.cmp-teaser__action-link');
      const cell = doc.createElement('div');
      if (img) cell.appendChild(img.cloneNode(true));
      if (titleLink) {
        const h5 = doc.createElement('h5');
        h5.textContent = titleLink.textContent.trim();
        cell.appendChild(h5);
      }
      if (cta) {
        const p = doc.createElement('p');
        const a = doc.createElement('a');
        a.href = cta.href;
        a.textContent = cta.textContent.trim();
        p.appendChild(a);
        cell.appendChild(p);
      }
      rows.push([cell]);
    });
    if (rows.length) {
      section.appendChild(doc.createElement('hr'));
      section.appendChild(block('Cards', rows, doc));
    }
  }
  return section;
}

// Value proposition: h4 intro text as default content
function buildCognizantValueProp(root, doc) {
  const xf = root.querySelector('.cmp-experiencefragment--value_prop');
  const textEl = xf?.querySelector('.cmp-text');
  if (!textEl) return null;
  const div = doc.createElement('div');
  div.innerHTML = textEl.innerHTML;
  return div;
}

// Parallax / video teaser: background image + teaser title/description/CTA → Hero block
function buildCognizantParallaxTeaser(root, doc, selector) {
  const xf = root.querySelector(selector);
  if (!xf) return null;

  const bgEl = xf.querySelector('.cmp-container-full[style*="background-image"]');
  const bgImg = bgEl ? extractBgImage(bgEl, doc) : null;
  const teaser = xf.querySelector('.cmp-teaser');

  const imageCell = doc.createElement('div');
  if (bgImg) imageCell.appendChild(bgImg);

  const contentCell = doc.createElement('div');
  const title = teaser?.querySelector('.cmp-teaser__title');
  const desc = teaser?.querySelector('.cmp-teaser__description');
  const cta = teaser?.querySelector('.cmp-teaser__action-link');
  if (title) contentCell.appendChild(title.cloneNode(true));
  if (desc) contentCell.appendChild(desc.cloneNode(true));
  if (cta) contentCell.appendChild(primaryButton(doc, cta.href, cta.textContent.trim()));

  if (!bgImg && !title) return null;
  return block('Hero', [[imageCell, contentCell]], doc);
}

// Case studies: h3 heading + intro + 4 hover-reveal cards → Cards block
function buildCognizantCaseStudies(root, doc) {
  const container = root.querySelector('[id="case-study"].cmp-container-full');
  if (!container) return null;

  const textCmp = container.querySelector('.cmp-text');
  const heading = textCmp?.querySelector('h3');
  const intro = textCmp?.querySelector('p');

  const teasers = container.querySelectorAll('.cmp-teaser.align-items-end');
  if (!teasers.length) return null;

  const rows = [];
  teasers.forEach((teaser) => {
    const panel = teaser.querySelector('.show-on-hover') || teaser;
    const pretitle = panel.querySelector('.cmp-teaser__pretitle');
    const title = panel.querySelector('.cmp-teaser__title');
    const desc = panel.querySelector('.cmp-teaser__description');
    const img = teaser.querySelector('.cmp-teaser__image .cmp-image__image');
    const cell = doc.createElement('div');
    if (img) cell.appendChild(img.cloneNode(true));
    if (pretitle) {
      const small = doc.createElement('p');
      small.textContent = pretitle.textContent.trim();
      cell.appendChild(small);
    }
    if (title) cell.appendChild(title.cloneNode(true));
    if (desc) cell.appendChild(desc.cloneNode(true));
    rows.push([cell]);
  });

  if (!rows.length) return null;

  const section = doc.createElement('div');
  if (heading) section.appendChild(heading.cloneNode(true));
  if (intro) section.appendChild(intro.cloneNode(true));
  section.appendChild(block('Cards', rows, doc));
  return section;
}

// News section: h3 heading + "See all news" CTA (feed is client-rendered, not importable)
function buildCognizantNews(root, doc) {
  const newsSection = root.querySelector('.cog-news-section');
  if (!newsSection) return null;

  const heading = newsSection.querySelector('h3');
  const seeAllBtn = newsSection.querySelector('#button-all-news');

  const section = doc.createElement('div');
  if (heading) section.appendChild(heading.cloneNode(true));
  if (seeAllBtn) {
    section.appendChild(
      primaryButton(
        doc,
        seeAllBtn.href,
        seeAllBtn.querySelector('.cmp-button__text')?.textContent?.trim() || 'See all news',
      ),
    );
  }
  return section;
}

// Careers promo: recruitment image + "Drive your career forward. Fast." → Columns block
function buildCognizantCareers(root, doc) {
  const container = root.querySelector('.cog-container--col-two-6-6.bg-primary');
  if (!container) return null;

  const img = container.querySelector('.cmp-image__image');
  const title = container.querySelector('.cmp-teaser__title');
  const cta = container.querySelector('.cmp-teaser__action-link');

  const imageCell = doc.createElement('div');
  if (img) imageCell.appendChild(img.cloneNode(true));

  const contentCell = doc.createElement('div');
  if (title) contentCell.appendChild(title.cloneNode(true));
  if (cta) contentCell.appendChild(primaryButton(doc, cta.href, cta.textContent.trim()));

  return block('Columns', [[imageCell, contentCell]], doc);
}

function transformCognizant(doc, url) {
  cleanupCognizant(doc);
  fixLinks(doc.body, url);
  fixLazyImages(doc.body);

  const root = doc.querySelector('main') || doc.body;

  // Diagnostic: log what key selectors resolve to so mismatches are visible in the browser console.
  const diag = {
    rootTag: root.tagName,
    earnings: !!root.querySelector('.cmp-experiencefragment--homepage-earnings'),
    hero: !!root.querySelector('.cmp-experiencefragment--homepage_banner'),
    valueProp: !!root.querySelector('.cmp-experiencefragment--value_prop'),
    video: !!root.querySelector('.cmp-experiencefragment--video-section1'),
    caseStudy: !!root.querySelector('[id="case-study"].cmp-container-full'),
    parallax: !!root.querySelector('.cmp-experiencefragment--banner_parallax'),
    news: !!root.querySelector('.cog-news-section'),
    careers: !!root.querySelector('.cog-container--col-two-6-6.bg-primary'),
  };
  // eslint-disable-next-line no-console
  console.log('[CognizantImport]', JSON.stringify(diag));

  // Stage output in a detached div so builders can still read from root.
  const staging = doc.createElement('div');
  function append(el) {
    if (!el) return;
    staging.appendChild(el);
    staging.appendChild(doc.createElement('hr'));
  }

  append(buildCognizantEarnings(root, doc));
  append(buildCognizantHero(root, doc));
  append(buildCognizantValueProp(root, doc));
  append(buildCognizantParallaxTeaser(root, doc, '.cmp-experiencefragment--video-section1'));
  append(buildCognizantCaseStudies(root, doc));
  append(buildCognizantParallaxTeaser(root, doc, '.cmp-experiencefragment--banner_parallax'));
  append(buildCognizantNews(root, doc));
  append(block('Form', [['/forms/contact']], doc));
  append(buildCognizantCareers(root, doc));
  append(block('Form', [['/forms/contact']], doc));
  staging.appendChild(wrapSection(buildMetadata(doc), doc));

  // Wipe the entire body and replace with only our staged content.
  // The importer clones the full document (including header/footer) and passes
  // it to html2md. Clearing body is the only reliable way to prevent chrome
  // from leaking into the converted output.
  while (doc.body.firstChild) doc.body.removeChild(doc.body.firstChild);
  while (staging.firstChild) doc.body.appendChild(staging.firstChild);

  return [{ element: doc.body, path: new URL(url).pathname.replace(/\/$/, '') || '/index' }];
}

// ===========================================================================
// Main export — routes by hostname
// ===========================================================================
export default {
  transform({ document: doc, url }) {
    const { hostname } = new URL(url);

    if (hostname.includes('cognizant.com')) {
      return transformCognizant(doc, url);
    }

    // Default: Colgate Palmolive India
    return transformColgate(doc, url);
  },
};
