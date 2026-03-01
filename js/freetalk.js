let selectedLang = localStorage.getItem('ctlanguage') || '';
let selectedVoiceName = localStorage.getItem('ctvoice') || '';
let availableVoices = [];
let voicesInitialized = false;
let svgLibrary = {};

// ---- Mode state (FreeTalk) ----
let practiceMode = false;
let currentMode = 'test';          // 'test' | 'practice'
let modeLocked = false;            // lock mode selection after session begins
const TEST_DURATION_SEC = 60;
let testTimerId = null;
let testTimeLeft = TEST_DURATION_SEC;
let volumeGlowTargetId = 'micButton';

// ---- FreeTalk mic/tts state ----
let isSessionActive = false; // FreeTalk session (mic) state
let isTtsSpeaking = false;   // Track TTS speaking for UI icon

// ---- FreeTalk lesson state ----
let freetalkLesson = null;
let freetalkLangData = null;
let lessonPromptData = null;
let wordListData = [];
let lessonLang = '';
let lessonLangName = '';

// Shared UI translations loaded from data/talker-translations.json
// Keep a single shared instance across pages/scripts
window.talkerTranslations = window.talkerTranslations || {};
let talkerTranslations = window.talkerTranslations;

function ensureTimerDisplay() {
  let el = document.getElementById('testTimerDisplay');
  if (el) return el;

  const footer = document.getElementById('cue-footer') || document.querySelector('footer');
  if (!footer) return null;

  el = document.createElement('div');
  el.id = 'testTimerDisplay';
  el.className = 'test-timer-display';
  el.style.display = 'none';
  el.style.userSelect = 'none';
  el.style.webkitUserSelect = 'none';

  // Put timer between mode selector and transcript (so it won't cover transcript)
  const transcript = footer.querySelector('#liveTranscript');
  if (transcript) footer.insertBefore(el, transcript);
  else footer.appendChild(el);

  return el;
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function updateTimerUI() {
  const el = ensureTimerDisplay();
  if (!el) return;

  if (currentMode !== 'test') {
    el.style.display = 'none';
    return;
  }

  el.style.display = 'block';
  el.textContent = `${formatTime(testTimeLeft)}`;
}

function stopTestTimer() {
  if (testTimerId) {
    clearInterval(testTimerId);
    testTimerId = null;
  }
  updateTimerUI();
}

function startTestTimer() {
  stopTestTimer();
  testTimeLeft = TEST_DURATION_SEC;
  updateTimerUI();

  testTimerId = setInterval(() => {
    testTimeLeft -= 1;
    updateTimerUI();

    if (testTimeLeft <= 0) {
      stopTestTimer();
      console.log('[FreeTalk] Test timer finished.');

      // Later: when speech recognition is wired, stop it here.
      // stopSpeechRecognition?.();
    }
  }, 1000);
}

function lockModeSelector(lock) {
  modeLocked = !!lock;
  document.querySelectorAll('#modeSelector input[name="mode"]').forEach(inp => {
    inp.disabled = modeLocked;
  });
}

function initializeModeSelector() {
  const modeSelector = document.getElementById('modeSelector');
  if (!modeSelector) return;

  const inputs = modeSelector.querySelectorAll('input[name="mode"]');
  if (!inputs.length) return;

  // Initial mode from HTML checked radio
  const checked = modeSelector.querySelector('input[name="mode"]:checked');
  currentMode = checked?.value === 'practice' ? 'practice' : 'test';
  practiceMode = (currentMode === 'practice');
  updateTimerUI();

  modeSelector.addEventListener('change', (e) => {
    const target = e.target;
    if (!target || target.name !== 'mode') return;

    if (modeLocked) {
      // Revert changes if locked
      inputs.forEach(inp => (inp.checked = (inp.value === currentMode)));
      return;
    }

    currentMode = target.value === 'practice' ? 'practice' : 'test';
    practiceMode = (currentMode === 'practice');

    // Reset timer whenever mode changes
    stopTestTimer();
    testTimeLeft = TEST_DURATION_SEC;
    updateTimerUI();
  });
}

function beginFreeTalkSession() {
  isSessionActive = true;
  updateMicIcon();
  lockModeSelector(true);
  if (currentMode === 'test') startTestTimer();
  else stopTestTimer();
}

function endFreeTalkSession() {
  isSessionActive = false;
  updateMicIcon();
  lockModeSelector(false);
  stopTestTimer();
  testTimeLeft = TEST_DURATION_SEC;
  updateTimerUI();
}

function initializeSettingsMenu() {

  // 🔈 Volume control
  const volumeSlider = document.getElementById('volumeLevelSlider');
  if (volumeSlider) {
    const savedVolume = parseFloat(localStorage.getItem('ctvolume') ?? '1');
    volumeSlider.value = savedVolume;
    updateSpeakerIcon(savedVolume);

    volumeSlider.addEventListener('input', (e) => {
      const volume = parseFloat(e.target.value);
      localStorage.setItem('ctvolume', volume);
      updateSpeakerIcon(volume); // ✅ Update icon live as the slider moves
    });
  }

  // 🚀 TTS Speed control
  const speedSlider = document.getElementById('TTSSpeedSlider');
  if (speedSlider) {
    const savedSpeed = localStorage.getItem('ctspeed') ?? '1.0';
    speedSlider.value = savedSpeed;

    speedSlider.addEventListener('input', (e) => {
      const speed = parseFloat(e.target.value);
      localStorage.setItem('ctspeed', speed);
    });
  }

  // ✅ Font size control
  const fontSizeSlider = document.getElementById('fontSizeSlider');
  const fontPreview = document.getElementById('fontSizePreview');

  if (fontSizeSlider) {
    const savedSize = localStorage.getItem('ctFontSize') || '100';
    fontSizeSlider.value = savedSize;
    document.documentElement.style.setProperty('--message-font-size', `${savedSize}%`);
    if (fontPreview) {
      fontPreview.style.fontSize = `${savedSize}%`;
    }

    fontSizeSlider.addEventListener('input', (e) => {
      const newSize = e.target.value;
      document.documentElement.style.setProperty('--message-font-size', `${newSize}%`);
      localStorage.setItem('ctFontSize', newSize);

      if (fontPreview) {
        fontPreview.style.fontSize = `${newSize}%`;
      }
    });
  }
}

function updateSpeakerIcon(volume) {
  const volumeMinIcon = document.getElementById('volumeMinIcon');
  if (!volumeMinIcon) return;

  const numericVolume = parseFloat(volume);

  if (numericVolume <= 0.01) {
    volumeMinIcon.classList.add('muted');
  } else {
    volumeMinIcon.classList.remove('muted');
  }
}

function getSelectedVoiceForLang(langCode) {
  const voices = speechSynthesis.getVoices();
  if (!voices || !voices.length) return null;

  // Prefer explicit selection
  if (selectedVoiceName) {
    const byName = voices.find(v => v.name === selectedVoiceName);
    if (byName) return byName;
  }

  // Fallback: match language root
  const root = (langCode || 'en-US').split('-')[0];
  return voices.find(v => (v.lang || '').split('-')[0] === root) || voices[0] || null;
}

function speakText(text, langCode) {
  const cleaned = (text || '').trim();
  if (!cleaned) return;

  // Cancel any current speech so repeated clicks restart cleanly
  try { speechSynthesis.cancel(); } catch (_) {}

  const utter = new SpeechSynthesisUtterance(cleaned);
  utter.lang = langCode || localStorage.getItem('ctlanguage') || 'en-US';

  const voice = getSelectedVoiceForLang(utter.lang);
  if (voice) utter.voice = voice;

  const vol = parseFloat(localStorage.getItem('ctvolume') ?? '1');
  const rate = parseFloat(localStorage.getItem('ctspeed') ?? '1.0');

  utter.volume = Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : 1;
  utter.rate = Number.isFinite(rate) ? Math.max(0.1, Math.min(10, rate)) : 1;
  utter.pitch = 1;

  // No mic icon changes during TTS in FreeTalk mode
  utter.onstart = () => { isTtsSpeaking = true; };
  utter.onend = () => { isTtsSpeaking = false; };
  utter.onerror = () => { isTtsSpeaking = false; };

  speechSynthesis.speak(utter);
}

function getLangKey(code) {
  // Ensure consistent language keys using full xx-XX format
  const knownLangs = ['en-US', 'fr-FR', 'es-ES', 'zh-CN', 'zh-TW'];
  if (knownLangs.includes(code)) return code;

  const base = (code || '').split('-')[0];
  return knownLangs.find(k => k.startsWith(base)) || 'en-US';
}

function loadTalkerTranslations() {
  fetch('data/talker-translations.json')
    .then(res => res.json())
    .then(data => {
      talkerTranslations = data;
      window.talkerTranslations = talkerTranslations;
      applyTalkerTranslations(); // ✅ This is fine now, because initializeSettingsMenu already ran
    });
}

function applyTalkerTranslations() {
  const lang = getLangKey(localStorage.getItem('ctlanguage'));
  const t = talkerTranslations[lang] || talkerTranslations['en'];

  // Settings menu (guarded for pages that don't include every control)
  const settingsTitle = document.querySelector('#settingsMenu h2');
  if (settingsTitle) settingsTitle.textContent = t.settings;

  const voiceLabel = document.querySelector('#voiceDropdown')?.previousElementSibling;
  if (voiceLabel) voiceLabel.textContent = t.voice;

  const volLabel = document.getElementById('volumeLevelLabel');
  if (volLabel) volLabel.textContent = t.volume;

  const speedLabel = document.getElementById('TTSSpeedLabel');
  if (speedLabel) speedLabel.textContent = t.speed;

  const autoAdvanceLabel = document.querySelector('label[for="autoAdvanceToggle"]');
  if (autoAdvanceLabel && autoAdvanceLabel.lastChild) {
    autoAdvanceLabel.lastChild.nodeValue = ` ${t.autoAdvance}`;
  }

  const fontLabel = document.querySelector('label[for="fontSizeSlider"]');
  if (fontLabel) fontLabel.textContent = t.fontSize;

  const preview = document.getElementById('fontSizePreview');
  if (preview) preview.textContent = t.preview;

  // Footer mode labels (only if the mode selector exists on this page)
  const modeLabels = document.querySelectorAll('#modeSelector label');
  if (modeLabels.length >= 2) {
    if (modeLabels[0].lastChild) modeLabels[0].lastChild.nodeValue = ` ${t.modeTest}`;
    if (modeLabels[1].lastChild) modeLabels[1].lastChild.nodeValue = ` ${t.modePractice}`;
  }
}

function initializeVoiceMenu() {
  availableVoices = speechSynthesis.getVoices();

  if (availableVoices.length) {
    populateCustomVoiceList();
  } else {
    speechSynthesis.onvoiceschanged = () => {
      availableVoices = speechSynthesis.getVoices();
      populateCustomVoiceList();
    };
  }

  const voiceSelect = document.getElementById('ctvoice');
  if (voiceSelect) {
    voiceSelect.addEventListener('change', (e) => {
      selectedVoiceName = e.target.value;
      const storedVoices = JSON.parse(localStorage.getItem('ctvoice')) || {};
      storedVoices[selectedLang] = selectedVoiceName;
      localStorage.setItem('ctvoice', JSON.stringify(storedVoices));
    });
  }
}

function patchFrenchPunctuationSpaces(container) {
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

    if (oldText !== newText) node.textContent = newText;
  }
}

