let selectedLang = localStorage.getItem('ctlanguage') || '';
let selectedVoiceName = localStorage.getItem('ctvoice') || '';
let availableVoices = [];

// ---- BuildTalker lesson state ----
let buildLesson = null;
let buildLangData = null;
let lessonPromptData = null;
let sentenceItems = [];
let currentSentenceIndex = 0;
let currentChunkIndex = 0;
let addedChunkIndexes = [];
let currentTargetChunkIndex = null;
let currentSentenceStateMap = new Map();
let currentSentenceHistory = [];
let roundSentenceHistories = [];
let awaitingSentenceReview = false;
let lessonCompleteAwaitingReview = false;
let showingRoundReview = false;
let lessonStarted = false;
let stepAdvanceTimer = null;
let suppressFooterIconUpdates = false;
let isAdvancingStep = false;
let freeModeSilenceTimer = null;
let pendingFreeModeMatch = null;
let lessonLang = '';
let lessonLangName = '';

// ---- BuildTalker mic/tts state ----
let transcriptController = null;
let transcriber = null;
let micStream = null;
let isSessionActive = false;
let isRecording = false;
let finalizedTranscript = '';
let displayTranscript = '';
let isTtsSpeaking = false;

// ---- Mic visual feedback ----
let audioContext = null;
let analyser = null;
let dataArray = null;
let volumeInterval = null;
let micIsMuted = true;
let volumeGlowTargetId = 'micButton';

const SESSION_BUTTON_ID = 'micButton';
const TELEPROMPTER_OVERFLOW_TOLERANCE_PX = 1;

// Shared UI translations loaded from data/talker-translations.json
window.talkerTranslations = window.talkerTranslations || {};
let talkerTranslations = window.talkerTranslations;

function getLangKey(code) {
  const knownLangs = ['en-US', 'fr-FR', 'es-ES', 'zh-CN', 'zh-TW', 'ja-JP', 'th-TH'];
  if (knownLangs.includes(code)) return code;

  const base = (code || '').split('-')[0];
  return knownLangs.find(k => k.startsWith(base)) || 'en-US';
}

function applyUrlLanguageOverride() {
  const params = new URLSearchParams(window.location.search);
  const langFromUrl = params.get('lang');
  if (!langFromUrl) return;

  const normalizedLang = getLangKey(langFromUrl);
  selectedLang = normalizedLang;
  localStorage.setItem('ctlanguage', normalizedLang);
}

function getLiveTranscriptEl() {
  return document.getElementById('liveTranscript');
}

function isTranscriptOverflowing() {
  const el = getLiveTranscriptEl();
  if (!el) return false;
  return el.scrollHeight > (el.clientHeight + TELEPROMPTER_OVERFLOW_TOLERANCE_PX);
}

function renderTranscriptFallback(interimText = '') {
  const el = getLiveTranscriptEl();
  if (!el) return;
  el.textContent = (displayTranscript + ' ' + (interimText || '')).trim();
}

function resetTranscriptDisplay(text = '') {
  displayTranscript = String(text || '').trim();

  if (transcriptController) {
    transcriptController.reset();
    if (displayTranscript) {
      transcriptController.appendFinal(displayTranscript);
    }
    transcriptController.setInterim('');
  } else {
    renderTranscriptFallback('');
  }
}

function clearTranscriptUI() {
  finalizedTranscript = '';
  resetTranscriptDisplay('');
}

