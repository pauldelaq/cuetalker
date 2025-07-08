// cuetalker.js

let currentIndex = 0;
let conversation = [];
let svgLibrary = {};
let hintAvatar = {};
let recognition;
let isRecording = false;
let isSpeaking = false;
let audioContext, analyser, dataArray, volumeInterval;
let micStream;
let micIsMuted = true;
let speechHasStarted = false;
let finalizedTranscript = '';
let selectedLang = localStorage.getItem('ctlanguage') || '';
let selectedVoiceName = localStorage.getItem('ctvoice') || '';
let availableVoices = [];
let autoAdvance = localStorage.getItem('ctAutoAdvance') === 'true';
let totalResponses = 0;
let incorrectResponses = 0;
let modeLocked = false;
let practiceMode = false;
let talkerTranslations = {};
let graceTimeout = null;

// Enable :active on mobile
document.addEventListener('touchstart', () => {}, true);

function getLangKey(code) {
  // Ensure consistent language keys using full xx-XX format
  const knownLangs = ['en-US', 'fr-FR', 'es-ES', 'zh-CN', 'zh-TW'];
  if (knownLangs.includes(code)) return code;

  const base = (code || '').split('-')[0];
  return knownLangs.find(k => k.startsWith(base)) || 'en-US';
}

function t(key) {
  const lang = getLangKey(localStorage.getItem('ctlanguage'));
  return (
    talkerTranslations?.[lang]?.[key] ||
    talkerTranslations?.['en']?.[key] ||
    `[${key}]`
  );
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startGraceTimer() {
  clearGraceTimer();
  graceTimeout = setTimeout(() => {
    console.log('Grace period expired — recognition stopped');
    stopSpeechRecognition(); // ✅ Correct way
  }, 3000);
}

function clearGraceTimer() {
  if (graceTimeout) {
    clearTimeout(graceTimeout);
    graceTimeout = null;
  }
}

function findOriginalAnswer(normalizedTarget, validAnswers) {
  return validAnswers.find(answer => normalize(answer) === normalizedTarget);
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
      // 🔸 Non-breaking space after opening guillemet «
      .replace(/(«)(\s)/g, '$1\u00A0')
      // 🔸 Non-breaking space before closing guillemet », and before ! ? : ; % $ €
      .replace(/(\s)([»!?;:%$€])/g, '\u00A0$2');

    if (oldText !== newText) {
      node.textContent = newText;
    }
  }
}

function loadTalkerTranslations() {
  fetch('data/talker-translations.json')
    .then(res => res.json())
    .then(data => {
      talkerTranslations = data;
      applyTalkerTranslations();
    });
}

function applyTalkerTranslations() {
  const lang = getLangKey(localStorage.getItem('ctlanguage'));
  const t = talkerTranslations[lang] || talkerTranslations['en'];

  // Settings menu
  document.querySelector('#settingsMenu h2').textContent = t.settings;
  document.querySelector('label[for="ctvoice"]').textContent = t.voice;
  document.getElementById('volumeLevelLabel').textContent = t.volume;
  document.getElementById('TTSSpeedLabel').textContent = t.speed;
  document.querySelector('label[for="autoAdvanceToggle"]').lastChild.nodeValue = ` ${t.autoAdvance}`;
  document.querySelector('label[for="fontSizeSlider"]').textContent = t.fontSize;
  document.getElementById('fontSizePreview').textContent = t.preview;

  // Footer mode labels
  const modeLabels = document.querySelectorAll('#modeSelector label');
  if (modeLabels.length >= 2) {
    modeLabels[0].lastChild.nodeValue = ` ${t.modeTest}`;
    modeLabels[1].lastChild.nodeValue = ` ${t.modePractice}`;
  }
}

function applyMisheardMap(text, lang) {
  const words = text.split(/\s+/);
  const langMap = misheardMap[lang] || {};
  return words.map(word => langMap[word] || word).join(' ');
}

const misheardMap = {
  'en-US': {
    'know': 'no',
    'there': 'their',
    'to': 'too',
    'see': 'sea'
  },
  'es-ES': {
    'di': 'vi',
    'muy': 'fui'
  }
};

function wordLevelDistance(a, b) {
  const wordsA = a.trim().split(/\s+/);
  const wordsB = b.trim().split(/\s+/);

  let mismatches = 0;
  const len = Math.max(wordsA.length, wordsB.length);

  for (let i = 0; i < len; i++) {
    if (wordsA[i] !== wordsB[i]) mismatches++;
  }
  return mismatches;
}