function renderLessonPrompt() {
  const item = {
    type: 'prompt',
    text: lessonPromptData?.text || '',
    character: lessonPromptData?.character || {}
  };

  const container = document.getElementById('cue-content');
  if (!container) return;

  // Remove any previously rendered lesson prompt bubble
  container.querySelector('.message.speaker.freetalk-lesson-prompt')?.remove();

  const msgDiv = document.createElement('div');
  msgDiv.className = 'message speaker swipe-in-left freetalk-lesson-prompt';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';

  // Prefer animating the SVG image if present (matches classic mode behavior)
  const character = item.character || {};
  const name = character.name || '';
  let avatarHTML = '';
  if (character.svg !== undefined && svgLibrary?.[character.svg]) {
    avatarHTML += `<img class="svg-avatar" src="${svgLibrary[character.svg]}" alt="avatar">`;
  }
  avatarHTML += `<div class="name">${name}</div>`;
  avatar.innerHTML = avatarHTML;

  // Prefer animating the SVG image if present (matches classic mode behavior)
  const avatarAnimTarget = avatar.querySelector('.svg-avatar') || avatar;
  avatar.dataset.animTarget = avatar.querySelector('.svg-avatar') ? 'img' : 'wrap';

  avatar.addEventListener('click', () => {
    // Trigger the same click animation used in classic mode
    avatarAnimTarget.classList.remove('rotate-shake');
    // Force reflow so the animation can retrigger on repeated clicks
    void avatarAnimTarget.offsetWidth;
    avatarAnimTarget.classList.add('rotate-shake');
    setTimeout(() => avatarAnimTarget.classList.remove('rotate-shake'), 450);

    speakText(item.text || '', selectedLang || lessonLang || localStorage.getItem('ctlanguage') || 'en-US');
  });


  const bubble = document.createElement('div');
  bubble.className = 'bubble left';
  bubble.innerText = item.text || '';
  patchFrenchPunctuationSpaces(bubble);

  msgDiv.appendChild(avatar);
  msgDiv.appendChild(bubble);

  // Insert prompt bubble above the word list (and above settings menu) so layout matches classic mode
  const wordListEl = document.getElementById('wordListContainer');
  const settingsMenuEl = document.getElementById('settingsMenu');

  if (wordListEl && wordListEl.parentNode === container) {
    container.insertBefore(msgDiv, wordListEl);
  } else if (settingsMenuEl && settingsMenuEl.parentNode === container) {
    container.insertBefore(msgDiv, settingsMenuEl);
  } else {
    container.appendChild(msgDiv);
  }

  container.scrollTop = container.scrollHeight;

}

