import { createOptimizedPicture } from '../../scripts/aem.js';

export default function decorate(block) {
  const rows = [...block.children];

  rows.forEach((row) => {
    const [iconCol, contentCol] = [...row.children];
    if (iconCol) iconCol.classList.add('quick-actions-icon');
    if (contentCol) contentCol.classList.add('quick-actions-content');
  });

  block.querySelectorAll('picture > img').forEach((img) => {
    img.closest('picture').replaceWith(
      createOptimizedPicture(img.src, img.alt, false, [{ width: '120' }]),
    );
  });

  const ul = document.createElement('ul');
  [...block.children].forEach((row) => {
    const li = document.createElement('li');
    while (row.firstElementChild) li.append(row.firstElementChild);
    ul.append(li);
  });
  block.replaceChildren(ul);
}
