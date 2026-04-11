let selectedLang = localStorage.getItem('ctlanguage') || '';
let selectedVoiceName = localStorage.getItem('ctvoice') || '';
let availableVoices = [];
let voicesInitialized = false;
let svgLibrary = {};

// ---- Mode state (FreeTalk) ----
let practiceMode = false;
let currentMode = 'test';          // 'test' | 'practice'
let modeLocked = false;            // lock mode selection after session begins
let showingFinalScore = false;     // true after a Test Mode session ends and score is shown
const TEST_DURATION_SEC = 60;
let testTimerId = null;
let testTimeLeft = TEST_DURATION_SEC;
let volumeGlowTargetId = 'micButton';

// ---- FreeTalk mic/tts state ----
let isSessionActive = false; // FreeTalk session (mic) state
let isTtsSpeaking = false;   // Track TTS speaking for UI icon
let micStream = null;
let isRecording = false;

const SESSION_BUTTON_ID = 'micButton';     // existing footer button
const RECORD_BUTTON_ID  = 'recordMicButton'; // new button we create
// Default glow target during sessions is the record mic button
volumeGlowTargetId = RECORD_BUTTON_ID;

// ---- Mic visual feedback (ported from classic mode) ----
let audioContext = null;
let analyser = null;
let dataArray = null;
let volumeInterval = null;
let micIsMuted = true; // when true, glow is off

// ---- FreeTalk lesson state ----
let freetalkLesson = null;
let freetalkLangData = null;
let lessonPromptData = null;
let wordListData = [];
let lessonLang = '';
let lessonLangName = '';

// ---- Universal transcript / speech recognition (FreeTalk) ----
let transcriptController = null;
let transcriber = null;
let finalizedTranscript = '';      // full session transcript for matching
let displayTranscript = '';        // visible transcript window only
let matchers = []; // compiled matchers from wordListData
let manuallyResetMatchCounts = new Map(); // practice-mode resets: how many prior matches to ignore per bubble
let latestTranscriptMatchCounts = new Map(); // most recent match counts found in transcript per bubble
let recordedAudioUrl = null;
let recordedAudioFilename = '';
let mediaRecorder = null;
let recordedChunks = [];
let recordingMimeType = '';
let recordingAudioContext = null;
let recordingSourceNode = null;
let recordingGainNode = null;
let recordingDestination = null;

const TELEPROMPTER_OVERFLOW_TOLERANCE_PX = 1;

function getLiveTranscriptEl() {
  return document.getElementById('liveTranscript');
}

function getRecordingDownloadContainer() {
  return document.getElementById('recordingDownloadContainer');
}

function getRecordingDownloadLinkEl() {
  return document.getElementById('recordingDownloadLink');
}

function clearRecordingDownloadLink() {
  const link = getRecordingDownloadLinkEl();
  if (link) {
    link.style.display = 'none';
    link.removeAttribute('href');
    link.removeAttribute('download');
  }

  if (recordedAudioUrl) {
    try { URL.revokeObjectURL(recordedAudioUrl); } catch (_) {}
    recordedAudioUrl = null;
  }

  recordedAudioFilename = '';
}

function getRecordingExtensionForMimeType(mimeType = '') {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('mpeg')) return 'mp3';
  return 'webm';
}

function sanitizeFilename(str) {
  return String(str || '')
    .replace(/[<>:"/\\|?*]+/g, '') // remove illegal filename chars
    .trim();
}

function buildRecordingFilename() {
  const now = new Date();

  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const lessonName = sanitizeFilename(freetalkLangData?.lessonName) || 'freetalk';

  const ext = getRecordingExtensionForMimeType(recordingMimeType);

  return `${lessonName} - ${stamp}.${ext}`;
}

function showRecordingDownloadLink(url, filename) {
  const link = getRecordingDownloadLinkEl();
  if (!link) return;

  link.href = url;
  link.download = filename || 'freetalk-recording.webm';
  link.style.display = '';
}

function setRecordingDownloadLinkFromBlob(blob) {
  if (!blob) return;

  clearRecordingDownloadLink();

  recordedAudioFilename = buildRecordingFilename();
  recordedAudioUrl = URL.createObjectURL(blob);
  showRecordingDownloadLink(recordedAudioUrl, recordedAudioFilename);
}

function getSupportedRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';

  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4'
  ];

  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch (_) {}
  }

  return '';
}