// Helper: Build phrase list item with {word} substitution
function buildPhraseListItem(phraseText, word) {
  const li = document.createElement('li');
  li.className = 'phrase-item tts-clickable';

  const phrase = String(phraseText || '');
  // Store the full phrase for TTS (replace placeholder)
  const fullPhraseForTTS = phrase.split('{word}').join(word);
  li.dataset.tts = fullPhraseForTTS;
  li.style.cursor = 'pointer';

  // Click phrase to speak the full phrase
  li.addEventListener('click', () => {
    speakText(fullPhraseForTTS, selectedLang || lessonLang || localStorage.getItem('ctlanguage') || 'en-US');
  });

  const parts = phrase.split('{word}');

  parts.forEach((part, i) => {
    if (part) li.appendChild(document.createTextNode(part));
    if (i < parts.length - 1) {
      const span = document.createElement('span');
      span.className = 'phrase-word';
      span.textContent = word;
      li.appendChild(span);
    }
  });

  return li;
}

function renderWordList() {
  const container = document.getElementById('wordList')
    || document.getElementById('wordListContainer')
    || document.getElementById('targetWordList');

  if (!container) {
    console.warn('[FreeTalk] No word list container found (expected #wordList or #wordListContainer or #targetWordList).');
    return;
  }

  // Clear container and build bubbles
  container.innerHTML = '';

  wordListData.forEach((item, idx) => {
    const word = (item.word || '').trim();
    if (!word) return;

    const bubble = document.createElement('div');
    bubble.className = 'wordBubble';
    bubble.dataset.index = String(idx);
    bubble.dataset.word = word;

    // Header row (triangle + word)
    const header = document.createElement('div');
    header.className = 'wordBubbleHeader';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'wordBubbleToggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Show phrases');
    toggle.textContent = '▸';

    const wordSpan = document.createElement('span');
    wordSpan.className = 'wordBubbleText tts-clickable';
    wordSpan.textContent = word;
    wordSpan.style.cursor = 'pointer';
    wordSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      speakText(word, selectedLang || lessonLang || localStorage.getItem('ctlanguage') || 'en-US');
    });

    header.appendChild(toggle);
    header.appendChild(wordSpan);

    // Phrases (collapsed by default)
    const phrasesWrap = document.createElement('div');
    phrasesWrap.className = 'wordBubblePhrases';

    const phrases = Array.isArray(item.phrases) ? item.phrases : [];
    if (phrases.length) {
      const ul = document.createElement('ul');
      ul.className = 'phraseList';
      phrases.forEach(p => ul.appendChild(buildPhraseListItem(p, word)));
      phrasesWrap.appendChild(ul);
    } else {
      // If no phrases, keep empty container for consistent animation
      phrasesWrap.innerHTML = '';
    }

    // Toggle expand/collapse
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = bubble.classList.toggle('expanded');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', expanded ? 'Hide phrases' : 'Show phrases');
    });

    bubble.appendChild(header);
    bubble.appendChild(phrasesWrap);

    container.appendChild(bubble);
  });

  // Optional: reduce accidental text selection on mobile
  container.querySelectorAll('.tts-clickable').forEach(el => {
    el.style.userSelect = 'none';
    el.style.webkitUserSelect = 'none';
  });
}

