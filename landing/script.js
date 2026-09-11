const root = document.documentElement;
const toggle = document.querySelector('.theme-toggle');
const label = document.querySelector('.theme-label');

const setTheme = (theme) => {
  root.dataset.theme = theme;
  const isLight = theme === 'light';
  toggle.setAttribute('aria-pressed', String(isLight));
  toggle.setAttribute('aria-label', `切换${isLight ? '深色' : '浅色'}主题`);
  label.textContent = isLight ? '浅色' : '深色';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', isLight ? '#eff7ef' : '#071715');
  localStorage.setItem('desktop-mascot-theme', theme);
};

const savedTheme = localStorage.getItem('desktop-mascot-theme');
if (savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme);

toggle.addEventListener('click', () => setTheme(root.dataset.theme === 'light' ? 'dark' : 'light'));

const mascotApi = window.LivelyMascot;
if (mascotApi) {
  const hero = mascotApi.createMascot(document.querySelector('#hero-mascot'), {
    type: 'ghost', size: 154, color: '#bdeef2', outline: '#23434d', accent: '#a9d9ff',
    viewMode: '3d', outlineVisible: true, followCursor: false, hopInterval: null,
  });
  hero.setEmotion('10');

  const stage = document.querySelector('.window-canvas');
  stage.addEventListener('pointerenter', () => hero.setEmotion('11'));
  stage.addEventListener('pointerleave', () => hero.setEmotion('10'));
  stage.addEventListener('click', () => hero.setEmotion('38'));

  document.querySelectorAll('[data-character]').forEach((host) => {
    const mascot = mascotApi.createMascot(host, {
      type: host.dataset.character, size: 58, viewMode: '3d', followCursor: false,
      hopInterval: null, animated: false,
    });
    mascot.setEmotion('02');
  });
}
