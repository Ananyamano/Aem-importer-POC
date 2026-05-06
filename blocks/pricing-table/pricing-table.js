export default function decorate(block) {
  const rows = [...block.children];

  rows.forEach((row) => {
    row.classList.add('pricing-table-plan');
    const cols = [...row.children];

    if (cols[0]) cols[0].classList.add('pricing-table-header');
    if (cols[1]) cols[1].classList.add('pricing-table-price');
    if (cols[2]) cols[2].classList.add('pricing-table-features');
    if (cols[3]) cols[3].classList.add('pricing-table-cta');

    // Mark the most popular / highlighted plan
    const headerText = cols[0]?.textContent?.toLowerCase() || '';
    if (headerText.includes('premium') || headerText.includes('pro')) {
      row.classList.add('pricing-table-featured');
    }
  });
}