async function loadLesson() {
  const urlParams = new URLSearchParams(window.location.search);
  const lessonId = urlParams.get('lesson');

  if (!lessonId) {
    alert('No lesson specified in URL.');
    return;
  }

  try {
    const res = await fetch(`data/freetalkdata/${lessonId}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${lessonId}.json`);

    const data = await res.json();
    freetalkLesson = data;

    // 🌍 Pick the correct language block
    const storedLang = getLangKey(localStorage.getItem('ctlanguage'));
    freetalkLangData = (data.languages && (data.languages[storedLang] || data.languages['en'])) || null;

    if (!freetalkLangData) {
      throw new Error(`No languages block found for ${storedLang} (and no 'en' fallback).`);
    }

    // Keep these in case you want avatars later
    svgLibrary = data.svgLibrary || {};

    // ---- NEW FORMAT ----
    lessonPromptData = freetalkLangData.lessonPrompt || { text: '' };
    wordListData = Array.isArray(freetalkLangData.wordList) ? freetalkLangData.wordList : [];

    // Optional meta
    lessonLang = freetalkLangData.language || storedLang;
    lessonLangName = freetalkLangData.languageName || storedLang;

    // Persist language for TTS/recognition
    selectedLang = lessonLang;
    localStorage.setItem('ctlanguage', selectedLang);

    // Render UI
    renderLessonPrompt();
    renderWordList();

    // Voice list depends on current language
    initializeVoiceMenu();
    updateMicIcon?.();

    console.log('[FreeTalk] Lesson loaded:', lessonId, { lang: storedLang, words: wordListData.length });
  } catch (error) {
    console.error('Failed to load lesson:', error);
    alert(`Could not load lesson: ${lessonId}`);
  }
}

