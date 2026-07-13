// -----------------------------------------------------------------------------
// voiceGuidance.js — Web Speech API wrappers (Phase 3).
// -----------------------------------------------------------------------------

export function speak() {
  // Phase 3
}

export function cancelSpeech() {
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.cancel();
  }
}
