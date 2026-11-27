// Runs before first paint so the page never flashes the wrong theme.
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('idash.theme') || 'system'; } catch (e) {}
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  var r = document.documentElement;
  r.setAttribute('data-theme', dark ? 'dark' : 'light');
  r.setAttribute('data-pref', pref);
})();
