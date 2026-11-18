(function () {
  try {
    var stored = JSON.parse(localStorage.getItem('goldwatch.settings.v1') || 'null');
    var theme = (stored && stored.theme) || 'system';
    var dark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.colors = (stored && stored.colorMode) || 'cn';
  } catch (error) {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.colors = 'cn';
  }
})();
