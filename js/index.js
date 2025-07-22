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

    document.getElementById('choose-text').textContent = t.choose;
    document.querySelector('#languageMenu h2').textContent = t.languageMenuTitle;

    // 🔁 Update modal button text dynamically when language changes
    const modalText = document.getElementById('modalText');
    const confirmBtn = document.getElementById('confirmReset');
    const cancelBtn = document.getElementById('cancelReset');

    if (modalText && confirmBtn && cancelBtn && t.modal) {
      modalText.textContent = t.modal.confirmReset;
      confirmBtn.textContent = t.modal.confirmButton;
      cancelBtn.textContent = t.modal.cancelButton;
    }

    const clearBtn = document.getElementById('clearScoresBtn');
    if (clearBtn && t.clearScores) {
      clearBtn.textContent = t.clearScores;
    }

  // ✅ Fix spacing if French is selected
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

  // Load Lessons
function loadLessons() {
  return fetch('data/lessons.json')
    .then(res => res.json())
    .then(data => {
      const lang = localStorage.getItem('ctlanguage') || 'en-US';
      const storedScores = JSON.parse(localStorage.getItem('ctscores')) || {};
      const scoresForLang = storedScores[lang] || [];

      lessonList.innerHTML = '';
      data.lessons.forEach(lesson => {
        const li = document.createElement('li');
        li.className = 'lesson-item';

        const title = lesson.name[lang] || lesson.name['en-US'] || lesson.id;
        const matching = scoresForLang.find(entry => entry.lesson === lesson.id);
        const date = matching?.date || '';
        const score = matching?.score || '';

        // 👇 Inject structured HTML
        li.innerHTML = `
          <div class="lesson-title">${title}</div>
          ${matching ? `
            <div class="lesson-meta">
              <span class="lesson-date">${date}</span>
              <span class="lesson-score">${score}</span>
            </div>
          ` : ''}
        `;

        li.addEventListener('click', () => {
          window.location.href = `talker.html?lesson=${encodeURIComponent(lesson.id)}`;
        });

        lessonList.appendChild(li);
      });
    });
}

  populateLanguageMenu();
  updateLanguageHighlight();

Promise.all([loadTranslations(), loadLessons()]).then(() => {
  document.body.classList.remove('preload');

  const lang = localStorage.getItem('ctlanguage') || 'en-US';
  const t = translations[lang] || translations['en-US'];

  const clearBtn = document.getElementById('clearScoresBtn');
  const modal = document.getElementById('confirmationModal');
  const modalText = document.getElementById('modalText');
  const confirmBtn = document.getElementById('confirmReset');
  const cancelBtn = document.getElementById('cancelReset');

  if (clearBtn && modal && modalText && confirmBtn && cancelBtn) {
    modalText.textContent = t.modal.confirmReset;
    confirmBtn.textContent = t.modal.confirmButton;
    cancelBtn.textContent = t.modal.cancelButton;

    clearBtn.addEventListener('click', () => {
      modal.classList.remove('hidden');
    });

    cancelBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    confirmBtn.addEventListener('click', () => {
      const langKey = localStorage.getItem('ctlanguage');
      const scores = JSON.parse(localStorage.getItem('ctscores') || '{}');
      delete scores[langKey];
      localStorage.setItem('ctscores', JSON.stringify(scores));
      modal.classList.add('hidden');
      location.reload();
    });
  }
});

    const infoButton = document.getElementById('infoButton');
  if (infoButton) {
    infoButton.addEventListener('click', () => {
      window.location.href = 'info.html';
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
      .replace(/(«)(\s)/g, '$1\u00A0')          // « + nbsp
      .replace(/(\s)([»!?;:%$€])/g, '\u00A0$2'); // nbsp + punctuation

    if (oldText !== newText) {
      node.textContent = newText;
    }
  }
}