function levenshteinDistance(a, b) {
  const matrix = [];

  const lenA = a.length;
  const lenB = b.length;

  for (let i = 0; i <= lenB; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= lenA; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= lenB; i++) {
    for (let j = 1; j <= lenA; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[lenB][lenA];
}

const fallbackTriggersByLang = {
  'en-US': ["i don't know", "i dont know"],
  'fr-FR': ["je ne sais pas"],
  'es-ES': ["no lo sé"],
  'zh-TW': ["我不知道"],
  'zh-CN': ["我不知道"],
};

function isFallbackTrigger(spokenText) {
  const normalized = normalize(spokenText, lessonLang);
  const triggers = (fallbackTriggersByLang[lessonLang] || []).map(t => normalize(t, lessonLang));
  return triggers.includes(normalized);
}

function skipCurrentSpeechAndShowHint() {
  const currentItem = conversation[currentIndex];

  speechSynthesis.cancel();
  isSpeaking = false;

  if (currentItem?.type === 'prompt' && currentItem.hint) {
    renderHintBubble(currentItem.hint);
  }

  updateMicIcon();
  tryAutoAdvance();
}

async function startMicSession() {
  if (micStream) return; // ✅ Mic is already running

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startVolumeMonitoring(micStream);
  } catch (err) {
    console.error('Mic error:', err);
    alert('Could not access the microphone.');
    micStream = null;
  }
}

function stopMicStream() {
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
}

function stopMicSession() {
  stopVolumeMonitoring();
  stopMicStream();
}

function displayFinalScore() {
  const transcriptEl = document.getElementById('liveTranscript');
  if (!transcriptEl) return;

  // ✅ 🔥 Don't show score in Practice Mode
  if (practiceMode) {
    transcriptEl.textContent = '';
    return;
  }

  const correct = totalResponses - incorrectResponses;
  const percent = totalResponses > 0
    ? Math.round((correct / totalResponses) * 100)
    : 100;

  transcriptEl.textContent = `${percent}% (${correct}/${totalResponses})`;
}

function updateAutoAdvanceToggle() {
  const autoAdvanceToggle = document.getElementById('autoAdvanceToggle');
  const autoAdvanceLabel = document.querySelector('label[for="autoAdvanceToggle"]');

  if (autoAdvanceToggle) {
    autoAdvanceToggle.disabled = practiceMode;
  }
  if (autoAdvanceLabel) {
    autoAdvanceLabel.classList.toggle('disabled', practiceMode);
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

function populateVoiceList() {
  availableVoices = speechSynthesis.getVoices();
  const voiceSelect = document.getElementById('ctvoice');
  voiceSelect.innerHTML = '';

  const storedVoices = JSON.parse(localStorage.getItem('ctvoice')) || {};
  const storedVoice = storedVoices[selectedLang] || '';

  const baseLang = selectedLang.split('-')[0].toLowerCase();

  // ✅ Allow all voices that match the base language (en → en-US, en-GB, etc)
  const filtered = availableVoices.filter(v =>
    v.lang && v.lang.toLowerCase().startsWith(baseLang)
  );

  filtered.forEach(voice => {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = `${voice.name} (${voice.lang})${voice.default ? ' — DEFAULT' : ''}`;
    if (voice.name === storedVoice) opt.selected = true;
    voiceSelect.appendChild(opt);
  });

  // ✅ Store fallback voice if none selected
  if (filtered.length > 0 && !filtered.find(v => v.name === storedVoice)) {
    const fallback = filtered[0].name;
    storedVoices[selectedLang] = fallback;
    localStorage.setItem('ctvoice', JSON.stringify(storedVoices));
    selectedVoiceName = fallback;
  } else {
    selectedVoiceName = storedVoice;
  }
}

function highlightDifferences(userText, expectedText) {
  const isCJK = ['zh-CN', 'zh-TW', 'ja', 'ko'].includes(lessonLang);

  const userUnitsRaw = isCJK ? Array.from(userText.trim()) : userText.trim().split(/\s+/);
  const userUnitsNorm = isCJK ? Array.from(normalize(userText)) : normalize(userText).split(/\s+/);
  const expectedUnitsNorm = isCJK ? Array.from(normalize(expectedText)) : normalize(expectedText).split(/\s+/);

  const highlighted = [];

  const len = Math.max(userUnitsNorm.length, expectedUnitsNorm.length);

  for (let i = 0; i < len; i++) {
    const userRaw = userUnitsRaw[i] || '';
    const userNorm = userUnitsNorm[i] || '';
    const expectedNorm = expectedUnitsNorm[i] || '';

    if (userNorm === expectedNorm) {
      highlighted.push(userRaw);
    } else {
      highlighted.push(`<span class="wrong-word">${userRaw}</span>`);
    }
  }

  return highlighted.join(isCJK ? '' : ' ');
}

function startVolumeMonitoring(stream) {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  const micSource = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  micSource.connect(analyser);

  dataArray = new Uint8Array(analyser.fftSize);

  volumeInterval = setInterval(() => {
    const micButton = document.getElementById('micButton');

    if (micIsMuted) {
      micButton.style.boxShadow = 'none'; // 🔥 Remove any glow entirely
      return;
    }

    analyser.getByteTimeDomainData(dataArray);
    const volume = Math.max(...dataArray) - 128;
    animateMicPulse(volume);
  }, 100);
}

function stopVolumeMonitoring() {
  clearInterval(volumeInterval);
  volumeInterval = null;

  analyser = null;
  dataArray = null;

  const micButton = document.getElementById('micButton');
  micButton.classList.remove('recording');
  micButton.style.boxShadow = 'none'; // ✅ 🔥 Fully removes glow
}

function animateMicPulse(volume) {
  const micButton = document.getElementById('micButton');

  const clampedVolume = Math.min(volume, 50); // cap volume
  const glowSize = 5 + (clampedVolume * 0.3); // range: ~5–20

  micButton.style.boxShadow = `0 0 ${glowSize}px red`;
}

function speakText(text, onend) {
  const utterance = new SpeechSynthesisUtterance(text);
  const matchedVoice = availableVoices.find(v => v.name === selectedVoiceName);
  if (matchedVoice) utterance.voice = matchedVoice;

  utterance.volume = parseFloat(localStorage.getItem('ctvolume') ?? '1');
  utterance.rate = parseFloat(localStorage.getItem('ctspeed') ?? '1.0');

  isSpeaking = true;

  utterance.onend = () => {
    isSpeaking = false;
    if (typeof onend === 'function') onend();
  };

  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

let lessonLang = '';
let lessonLangName = '';

async function loadLesson() {
  const urlParams = new URLSearchParams(window.location.search);
  const lessonId = urlParams.get('lesson');

  if (!lessonId) {
    alert('No lesson specified in URL.');
    return;
  }

  try {
    const res = await fetch(`data/lessons/${lessonId}.json`);
    const data = await res.json();

    // 🌍 Get the user's selected language
    const storedLang = getLangKey(localStorage.getItem('ctlanguage'));
    const languageData = data.languages[storedLang] || data.languages['en'];

    if (!languageData) {
      throw new Error(`Language ${storedLang} not found in lesson data.`);
    }

    // 🔗 Load global assets
    svgLibrary = data.svgLibrary || {};
    hintAvatar = data.hintAvatar || {};

    // 🌍 Load per-language content
    conversation = languageData.exercises || [];
    lessonLang = languageData.language || storedLang;
    lessonLangName = languageData.languageName || storedLang;

    // ✅ Reset session state
    currentIndex = 0;
    totalResponses = 0;
    incorrectResponses = 0;

    modeLocked = false;
    practiceMode = false;
    document.getElementById('cue-footer')?.classList.remove('locked');

    updateAutoAdvanceToggle();

    // ✅ Update localStorage if needed
    localStorage.setItem('ctlanguage', lessonLang);
    selectedLang = lessonLang;
    localStorage.setItem('ctlanguage', selectedLang); // full format

    initializeVoiceMenu();
    updateMicIcon();
    showNextMessage();
  } catch (error) {
    console.error('Failed to load lesson:', error);
    alert(`Could not load lesson: ${lessonId}`);
  }
}

function tryAutoAdvance() {
  if (practiceMode) return; // ⛔ Always block auto-advance during Practice Mode
  const nextItem = conversation[currentIndex + 1];

  if (autoAdvance && nextItem?.type === 'response' && !isRecording) {
    setTimeout(() => {
      const micButton = document.getElementById('micButton');
      if (!isRecording && micButton) {
        currentIndex++;      // ✅ Only increment here if actually auto-advancing
        micButton.click();
      }
    }, 300);
  }

  // ✅ DO NOT increment otherwise — user must manually trigger
}

function updateMicIcon() {
  const micIcon = document.querySelector('#micButton img');
  const micButton = document.getElementById('micButton');
  const currentItem = conversation[currentIndex];

  // 🔁 Toggle recording visual
    if (isRecording) {
    micIcon.src = 'assets/svg/23FA.svg';
    micButton.classList.add('recording');
    } else {
    micButton.classList.remove('recording');

    if (isSpeaking && currentItem?.type === 'prompt') {
    micIcon.src = 'assets/svg/25B6.svg'; // "next" icon
    return;
  }

    if (practiceMode) {
        // ✅ Keep static icon in practice mode
        micIcon.src = 'assets/svg/25B6.svg'; // mic
    } else if (!currentItem || currentItem.type === 'narration') {
        micIcon.src = 'assets/svg/25B6.svg'; // narration
    } else {
        micIcon.src = 'assets/svg/1F3A4.svg'; // mic
    }
    }
}

function showNextMessage() {
  const item = conversation[currentIndex];
  if (!item) return;

  renderCurrentLine(item);

  if (item.type === 'prompt' && item.text) {
    const container = document.getElementById('cue-content');
    const messageDivs = container.querySelectorAll('.message.speaker');
    const latestMsg = messageDivs[messageDivs.length - 1];
    const avatar = latestMsg?.querySelector('.avatar');

    if (latestMsg && avatar) {
      latestMsg.addEventListener('animationend', () => {
        const svgEl = avatar.querySelector('.svg-avatar');

        if (svgEl) {
          svgEl.classList.add('rotate-shake');

          svgEl.addEventListener('animationend', () => {
            svgEl.classList.remove('rotate-shake');
            speakText(item.text, () => {
              if (item.hint) renderHintBubble(item.hint);
              updateMicIcon();
              tryAutoAdvance();
            });
          }, { once: true });

        } else {
          // Fallback
        speakText(item.text, () => {
          if (item.hint) renderHintBubble(item.hint);
          updateMicIcon(); // ✅ mic appears after hint
          tryAutoAdvance();
        });
        }
      }, { once: true });
    } else {
      speakText(item.text, () => {
        if (item.hint) renderHintBubble(item.hint);
        updateMicIcon(); // ✅ mic appears after hint
        tryAutoAdvance();
      });
    }

  } else if (item.type === 'prompt' && item.hint) {
    renderHintBubble(item.hint);
    tryAutoAdvance();

  } else if (item.type === 'narration') {
    // Show narration and wait for user input

  } else if (item.type === 'response') {
    // Wait for user input
  }

  // ✅ Display final score if this is the last item
  const nextItem = conversation[currentIndex + 1];
  if (!nextItem) {
    displayFinalScore();

    const micIcon = document.querySelector('#micButton img');
    micIcon.src = 'assets/svg/1F504.svg';

    const micButton = document.getElementById('micButton');
    micButton.onclick = () => {
      location.reload();
    };
  }
}

function renderCurrentLine(item) {
  const container = document.getElementById('cue-content');
  if (!item) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = 'message ' + (
    item.type === 'response' ? 'user' :
    item.type === 'prompt' ? 'speaker' :
    item.type === 'narration' ? 'narration' : ''
  );

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.dataset.id = item.id;

  const character = item.character || {};
  let avatarHTML = `<div class="name">${character.name || ''}</div>`;

  if (character.svg !== undefined && svgLibrary?.[character.svg]) {
    avatarHTML = `
      <img class="svg-avatar" src="${svgLibrary[character.svg]}" alt="avatar">
      ${avatarHTML}
    `;
  }

  avatar.innerHTML = avatarHTML;

  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + (
    item.type === 'response' ? 'right response-fade-in' :
    item.type === 'prompt' ? 'left' :
    item.type === 'narration' ? 'center' : ''
  );

  // ✅ Apply correct/incorrect bubble coloring for responses
  if (item.type === 'response') {
    if (item.wasIncorrect) {
      bubble.classList.add('incorrect');
    } else {
      bubble.classList.add('correct');
    }
  }

  // Apply swipe-in animation to the entire message row for prompts
  if (item.type === 'prompt') {
    msgDiv.classList.add('swipe-in-left');
  }

  bubble.innerText = item.text || '...';
  patchFrenchPunctuationSpaces(bubble);

  if (item.type === 'response') {
    msgDiv.appendChild(bubble);
    msgDiv.appendChild(avatar);
  } else if (item.type === 'prompt') {
    msgDiv.appendChild(avatar);
    msgDiv.appendChild(bubble);
  } else if (item.type === 'narration') {
    msgDiv.appendChild(bubble);
  }

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

function renderNarration(text) {
  const container = document.getElementById('cue-content');

  const narrationDiv = document.createElement('div');
  narrationDiv.className = 'message narration';

  const bubble = document.createElement('div');
  bubble.className = 'bubble center';
  bubble.innerText = text;

  narrationDiv.appendChild(bubble);
  container.appendChild(narrationDiv);
  container.scrollTop = container.scrollHeight;
}

function renderHintBubble(hint) {
  const container = document.getElementById('cue-content');

  const hintDiv = document.createElement('div');
  hintDiv.className = 'message user';

    const avatar = document.createElement('div');
    avatar.className = 'avatar swipe-in-right';

  // ✅ Use svgLibrary + hintAvatar
  let avatarHTML = `<div class="name">${hintAvatar?.name || 'You'}</div>`;

    avatarHTML = `
    <img class="svg-avatar" src="${svgLibrary[hintAvatar.svg]}" alt="thinking">
    ${avatarHTML}
    `;

  avatar.innerHTML = avatarHTML;

  const wrapper = document.createElement('div');
  wrapper.className = 'bubble-wrapper swipe-in-right';

  const textLayer = document.createElement('div');
  textLayer.className = 'hint-bubble';
  textLayer.textContent = hint;

  const bgLayer = document.createElement('div');
  bgLayer.className = 'bubble-bg-pulse';

  wrapper.appendChild(bgLayer);
  wrapper.appendChild(textLayer);

  hintDiv.appendChild(wrapper);
  hintDiv.appendChild(avatar);
  container.appendChild(hintDiv);
  container.scrollTop = container.scrollHeight;

  if (practiceMode) {
    const transcriptEl = document.getElementById('liveTranscript');
    if (transcriptEl) {
      transcriptEl.textContent = t('recordingDisabled');
    }
  }
}

function startSpeechRecognition() {
  if (!('webkitSpeechRecognition' in window)) {
    alert('Speech recognition not supported.');
    return;
  }

  micIsMuted = false;
  speechHasStarted = false;
  clearGraceTimer();
  fullTranscript = '';

  recognition = new webkitSpeechRecognition();
  recognition.lang = lessonLang || 'en-US';
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  isRecording = true;
  updateMicIcon();
  startVolumeMonitoring(micStream);

  recognition.onstart = () => {
    console.log('Speech recognition started');

    if (!speechHasStarted && !fullTranscript.trim()) {
      const transcriptEl = document.getElementById('liveTranscript');
      if (transcriptEl) {
        transcriptEl.innerText = t('listening');
      }
    }
  };

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      } else {
        interimTranscript += result[0].transcript;
      }
    }

    // ✅ Accumulate finalized parts across result events
    if (finalTranscript) {
      finalizedTranscript += ' ' + finalTranscript;
      finalizedTranscript = finalizedTranscript.trim();
    }

    // ✅ Display = finalized + interim
    const currentTranscript = (finalizedTranscript + ' ' + interimTranscript).trim();

    const transcriptEl = document.getElementById('liveTranscript');
    if (transcriptEl) {
      transcriptEl.innerText = currentTranscript;
    }

    // ✅ Grace timer
    if (currentTranscript) {
      if (!speechHasStarted) {
        speechHasStarted = true;
        console.log('Speech detected — starting grace timer');
        startGraceTimer();
      } else {
        clearGraceTimer();
        startGraceTimer();
      }
    }

    // ✅ Instant match logic
    const promptItem = conversation[currentIndex - 1];
    const validAnswers = promptItem?.expectedAnswers || [];
    const normalizedTranscript = normalize(currentTranscript);

    const matched = validAnswers.find(answer =>
      normalize(answer) === normalizedTranscript
    );

    if (matched) {
      console.log('✅ Instant match — stopping recognition early');
      stopSpeechRecognition();
      handleUserResponse(currentTranscript);
    }
  };

  recognition.onerror = (e) => {
    console.warn('Speech recognition error:', e.error);

    if (e.error === 'no-speech' && !speechHasStarted) {
      console.log('No speech detected — restarting recognition');
      stopSpeechRecognition();
      startMicSession().then(() => {
        startSpeechRecognition();
      });
      return;
    }

    // On other errors, stop cleanly
    clearGraceTimer();
    stopSpeechRecognition();
  };

  recognition.onend = () => {
    if (isRecording) {
      console.log('Recognition ended — restarting');
      try {
        recognition.start();
      } catch (err) {
        console.warn('Failed to restart recognition:', err);
      }
    }
  };

  recognition.start();
}

function stopSpeechRecognition() {
  finalizedTranscript = '';
  micIsMuted = true;
  clearGraceTimer();

  if (recognition) {
    recognition.abort();
    recognition = null;
  }

  const transcriptEl = document.getElementById('liveTranscript');
  let finalInput = transcriptEl?.innerText.trim();

  if (finalInput?.startsWith('[') && finalInput.endsWith(']')) {
    console.warn('⚠️ Skipping placeholder transcript:', finalInput);
    finalInput = '';

    if (transcriptEl) {
      transcriptEl.textContent = '';  // ✅ Clear the visible transcript
    }
  }

  if (finalInput) {
    console.log('[Using visible transcript]:', finalInput);
    handleUserResponse(finalInput);
  } else {
    console.warn('[Transcript empty — skipping response handling]');
  }

  isRecording = false;
  updateMicIcon();
}

function normalize(text, langHint) {
  if (!text) return '';

  let normalized = text.trim().toLowerCase();

  // 🔥 Remove accents/diacritics globally
  normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // 🔥 Remove punctuation
  normalized = normalized.replace(/[.,!?;:"'’“”()\[\]{}¿¡，。！？；：「」『』（）【】]/g, '');

  // 🔥 Extract base language from langHint (e.g., 'zh-TW' → 'zh')
  const baseLang = (langHint || lessonLang || 'en-US').split('-')[0];

  const asianLangs = ['zh', 'ja', 'ko', 'th'];
  if (asianLangs.includes(baseLang)) {
    normalized = normalized.replace(/\s+/g, '');
  } else {
    normalized = normalized.replace(/\s+/g, ' ');
  }

  return normalized;
}

function handleUserResponse(spokenText) {
  const item = conversation[currentIndex];
  if (!item || item.type !== 'response') return;

  const promptItem = conversation[currentIndex - 1];
  const validAnswers = promptItem?.expectedAnswers || [];

  totalResponses++;

  // ✅ Fallback: "I don't know"
  if (isFallbackTrigger(spokenText)) {
    incorrectResponses++;
    item.wasIncorrect = true;

    const fallbackAnswer = validAnswers[0] || '...';

    const hintWrapper = document.querySelector('#cue-content .bubble-wrapper');
    if (hintWrapper?.parentElement) {
      hintWrapper.parentElement.remove();
    }

    item.text = fallbackAnswer;
    renderCurrentLine(item);

    currentIndex++;
    showNextMessage();
    return;
  }

  // Step 1: Exact match
  let matched = validAnswers.find(answer => answer === spokenText);

  const normalizedSpoken = normalize(spokenText);
  const normalizedAnswers = validAnswers.map(answer => normalize(answer));

  // Step 2: Normalized match
  if (!matched) {
    for (let i = 0; i < validAnswers.length; i++) {
      if (normalize(validAnswers[i]) === normalizedSpoken) {
        matched = validAnswers[i];
        break;
      }
    }
  }

  // Step 3: Global misheard correction
  if (!matched) {
    const correctedText = applyMisheardMap(spokenText, lessonLang);
    const normalizedCorrected = normalize(correctedText);

    for (let i = 0; i < validAnswers.length; i++) {
      if (normalize(validAnswers[i]) === normalizedCorrected) {
        matched = validAnswers[i];
        console.log(`✅ Matched after global misheard correction: "${correctedText}"`);
        break;
      }
    }
  }

  // Step 4: Per-word misheard justification
  if (!matched) {
    const langMap = misheardMap[lessonLang] || {};

    for (let i = 0; i < normalizedAnswers.length; i++) {
      const normExpected = normalizedAnswers[i];
      const expectedWords = normExpected.split(/\s+/);
      const spokenWords = normalizedSpoken.split(/\s+/);
      if (spokenWords.length !== expectedWords.length) continue;

      let allJustified = true;

      for (let j = 0; j < spokenWords.length; j++) {
        const spoken = spokenWords[j];
        const expected = expectedWords[j];

        if (spoken === expected) continue;

        const corrected = langMap[spoken];
        if (corrected !== expected) {
          allJustified = false;
          break;
        }
      }

      if (allJustified) {
        matched = validAnswers[i]; // ✅ use original string
        spokenText = validAnswers[i]; // ✅ update transcript display
        console.log("✅ Accepted via per-word misheard justification.");

        const transcriptEl = document.getElementById('liveTranscript');
        if (transcriptEl) {
          transcriptEl.textContent = spokenText;
        }
        break;
      }
    }
  }

  // Step 5: Per-word fuzzy match (Levenshtein distance <= 1)
  if (!matched) {
    for (let i = 0; i < normalizedAnswers.length; i++) {
      const expectedWords = normalizedAnswers[i].split(/\s+/);
      const spokenWords = normalizedSpoken.split(/\s+/);

      if (expectedWords.length !== spokenWords.length) continue;

      let allWordsMatch = true;

      for (let j = 0; j < spokenWords.length; j++) {
        const wordA = spokenWords[j];
        const wordB = expectedWords[j];

        if (wordA === wordB) continue;

        const dist = levenshteinDistance(wordA, wordB);
        if (dist > 1) {
          allWordsMatch = false;
          break;
        }
      }

      if (allWordsMatch) {
        matched = validAnswers[i];
        spokenText = matched;

        const transcriptEl = document.getElementById('liveTranscript');
        if (transcriptEl) {
          transcriptEl.textContent = matched;
        }

        console.log("✅ Accepted via per-word fuzzy match.");
        break;
      }
    }
  }

  if (matched) {
    // ✅ CORRECT
    const hintWrapper = document.querySelector('#cue-content .bubble-wrapper');
    if (hintWrapper?.parentElement) {
      hintWrapper.parentElement.remove();
    }

    item.text = matched;
    renderCurrentLine(item);

    currentIndex++;
    showNextMessage();
  } else {
    // ❌ INCORRECT
    incorrectResponses++;
    item.wasIncorrect = true;

    let bestMatch = '';
    let lowestDistance = Infinity;

    for (const expected of validAnswers) {
      const dist = wordLevelDistance(normalizedSpoken, normalize(expected));
      if (dist < lowestDistance) {
        lowestDistance = dist;
        bestMatch = expected;
      }
    }

    const redText = highlightDifferences(spokenText, bestMatch);

    const transcriptEl = document.getElementById('liveTranscript');
    if (transcriptEl) transcriptEl.innerHTML = redText;

    const container = document.getElementById('cue-content');
    const avatars = container.querySelectorAll('.message.user .avatar .svg-avatar');
    const lastEmoji = avatars[avatars.length - 1];
    if (lastEmoji) {
      lastEmoji.classList.add('shake');
      lastEmoji.addEventListener('animationend', () => {
        lastEmoji.classList.remove('shake');
      }, { once: true });
    }
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

function initializeVoiceMenu() {
  availableVoices = speechSynthesis.getVoices();

  if (availableVoices.length) {
    populateVoiceList();
  } else {
    speechSynthesis.onvoiceschanged = () => {
      availableVoices = speechSynthesis.getVoices();
      populateVoiceList();
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

function initializeSettingsMenu() {
  const autoAdvanceToggle = document.getElementById('autoAdvanceToggle');
  const autoAdvanceLabel = document.querySelector('label[for="autoAdvanceToggle"]');

  // 🔁 Setup auto-advance toggle
  if (autoAdvanceToggle) {
    autoAdvanceToggle.checked = autoAdvance;
    autoAdvanceToggle.addEventListener('change', (e) => {
      autoAdvance = e.target.checked;
      localStorage.setItem('ctAutoAdvance', autoAdvance);
    });
  }

  // ✅ Disable auto-advance when Practice Mode is active
  if (autoAdvanceToggle) {
    autoAdvanceToggle.disabled = practiceMode;
  }

  if (autoAdvanceLabel) {
    autoAdvanceLabel.classList.toggle('disabled', practiceMode);
  }

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

window.addEventListener('DOMContentLoaded', () => {
  loadLesson();
  initializeVoiceMenu();
  setupVoiceMenuListener();
  initializeSettingsMenu();
  loadTalkerTranslations();

  const micButton = document.getElementById('micButton');
  const settingsButton = document.getElementById('settingsButton');

micButton.addEventListener('click', () => {
  micButton.blur(); // ✅ Clear focus so :active doesn't stick on mobile

  // ✅ Unlock TTS on iPhone (safari autoplay workaround)
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(''));

  // 🔥 NEW: Skip TTS if user clicks during playback
  if (isSpeaking) {
    skipCurrentSpeechAndShowHint();
    return;
  }

  if (!modeLocked) {
    const selected = document.querySelector('input[name="mode"]:checked')?.value;
    practiceMode = (selected === 'practice');

    if (practiceMode) {
      autoAdvance = false;
    }

    modeLocked = true;
    document.getElementById('cue-footer').classList.add('locked');

    updateAutoAdvanceToggle();
  }

  let currentItem = conversation[currentIndex];
  if (!currentItem) return;

  // 🔥 ✅ Check if recognition is running — toggle it (soft mute model)
  if (isRecording) {
    stopSpeechRecognition();
    return;
  }

  // 🔥 ✅ Practice Mode
  if (practiceMode) {
    if (
      currentItem.type === 'prompt' &&
      currentItem.hint &&
      conversation[currentIndex + 1]?.type === 'response'
    ) {
      currentIndex++;
      currentItem = conversation[currentIndex];
    } else if (currentItem.type === 'narration' || currentItem.type === 'response') {
      currentIndex++;
      currentItem = conversation[currentIndex];
    }

    // ✅ Auto-fill for empty response
    if (currentItem?.type === 'response' && !currentItem.text) {
      const prevItem = conversation[currentIndex - 1];
      const fallbackAnswer = prevItem?.expectedAnswers?.[0];
      if (fallbackAnswer) {
        currentItem.text = fallbackAnswer;
        currentItem.autoFilled = true;
      }
    }

    // ✅ Remove current hint (if any)
    const hintWrapper = document.querySelector('#cue-content .bubble-wrapper');
    if (hintWrapper?.parentElement) {
      hintWrapper.parentElement.remove();
    }

    const transcriptEl = document.getElementById('liveTranscript');
    if (transcriptEl) {
      transcriptEl.textContent = '';
    }

    showNextMessage();
    return;
  }

  // 🔁 Regular Mode
  if (
    currentItem.type === 'prompt' &&
    currentItem.hint &&
    conversation[currentIndex + 1]?.type === 'response'
  ) {
    currentIndex++;
    currentItem = conversation[currentIndex];
  }

  if (currentItem.type === 'response') {
    if (currentItem.autoFilled) {
      currentIndex++;
      showNextMessage();
    } else {
      startMicSession().then(() => {
        startSpeechRecognition();
      });
    }
  } else if (currentItem.type === 'narration') {
    currentIndex++;
    showNextMessage();
  }
});

  settingsButton.addEventListener('click', () => {
    settingsButton.blur(); // ✅ Prevent sticky focus
    document.getElementById('settingsMenu')?.classList.toggle('show');
  });
});

document.addEventListener('click', (e) => {
  const avatar = e.target.closest('.avatar');
  if (!avatar || !avatar.dataset.id) return;

  // 🚫 Ignore hint avatars
  if (avatar.closest('.message.user.swipe-in-right')) return;

  const id = Number(avatar.dataset.id);
  const item = conversation.find(entry => entry.id === id);
  if (!item || !item.text) return;

  const svg = avatar.querySelector('.svg-avatar');
  if (svg) {
    svg.classList.add('rotate-shake');
    svg.addEventListener('animationend', () => {
      svg.classList.remove('rotate-shake');
    }, { once: true });
  }

  if (isSpeaking) skipCurrentSpeechAndShowHint(); // ✅ new

  speakText(item.text);
});

document.querySelectorAll('.circle-btn').forEach(button => {
  button.addEventListener('touchstart', () => {
    button.classList.add('active');
  });

  const removeActive = () => {
    button.classList.remove('active');
  };

  button.addEventListener('touchend', removeActive);
  button.addEventListener('touchcancel', removeActive);
});

window.addEventListener('beforeunload', () => {
  stopMicSession(); // ✅ First stop mic and volume monitoring

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
});
