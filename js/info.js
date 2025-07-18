document.addEventListener('DOMContentLoaded', () => {
  const langButton = document.getElementById('languageButton');
  const langMenu = document.getElementById('languageMenu');
  const langList = document.querySelector('.language-list');

  const languages = [
    { code: 'en-US', name: 'English' },
    { code: 'fr-FR', name: 'Français' },
    { code: 'es-ES', name: 'Español' },
    { code: 'zh-TW', name: '中文 (繁體)' },
    { code: 'zh-CN', name: '中文 (简体)' }
  ];

  const currentLang = localStorage.getItem('ctlanguage') || '';
  let translations = {};

  langButton.addEventListener('click', () => {
    langMenu.classList.toggle('hidden');
  });

  function populateLanguageMenu() {
    langList.innerHTML = '';
    languages.forEach(lang => {
      const btn = document.createElement('button');
      btn.className = 'lang-btn';
      btn.textContent = lang.name;
      if (lang.code === currentLang) btn.classList.add('selected');

      btn.addEventListener('click', () => {
        localStorage.setItem('ctlanguage', lang.code);
        langMenu.classList.add('hidden');
        updateLanguageHighlight();
        applyTranslations();
      });

      langList.appendChild(btn);
    });
  }

  function loadTranslations() {
    return fetch('data/index-translations.json')
      .then(res => res.json())
      .then(data => {
        translations = data;
        applyTranslations();
      });
  }

  function applyTranslations() {
    const lang = localStorage.getItem('ctlanguage') || 'en-US';
    const t = translations[lang] || translations['en-US'];

    const welcomeEl = document.getElementById('welcome-text');
    if (welcomeEl) welcomeEl.textContent = t.welcome;

    const introEl = document.getElementById('intro-text');
    if (introEl) introEl.textContent = t.intro;

    const creditsLabel = document.getElementById('credits-label');
    if (creditsLabel) creditsLabel.textContent = t.creditsLabel;

    const createdBy = document.getElementById('created-by');
    if (createdBy) createdBy.innerHTML = t.createdBy;

    const openMoji = document.getElementById('openmoji');
    if (openMoji) openMoji.innerHTML = t.openMoji;

    const langMenuHeader = document.querySelector('#languageMenu h2');
    if (langMenuHeader) langMenuHeader.textContent = t.languageMenuTitle;

    const footerEl = document.querySelector('footer p');
    if (footerEl) footerEl.textContent = t.footer;

    if (lang.startsWith('fr')) {
      patchFrenchPunctuationSpaces(document.body);
    }
  }

  function updateLanguageHighlight() {
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.remove('selected');
      const selectedLang = localStorage.getItem('ctlanguage');
      if (btn.textContent === languages.find(l => l.code === selectedLang)?.name) {
        btn.classList.add('selected');
      }
    });
  }

  populateLanguageMenu();
  updateLanguageHighlight();

    loadTranslations()
    .catch(err => {
        console.error('Translation loading failed:', err);
    })
    .finally(() => {
        document.body.classList.remove('preload');
    });

    const infoButton = document.getElementById('backButton');
    if (backButton) {
      backButton.addEventListener('click', () => {
        window.location.href = 'index.html';
      });
    }

});

function patchFrenchPunctuationSpaces(container) {
  const lessonLang = localStorage.getItem('ctlanguage');
  if (!lessonLang || !lessonLang.startsWith('fr')) return;

  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const oldText = node.textContent;

    const newText = oldText
      .replace(/(«)(\s)/g, '$1\u00A0')
      .replace(/(\s)([»!?;:%$€])/g, '\u00A0$2');

    if (oldText !== newText) {
      node.textContent = newText;
    }
  }
}
