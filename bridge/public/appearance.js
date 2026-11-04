// Apply the saved appearance before first paint. WebKit can disable local storage.
try {
  const theme = localStorage.getItem('maestro-appearance');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* The system appearance still works without storage. */ }
