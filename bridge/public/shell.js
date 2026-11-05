import '/disclosures.js';

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
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const transition = document.startViewTransition(applyTheme);
      void transition.ready.catch(() => { /* Resizing may skip the animation; the theme still applies. */ });
    }
    else applyTheme();
    try { localStorage.setItem('maestro-appearance', theme); } catch { /* Optional preference. */ }
  });
}
syncNativeAppearance();
if (location.pathname === '/setup.html' && location.hash === '#app-settings') location.replace('/settings.html');
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  if (event.key === '2' && document.body.classList.contains('conversations-page')) return;
  const destination = { '1': '/?sidebar=open', '2': '/?filter=unread', '3': '/setup.html', ',': '/settings.html' }[event.key];
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
