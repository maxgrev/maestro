// Apply the saved appearance before first paint. WebKit can disable local storage.
try {
  const theme = localStorage.getItem('maestro-appearance');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  if (localStorage.getItem('maestro-sidebar-collapsed') === 'true') document.documentElement.dataset.sidebarCollapsed = 'true';
  const width = Number(localStorage.getItem('maestro-sidebar-width'));
  if (Number.isFinite(width) && width >= 240 && width <= 420) document.documentElement.style.setProperty('--conversation-sidebar-width', width + 'px');
} catch { /* The system appearance still works without storage. */ }