function teardownTestModeRecordingGraph() {
  try { recordingSourceNode?.disconnect(); } catch (_) {}
  try { recordingGainNode?.disconnect(); } catch (_) {}

  recordingSourceNode = null;
  recordingGainNode = null;
  recordingDestination = null;

  if (recordingAudioContext) {
    try { recordingAudioContext.close(); } catch (_) {}
    recordingAudioContext = null;
  }
}

function setupTestModeRecordingGraph() {
  if (!micStream) return null;

  teardownTestModeRecordingGraph();

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    console.warn('[FreeTalk] AudioContext is not available for processed recording.');
    return null;
  }

  try {
    recordingAudioContext = new Ctx();
    recordingSourceNode = recordingAudioContext.createMediaStreamSource(micStream);
    recordingGainNode = recordingAudioContext.createGain();
    recordingDestination = recordingAudioContext.createMediaStreamDestination();

    recordingGainNode.gain.value = micIsMuted ? 0 : 1;

    recordingSourceNode.connect(recordingGainNode);
    recordingGainNode.connect(recordingDestination);

    return recordingDestination.stream;
  } catch (err) {
    console.warn('[FreeTalk] Could not set up test-mode recording graph:', err);
    teardownTestModeRecordingGraph();
    return null;
  }
}

function setTestModeRecordingMuted(muted) {
  if (!recordingGainNode) return;
  try {
    recordingGainNode.gain.value = muted ? 0 : 1;
  } catch (_) {}
}

