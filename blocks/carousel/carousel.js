/*
 * Carousel block.
 *
 * Authored content (each row in the docx table = one slide):
 *   | Carousel             |                              |
 *   | [image]              | [heading + body + cta]       |
 *   | [image]              | [heading + body + cta]       |
 *   ...
 *
 * After EDS decorates the table to divs:
 *   <div class="carousel block">
 *     <div>                  <-- slide 0
 *       <div>image cell</div>
 *       <div>content cell</div>
 *     </div>
 *     <div> ... slide 1 ... </div>
 *   </div>
 *
 * The block decorates that into a horizontal slider with prev/next buttons
 * and dot pagination.
 */

function showSlide(block, index) {
  const slides = [...block.querySelectorAll(':scope > .carousel-slides > .carousel-slide')];
  const dots = [...block.querySelectorAll(':scope > .carousel-dots > button')];
  const total = slides.length;
  if (total === 0) return;
  const next = ((index % total) + total) % total;
  slides.forEach((slide, i) => {
    slide.classList.toggle('carousel-slide-active', i === next);
    slide.setAttribute('aria-hidden', i === next ? 'false' : 'true');
  });
  dots.forEach((dot, i) => {
    dot.classList.toggle('carousel-dot-active', i === next);
    dot.setAttribute('aria-selected', i === next ? 'true' : 'false');
  });
  block.dataset.carouselIndex = String(next);
}

function step(block, delta) {
  const current = Number(block.dataset.carouselIndex || 0);
  showSlide(block, current + delta);
}

function buildNav(block, slidesCount) {
  const nav = document.createElement('div');
  nav.classList.add('carousel-nav');

  const prev = document.createElement('button');
  prev.classList.add('carousel-prev');
  prev.type = 'button';
  prev.setAttribute('aria-label', 'Previous slide');
  prev.textContent = '‹';
  prev.addEventListener('click', () => step(block, -1));

  const next = document.createElement('button');
  next.classList.add('carousel-next');
  next.type = 'button';
  next.setAttribute('aria-label', 'Next slide');
  next.textContent = '›';
  next.addEventListener('click', () => step(block, 1));

  nav.append(prev, next);

  const dots = document.createElement('div');
  dots.classList.add('carousel-dots');
  dots.setAttribute('role', 'tablist');
  for (let i = 0; i < slidesCount; i += 1) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('role', 'tab');
    dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
    dot.addEventListener('click', () => showSlide(block, i));
    dots.appendChild(dot);
  }

  return { nav, dots };
}

export default function decorate(block) {
  const rawSlides = [...block.children].filter((c) => c.tagName === 'DIV');
  if (rawSlides.length === 0) return;

  const track = document.createElement('div');
  track.classList.add('carousel-slides');

  rawSlides.forEach((slide) => {
    slide.classList.add('carousel-slide');
    track.appendChild(slide);
  });

  block.append(track);

  const { nav, dots } = buildNav(block, rawSlides.length);
  block.append(nav);
  block.append(dots);

  showSlide(block, 0);
}
