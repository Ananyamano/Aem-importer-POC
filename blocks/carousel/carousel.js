import { createOptimizedPicture } from '../../scripts/aem.js';

function updateActiveSlide(slide) {
  const block = slide.closest('.carousel');
  const slides = block.querySelectorAll('.carousel-slide');
  slides.forEach((s, i) => {
    const isActive = s === slide;
    s.setAttribute('aria-hidden', !isActive);
    const indicator = block.querySelector(`.carousel-slide-indicator:nth-child(${i + 1}) button`);
    if (indicator) indicator.disabled = isActive;
  });
}

function showSlide(block, slideIndex) {
  const slides = block.querySelectorAll('.carousel-slide');
  let realIndex = slideIndex;
  if (slideIndex < 0) realIndex = slides.length - 1;
  if (slideIndex >= slides.length) realIndex = 0;
  const target = slides[realIndex];
  target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  updateActiveSlide(target);
}

function bindEvents(block) {
  const slidesContainer = block.querySelector('.carousel-slides');
  const prevBtn = block.querySelector('.slide-prev');
  const nextBtn = block.querySelector('.slide-next');

  let currentIndex = 0;

  if (prevBtn) prevBtn.addEventListener('click', () => { currentIndex -= 1; showSlide(block, currentIndex); });
  if (nextBtn) nextBtn.addEventListener('click', () => { currentIndex += 1; showSlide(block, currentIndex); });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        updateActiveSlide(entry.target);
        const slides = [...block.querySelectorAll('.carousel-slide')];
        currentIndex = slides.indexOf(entry.target);
      }
    });
  }, { root: slidesContainer, threshold: 0.5 });

  block.querySelectorAll('.carousel-slide').forEach((slide) => observer.observe(slide));
}

function createSlide(row, index) {
  const slide = document.createElement('li');
  slide.classList.add('carousel-slide');
  slide.setAttribute('role', 'group');
  slide.setAttribute('aria-roledescription', 'slide');
  slide.setAttribute('aria-label', `Slide ${index + 1}`);

  [...row.children].forEach((col, i) => {
    if (i === 0 && col.querySelector('picture')) {
      col.classList.add('carousel-slide-image');
      col.querySelectorAll('picture > img').forEach((img) => {
        img.closest('picture').replaceWith(
          createOptimizedPicture(img.src, img.alt, index === 0, [{ width: '1240' }]),
        );
      });
    } else {
      col.classList.add('carousel-slide-content');
    }
    slide.append(col);
  });

  return slide;
}

export default function decorate(block) {
  const rows = [...block.children];
  const isSingle = rows.length < 2;

  const slidesContainer = document.createElement('div');
  slidesContainer.classList.add('carousel-slides-container');

  const slidesList = document.createElement('ul');
  slidesList.classList.add('carousel-slides');
  slidesList.setAttribute('role', 'list');

  rows.forEach((row, i) => {
    const slide = createSlide(row, i);
    slidesList.append(slide);
  });
  slidesContainer.append(slidesList);

  if (!isSingle) {
    const navButtons = document.createElement('div');
    navButtons.classList.add('carousel-navigation-buttons');
    navButtons.innerHTML = `
      <button type="button" class="slide-prev" aria-label="Previous slide"></button>
      <button type="button" class="slide-next" aria-label="Next slide"></button>`;
    slidesContainer.append(navButtons);

    const indicators = document.createElement('ol');
    indicators.classList.add('carousel-slide-indicators');
    rows.forEach((_, i) => {
      const li = document.createElement('li');
      li.classList.add('carousel-slide-indicator');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Slide ${i + 1} indicator`);
      btn.addEventListener('click', () => {
        slidesList.querySelectorAll('.carousel-slide')[i]
          .scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
      });
      li.append(btn);
      indicators.append(li);
    });
    slidesContainer.append(indicators);
  }

  block.replaceChildren(slidesContainer);
  bindEvents(block);
  updateActiveSlide(block.querySelector('.carousel-slide'));
}
