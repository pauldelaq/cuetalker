// cuetalker.js

let currentIndex = 0;
let conversation = [];
let recognition;
let isRecording = false;
let audioContext, analyser, dataArray, volumeInterval;
let micStream;
let selectedLang = localStorage.getItem('ctlanguage') || '';
let selectedVoiceName = localStorage.getItem('ctvoice') || '';
let availableVoices = [];
let autoAdvance = localStorage.getItem('ctAutoAdvance') === 'true';

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

function highlightDifferences(userText, expectedText) {
  const userWordsRaw = userText.trim().split(/\s+/); // unnormalized for display
  const userWordsNorm = normalize(userText).split(/\s+/); // for comparison
  const expectedWordsNorm = normalize(expectedText).split(/\s+/);
  const highlighted = [];

  const len = Math.max(userWordsNorm.length, expectedWordsNorm.length);

  for (let i = 0; i < len; i++) {
    const userRaw = userWordsRaw[i] || '';
    const userNorm = userWordsNorm[i] || '';
    const expectedNorm = expectedWordsNorm[i] || '';

    if (userNorm === expectedNorm) {
      highlighted.push(userRaw);
    } else {
      highlighted.push(`<span class="wrong-word">${userRaw}</span>`);
    }
  }

  return highlighted.join(' ');
}

function startVolumeMonitoring(stream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const micSource = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  micSource.connect(analyser);

  dataArray = new Uint8Array(analyser.fftSize);

  volumeInterval = setInterval(() => {
    analyser.getByteTimeDomainData(dataArray);
    const volume = Math.max(...dataArray) - 128;
    animateMicPulse(volume);
  }, 100);
}

function stopVolumeMonitoring() {
  clearInterval(volumeInterval);

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }

  const micButton = document.getElementById('micButton');
  micButton.classList.remove('recording'); // ✅ remove class
  micButton.style.boxShadow = 'none';      // ✅ clear any inline override
  micButton.style.transform = 'scale(1)';
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

  utterance.onend = () => {
    if (typeof onend === 'function') onend();
  };

  speechSynthesis.cancel(); // Cancel any queued speech
  speechSynthesis.speak(utterance);
}

async function loadLesson() {
  const res = await fetch('data/france.json');
  conversation = (await res.json()).exercises;
  currentIndex = 0;

  // ✅ Update mic icon BEFORE first message is rendered
  updateMicIcon();

  // Then render the first message
  showNextMessage();
}

function tryAutoAdvance() {
  const nextItem = conversation[currentIndex + 1];

  if (autoAdvance && nextItem?.type === 'response' && !isRecording) {
    setTimeout(() => {
      const micButton = document.getElementById('micButton');
      if (!isRecording && micButton) {
        currentIndex++; // ✅ manually advance index since we're skipping a click
        micButton.click(); // safely start recording
      }
    }, 300);
  } else {
    currentIndex++; // ✅ always move forward unless we’re waiting for speech
  }
}

function updateMicIcon() {
  const micIcon = document.querySelector('#micButton img');
  const micButton = document.getElementById('micButton');
  const currentItem = conversation[currentIndex];

  // 🔁 Toggle recording visual
  if (isRecording) {
    micIcon.src = 'https://openmoji.org/data/color/svg/23FA.svg'; // stop icon
    micButton.classList.add('recording');
  } else {
    micButton.classList.remove('recording');
    if (!currentItem || currentItem.type === 'narration') {
      micIcon.src = 'https://openmoji.org/data/color/svg/23E9.svg'; // narration
    } else {
      micIcon.src = 'https://openmoji.org/data/color/svg/1F3A4.svg'; // mic
    }
  }
}