function populateCustomVoiceList() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) {
    setTimeout(populateCustomVoiceList, 200);
    return;
  }

  const fullLang = localStorage.getItem('ctlanguage') || 'en-US';
  const langKey = fullLang.split('-')[0];

  const dropdownList = document.getElementById('dropdownList');
  const dropdownToggle = document.getElementById('dropdownToggle');
  if (!dropdownList || !dropdownToggle) return;

  dropdownList.innerHTML = '';

  const filtered = voices.filter(v => {
    const [root, region] = v.lang.split('-');
    if (root !== langKey) return false;
    if (root === 'zh' && region?.toUpperCase() === 'HK') return false;
    return true;
  });

  filtered.forEach(voice => {
    const li = document.createElement('li');
    li.textContent = `${voice.name} (${voice.lang})`;
    li.dataset.voiceName = voice.name;
    dropdownList.appendChild(li);
  });

  // Load stored voice for this language
  const stored = JSON.parse(localStorage.getItem('ctvoice') || '{}');
  const savedVoiceName = stored[langKey];
  const defaultVoice = filtered.find(v => v.name === savedVoiceName) || filtered[0];

  if (defaultVoice) {
    dropdownToggle.textContent = `${defaultVoice.name} (${defaultVoice.lang})`;
    selectedVoiceName = defaultVoice.name; // ✅ THIS IS WHAT YOU WERE MISSING
    stored[langKey] = defaultVoice.name;
    localStorage.setItem('ctvoice', JSON.stringify(stored));
  }

  if (dropdownList.dataset.bound !== '1') {
    dropdownList.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;

      const selected = li.dataset.voiceName;
      dropdownToggle.textContent = li.textContent;
      dropdownList.style.display = 'none';

      selectedVoiceName = selected;
      const updated = JSON.parse(localStorage.getItem('ctvoice') || '{}');
      updated[langKey] = selected;
      localStorage.setItem('ctvoice', JSON.stringify(updated));
    });
    dropdownList.dataset.bound = '1';
  }

  if (dropdownToggle.dataset.bound !== '1') {
    dropdownToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownList.style.display =
        dropdownList.style.display === 'block' ? 'none' : 'block';
    });

    // Close the dropdown when clicking elsewhere
    document.addEventListener('click', () => {
      dropdownList.style.display = 'none';
    });

    dropdownToggle.dataset.bound = '1';
  }
}

