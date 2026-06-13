// js/engine/transcriber-webspeech.js
class WebSpeechTranscriber {
  constructor({
    lang = 'en-US',
    onStart = () => {},
    onInterim = (_text) => {},
    onFinal = (_text) => {},
    onEnd = () => {},
    onError = (_err) => {},
    interimResults = true,
    continuousRestart = false, // start simple: false for now
  } = {}) {
    this.lang = lang;
    this.onStart = onStart;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onEnd = onEnd;
    this.onError = onError;
    this.interimResults = interimResults;
    this.continuousRestart = continuousRestart;

    this.recognition = null;
    this.running = false;
  }

  setLanguage(lang) {
    this.lang = lang || 'en-US';
    if (this.recognition) this.recognition.lang = this.lang;
  }

  isRunning() {
    return this.running;
  }

  start() {
    if (this.running) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this.onError(new Error('SpeechRecognition not supported'));
      return;
    }

    this.recognition = new SR();
    this.recognition.lang = this.lang;
    this.recognition.interimResults = !!this.interimResults;
    this.recognition.maxAlternatives = 1;

    this.running = true;

    this.recognition.onstart = () => {
      this.onStart();
    };

    this.recognition.onresult = (event) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }

      if (interim) this.onInterim(interim);
      if (final) this.onFinal(final);
    };

    this.recognition.onerror = (e) => {
      // pass the raw error up; engine decides what to do
      this.onError(e);
    };

    this.recognition.onend = () => {
      const wasRunning = this.running;
      this.running = false;
      this.onEnd();

      // optional “always-on” restart behavior (we can add later once stable)
      if (this.continuousRestart && wasRunning) {
        try { this.start(); } catch (_) {}
      }
    };

    try {
      this.recognition.start();
    } catch (err) {
      this.running = false;
      this.onError(err);
    }
  }

  stop() {
    this.running = false;
    try { this.recognition?.stop(); } catch (_) {}
  }

  abort() {
    this.running = false;
    try { this.recognition?.abort(); } catch (_) {}
  }
}

// ... class WebSpeechTranscriber { ... }
window.WebSpeechTranscriber = WebSpeechTranscriber;