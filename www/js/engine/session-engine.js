// js/engine/session-engine.js
export class SpeechSessionEngine {
  constructor({
    transcriber,
    transcript,
    onFinalText = (_fullText) => {}, // hook for matching/scoring
  }) {
    this.transcriber = transcriber;
    this.transcript = transcript;
    this.onFinalText = onFinalText;

    // Wire transcriber events -> transcript
    this.transcriber.onStart = () => {
      // you can set “[Listening…]” here if you want
    };

    this.transcriber.onInterim = (t) => {
      this.transcript.setInterim(t);
    };

    this.transcriber.onFinal = (t) => {
      this.transcript.appendFinal(t);
      this.onFinalText(this.transcript.getFullText());
    };

    this.transcriber.onEnd = () => {
      // session ended (user stopped / recognition ended)
    };

    this.transcriber.onError = (err) => {
      console.warn('[Transcriber error]', err);
      // engine decides whether to restart later
    };
  }

  start() {
    this.transcript.reset();
    this.transcriber.start();
  }

  stop() {
    this.transcriber.stop();
  }

  abort() {
    this.transcriber.abort();
  }

  setLanguage(lang) {
    this.transcriber.setLanguage(lang);
  }
}