function showNextMessage() {
  const item = conversation[currentIndex];
  if (!item) return;

  renderCurrentLine(item);
  updateMicIcon(); // always show the correct icon before anything else

  if (item.type === 'prompt' && item.text) {
    const container = document.getElementById('cue-content');
    const messageDivs = container.querySelectorAll('.message.speaker');
    const latestMsg = messageDivs[messageDivs.length - 1];
    const avatar = latestMsg?.querySelector('.avatar');

    if (latestMsg && avatar) {
      latestMsg.addEventListener('animationend', () => {
        const emoji = avatar.querySelector('.emoji');
        if (emoji) emoji.classList.add('rotate-shake');

        emoji?.addEventListener('animationend', () => {
          emoji.classList.remove('rotate-shake');
          speakText(item.text, () => {
            if (item.hint) renderHintBubble(item.hint);

            // ✅ After hint is shown, advance if allowed
            tryAutoAdvance();
          });
        }, { once: true });
      }, { once: true });
    } else {
      speakText(item.text, () => {
        if (item.hint) renderHintBubble(item.hint);
        tryAutoAdvance();
      });
    }

  } else if (item.type === 'prompt' && item.hint) {
    renderHintBubble(item.hint);
    tryAutoAdvance();

  } else if (item.type === 'narration') {
    // Show narration and wait for user input — no auto-advance


  } else if (item.type === 'response') {
    // Do nothing. Wait for user or auto-advance to trigger mic manually.
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
  avatar.innerHTML = `
    <div class="emoji">${item.character?.emoji || ''}</div>
    <div class="name">${item.character?.name || ''}</div>
  `;

  const bubble = document.createElement('div');
    bubble.className = 'bubble ' + (
    item.type === 'response' ? 'right' :
    item.type === 'prompt' ? 'left' :
    item.type === 'narration' ? 'center' : ''
    );

    // Apply swipe-in animation to the entire message row for prompts
    if (item.type === 'prompt') {
    msgDiv.classList.add('swipe-in-left');
    }

  bubble.innerText = item.text || '...';

  if (item.type === 'response') {
    msgDiv.appendChild(bubble);
    msgDiv.appendChild(avatar);
  } else if (item.type === 'prompt') {
    msgDiv.appendChild(avatar);
    msgDiv.appendChild(bubble);
  } else if (item.type === 'narration') {
    msgDiv.appendChild(bubble); // narration doesn't need an avatar
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
  avatar.className = 'avatar';
  avatar.innerHTML = `
    <div class="emoji">🤔</div>
    <div class="name">You</div>
  `;

  // Outer wrapper positions both layers
  const wrapper = document.createElement('div');
  wrapper.className = 'bubble-wrapper swipe-in-right';

  // Text layer (normal size, drives layout)
  const textLayer = document.createElement('div');
  textLayer.className = 'hint-bubble';
  textLayer.textContent = hint;

  // Background animation layer (same size, scaled)
  const bgLayer = document.createElement('div');
  bgLayer.className = 'bubble-bg-pulse';

  wrapper.appendChild(bgLayer);
  wrapper.appendChild(textLayer);

  hintDiv.appendChild(wrapper);
  hintDiv.appendChild(avatar);
  container.appendChild(hintDiv);
  container.scrollTop = container.scrollHeight;
}

function startSpeechRecognition() {
  if (!('webkitSpeechRecognition' in window)) {
    alert('Speech recognition not supported.');
    return;
  }

  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    micStream = stream;

    // Start audio volume analysis
    startVolumeMonitoring(stream);

    // Now start STT
    recognition = new webkitSpeechRecognition(); // ✅ now assigned to global
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    isRecording = true;
    updateMicIcon();

    recognition.onstart = () => {
      document.getElementById('liveTranscript').innerText = '[Listening...]';
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

    const display = finalTranscript || interimTranscript || '';
    document.getElementById('liveTranscript').innerText = display;

    if (finalTranscript) {
        isRecording = false;
        recognition.stop();
        stopVolumeMonitoring();
        updateMicIcon();
        handleUserResponse(finalTranscript);
    }
    };

    recognition.onerror = () => {
      isRecording = false;
      recognition.stop(); // ✅ explicitly stop the mic
      stopVolumeMonitoring();
      updateMicIcon();
    };

    recognition.start();
  });
}

function stopSpeechRecognition() {
  if (recognition) {
    recognition.abort(); // 💥 force stop (use abort, not stop, to cancel)
  }

  isRecording = false;
  stopVolumeMonitoring();
  updateMicIcon();

  const liveTranscript = document.getElementById('liveTranscript');
  if (liveTranscript) liveTranscript.textContent = '';
}

function normalize(text) {
  return text.toLowerCase().replace(/[.,!?]/g, '').trim();
}