function initTranscriptController() {
  const el = document.getElementById('liveTranscript');
  if (!el) return;

  if (!window.TranscriptController) {
    console.warn('[BuildTalker] TranscriptController not found. Ensure js/engine/transcript-controller.js is loaded before build.js');
    return;
  }

  transcriptController = new window.TranscriptController({ el });
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’‘´`]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDisplayTtsText(rawText) {
  const raw = String(rawText || '').trim();
  const match = /^\(([^/()]+)\/([^()]+)\)$/.exec(raw);

  if (!match) {
    return {
      displayText: raw,
      ttsText: raw
    };
  }

  return {
    displayText: match[1].trim(),
    ttsText: match[2].trim()
  };
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

function initializeSettingsMenu() {
  const volumeSlider = document.getElementById('volumeLevelSlider');
  if (volumeSlider) {
    const savedVolume = parseFloat(localStorage.getItem('ctvolume') ?? '1');
    volumeSlider.value = savedVolume;
    updateSpeakerIcon(savedVolume);

    volumeSlider.addEventListener('input', (e) => {
      const volume = parseFloat(e.target.value);
      localStorage.setItem('ctvolume', volume);
      updateSpeakerIcon(volume);
    });
  }

  const speedSlider = document.getElementById('TTSSpeedSlider');
  if (speedSlider) {
    const savedSpeed = localStorage.getItem('ctspeed') ?? '1.0';
    speedSlider.value = savedSpeed;

    speedSlider.addEventListener('input', (e) => {
      const speed = parseFloat(e.target.value);
      localStorage.setItem('ctspeed', speed);
    });
  }

  const fontSizeSlider = document.getElementById('fontSizeSlider');
  const fontPreview = document.getElementById('fontSizePreview');

  if (fontSizeSlider) {
    const savedSize = localStorage.getItem('ctFontSize') || '100';
    fontSizeSlider.value = savedSize;
    document.documentElement.style.setProperty('--message-font-size', `${savedSize}%`);
    if (fontPreview) fontPreview.style.fontSize = `${savedSize}%`;

    fontSizeSlider.addEventListener('input', (e) => {
      const newSize = e.target.value;
      document.documentElement.style.setProperty('--message-font-size', `${newSize}%`);
      localStorage.setItem('ctFontSize', newSize);
      if (fontPreview) fontPreview.style.fontSize = `${newSize}%`;
    });
  }
}

function updateSpeakerIcon(volume) {
  const volumeMinIcon = document.getElementById('volumeMinIcon');
  if (!volumeMinIcon) return;

  const numericVolume = parseFloat(volume);
  if (numericVolume <= 0.01) volumeMinIcon.classList.add('muted');
  else volumeMinIcon.classList.remove('muted');
}

function loadTalkerTranslations() {
  return fetch('data/talker-translations.json')
    .then(res => res.json())
    .then(data => {
      talkerTranslations = data;
      window.talkerTranslations = talkerTranslations;
      applyTalkerTranslations();
    })
    .catch(err => {
      console.warn('[BuildTalker] Could not load talker translations:', err);
    });
}

function applyTalkerTranslations() {
  const lang = getLangKey(localStorage.getItem('ctlanguage'));
  const t = talkerTranslations[lang] || talkerTranslations['en-US'];
  if (!t) return;

  const settingsTitle = document.querySelector('#settingsMenu h2');
  if (settingsTitle) settingsTitle.textContent = t.settings;

  const voiceLabel = document.querySelector('#voiceDropdown')?.previousElementSibling;
  if (voiceLabel) voiceLabel.textContent = t.voice;

  const volLabel = document.getElementById('volumeLevelLabel');
  if (volLabel) volLabel.textContent = t.volume;

  const speedLabel = document.getElementById('TTSSpeedLabel');
  if (speedLabel) speedLabel.textContent = t.speed;

  const fontLabel = document.querySelector('label[for="fontSizeSlider"]');
  if (fontLabel) fontLabel.textContent = t.fontSize;

  const preview = document.getElementById('fontSizePreview');
  if (preview) preview.textContent = t.preview;
}

function getSelectedVoiceForLang(langCode) {
  const voices = speechSynthesis.getVoices();
  if (!voices || !voices.length) return null;

  if (selectedVoiceName) {
    const byName = voices.find(v => v.name === selectedVoiceName);
    if (byName) return byName;
  }

  const root = (langCode || 'en-US').split('-')[0];
  return voices.find(v => (v.lang || '').split('-')[0] === root) || voices[0] || null;
}

function speakText(text, langCode) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return;

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

  utter.onstart = () => { isTtsSpeaking = true; };
  utter.onend = () => { isTtsSpeaking = false; };
  utter.onerror = () => { isTtsSpeaking = false; };

  speechSynthesis.speak(utter);
}

// Add sentence-level TTS click support
function makeSentenceTtsClickable(el, text) {
  if (!el) return;

  const ttsText = String(text || '').trim();
  if (!ttsText) return;

  el.classList.add('tts-clickable');
  el.style.cursor = 'pointer';
  el.dataset.tts = ttsText;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    speakText(ttsText, selectedLang || lessonLang || localStorage.getItem('ctlanguage') || 'en-US');
  });
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

  const stored = JSON.parse(localStorage.getItem('ctvoice') || '{}');
  const savedVoiceName = stored[langKey];
  const defaultVoice = filtered.find(v => v.name === savedVoiceName) || filtered[0];

  if (defaultVoice) {
    dropdownToggle.textContent = `${defaultVoice.name} (${defaultVoice.lang})`;
    selectedVoiceName = defaultVoice.name;
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
      dropdownList.style.display = dropdownList.style.display === 'block' ? 'none' : 'block';
    });

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
}

function renderLessonPrompt() {
  const container = document.getElementById('cue-content');
  if (!container) return;

  container.querySelector('.buildtalker-lesson-prompt')?.remove();

  const text = lessonPromptData?.text || '';
  if (!text) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = 'message narration swipe-in-left buildtalker-lesson-prompt';

  const bubble = document.createElement('div');
  bubble.className = 'bubble center';
  bubble.textContent = text;

  patchFrenchPunctuationSpaces(bubble);

  msgDiv.appendChild(bubble);

  const settingsMenuEl = document.getElementById('settingsMenu');

  if (settingsMenuEl && settingsMenuEl.parentNode === container) {
    container.insertBefore(msgDiv, settingsMenuEl);
  } else {
    container.appendChild(msgDiv);
  }
}


function startVolumeMonitoring(stream, targetId = 'micButton') {
  volumeGlowTargetId = targetId;
  if (!stream) return;

  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (volumeInterval) clearInterval(volumeInterval);

  try {
    const micSource = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    micSource.connect(analyser);

    dataArray = new Uint8Array(analyser.fftSize);

    volumeInterval = setInterval(() => {
      const targetBtn = document.getElementById(volumeGlowTargetId) || document.getElementById('micButton');
      if (!targetBtn || !analyser || !dataArray) return;

      if (micIsMuted) {
        targetBtn.style.boxShadow = 'none';
        return;
      }

      analyser.getByteTimeDomainData(dataArray);
      const volume = Math.max(...dataArray) - 128;
      animateMicPulse(volume);
    }, 100);
  } catch (e) {
    console.warn('[BuildTalker] Volume monitoring unavailable:', e);
  }
}

function animateMicPulse(volume) {
  const targetBtn = document.getElementById(volumeGlowTargetId) || document.getElementById('micButton');
  if (!targetBtn) return;

  const clamped = Math.min(volume, 50);
  const glowSize = 5 + (clamped * 0.3);
  targetBtn.style.boxShadow = `0 0 ${glowSize}px red`;
}

function stopVolumeMonitoring() {
  if (volumeInterval) {
    clearInterval(volumeInterval);
    volumeInterval = null;
  }

  analyser = null;
  dataArray = null;

  const micButton = document.getElementById('micButton');
  if (micButton) micButton.style.boxShadow = 'none';
}

async function startMicSession() {
  if (micStream) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startVolumeMonitoring(micStream, SESSION_BUTTON_ID);
  } catch (err) {
    console.error('[BuildTalker] Mic error:', err);
    alert('Could not access the microphone.');
    micStream = null;
  }
}

function stopMicSession() {
  stopVolumeMonitoring();
  if (!micStream) return;
  micStream.getTracks().forEach(t => t.stop());
  micStream = null;
}

function startBuildTalkerRecognition() {
  if (!window.WebSpeechTranscriber) {
    alert('Speech recognition engine not loaded.');
    return;
  }

  if (!transcriptController) initTranscriptController();

  clearTranscriptUI();

  transcriber = new window.WebSpeechTranscriber({
    lang: selectedLang || lessonLang || localStorage.getItem('ctlanguage') || 'en-US',
    interimResults: true,
    continuousRestart: true
  });

  transcriber.onInterim = (interimText) => {
    const interim = (interimText || '').trim();

    if (transcriptController) {
      transcriptController.setInterim(interim);
    } else {
      renderTranscriptFallback(interim);
    }

    const full = (finalizedTranscript + ' ' + interim).trim();
    checkCurrentStepAnswer(full);
  };

  transcriber.onFinal = (finalChunk) => {
    const chunk = (finalChunk || '').trim();
    if (!chunk) return;

    finalizedTranscript = (finalizedTranscript + ' ' + chunk).trim();
    const nextDisplayTranscript = (displayTranscript + ' ' + chunk).trim();

    if (transcriptController) {
      transcriptController.reset();
      if (nextDisplayTranscript) transcriptController.appendFinal(nextDisplayTranscript);
      transcriptController.setInterim('');
    } else {
      displayTranscript = nextDisplayTranscript;
      renderTranscriptFallback('');
    }

    if (isTranscriptOverflowing()) {
      resetTranscriptDisplay(chunk);
    } else {
      displayTranscript = nextDisplayTranscript;
    }

    console.log('[BuildTalker] Final transcript:', finalizedTranscript);
    checkCurrentStepAnswer(finalizedTranscript);
  };

  transcriber.onError = (e) => {
    const errCode = e?.error || e?.name || e?.message;
    console.warn('[BuildTalker] Speech recognition error:', errCode, e);

    if (shouldBuildTalkerListen()) {
      try { transcriber.start(); } catch (_) {}
    }
  };

  transcriber.onEnd = () => {
    if (shouldBuildTalkerListen()) {
      try { transcriber.start(); } catch (_) {}
    }
  };

  transcriber.start();
}

function stopBuildTalkerRecognition() {
  if (transcriber) {
    try { transcriber.abort(); } catch (_) {}
    transcriber = null;
  }

  if (transcriptController) {
    transcriptController.setInterim('');
    transcriptController.reset();
    if (displayTranscript) transcriptController.appendFinal(displayTranscript);
  }

  displayTranscript = displayTranscript.trim();

  const glowBtn = document.getElementById(volumeGlowTargetId) || document.getElementById('micButton');
  if (glowBtn) glowBtn.style.boxShadow = 'none';
}

function shouldBuildTalkerListen() {
  return lessonStarted &&
    isSessionActive &&
    !isAdvancingStep &&
    !awaitingSentenceReview &&
    !lessonCompleteAwaitingReview &&
    !showingRoundReview;
}

function pauseBuildTalkerListening() {
  micIsMuted = true;
  isRecording = false;
  stopBuildTalkerRecognition();
  // Don't overwrite the temporary ✓ icon while we're between steps.
  if (!isAdvancingStep) {
    updateFooterIcons();
  }
}

function resumeBuildTalkerListeningIfNeeded() {
  if (!shouldBuildTalkerListen()) return;

  startMicSession().then(() => {
    if (!shouldBuildTalkerListen()) return;

    micIsMuted = false;
    isRecording = true;
    startBuildTalkerRecognition();
    updateFooterIcons();
  });
}

async function beginBuildTalkerSession() {
  isSessionActive = true;
  isRecording = true;
  micIsMuted = false;

  updateFooterIcons();

  await startMicSession();
  if (!isSessionActive) return;

  startBuildTalkerRecognition();
  updateFooterIcons();
}

function endBuildTalkerSession() {
  isSessionActive = false;
  isRecording = false;
  micIsMuted = true;

  stopBuildTalkerRecognition();
  stopMicSession();
  updateFooterIcons();
}

function updateFooterIcons() {
  const sessionBtn = document.getElementById(SESSION_BUTTON_ID);
  const sessionImg = sessionBtn?.querySelector('img');

  if (!sessionImg) return;
  if (suppressFooterIconUpdates) return;

  sessionImg.classList.remove('play-icon-pulse');

  if (showingRoundReview) {
    sessionImg.src = 'assets/svg/1F504.svg'; // 🔁 restart
  } else if (awaitingSentenceReview || lessonCompleteAwaitingReview) {
    sessionImg.src = 'assets/svg/25B6.svg'; // ▶ continue/review
  } else if (isSessionActive && isRecording) {
    sessionImg.src = 'assets/svg/23FA.svg'; // ⏺ recording active
  } else if (isSessionActive && !isRecording) {
    sessionImg.src = 'assets/svg/1F3A4.svg'; // 🎤 recording paused/ready
  } else {
    sessionImg.src = 'assets/svg/25B6.svg'; // ▶ play
    sessionImg.classList.add('play-icon-pulse');
  }
}

// --- BuildTalker lesson step helpers (moved out of loadLesson) ---

function startLesson() {

  lessonStarted = true;

  currentSentenceIndex = 0;

  initializeCurrentSentence();

  renderCurrentStep();

  const modeSelector = document.getElementById('modeSelector');

  if (modeSelector) {
    modeSelector.style.display = 'none';
  }

  beginBuildTalkerSession();
}

function extractChunks(sentence) {
  return [...sentence.matchAll(/\((.*?)\)/g)].map(m => m[1].trim());
}

function getBaseSentence(sentence) {
  return sentence
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getGoalSentence(sentence) {
  return sentence
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanupGeneratedSentence(text) {
  const cleaned = String(text || '')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.replace(/^([a-zà-ÿ])/, char => char.toUpperCase());
}

function makeChunkKey(indexes) {
  return [...new Set(indexes)]
    .map(Number)
    .filter(n => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b)
    .join(',');
}

function generateSentenceFromChunkIndexes(sentence, indexes) {
  const active = new Set(indexes.map(Number));
  let chunkIndex = -1;

  const generated = String(sentence || '').replace(/\((.*?)\)/g, (_, chunk) => {
    chunkIndex += 1;
    return active.has(chunkIndex) ? chunk : '';
  });

  return cleanupGeneratedSentence(generated);
}

function getAllChunkIndexSubsets(count) {
  const total = Math.pow(2, count);
  const subsets = [];

  for (let mask = 0; mask < total; mask += 1) {
    const subset = [];

    for (let i = 0; i < count; i += 1) {
      if (mask & (1 << i)) subset.push(i);
    }

    subsets.push(subset);
  }

  return subsets;
}

// Returns all non-empty subsets of the given chunk indexes array
function getNonEmptyChunkIndexSubsets(indexes) {
  const source = Array.isArray(indexes) ? indexes : [];
  const total = Math.pow(2, source.length);
  const subsets = [];

  for (let mask = 1; mask < total; mask += 1) {
    const subset = [];

    for (let i = 0; i < source.length; i += 1) {
      if (mask & (1 << i)) subset.push(source[i]);
    }

    subsets.push(subset);
  }

  return subsets;
}

function buildSentenceStateMap(sentence) {
  const chunks = extractChunks(sentence);
  const map = new Map();

  getAllChunkIndexSubsets(chunks.length).forEach(indexes => {
    map.set(makeChunkKey(indexes), generateSentenceFromChunkIndexes(sentence, indexes));
  });

  return map;
}

function initializeCurrentSentence() {
  const sentence = sentenceItems[currentSentenceIndex];
  if (!sentence) return;

  currentSentenceStateMap = buildSentenceStateMap(sentence);

  addedChunkIndexes = [];
  currentSentenceHistory = [];
  awaitingSentenceReview = false;

  if (isFreeBuildMode()) {
    currentTargetChunkIndex = null;
  } else {
    pickNextTargetChunk();
  }

  currentSentenceHistory.push({
    text: getCurrentDisplaySentence(),
    addedChunk: ''
  });
}

function pickNextTargetChunk() {
  const sentence = sentenceItems[currentSentenceIndex];
  if (!sentence) return;

  const chunks = extractChunks(sentence);

  const remaining = chunks
    .map((_, i) => i)
    .filter(i => !addedChunkIndexes.includes(i));

  if (!remaining.length) {
    currentTargetChunkIndex = null;
    return;
  }

  currentTargetChunkIndex =
    remaining[Math.floor(Math.random() * remaining.length)];
}

function getSelectedBuildMode() {
  return document.querySelector('#modeSelector input[name="mode"]:checked')?.value || 'step';
}

function isFreeBuildMode() {
  return getSelectedBuildMode() === 'free';
}

function getCurrentDisplaySentence() {
  return currentSentenceStateMap.get(makeChunkKey(addedChunkIndexes)) || '';
}


function getCurrentExpectedSentence() {
  if (currentTargetChunkIndex === null || currentTargetChunkIndex === undefined) return '';

  return currentSentenceStateMap.get(
    makeChunkKey([...addedChunkIndexes, currentTargetChunkIndex])
  ) || '';
}

// Attempts to find a Free Mode match in the transcript text
function findFreeModeMatch(transcriptText) {
  const sentence = sentenceItems[currentSentenceIndex];
  if (!sentence) return null;

  const chunks = extractChunks(sentence);

  const remaining = chunks
    .map((_, i) => i)
    .filter(i => !addedChunkIndexes.includes(i));

  const transcriptNorm = normalizeText(transcriptText);
  if (!transcriptNorm) return null;

  const candidates = getNonEmptyChunkIndexSubsets(remaining)
    .map(newIndexes => {
      const allIndexes = [...addedChunkIndexes, ...newIndexes];
      const text = currentSentenceStateMap.get(makeChunkKey(allIndexes)) || '';

      return {
        text,
        newIndexes,
        allIndexes
      };
    })
    .filter(candidate => candidate.text)
    .sort((a, b) => b.newIndexes.length - a.newIndexes.length);

  return candidates.find(candidate => {
    const expectedNorm = normalizeText(candidate.text);
    return expectedNorm && transcriptNorm.includes(expectedNorm);
  }) || null;
}

function clearPendingFreeModeMatch() {
  if (freeModeSilenceTimer) {
    clearTimeout(freeModeSilenceTimer);
    freeModeSilenceTimer = null;
  }

  pendingFreeModeMatch = null;
}

function queueFreeModeMatch(match) {
  if (!match) return;

  const currentSize = pendingFreeModeMatch?.newIndexes?.length || 0;
  const nextSize = match?.newIndexes?.length || 0;

  if (!pendingFreeModeMatch || nextSize >= currentSize) {
    pendingFreeModeMatch = match;
  }

  if (freeModeSilenceTimer) clearTimeout(freeModeSilenceTimer);

  freeModeSilenceTimer = setTimeout(() => {
    const queuedMatch = pendingFreeModeMatch;
    clearPendingFreeModeMatch();

    if (queuedMatch) {
      handleCorrectFreeModeMatch(queuedMatch);
    }
  }, 900);
}

function updateMainBubble(text) {
  const bubble = document.querySelector('.buildtalker-lesson-prompt .bubble');

  if (!bubble) return;

  bubble.textContent = text;
  makeSentenceTtsClickable(bubble, text);
  patchFrenchPunctuationSpaces(bubble);
}


function updateMainBubbleWithHighlightedChunk(sentence, chunkIndex) {
  const bubble = document.querySelector('.buildtalker-lesson-prompt .bubble');
  if (!bubble) return;

  const active = [...new Set([...addedChunkIndexes, chunkIndex].map(Number))]
    .filter(n => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);

  const expandedSentence = currentSentenceStateMap.get(makeChunkKey(active)) || getCurrentExpectedSentence();

  bubble.innerHTML = '';

  if (!active.length || !expandedSentence) {
    bubble.textContent = expandedSentence;
    makeSentenceTtsClickable(bubble, expandedSentence);
    patchFrenchPunctuationSpaces(bubble);
    return;
  }

  const chunks = extractChunks(sentence);
  let remainingText = expandedSentence;

  active.forEach(index => {
    const chunk = chunks[index] || '';
    if (!chunk) return;

    const start = remainingText.indexOf(chunk);
    if (start < 0) return;

    const before = remainingText.slice(0, start);
    if (before) bubble.appendChild(document.createTextNode(before));

    const span = document.createElement('span');
    span.className = index === Number(chunkIndex)
      ? 'highlight phrase-underline buildtalker-added-chunk buildtalker-current-added-chunk'
      : 'highlight buildtalker-added-chunk';
    span.textContent = chunk;

    bubble.appendChild(span);

    remainingText = remainingText.slice(start + chunk.length);
  });

  if (remainingText) bubble.appendChild(document.createTextNode(remainingText));

  makeSentenceTtsClickable(bubble, expandedSentence);
  patchFrenchPunctuationSpaces(bubble);
}

function updateMainBubbleWithHighlightedChunks(sentence, activeIndexes, newestIndexes) {
  const bubble = document.querySelector('.buildtalker-lesson-prompt .bubble');
  if (!bubble) return;

  const active = [...new Set((activeIndexes || []).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);

  const newest = new Set(
    [...new Set((newestIndexes || []).map(Number))]
      .filter(n => Number.isInteger(n) && n >= 0)
  );

  const expandedSentence = currentSentenceStateMap.get(makeChunkKey(active)) || '';

  bubble.innerHTML = '';

  if (!active.length || !expandedSentence) {
    bubble.textContent = expandedSentence;
    makeSentenceTtsClickable(bubble, expandedSentence);
    patchFrenchPunctuationSpaces(bubble);
    return;
  }

  const chunks = extractChunks(sentence);
  let remainingText = expandedSentence;

  active.forEach(index => {
    const chunk = chunks[index] || '';
    if (!chunk) return;

    const start = remainingText.indexOf(chunk);
    if (start < 0) return;

    const before = remainingText.slice(0, start);
    if (before) bubble.appendChild(document.createTextNode(before));

    const span = document.createElement('span');
    span.className = newest.has(index)
      ? 'highlight phrase-underline buildtalker-added-chunk buildtalker-current-added-chunk'
      : 'highlight buildtalker-added-chunk';
    span.textContent = chunk;
    bubble.appendChild(span);

    remainingText = remainingText.slice(start + chunk.length);
  });

  if (remainingText) bubble.appendChild(document.createTextNode(remainingText));

  makeSentenceTtsClickable(bubble, expandedSentence);
  patchFrenchPunctuationSpaces(bubble);
}

function updateMainBubbleWithActiveHighlights(sentence, activeIndexes) {
  const bubble = document.querySelector('.buildtalker-lesson-prompt .bubble');
  if (!bubble) return;

  const active = [...new Set(activeIndexes.map(Number))]
    .filter(n => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);

  const displaySentence = currentSentenceStateMap.get(makeChunkKey(active)) || '';

  bubble.innerHTML = '';

  if (!active.length || !displaySentence) {
    bubble.textContent = displaySentence;
    makeSentenceTtsClickable(bubble, displaySentence);
    patchFrenchPunctuationSpaces(bubble);
    return;
  }

  const chunks = extractChunks(sentence);
  let remainingText = displaySentence;

  active.forEach(index => {
    const chunk = chunks[index] || '';
    if (!chunk) return;

    const start = remainingText.indexOf(chunk);

    if (start < 0) return;

    const before = remainingText.slice(0, start);
    if (before) bubble.appendChild(document.createTextNode(before));

    const span = document.createElement('span');
    span.className = 'highlight buildtalker-added-chunk';
    span.textContent = chunk;
    bubble.appendChild(span);

    remainingText = remainingText.slice(start + chunk.length);
  });

  if (remainingText) bubble.appendChild(document.createTextNode(remainingText));

  makeSentenceTtsClickable(bubble, displaySentence);
  patchFrenchPunctuationSpaces(bubble);
}

function renderStepButton() {

  const container = document.getElementById('wordListContainer');

  if (!container) return;

  const bubbleMessage = document.querySelector('.buildtalker-lesson-prompt');

  if (bubbleMessage) {
    bubbleMessage.insertAdjacentElement('afterend', container);
  }

  container.innerHTML = '';

  const sentence = sentenceItems[currentSentenceIndex];

  if (!sentence) return;

  const chunks = extractChunks(sentence);

  const chunk = chunks[currentTargetChunkIndex];

  if (!chunk) return;

  const btn = document.createElement('button');

  btn.className = 'wordBubble';
  btn.textContent = chunk;

  btn.addEventListener('click', () => {
    speakText(chunk, selectedLang);
  });

  container.appendChild(btn);
}

function renderFreeButtons() {
  const container = document.getElementById('wordListContainer');
  if (!container) return;

  const bubbleMessage = document.querySelector('.buildtalker-lesson-prompt');
  if (bubbleMessage) {
    bubbleMessage.insertAdjacentElement('afterend', container);
  }

  container.innerHTML = '';

  const sentence = sentenceItems[currentSentenceIndex];
  if (!sentence) return;

  const chunks = extractChunks(sentence);

  chunks.forEach((chunk, index) => {
    if (addedChunkIndexes.includes(index)) return;

    const btn = document.createElement('button');
    btn.className = 'wordBubble';
    btn.textContent = chunk;

    btn.addEventListener('click', () => {
      speakText(chunk, selectedLang);
    });

    container.appendChild(btn);
  });
}

function renderCurrentStep() {

  const sentence = sentenceItems[currentSentenceIndex];

  if (!sentence) return;

  updateMainBubbleWithActiveHighlights(sentence, addedChunkIndexes);

  if (isFreeBuildMode()) {
    renderFreeButtons();
  } else {
    renderStepButton();
  }
}

function renderSentenceReview() {
  const bubble = document.querySelector('.buildtalker-lesson-prompt .bubble');
  if (!bubble) return;

  bubble.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'buildtalker-review-list';

  const cumulativeChunks = [];

  currentSentenceHistory.forEach((text, index) => {
    if (index > 0) {
      const arrow = document.createElement('div');
      arrow.className = 'buildtalker-review-arrow';
      arrow.textContent = '↓';
      list.appendChild(arrow);
    }

    const entry = typeof text === 'string'
      ? { text, addedChunk: '' }
      : text;

    const row = document.createElement('div');
    row.className = 'buildtalker-review-row';

    const rowText = entry?.text || '';
    const addedChunks = Array.isArray(entry?.addedChunks) && entry.addedChunks.length
      ? entry.addedChunks
      : (entry?.addedChunk ? [entry.addedChunk] : []);

    addedChunks.forEach(chunk => {
      if (chunk) cumulativeChunks.push(chunk);
    });

    if (!cumulativeChunks.length) {
      row.textContent = rowText;
    } else {
      let remainingText = rowText;

      const chunksForRow = [...cumulativeChunks]
        .filter(chunk => rowText.includes(chunk))
        .sort((a, b) => rowText.indexOf(a) - rowText.indexOf(b));

      chunksForRow.forEach(chunk => {
        const start = remainingText.indexOf(chunk);
        if (start < 0) return;

        const before = remainingText.slice(0, start);
        if (before) {
          row.appendChild(document.createTextNode(before));
        }

        const span = document.createElement('span');
        span.className = addedChunks.includes(chunk)
          ? 'highlight phrase-underline'
          : 'highlight';
        span.textContent = chunk;
        row.appendChild(span);

        remainingText = remainingText.slice(start + chunk.length);
      });

      if (remainingText) {
        row.appendChild(document.createTextNode(remainingText));
      }
    }

    makeSentenceTtsClickable(row, rowText);
    list.appendChild(row);
  });

  bubble.appendChild(list);
  patchFrenchPunctuationSpaces(bubble);
}

function renderRoundReview() {
  const container = document.getElementById('cue-content');
  if (!container) return;

  showingRoundReview = true;
  lessonCompleteAwaitingReview = false;

  // Keep/reuse the main BuildTalker message bubble as the lesson-complete bubble.
  const bubble = document.querySelector('.buildtalker-lesson-prompt .bubble');
  if (bubble) {
    bubble.innerHTML = '';
    bubble.textContent = 'Lesson Complete';
    patchFrenchPunctuationSpaces(bubble);
  }

  const wordListContainer = document.getElementById('wordListContainer');
  if (!wordListContainer) return;

  const promptMessage = document.querySelector('.buildtalker-lesson-prompt');
  if (promptMessage) {
    promptMessage.insertAdjacentElement('afterend', wordListContainer);
  }

  wordListContainer.innerHTML = '';

  roundSentenceHistories.forEach((history, index) => {
    if (!Array.isArray(history) || !history.length) return;

    const lastEntry = history[history.length - 1];
    const finalText = typeof lastEntry === 'string'
      ? lastEntry
      : (lastEntry?.text || `Sentence ${index + 1}`);

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'wordBubble buildtalker-round-review-item';
    bubbleEl.dataset.index = String(index);

    const header = document.createElement('div');
    header.className = 'wordBubbleHeader';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'wordBubbleToggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Show sentence history');
    toggle.textContent = '▸';

    const sentenceSpan = document.createElement('span');
    sentenceSpan.className = 'wordBubbleText tts-clickable';
    sentenceSpan.textContent = finalText;
    sentenceSpan.style.cursor = 'pointer';
    sentenceSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      speakText(finalText, selectedLang || lessonLang || localStorage.getItem('ctlanguage') || 'en-US');
    });

    header.appendChild(toggle);
    header.appendChild(sentenceSpan);

    const phrasesWrap = document.createElement('div');
    phrasesWrap.className = 'wordBubblePhrases';
    phrasesWrap.style.display = 'none';

    const reviewList = document.createElement('div');
    reviewList.className = 'buildtalker-review-list phraseList';

    const cumulativeChunks = [];

    history.forEach((entry, hIdx) => {
      if (hIdx > 0) {
        const arrow = document.createElement('div');
        arrow.className = 'buildtalker-review-arrow';
        arrow.textContent = '↓';
        reviewList.appendChild(arrow);
      }

      const entryObj = typeof entry === 'string'
        ? { text: entry, addedChunk: '' }
        : entry;

      const row = document.createElement('div');
      row.className = 'buildtalker-review-row';

      const rowText = entryObj?.text || '';
      const addedChunks = Array.isArray(entryObj?.addedChunks) && entryObj.addedChunks.length
        ? entryObj.addedChunks
        : (entryObj?.addedChunk ? [entryObj.addedChunk] : []);

      addedChunks.forEach(chunk => {
        if (chunk) cumulativeChunks.push(chunk);
      });

      if (!cumulativeChunks.length) {
        row.textContent = rowText;
      } else {
        let remainingText = rowText;

        const chunksForRow = [...cumulativeChunks]
          .filter(chunk => rowText.includes(chunk))
          .sort((a, b) => rowText.indexOf(a) - rowText.indexOf(b));

        chunksForRow.forEach(chunk => {
          const start = remainingText.indexOf(chunk);
          if (start < 0) return;

          const before = remainingText.slice(0, start);
          if (before) row.appendChild(document.createTextNode(before));

          const span = document.createElement('span');
          span.className = addedChunks.includes(chunk)
            ? 'highlight phrase-underline'
            : 'highlight';
          span.textContent = chunk;
          row.appendChild(span);

          remainingText = remainingText.slice(start + chunk.length);
        });

        if (remainingText) {
          row.appendChild(document.createTextNode(remainingText));
        }
      }

      makeSentenceTtsClickable(row, rowText);
      reviewList.appendChild(row);
    });

    phrasesWrap.appendChild(reviewList);

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = bubbleEl.classList.toggle('expanded');
      phrasesWrap.style.display = expanded ? '' : 'none';
      toggle.textContent = '▸';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', expanded ? 'Hide sentence history' : 'Show sentence history');
    });

    bubbleEl.appendChild(header);
    bubbleEl.appendChild(phrasesWrap);

    patchFrenchPunctuationSpaces(bubbleEl);
    wordListContainer.appendChild(bubbleEl);
  });
}

function saveCurrentSentenceHistory() {
  if (!currentSentenceHistory.length) return;

  roundSentenceHistories.push(
    currentSentenceHistory.map(entry => {
      if (typeof entry === 'string') {
        return { text: entry, addedChunk: '' };
      }

      return {
        text: entry?.text || '',
        addedChunk: entry?.addedChunk || '',
        addedChunks: Array.isArray(entry?.addedChunks) ? entry.addedChunks : []
      };
    })
  );
}

function renderNextSentenceButton() {
  const container = document.getElementById('wordListContainer');
  if (!container) return;

  const bubbleMessage = document.querySelector('.buildtalker-lesson-prompt');
  if (bubbleMessage) {
    bubbleMessage.insertAdjacentElement('afterend', container);
  }

  container.innerHTML = '';

  const btn = document.createElement('button');
  btn.className = 'wordBubble';
  btn.textContent = sentenceItems[currentSentenceIndex + 1] ? 'Next sentence' : 'Finish lesson';

  btn.addEventListener('click', () => {
    proceedAfterSentenceReview();
  });

  container.appendChild(btn);
}

function proceedAfterSentenceReview() {
  awaitingSentenceReview = false;
  currentSentenceIndex += 1;

  if (!sentenceItems[currentSentenceIndex]) {
    if (typeof window.buildTalkerFinishAction === 'function') {
      window.buildTalkerFinishAction();
    }
    return;
  }

  initializeCurrentSentence();
  clearTranscriptUI();
  renderCurrentStep();
  updateFooterIcons();
  resumeBuildTalkerListeningIfNeeded();
}

function showLessonCompleteAwaitingReview() {
  lessonCompleteAwaitingReview = true;
  awaitingSentenceReview = false;
  isAdvancingStep = false;

  // The speaking round is finished, so shut down STT/mic just like pressing Stop.
  isSessionActive = false;
  isRecording = false;
  micIsMuted = true;
  stopBuildTalkerRecognition();
  stopMicSession();

  clearTranscriptUI();
  updateMainBubble('Lesson complete');

  const container = document.getElementById('wordListContainer');
  if (container) container.innerHTML = '';

  updateFooterIcons();
}

function flashSessionButtonCheckmark() {
  const btn = document.getElementById(SESSION_BUTTON_ID);
  if (!btn) return;

  const img = btn.querySelector('img');
  if (!img) return;

  img.classList.remove('play-icon-pulse');
  img.src = 'assets/svg/2714.svg';
}

function advanceToNextStep() {
  const sentence = sentenceItems[currentSentenceIndex];
  if (!sentence) return;

  const chunks = extractChunks(sentence);

  if (!isFreeBuildMode() && currentTargetChunkIndex !== null && currentTargetChunkIndex !== undefined) {
    addedChunkIndexes.push(currentTargetChunkIndex);
  }

  if (addedChunkIndexes.length >= chunks.length) {
    saveCurrentSentenceHistory();

    isAdvancingStep = false;
    clearTranscriptUI();

    if (chunks.length >= 2) {
      awaitingSentenceReview = true;
      renderSentenceReview();

      if (!sentenceItems[currentSentenceIndex + 1]) {
        // Last sentence: keep the sentence review visible, but replace the
        // inline "Finish lesson" button with the footer ⏭ button.
        lessonCompleteAwaitingReview = true;
        isSessionActive = false;
        isRecording = false;
        micIsMuted = true;
        stopBuildTalkerRecognition();
        stopMicSession();

        const container = document.getElementById('wordListContainer');
        if (container) container.innerHTML = '';

        window.buildTalkerFinishAction = () => {
          renderRoundReview();
          window.buildTalkerFinishAction = null;
        };

        // The ✓ is finished; allow the footer to become the ⏭ button.
        suppressFooterIconUpdates = false;
        updateFooterIcons();
        return;
      }

      const container = document.getElementById('wordListContainer');
      if (container) container.innerHTML = '';

      suppressFooterIconUpdates = false;
      updateFooterIcons();
      return;
    }

    awaitingSentenceReview = false;
    currentSentenceIndex += 1;

    if (!sentenceItems[currentSentenceIndex]) {
      lessonCompleteAwaitingReview = true;
      isSessionActive = false;
      isRecording = false;
      micIsMuted = true;
      stopBuildTalkerRecognition();
      stopMicSession();

      window.buildTalkerFinishAction = () => {
        renderRoundReview();
        window.buildTalkerFinishAction = null;
      };

      updateFooterIcons();
      return;
    }

    initializeCurrentSentence();
    renderCurrentStep();
    return;
  }

  if (isFreeBuildMode()) {
    currentTargetChunkIndex = null;
  } else {
    pickNextTargetChunk();
  }

  isAdvancingStep = false;
  suppressFooterIconUpdates = false;
  clearTranscriptUI();
  renderCurrentStep();
  resumeBuildTalkerListeningIfNeeded();
}

function handleCorrectCurrentStep() {
  if (isAdvancingStep) return;

  const sentence = sentenceItems[currentSentenceIndex];
  if (!sentence) return;

  isAdvancingStep = true;
  suppressFooterIconUpdates = true;
  pauseBuildTalkerListening();

  const expectedSentence = getCurrentExpectedSentence();
  if (expectedSentence) {
    const chunks = extractChunks(sentence);
    currentSentenceHistory.push({
      text: expectedSentence,
      addedChunk: chunks[currentTargetChunkIndex] || ''
    });
  }

  updateMainBubbleWithHighlightedChunk(sentence, currentTargetChunkIndex);
  flashSessionButtonCheckmark(2200);

  const container = document.getElementById('wordListContainer');
  if (container) container.innerHTML = '';

  if (stepAdvanceTimer) clearTimeout(stepAdvanceTimer);
  stepAdvanceTimer = setTimeout(() => {
    stepAdvanceTimer = null;
    advanceToNextStep();
  }, 2400);
}

function handleCorrectFreeModeMatch(match) {
  if (isAdvancingStep || !match) return;

  const sentence = sentenceItems[currentSentenceIndex];
  if (!sentence) return;

  const chunks = extractChunks(sentence);
  const newIndexes = Array.isArray(match.newIndexes) ? match.newIndexes : [];
  const allIndexes = Array.isArray(match.allIndexes) ? match.allIndexes : [...addedChunkIndexes, ...newIndexes];

  if (!newIndexes.length) return;

  isAdvancingStep = true;
  suppressFooterIconUpdates = true;
  pauseBuildTalkerListening();

  currentSentenceHistory.push({
    text: match.text || currentSentenceStateMap.get(makeChunkKey(allIndexes)) || '',
    addedChunk: chunks[newIndexes[0]] || '',
    addedChunks: newIndexes.map(index => chunks[index] || '').filter(Boolean)
  });

  addedChunkIndexes = [...new Set(allIndexes.map(Number))]
    .filter(n => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);

  currentTargetChunkIndex = null;

  updateMainBubbleWithHighlightedChunks(sentence, addedChunkIndexes, newIndexes);
  flashSessionButtonCheckmark();

  const container = document.getElementById('wordListContainer');
  if (container) container.innerHTML = '';

  if (stepAdvanceTimer) clearTimeout(stepAdvanceTimer);
  stepAdvanceTimer = setTimeout(() => {
    stepAdvanceTimer = null;
    advanceToNextStep();
  }, 2400);
}

function checkCurrentStepAnswer(transcriptText) {
  if (!lessonStarted || isAdvancingStep || awaitingSentenceReview) return;

  if (isFreeBuildMode()) {
    const match = findFreeModeMatch(transcriptText);
    if (match) {
      queueFreeModeMatch(match);
    }
    return;
  }

  const expected = getCurrentExpectedSentence();
  if (!expected) return;

  const transcriptNorm = normalizeText(transcriptText);
  const expectedNorm = normalizeText(expected);

  if (!transcriptNorm || !expectedNorm) return;

  if (transcriptNorm.includes(expectedNorm)) {
    handleCorrectCurrentStep();
  }
}

async function loadLesson() {
  const urlParams = new URLSearchParams(window.location.search);
  const lessonId = urlParams.get('lesson');

  if (!lessonId) {
    alert('No lesson specified in URL.');
    return;
  }

  try {
    const res = await fetch(`data/buildtalkerdata/${lessonId}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${lessonId}.json`);

    const data = await res.json();
    buildLesson = data;

    const storedLang = getLangKey(selectedLang || localStorage.getItem('ctlanguage'));
    buildLangData = (data.languages && (data.languages[storedLang] || data.languages['en-US'])) || null;

    if (!buildLangData) {
      throw new Error(`No languages block found for ${storedLang} (and no 'en-US' fallback).`);
    }

    // svgLibrary = data.svgLibrary || {};  // Removed as per instructions
    lessonPromptData = buildLangData.lessonPrompt || { text: '' };
    sentenceItems = Array.isArray(buildLangData.sentences) ? buildLangData.sentences : [];
    currentSentenceIndex = 0;
    addedChunkIndexes = [];
    currentTargetChunkIndex = null;
    currentSentenceStateMap = new Map();
    currentSentenceHistory = [];
    roundSentenceHistories = [];
    awaitingSentenceReview = false;
    lessonCompleteAwaitingReview = false;
    showingRoundReview = false;
    currentChunkIndex = 0;
    lessonStarted = false;

    isAdvancingStep = false;

    if (stepAdvanceTimer) {
      clearTimeout(stepAdvanceTimer);
      stepAdvanceTimer = null;
    }


    lessonLang = buildLangData.language || storedLang;
    lessonLangName = buildLangData.languageName || storedLang;

    selectedLang = lessonLang;
    localStorage.setItem('ctlanguage', selectedLang);

    renderLessonPrompt();

    initializeVoiceMenu();
    updateFooterIcons();

   // console.log('[BuildTalker] Lesson loaded:', lessonId, { lang: storedLang, sentences: sentenceItems.length });
  } catch (error) {
    console.error('[BuildTalker] Failed to load lesson:', error);
    alert(`Could not load BuildTalker lesson: ${lessonId}`);
  }
}

function bindFooterControls() {
  const sessionBtn = document.getElementById(SESSION_BUTTON_ID);
  if (sessionBtn && sessionBtn.dataset.bound !== '1') {
    sessionBtn.addEventListener('click', () => {

      if (!lessonStarted) {
        startLesson();
        return;
      }

      if (showingRoundReview) {
        window.location.reload();
        return;
      }

      if (lessonCompleteAwaitingReview) {
        lessonCompleteAwaitingReview = false;

        if (typeof window.buildTalkerFinishAction === 'function') {
          window.buildTalkerFinishAction();
        }

        updateFooterIcons();
        return;
      }

      if (awaitingSentenceReview) {
        proceedAfterSentenceReview();
        return;
      }

      if (!isSessionActive) {
        beginBuildTalkerSession();
        return;
      }

      if (isRecording) {
        pauseBuildTalkerListening();
        updateFooterIcons();
        return;
      }

      resumeBuildTalkerListeningIfNeeded();

    });
    sessionBtn.dataset.bound = '1';
  }

  const settingsButton = document.getElementById('settingsButton');
  if (settingsButton && settingsButton.dataset.bound !== '1') {
    settingsButton.addEventListener('click', () => {
      settingsButton.blur();
      document.getElementById('settingsMenu')?.classList.toggle('show');
    });
    settingsButton.dataset.bound = '1';
  }
}

function initializeBuildTalkerPage() {
  applyUrlLanguageOverride();
  initializeSettingsMenu();
  initTranscriptController();
  clearTranscriptUI();
  initializeVoiceMenu();
  updateFooterIcons();
  bindFooterControls();

  Promise.all([
    loadTalkerTranslations(),
    loadLesson()
  ]).then(() => {
    document.body.classList.remove('preload');

    const cueContent = document.getElementById('cue-content');
    if (cueContent) cueContent.scrollTop = 0;
    window.scrollTo(0, 0);
  });

  speechSynthesis.onvoiceschanged = populateCustomVoiceList;
}

document.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(initializeBuildTalkerPage);
});

window.addEventListener('beforeunload', () => {
  micIsMuted = true;
  stopBuildTalkerRecognition();
  stopMicSession();
  stopVolumeMonitoring();
  if (stepAdvanceTimer) clearTimeout(stepAdvanceTimer);

  if (audioContext) {
    try { audioContext.close(); } catch (_) {}
    audioContext = null;
  }
});