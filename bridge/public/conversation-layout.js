const root = document.documentElement;
const sidebar = document.getElementById('conversation-sidebar');
const toggle = document.getElementById('toggle-sidebar');
const resizer = document.getElementById('sidebar-resizer');
const compact = matchMedia('(max-width: 760px)');
let preferredWidth = parseFloat(root.style.getPropertyValue('--conversation-sidebar-width')) || 300;
let drag;
let readingPosition;

function remember(key, value) { try { localStorage.setItem(key, String(value)); } catch { /* Layout still works for this window. */ } }
function keepReading(update) {
  const scroll = document.getElementById('history-scroll');
  if (scroll.clientHeight) {
    const edge = scroll.getBoundingClientRect().top;
    const anchor = [...scroll.querySelectorAll('.exchange')].find(node => node.getBoundingClientRect().bottom > edge);
    readingPosition = { bottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80,
      anchor, offset: anchor ? anchor.getBoundingClientRect().top - edge : 0 };
  }
  update();
  if (!scroll.clientHeight || !readingPosition) return;
  if (readingPosition.bottom) scroll.scrollTop = scroll.scrollHeight;
  else if (readingPosition.anchor?.isConnected) scroll.scrollTop += readingPosition.anchor.getBoundingClientRect().top
    - scroll.getBoundingClientRect().top - readingPosition.offset;
}
export function syncSidebar() {
  const visible = compact.matches ? document.body.dataset.threadOpen !== 'true' : root.dataset.sidebarCollapsed !== 'true';
  toggle.setAttribute('aria-expanded', String(visible));
  toggle.setAttribute('aria-label', visible ? 'Hide conversations' : 'Show conversations');
  return visible;
}
export function showSidebar() {
  keepReading(() => {
    delete document.body.dataset.threadOpen;
    if (!compact.matches) { delete root.dataset.sidebarCollapsed; remember('maestro-sidebar-collapsed', false); }
  });
  syncSidebar();
}
function toggleSidebar() {
  const visible = syncSidebar();
  const focusWasInSidebar = sidebar.contains(document.activeElement);
  keepReading(() => {
    if (compact.matches) {
      if (visible) document.body.dataset.threadOpen = 'true';
      else delete document.body.dataset.threadOpen;
    } else {
      root.dataset.sidebarCollapsed = String(visible);
      remember('maestro-sidebar-collapsed', visible);
    }
  });
  syncSidebar();
  if (!visible) document.getElementById('search').focus({ preventScroll: true });
  else if (focusWasInSidebar) {
    const message = document.getElementById('message');
    (message.disabled || message.closest('[hidden]') ? document.getElementById('thread') : message).focus({ preventScroll: true });
  }
}
function setWidth(width) {
  const maximum = Math.max(240, Math.min(420, innerWidth - 360));
  const value = Math.round(Math.max(240, Math.min(maximum, width)));
  keepReading(() => root.style.setProperty('--conversation-sidebar-width', value + 'px'));
  resizer.setAttribute('aria-valuemax', String(maximum));
  resizer.setAttribute('aria-valuenow', String(value));
  return value;
}
function finishResize() {
  if (!drag) return;
  preferredWidth = parseFloat(root.style.getPropertyValue('--conversation-sidebar-width'));
  remember('maestro-sidebar-width', preferredWidth);
  const pointer = drag.pointer; drag = null;
  document.body.classList.remove('sidebar-resizing');
  if (resizer.hasPointerCapture(pointer)) resizer.releasePointerCapture(pointer);
}
resizer.addEventListener('pointerdown', event => {
  if (event.button !== 0 || compact.matches) return;
  drag = { pointer: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width };
  resizer.setPointerCapture(event.pointerId); resizer.focus({ preventScroll: true });
  document.body.classList.add('sidebar-resizing'); event.preventDefault();
});
resizer.addEventListener('pointermove', event => { if (drag?.pointer === event.pointerId) setWidth(drag.width + event.clientX - drag.x); });
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) resizer.addEventListener(event, finishResize);
window.addEventListener('blur', finishResize);
resizer.addEventListener('dblclick', () => { preferredWidth = setWidth(300); remember('maestro-sidebar-width', preferredWidth); });
resizer.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = sidebar.getBoundingClientRect().width;
  preferredWidth = setWidth(event.key === 'Home' ? 240 : event.key === 'End' ? 420 : current + (event.key === 'ArrowLeft' ? -10 : 10));
  remember('maestro-sidebar-width', preferredWidth);
});
toggle.addEventListener('click', toggleSidebar);
window.addEventListener('maestro:toggle-sidebar', toggleSidebar);
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar(); }
});
compact.addEventListener('change', () => {
  if (compact.matches && !document.getElementById('thread-header').hidden) document.body.dataset.threadOpen = 'true';
  syncSidebar();
});
window.addEventListener('resize', () => setWidth(preferredWidth));
if (new URLSearchParams(location.search).get('sidebar') === 'open' || new URLSearchParams(location.search).get('filter') === 'unread') showSidebar();
setWidth(preferredWidth); syncSidebar();
