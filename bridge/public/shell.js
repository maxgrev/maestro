const icons = {
  conversations: '<path d="M4 4.5h16v11H9l-5 4v-15Z"/><path d="M8 8.5h8M8 11.5h5"/>',
  inbox: '<path d="M5 4.5h14l2 10v5H3v-5l2-10Z"/><path d="M3 14.5h5l1.5 2h5l1.5-2h5M8 8.5h8"/>',
  setup: '<circle cx="12" cy="12" r="7.5"/><path d="m6 5-1.5-1.5M18 5l1.5-1.5M12 8v4l3 2"/>',
};
for (const link of document.querySelectorAll('[data-nav]')) {
  link.insertAdjacentHTML('afterbegin', `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[link.dataset.nav] || ''}</svg>`);
}
const appearance = document.getElementById('appearance');
function syncNativeAppearance() {
  window.webkit?.messageHandlers?.appearance?.postMessage(document.documentElement.dataset.theme || 'system');
}
if (window.maestroNative) document.documentElement.classList.add('native-app');
if (appearance) {
  appearance.setAttribute('aria-label', 'Appearance');
  appearance.value = document.documentElement.dataset.theme || 'system';
  appearance.addEventListener('change', () => {
    const theme = appearance.value;
    const applyTheme = () => {
      if (theme === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
      syncNativeAppearance();
    };
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(applyTheme);
    else applyTheme();
    try { localStorage.setItem('maestro-appearance', theme); } catch { /* Optional preference. */ }
  });
  syncNativeAppearance();
}
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  const destination = { '1': '/', '2': '/inbox.html', '3': '/setup.html', ',': '/setup.html' }[event.key];
  if (destination) { event.preventDefault(); location.assign(destination); }
});
const connection = document.getElementById('connection');
if (connection) {
  const update = () => { connection.dataset.connected = String(/connected/i.test(connection.textContent) && !/offline|disconnected/i.test(connection.textContent)); };
  new MutationObserver(update).observe(connection, { childList: true, characterData: true, subtree: true });
  update();
  if (!document.querySelector('#composer, #inbox-list')) {
    const check = async () => {
      try {
        const response = await fetch('/api/health');
        const health = await response.json();
        connection.textContent = response.ok && health.name === 'Maestro' ? 'Mac connected' : 'Mac offline';
      } catch { connection.textContent = 'Mac offline'; }
    };
    void check();
    setInterval(() => { if (!document.hidden) void check(); }, 15000);
  }
}
