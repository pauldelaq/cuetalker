document.addEventListener('DOMContentLoaded', () => {
  const langButton = document.getElementById('languageButton');
  const langMenu = document.getElementById('languageMenu');
  const langList = document.querySelector('.language-list');
  const lessonList = document.getElementById('lesson-list');

  const languages = [
    { code: 'en-US', name: 'English' },
    { code: 'fr-FR', name: 'Français' },
    { code: 'es-ES', name: 'Español' },
    { code: 'zh-TW', name: '中文 (繁體)' },
    { code: 'zh-CN', name: '中文 (简体)' }
  ];

  const currentLang = localStorage.getItem('ctlanguage') || '';
  let translations = {};

  // Open language menu
  langButton.addEventListener('click', () => {
    langMenu.classList.toggle('hidden');
  });

  // Populate Language Menu
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
    loadLessons(); // 🔥 Reload lesson titles
  });

      langList.appendChild(btn);
    });
  }

  function loadTranslations() {
    fetch('data/index-translations.json')
      .then(res => res.json())
      .then(data => {
        translations = data;
        applyTranslations();
      });
  }

  function applyTranslations() {
    const lang = localStorage.getItem('ctlanguage') || 'en-US';
    const t = translations[lang] || translations['en-US'];

    document.getElementById('header-title').textContent = t.title;
    document.getElementById('intro-text').textContent = t.intro;
    document.getElementById('choose-text').textContent = t.choose;
    document.querySelector('#languageMenu h2').textContent = t.languageMenuTitle;
    document.querySelector('footer p').textContent = t.footer;
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

  // Load Lessons
  function loadLessons() {
    fetch('data/lessons.json')
      .then(res => res.json())
      .then(data => {
        const lang = localStorage.getItem('ctlanguage') || 'en-US';

        lessonList.innerHTML = '';
        data.lessons.forEach(lesson => {
          const li = document.createElement('li');
          li.className = 'lesson-item';

          // 🔥 Grab the title in the current language, fallback to English
          const title = lesson.name[lang] || lesson.name['en-US'] || lesson.id;
          li.textContent = title;

          li.addEventListener('click', () => {
            window.location.href = `talker.html?lesson=${encodeURIComponent(lesson.id)}`;
          });

          lessonList.appendChild(li);
        });
      });
  }

  populateLanguageMenu();
  updateLanguageHighlight();
  loadTranslations();
  loadLessons();
});
