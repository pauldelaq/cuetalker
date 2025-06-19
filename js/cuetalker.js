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
  showNextMessage();       // ⬅️ show the first message
  updateMicIcon();         // ⬅️ update the mic icon *after* first message is shown
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

  if (item.type === 'prompt' && item.text) {
    const container = document.getElementById('cue-content');

    // Get the most recent full message div (with avatar and bubble)
    const messageDivs = container.querySelectorAll('.message.speaker');
    const latestMsg = messageDivs[messageDivs.length - 1];
    const avatar = latestMsg?.querySelector('.avatar');

    if (latestMsg && avatar) {
      // Listen for swipe-in animation on the WHOLE message div
      latestMsg.addEventListener('animationend', () => {
        avatar.classList.add('rotate-shake');

        avatar.addEventListener('animationend', () => {
          avatar.classList.remove('rotate-shake');

          speakText(item.text, () => {
            if (item.hint) renderHintBubble(item.hint);
          });
        }, { once: true });

      }, { once: true });
    } else {
      // fallback
      speakText(item.text, () => {
        if (item.hint) renderHintBubble(item.hint);
      });
    }

  } else if (item.type === 'prompt' && item.hint) {
    // fallback if no text to speak
    renderHintBubble(item.hint);
  }

  if (item.type !== 'response') {
    currentIndex++;
    updateMicIcon();
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
  wrapper.className = 'bubble-wrapper';

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
    const recognition = new webkitSpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    isRecording = true;
    updateMicIcon();

    recognition.onstart = () => {
      document.getElementById('liveTranscript').innerText = '[Listening...]';
    };

    recognition.onresult = (event) => {
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        }
      }

      if (final) {
        isRecording = false;
        stopVolumeMonitoring();
        updateMicIcon();
        document.getElementById('liveTranscript').innerText = final;
        handleUserResponse(final);
      }
    };

    recognition.onerror = () => {
      isRecording = false;
      stopVolumeMonitoring();
      updateMicIcon();
    };

    recognition.start();
  });
}

function normalize(text) {
  return text.toLowerCase().replace(/[.,!?]/g, '').trim();
}

function handleUserResponse(spokenText) {
  const item = conversation[currentIndex];
  if (!item || item.type !== 'response') return;

  const promptItem = conversation[currentIndex - 1];
  const validAnswers = promptItem?.expectedAnswers || [];

  // Try exact match first
  let matched = validAnswers.find(answer => answer === spokenText);

  // If not found, try normalized match
  if (!matched) {
    const normalizedSpoken = normalize(spokenText);
    matched = validAnswers.find(answer => normalize(answer) === normalizedSpoken);
  }

  // Remove the last hint bubble (if any)
  const lastHint = document.querySelector('#cue-content .message.user .bubble.thought');
  if (lastHint?.parentElement) {
    lastHint.parentElement.remove();
  }

  item.text = matched || spokenText;
  renderCurrentLine(item);

  currentIndex++;
  showNextMessage();
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

window.addEventListener('DOMContentLoaded', () => {
  loadLesson();
  initializeVoiceMenus(); // <- REPLACEMENT LINE

  document.getElementById('micButton').addEventListener('click', () => {
    const currentItem = conversation[currentIndex];
    if (!currentItem) return;

    if (currentItem.type === 'narration') {
      currentIndex++;
      showNextMessage();
    } else if (currentItem.type === 'response') {
      startSpeechRecognition();
    } else {
      showNextMessage();
    }
  });

  document.getElementById('settingsButton').addEventListener('click', () => {
    document.getElementById('settingsMenu')?.classList.toggle('show');
  });
});