function initializeVoiceMenu() {
  availableVoices = speechSynthesis.getVoices();

  if (availableVoices.length) {
    populateCustomVoiceList();
  } else {
    speechSynthesis.onvoiceschanged = () => {
      availableVoices = speechSynthesis.getVoices();
      populateCustomVoiceList();
    };
  }

  const voiceSelect = document.getElementById('ctvoice');
  if (voiceSelect) {
    voiceSelect.addEventListener('change', (e) => {
      selectedVoiceName = e.target.value;
      const storedVoices = JSON.parse(localStorage.getItem('ctvoice')) || {};
      storedVoices[selectedLang] = selectedVoiceName;
      localStorage.setItem('ctvoice', JSON.stringify(storedVoices));
    });
  }
}

function setupVoiceMenuListener() {
  const voiceSelect = document.getElementById('ctvoice');
  if (voiceSelect) {
    voiceSelect.addEventListener('change', (e) => {
      selectedVoiceName = e.target.value;
      const storedVoices = JSON.parse(localStorage.getItem('ctvoice')) || {};
      storedVoices[selectedLang] = selectedVoiceName;
      localStorage.setItem('ctvoice', JSON.stringify(storedVoices));
    });
  }
}

function updateMicIcon() {
  const micIcon = document.querySelector('#micButton img');
  const micButton = document.getElementById('micButton');
  if (!micIcon || !micButton) return;

  // Session active (recognition running / user speaking)
  if (isSessionActive || micButton.classList.contains('active')) {
    micIcon.src = 'assets/svg/23FA.svg'; // ⏺️ / stop-style icon while recording
    micButton.classList.add('recording');
    return;
  }

  micButton.classList.remove('recording');


  // Default idle state
  micIcon.src = 'assets/svg/1F3A4.svg'; // 🎤 mic
}

document.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(() => {
    initializeSettingsMenu();
    loadTalkerTranslations();
    initializeVoiceMenu();
    setupVoiceMenuListener();
    initializeModeSelector();
    updateMicIcon();

    Promise.all([
      loadLesson()
    ]).then(() => {
      document.body.classList.remove('preload');
    });
    
    speechSynthesis.onvoiceschanged = populateCustomVoiceList;

    const micButton = document.getElementById('micButton');
    const settingsButton = document.getElementById('settingsButton');

    micButton.addEventListener('click', () => {
      // Temporary session toggle until speech recognition is wired in
      const active = micButton.classList.toggle('active');
      isSessionActive = active;

      if (active) beginFreeTalkSession();
      else endFreeTalkSession();

      updateMicIcon();
    });

    settingsButton.addEventListener('click', () => {
      settingsButton.blur();
      document.getElementById('settingsMenu')?.classList.toggle('show');
    });
  });
});
