// Тема до першого малювання: окремий файл, бо CSP не пускає вбудовані скрипти.
// Далі тему веде app.js (Налаштування → Тема).
(function () {
  var pref = 'auto';
  try { pref = localStorage.getItem('marnotrat:theme') || 'auto'; } catch (e) { /* приватний режим */ }
  var light = pref === 'light' || (pref === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  var theme = ['night', 'phosphor', 'amber', 'white'].indexOf(pref) >= 0 ? pref : light ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  // Фон під картками — теж до малювання, інакше на старті блимне «Без малюнка»; у спецрежимах фону немає.
  // Ключі — ті самі, що BACKDROPS у app.js
  if (theme === 'light' || theme === 'dark') {
    var list = theme === 'light' ? ['l-plain', 'l-map', 'l-mm', 'l-sand', 'l-sand-acc', 'l-khaki', 'l-khaki-acc']
      : ['plain', 'map', 'olive', 'carbon', 'coyote', 'lines', 'lines-acc'];
    var bg = null;
    try { bg = localStorage.getItem(theme === 'light' ? 'marnotrat:bg-light' : 'marnotrat:bg'); } catch (e) { /* приватний режим */ }
    document.documentElement.dataset.bg = list.indexOf(bg) >= 0 ? bg : list[0];
  }
})();