function handleUserResponse(spokenText) {
  const item = conversation[currentIndex];
  if (!item || item.type !== 'response') return;

  const promptItem = conversation[currentIndex - 1];
  const validAnswers = promptItem?.expectedAnswers || [];

  // ✅ Try exact match first
  let matched = validAnswers.find(answer => answer === spokenText);

  // ✅ Try normalized match
  if (!matched) {
    const normalizedSpoken = normalize(spokenText);
    matched = validAnswers.find(answer => normalize(answer) === normalizedSpoken);
  }

  if (matched) {
    // ✅ Remove the current hint bubble (animated wrapper)
    const hintWrapper = document.querySelector('#cue-content .bubble-wrapper');
    if (hintWrapper?.parentElement) {
      hintWrapper.parentElement.remove();
    }

    item.text = matched;
    renderCurrentLine(item);

    currentIndex++;
    showNextMessage();
  } else {
    // ❌ INCORRECT: Find closest expectedAnswer for red-word comparison
    const normalizedSpoken = normalize(spokenText);
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

    // 🟥 Update footer transcript with red highlights
    const transcriptEl = document.getElementById('liveTranscript');
    if (transcriptEl) transcriptEl.innerHTML = redText;

    // 💢 Shake latest user avatar
    const container = document.getElementById('cue-content'); // ✅ Define this first
    const avatars = container.querySelectorAll('.message.user .avatar .emoji');
    const lastEmoji = avatars[avatars.length - 1];
    if (lastEmoji) {
    lastEmoji.classList.add('shake');
    lastEmoji.addEventListener('animationend', () => {
        lastEmoji.classList.remove('shake');
    }, { once: true });
    }
  }
}

function populateLanguageList() {
  const langSelect = document.getElementById('ctlanguage');
  const langs = [...new Set(speechSynthesis.getVoices().map(v => v.lang))];
  langSelect.innerHTML = '';

  langs.forEach(lang => {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = lang;
    if (lang === selectedLang) opt.selected = true;
    langSelect.appendChild(opt);
  });
}

function populateVoiceList() {
  availableVoices = speechSynthesis.getVoices();
  const voiceSelect = document.getElementById('ctvoice');
  voiceSelect.innerHTML = '';

const filtered = availableVoices.filter(v => v.lang.startsWith(selectedLang));

  filtered.forEach(voice => {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = `${voice.name} (${voice.lang})${voice.default ? ' — DEFAULT' : ''}`;
    if (voice.name === selectedVoiceName) opt.selected = true;
    voiceSelect.appendChild(opt);
  });
}

function initializeVoiceMenus() {
  availableVoices = speechSynthesis.getVoices();

  if (availableVoices.length) {
    populateLanguageList();
    populateVoiceList();
  } else {
    // Try again when voices load
    speechSynthesis.onvoiceschanged = () => {
      availableVoices = speechSynthesis.getVoices();
      populateLanguageList();
      populateVoiceList();
    };
  }

  const langSelect = document.getElementById('ctlanguage');
  const voiceSelect = document.getElementById('ctvoice');

  if (langSelect && voiceSelect) {
    langSelect.addEventListener('change', (e) => {
      selectedLang = e.target.value;
      localStorage.setItem('ctlanguage', selectedLang);
      populateVoiceList();
    });

    voiceSelect.addEventListener('change', (e) => {
      selectedVoiceName = e.target.value;
      localStorage.setItem('ctvoice', selectedVoiceName);
    });
  }
}

function initializeSettingsMenu() {
  const autoAdvanceToggle = document.getElementById('autoAdvanceToggle');
  if (autoAdvanceToggle) {
    autoAdvanceToggle.checked = autoAdvance;
    autoAdvanceToggle.addEventListener('change', (e) => {
      autoAdvance = e.target.checked;
      localStorage.setItem('ctAutoAdvance', autoAdvance);
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  loadLesson();
  initializeVoiceMenus();
  initializeSettingsMenu(); // ✅ new clean hook

document.getElementById('micButton').addEventListener('click', () => {
  const currentItem = conversation[currentIndex];
  if (!currentItem) return;

    // 🔁 Toggle logic: if already recording, cancel it
    if (isRecording) {
        stopSpeechRecognition(); // You'll define this below
        return;
    }

    if (currentItem.type === 'response') {
        startSpeechRecognition();
    } else if (currentItem.type === 'narration') {
        currentIndex++;
        showNextMessage();
    } else {
        showNextMessage();
    }
    });

  document.getElementById('settingsButton').addEventListener('click', () => {
    document.getElementById('settingsMenu')?.classList.toggle('show');
  });
});