function startTestModeRecording() {
  if (currentMode !== 'test') return;
  if (!micStream) return;
  if (typeof MediaRecorder === 'undefined') {
    console.warn('[FreeTalk] MediaRecorder is not available in this browser.');
    return;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return;

  const recordingStream = setupTestModeRecordingGraph();
  if (!recordingStream) return;

  recordedChunks = [];
  recordingMimeType = getSupportedRecordingMimeType();

  let recorder;
  try {
    recorder = recordingMimeType
      ? new MediaRecorder(recordingStream, { mimeType: recordingMimeType })
      : new MediaRecorder(recordingStream);
  } catch (err) {
    console.warn('[FreeTalk] Could not start test-mode recording:', err);
    mediaRecorder = null;
    recordedChunks = [];
    recordingMimeType = '';
    teardownTestModeRecordingGraph();
    return;
  }

  mediaRecorder = recorder;
  recordingMimeType = recorder.mimeType || recordingMimeType || '';
  setTestModeRecordingMuted(micIsMuted);

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  recorder.onstop = () => {
    const chunks = recordedChunks.slice();
    const mimeType = recordingMimeType || recorder.mimeType || 'audio/webm';

    mediaRecorder = null;
    recordedChunks = [];
    recordingMimeType = mimeType;
    teardownTestModeRecordingGraph();

    if (!chunks.length) return;

    const blob = new Blob(chunks, { type: mimeType });
    setRecordingDownloadLinkFromBlob(blob);
  };

  recorder.onerror = (event) => {
    console.warn('[FreeTalk] Recording error:', event);
  };

  try {
    recorder.start();
    console.log('[FreeTalk] Test-mode recording started:', recordingMimeType || '(browser default)');
  } catch (err) {
    console.warn('[FreeTalk] Recorder.start() failed:', err);
    mediaRecorder = null;
    recordedChunks = [];
    recordingMimeType = '';
    teardownTestModeRecordingGraph();
  }
}

function stopTestModeRecording() {
  if (!mediaRecorder) {
    teardownTestModeRecordingGraph();
    return;
  }
  if (mediaRecorder.state === 'inactive') {
    teardownTestModeRecordingGraph();
    return;
  }

  try {
    mediaRecorder.stop();
    console.log('[FreeTalk] Test-mode recording stopped.');
  } catch (err) {
    console.warn('[FreeTalk] Recorder.stop() failed:', err);
    teardownTestModeRecordingGraph();
  }
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

// Shared UI translations loaded from data/talker-translations.json
// Keep a single shared instance across pages/scripts
window.talkerTranslations = window.talkerTranslations || {};
let talkerTranslations = window.talkerTranslations;

function initTranscriptController() {
  const el = document.getElementById('liveTranscript');
  if (!el) return;

  if (!window.TranscriptController) {
    console.warn('[FreeTalk] TranscriptController not found. Ensure js/engine/transcript-controller.js is loaded before freetalk.js');
    return;
  }

  transcriptController = new window.TranscriptController({ el });
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    // normalize apostrophes
    .replace(/[’‘´`]/g, "'")
    // normalize accented Latin characters so transcript text like
    // "empaque" can match forms like "empaqué"
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // strip most punctuation (keep apostrophes for contractions)
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}


function normalizeLooseMatchText(s) {
  return normalizeText(s).replace(/\s+/g, '');
}

function shouldUseSpaceInsensitiveMatching() {
  const lang = (selectedLang || lessonLang || localStorage.getItem('ctlanguage') || '').toLowerCase();
  return lang.startsWith('zh') || lang.startsWith('ja') || lang.startsWith('th');
}

function clearTranscriptUI() {
  resetTranscriptDisplay('');
}

function resetWordMatchesUI() {
  manuallyResetMatchCounts.clear();
  latestTranscriptMatchCounts.clear();
  document.querySelectorAll('.wordBubble.matched').forEach(b => b.classList.remove('matched'));
  document.querySelectorAll('.wordBubble .wordBubbleCheck').forEach(el => el.remove());
}

function ensureCheckmark(bubbleEl) {
  if (!bubbleEl) return;
  if (bubbleEl.querySelector('.wordBubbleCheck')) return;

  const header = bubbleEl.querySelector('.wordBubbleHeader');
  if (!header) return;

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'wordBubbleCheck';
  check.textContent = '✓';
  check.setAttribute('aria-label', 'Reset matched word');

  check.addEventListener('click', (e) => {
    e.stopPropagation();

    // Manual reset is only allowed in Practice Mode
    if (!practiceMode) return;

    const key = bubbleEl.dataset.word;
    if (key) {
      const currentCount = latestTranscriptMatchCounts.get(key) || 0;
      manuallyResetMatchCounts.set(key, currentCount);
    }

    bubbleEl.classList.remove('matched');
    check.remove();
  });

  header.appendChild(check);
}

function compileMatchers() {
  matchers = [];

  (wordListData || []).forEach((item) => {
    const base = (item.word || '').trim();
    if (!base) return;

    // IMPORTANT: forms is the only source of truth for transcript matching.
    // The displayed word can later be a hint/prompt, while forms contains the
    // actual acceptable spoken answers (including conjugated forms, etc.).
    const variants = (Array.isArray(item.forms) ? item.forms : [])
      .map(v => normalizeText(v))
      .filter(Boolean);

    const uniq = Array.from(new Set(variants));
    if (!uniq.length) return;

    matchers.push({
      key: base,          // used to find bubble via data-word
      variants: uniq,     // normalized acceptable matches from forms only
      maxVariantLength: Math.max(...uniq.map(v => normalizeLooseMatchText(v).length), 0)
    });
  });
}

function getTranscriptMatchCounts(fullTextRaw) {
  let remaining = normalizeText(fullTextRaw);
  if (!remaining) return new Map();

  const matchCounts = new Map();

  // Longest match first so something like "petit-dejeuner" matches
  // before the smaller "dejeuner" inside it. Each successful match
  // consumes that text once, so one spoken chunk only counts once.
  const sortedMatchers = [...matchers].sort((a, b) => {
    if (b.maxVariantLength !== a.maxVariantLength) {
      return b.maxVariantLength - a.maxVariantLength;
    }
    return a.key.localeCompare(b.key);
  });

  sortedMatchers.forEach(matcher => {
    const sortedVariants = [...matcher.variants].sort(
      (a, b) => normalizeLooseMatchText(b).length - normalizeLooseMatchText(a).length
    );

    let localCount = 0;

    while (true) {
      let foundThisRound = false;

      for (const v of sortedVariants) {
        const variantNorm = normalizeText(v);
        if (!variantNorm) continue;

        let match = null;
        let start = -1;
        let length = 0;

        const spaceInsensitive = shouldUseSpaceInsensitiveMatching();

        if (variantNorm.includes(' ') && !spaceInsensitive) {
          // Multi-word Latin-script answers should match as full phrase chunks,
          // not loose substrings. This prevents bad matches like "I talks"
          // satisfying the form "I talk".
          const escapedWords = variantNorm
            .split(' ')
            .filter(Boolean)
            .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

          const body = escapedWords.join('\\s+');
          const strictRegex = new RegExp(`(^|\\s)(${body})(?=\\s|$)`);
          match = strictRegex.exec(remaining);

          if (match) {
            start = match.index + match[1].length;
            length = match[2].length;
          }
        } else {
          // Space-insensitive languages (Chinese, Japanese, Thai) should still match
          // even when ASR inserts spaces unpredictably. For other languages, keep
          // the existing flexible single-token behavior.
          const source = spaceInsensitive
            ? normalizeLooseMatchText(variantNorm)
            : variantNorm;

          const body = source
            .split('')
            .map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('\\s*');

          const flexibleRegex = new RegExp(body);
          match = flexibleRegex.exec(remaining);

          if (match) {
            start = match.index;
            length = match[0].length;
          }
        }

        if (!match || start < 0 || length <= 0) continue;

        localCount += 1;
        remaining = remaining.slice(0, start) + ' '.repeat(length) + remaining.slice(start + length);
        foundThisRound = true;
        break;
      }

      if (!foundThisRound) break;
    }

    if (localCount > 0) {
      matchCounts.set(matcher.key, localCount);
    }
  });

  return matchCounts;
}

function getMatchedWordCount() {
  return document.querySelectorAll('.wordBubble.matched').length;
}

function getFreeTalkScoreSummary() {
  const total = Array.isArray(wordListData) ? wordListData.length : 0;
  const matched = getMatchedWordCount();
  const percent = total > 0
    ? Math.round((matched / total) * 100)
    : 100;

  return {
    matched,
    total,
    percent,
    scoreString: `${percent}% (${matched}/${total})`
  };
}

function displayFinalScore() {
  const transcriptEl = document.getElementById('liveTranscript');
  if (!transcriptEl) return;
  clearRecordingDownloadLink();

  const { scoreString } = getFreeTalkScoreSummary();

  if (transcriptController) transcriptController.reset();
  transcriptEl.textContent = scoreString;
}

function saveFinalScore() {
  if (practiceMode) return;

  const { scoreString } = getFreeTalkScoreSummary();
  const urlParams = new URLSearchParams(window.location.search);
  const lessonId = urlParams.get('lesson') || 'unknown';

  const today = new Date();
  const dateStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

  const lang = getLangKey(localStorage.getItem('ctlanguage'));
  const mode = 'freetalk';

  const storedScores = JSON.parse(localStorage.getItem('ctscores')) || {};

  if (!storedScores[lang]) {
    storedScores[lang] = [];
  }

  const existingIndex = storedScores[lang].findIndex(entry =>
    entry.lesson === lessonId && entry.mode === mode
  );

  const newEntry = {
    lesson: lessonId,
    mode,
    score: scoreString,
    date: dateStr
  };

  if (existingIndex >= 0) {
    storedScores[lang][existingIndex] = newEntry;
  } else {
    storedScores[lang].push(newEntry);
  }

  localStorage.setItem('ctscores', JSON.stringify(storedScores));
}

function updateMatchesFromTranscript(fullTextRaw) {
  const transcriptMatchCounts = getTranscriptMatchCounts(fullTextRaw);
  latestTranscriptMatchCounts = transcriptMatchCounts;

  matchers.forEach(m => {
    const bubble = document.querySelector(`.wordBubble[data-word="${CSS.escape(m.key)}"]`);
    if (!bubble) return;

    const currentCount = transcriptMatchCounts.get(m.key) || 0;
    const resetCount = practiceMode ? (manuallyResetMatchCounts.get(m.key) || 0) : 0;
    const shouldBeMatched = currentCount > resetCount;

    if (shouldBeMatched) {
      if (!bubble.classList.contains('matched')) {
        bubble.classList.add('matched');
      }
      ensureCheckmark(bubble);
    } else {
      bubble.classList.remove('matched');
      bubble.querySelector('.wordBubbleCheck')?.remove();
    }
  });
}

function ensureRecordMicButton() {
  if (document.getElementById(RECORD_BUTTON_ID)) return;

  const footer = document.getElementById('cue-footer');
  const transcriptEl = document.getElementById('liveTranscript');
  if (!footer || !transcriptEl) return;

  const btn = document.createElement('button');
  btn.id = RECORD_BUTTON_ID;
  btn.className = 'circle-btn';
  btn.style.display = 'none'; // hidden until session starts
  btn.innerHTML = `<img src="assets/svg/1F3A4.svg" alt="Mic">`;

  footer.insertBefore(btn, transcriptEl);

  // mic button click = toggle recording only
  btn.addEventListener('click', async () => {
    if (!isSessionActive) return;

    if (isRecording) {
      stopFreeTalkRecognition();
      isRecording = false;
      micIsMuted = true;
      setTestModeRecordingMuted(true);
      updateFooterIcons();
      return;
    }

    await startMicSession();
    micIsMuted = false;
    setTestModeRecordingMuted(false);
    startFreeTalkRecognition({ resetAll: false, targetBtnId: RECORD_BUTTON_ID });
    isRecording = true;
    updateFooterIcons();
  });
}

function showRecordMicButton(show) {
  const btn = document.getElementById(RECORD_BUTTON_ID);
  if (!btn) return;
  btn.style.display = show ? '' : 'none';
}

async function startMicSession() {
  if (micStream) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startVolumeMonitoring(micStream, 'micButton');
  } catch (err) {
    console.error('[FreeTalk] Mic error:', err);
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

function startVolumeMonitoring(stream, targetId = 'micButton') {
  volumeGlowTargetId = targetId;

  if (!stream) return;

  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  // Clear any previous polling loop so we don't stack intervals
  if (volumeInterval) clearInterval(volumeInterval);

  try {
    const micSource = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    micSource.connect(analyser);

    dataArray = new Uint8Array(analyser.fftSize);

    volumeInterval = setInterval(() => {
      const targetBtn =
        document.getElementById(volumeGlowTargetId) ||
        document.getElementById('micButton');

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
    console.warn('[FreeTalk] Volume monitoring unavailable:', e);
  }
}

function animateMicPulse(volume) {
  const targetBtn =
    document.getElementById(volumeGlowTargetId) ||
    document.getElementById('micButton');

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

function startFreeTalkRecognition(opts = {}) {
  const resetAll = opts.resetAll !== false;  // default true
  const targetBtnId = opts.targetBtnId || RECORD_BUTTON_ID;

  if (!window.WebSpeechTranscriber) {
    alert('Speech recognition engine not loaded.');
    return;
  }

  if (!transcriptController) initTranscriptController();

  // IMPORTANT: pulse glow on the mic button, not the session button
  startVolumeMonitoring(micStream, targetBtnId);

  if (resetAll) {
    clearTranscriptUI();
    resetWordMatchesUI();
    compileMatchers();
  }

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
    updateMatchesFromTranscript(full);
  };

  transcriber.onFinal = (finalChunk) => {
    const chunk = (finalChunk || '').trim();
    if (!chunk) return;

    finalizedTranscript = (finalizedTranscript + ' ' + chunk).trim();
    const nextDisplayTranscript = (displayTranscript + ' ' + chunk).trim();

    // First, try rendering the new chunk onto the existing visible transcript.
    if (transcriptController) {
      transcriptController.reset();
      if (nextDisplayTranscript) {
        transcriptController.appendFinal(nextDisplayTranscript);
      }
      transcriptController.setInterim('');
    } else {
      displayTranscript = nextDisplayTranscript;
      renderTranscriptFallback('');
    }

    // If the newly added chunk pushes us past the available 3-line window,
    // restart the visible transcript with ONLY that newest chunk.
    if (isTranscriptOverflowing()) {
      resetTranscriptDisplay(chunk);
    } else {
      displayTranscript = nextDisplayTranscript;
    }

    updateMatchesFromTranscript(finalizedTranscript);
  };

  transcriber.onError = (e) => {
    const errCode = e?.error || e?.name || e?.message;
    console.warn('[FreeTalk] Speech recognition error:', errCode, e);

    // Keep it always-on while session is active
    if (isSessionActive) {
      try { transcriber.start(); } catch (_) {}
    }
  };

  transcriber.onEnd = () => {
    // Keep it alive while session is active
    if (isSessionActive) {
      try { transcriber.start(); } catch (_) {}
    }
  };

  transcriber.start();
}

function stopFreeTalkRecognition() {
  if (transcriber) {
    try { transcriber.abort(); } catch (_) {}
    transcriber = null;
  }
  if (transcriptController) transcriptController.setInterim('');
  if (transcriptController) {
    transcriptController.reset();
    if (displayTranscript) {
      transcriptController.appendFinal(displayTranscript);
    }
  }
  displayTranscript = displayTranscript.trim();
  const glowBtn =
    document.getElementById(volumeGlowTargetId) ||
    document.getElementById('micButton');
  if (glowBtn) glowBtn.style.boxShadow = 'none';
}

function ensureTimerDisplay() {
  let el = document.getElementById('testTimerDisplay');
  if (el) return el;

  const header = document.querySelector('header');
  if (!header) return null;

  el = document.createElement('div');
  el.id = 'testTimerDisplay';
  el.className = 'test-timer-display';
  el.style.display = 'none';
  el.style.userSelect = 'none';
  el.style.webkitUserSelect = 'none';

  // Insert between the header title and the settings menu
  const title = header.querySelector('#header-title');
  const menu = header.querySelector('.menu');

  if (title && menu) {
    header.insertBefore(el, menu);
  } else {
    header.appendChild(el);
  }

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

      endFreeTalkSession();
    }
  }, 1000);
}

function lockModeSelector(lock) {
  modeLocked = !!lock;

  const modeSelector = document.getElementById('modeSelector');
  if (modeSelector) {
    // Hide the whole selector during a session to keep footer clean
    modeSelector.style.display = modeLocked ? 'none' : '';
  }

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
  showingFinalScore = false;
  micIsMuted = false;

  showRecordMicButton(true);
  updateFooterIcons();
  lockModeSelector(true);

  finalizedTranscript = '';
  clearRecordingDownloadLink();
  clearTranscriptUI();
  resetWordMatchesUI();
  compileMatchers();
  startMicSession().then(() => {
    if (!isSessionActive) return;
    if (currentMode === 'test') startTestModeRecording();
    startFreeTalkRecognition({ resetAll: false, targetBtnId: RECORD_BUTTON_ID });
    isRecording = true;
    updateFooterIcons();
  });

  if (currentMode === 'test') startTestTimer();
  else stopTestTimer();
}

function endFreeTalkSession() {
  // stop recording but session stop is the boss
  if (isRecording) {
    stopFreeTalkRecognition();
    isRecording = false;
  }

  showingFinalScore = true;

  if (currentMode === 'test') {
    displayFinalScore();
    saveFinalScore();
    stopTestModeRecording();
  } else {
    stopTestModeRecording();
    clearRecordingDownloadLink();
    clearTranscriptUI();
  }

  isSessionActive = false;
  micIsMuted = true;
  setTestModeRecordingMuted(true);

  showRecordMicButton(false);

  stopMicSession();

  stopTestTimer();
  testTimeLeft = TEST_DURATION_SEC;
  updateTimerUI();

  updateFooterIcons();
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
  const knownLangs = ['en-US', 'fr-FR', 'es-ES', 'zh-CN', 'zh-TW', 'ja-JP', 'th-TH'];
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
  const t = talkerTranslations[lang] || talkerTranslations['en-US'];

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

  const recordingDownloadLink = getRecordingDownloadLinkEl();
  if (recordingDownloadLink) {
    recordingDownloadLink.textContent = t.downloadRecording || 'Download recording';
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

function buildPhraseListItem(phraseText, word) {
  const li = document.createElement('li');
  li.className = 'phrase-item tts-clickable';

  const phrase = String(phraseText || '');

  // Support both:
  // - {word} => insert the current topic word
  // - {anythingElse} => underline that literal text without the braces
  const fullPhraseForTTS = phrase.replace(/\{([^}]+)\}/g, (_, token) => {
    return token === 'word' ? word : token;
  });

  li.dataset.tts = fullPhraseForTTS;
  li.style.cursor = 'pointer';

  li.addEventListener('click', () => {
    speakText(fullPhraseForTTS, selectedLang || lessonLang || localStorage.getItem('ctlanguage') || 'en-US');
  });

  let lastIndex = 0;
  const tokenRegex = /\{([^}]+)\}/g;
  let match;

  while ((match = tokenRegex.exec(phrase)) !== null) {
    const before = phrase.slice(lastIndex, match.index);
    if (before) li.appendChild(document.createTextNode(before));

    const token = match[1];
    const span = document.createElement('span');
    span.className = 'phrase-word';
    span.textContent = token === 'word' ? word : token;
    li.appendChild(span);

    lastIndex = tokenRegex.lastIndex;
  }

  const after = phrase.slice(lastIndex);
  if (after) li.appendChild(document.createTextNode(after));

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

    const phrases = Array.isArray(item.phrases) ? item.phrases : [];
    const hasPhrases = phrases.length > 0;

    const toggle = document.createElement(hasPhrases ? 'button' : 'span');

    if (hasPhrases) {
      toggle.type = 'button';
      toggle.className = 'wordBubbleToggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Show phrases');
      toggle.textContent = '▸';
    } else {
      toggle.className = 'wordBubbleToggle wordBubbleTogglePlaceholder';
      toggle.setAttribute('aria-hidden', 'true');
      toggle.textContent = '';
    }

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

    if (hasPhrases) {
      const ul = document.createElement('ul');
      ul.className = 'phraseList';
      phrases.forEach(p => ul.appendChild(buildPhraseListItem(p, word)));
      phrasesWrap.appendChild(ul);
    }

    // Toggle expand/collapse
    if (hasPhrases) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const expanded = bubble.classList.toggle('expanded');
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggle.setAttribute('aria-label', expanded ? 'Hide phrases' : 'Show phrases');
      });
    }

    bubble.appendChild(header);
    bubble.appendChild(phrasesWrap);

    container.appendChild(bubble);
  });

  /* Optional: reduce accidental text selection on mobile
  container.querySelectorAll('.tts-clickable').forEach(el => {
    el.style.userSelect = 'none';
    el.style.webkitUserSelect = 'none';
  });
  */
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
    freetalkLangData = (data.languages && (data.languages[storedLang] || data.languages['en-US'])) || null;

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
    updateFooterIcons();

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

function updateFooterIcons() {
  const sessionBtn = document.getElementById(SESSION_BUTTON_ID);
  const sessionImg = sessionBtn?.querySelector('img');

  if (sessionImg) {
    sessionImg.src = showingFinalScore
      ? 'assets/svg/1F504.svg'  // 🔁 restart
      : isSessionActive
        ? 'assets/svg/23F9.svg' // ⏹ stop session
        : 'assets/svg/25B6.svg'; // ▶ play
  }

  const recordBtn = document.getElementById(RECORD_BUTTON_ID);
  const recordImg = recordBtn?.querySelector('img');

  if (recordImg) {
    recordImg.src = isRecording
      ? 'assets/svg/23FA.svg'   // ⏺ recording icon
      : 'assets/svg/1F3A4.svg'; // 🎤
  }
}

document.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(() => {
    initializeSettingsMenu();
    loadTalkerTranslations();
    initializeVoiceMenu();
    setupVoiceMenuListener();
    initializeModeSelector();
    updateFooterIcons();
    initTranscriptController();
    clearTranscriptUI();
    ensureRecordMicButton();
    showRecordMicButton(false);
    updateFooterIcons();

    Promise.all([
      loadLesson()
    ]).then(() => {
      document.body.classList.remove('preload');
    });
    
    speechSynthesis.onvoiceschanged = populateCustomVoiceList;

    const sessionBtn = document.getElementById('micButton');
    sessionBtn.addEventListener('click', () => {
      if (showingFinalScore) {
        window.location.reload();
        return;
      }

      if (!isSessionActive) beginFreeTalkSession();
      else endFreeTalkSession();
      updateFooterIcons();
    });
    const settingsButton = document.getElementById('settingsButton');

    settingsButton.addEventListener('click', () => {
      settingsButton.blur();
      document.getElementById('settingsMenu')?.classList.toggle('show');
    });
  });
});

window.addEventListener('beforeunload', () => {
  clearRecordingDownloadLink();
  micIsMuted = true;
  stopVolumeMonitoring();
  teardownTestModeRecordingGraph();
  if (audioContext) {
    try { audioContext.close(); } catch (_) {}
    audioContext = null;
  }
});
