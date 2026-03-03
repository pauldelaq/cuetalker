// js/engine/transcript-controller.js
class TranscriptController {
    constructor({ el }) {
    this.el = el;
    this.finalText = '';
    this.interimText = '';
  }

  reset() {
    this.finalText = '';
    this.interimText = '';
    this.render();
  }

  setInterim(text) {
    this.interimText = (text || '').trim();
    this.render();
  }

  appendFinal(text) {
    const chunk = (text || '').trim();
    if (!chunk) return;

    this.finalText = (this.finalText ? (this.finalText + ' ') : '') + chunk;
    this.finalText = this.finalText.trim();
    this.interimText = '';
    this.render();
  }

  getFullText() {
    return (this.finalText + ' ' + this.interimText).trim();
  }

  render() {
    if (!this.el) return;
    const full = this.getFullText();
    this.el.textContent = full;
  }
}

// ... class TranscriptController { ... }
window.TranscriptController = TranscriptController;