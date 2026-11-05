const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const active = new Set();
const enhanced = new WeakSet();
const curve = 'cubic-bezier(.23, 1, .32, 1)';

function enhance(details) {
  const summary = details.querySelector(':scope > summary');
  if (!summary || enhanced.has(details)) return;
  enhanced.add(details);
  let expanded = details.open, animation;
  let inertChildren = [];
  const originalHeight = details.style.height, originalOverflow = details.style.overflow;
  const restoreChildren = () => {
    for (const [child, value] of inertChildren) child.inert = value;
    inertChildren = [];
  };
  function settle(open) {
    animation?.cancel(); animation = undefined;
    expanded = open; details.open = open;
    details.dataset.expanded = String(open);
    summary.setAttribute('aria-expanded', String(open));
    details.style.height = originalHeight; details.style.overflow = originalOverflow;
    restoreChildren(); active.delete(finish);
  }
  function finish() { settle(expanded); }
  summary.addEventListener('click', event => {
    if (event.target.closest('a, button, input, select')) return;
    event.preventDefault();
    const start = details.getBoundingClientRect().height;
    const next = !expanded;
    animation?.cancel(); animation = undefined; restoreChildren();
    if (!next && details.contains(document.activeElement) && document.activeElement !== summary) summary.focus({ preventScroll: true });
    expanded = next; details.dataset.expanded = String(next);
    summary.setAttribute('aria-expanded', String(next));
    // Keyboard actions and Reduce Motion resolve immediately.
    if (!event.detail || reducedMotion.matches || !details.animate) { settle(next); return; }
    details.open = true; details.style.height = 'auto';
    const style = getComputedStyle(details);
    const end = next ? details.getBoundingClientRect().height : summary.getBoundingClientRect().height
      + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    if (!next) {
      inertChildren = [...details.children].filter(child => child !== summary).map(child => [child, child.inert]);
      for (const [child] of inertChildren) child.inert = true;
    }
    details.style.height = start + 'px'; details.style.overflow = 'hidden';
    // Only this small disclosure changes layout; no per-frame JS or page-wide transition.
    const current = details.animate([{ height: start + 'px' }, { height: end + 'px' }],
      { duration: next ? 200 : 160, easing: curve });
    animation = current; active.add(finish);
    current.finished.then(() => { if (animation === current) settle(next); }).catch(() => {});
  });
  details.addEventListener('toggle', () => {
    if (!animation || !details.open) settle(details.open);
  });
  settle(expanded);
}
function scan(root) {
  if (root.nodeType !== Node.ELEMENT_NODE && root !== document) return;
  if (root.matches?.('details')) enhance(root);
  root.querySelectorAll('details').forEach(enhance);
}
scan(document);
new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) scan(node);
}).observe(document.body, { childList: true, subtree: true });
window.addEventListener('resize', () => { for (const finish of [...active]) finish(); });
reducedMotion.addEventListener('change', () => { for (const finish of [...active]) finish(); });
