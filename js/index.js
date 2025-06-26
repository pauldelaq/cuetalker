document.addEventListener('DOMContentLoaded', () => {
  const langButton = document.getElementById('languageButton');
  const langMenu = document.getElementById('languageMenu');
  const langList = document.querySelector('.language-list');
  const lessonList = document.getElementById('lesson-list');

  const languages = [
    { code: 'en', name: 'English' },
    { code: 'fr', name: 'Français' },
    { code: 'es', name: 'Español' },
    { code: 'zh', name: '中文' }
  ];

  const currentLang = localStorage.getItem('ctlanguage') || '';

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
      });

      langList.appendChild(btn);
    });
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
  fetch('data/lessons.json')
    .then(res => res.json())
    .then(data => {
      lessonList.innerHTML = '';
      data.lessons.forEach(lesson => {
        const li = document.createElement('li');
        li.className = 'lesson-item';
        li.textContent = lesson.name;
        li.addEventListener('click', () => {
          window.location.href = `talker.html?lesson=${encodeURIComponent(lesson.id)}`;
        });
        lessonList.appendChild(li);
      });
    });

  populateLanguageMenu();
  updateLanguageHighlight();
});
