import { readStored, writeStored } from "./local-store";
import { startVoiceTyping } from "./system-client";

/**
 * Voice in the chat. Input uses Windows voice typing (WebView2 has no speech recognition), so
 * the mic button focuses the input and opens it (Win+H). Output reads answers aloud with the
 * Windows voices through speechSynthesis and tells the character to move its mouth.
 */
export const SPEAKING_EVENT = "ai-character:speaking";
const TTS_KEY = "ai-character-tts";

function readAloudOn(): boolean {
  return readStored(TTS_KEY) === "on";
}

/** Markdown to something worth hearing: no code, links read by their text, no symbols. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " 코드는 화면에서 확인해 주세요. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/[#>*_~|-]{1,}/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_500);
}

function koreanVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  // No Korean voice installed: leave the choice to the engine (lang ko-KR) instead of reading
  // Korean with the first, usually English, voice.
  return voices.find((voice) => voice.lang.toLowerCase().startsWith("ko"));
}

/** Reads an answer aloud when the user turned it on. */
export function speakAnswer(markdown: string): void {
  if (!readAloudOn() || !("speechSynthesis" in window)) return;
  const text = speakableText(markdown);
  if (!text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = koreanVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = "ko-KR";
  }
  const say = (on: boolean) => window.dispatchEvent(new CustomEvent(SPEAKING_EVENT, { detail: on }));
  utterance.onstart = () => say(true);
  utterance.onend = () => say(false);
  utterance.onerror = () => say(false);
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  window.dispatchEvent(new CustomEvent(SPEAKING_EVENT, { detail: false }));
}

/** Adds the mic and read-aloud buttons next to the chat input. */
export function setupVoiceButtons(form: HTMLFormElement, input: HTMLTextAreaElement, onError: (text: string) => void): void {
  const mic = document.createElement("button");
  mic.type = "button";
  mic.className = "chat-voice-button";
  mic.textContent = "🎤";
  mic.title = "말로 입력 (Windows 음성 입력이 열립니다 · Win+H)";
  mic.setAttribute("aria-label", "말로 입력");
  mic.addEventListener("click", () => {
    input.focus();
    void startVoiceTyping().catch((error) => {
      onError(`음성 입력을 열지 못했습니다. Win+H를 직접 눌러 보세요. (${error instanceof Error ? error.message : String(error)})`);
    });
  });

  const speaker = document.createElement("button");
  speaker.type = "button";
  speaker.className = "chat-voice-button";
  speaker.setAttribute("aria-label", "답변 소리 내어 읽기");
  const paint = () => {
    const on = readAloudOn();
    speaker.textContent = on ? "🔊" : "🔈";
    speaker.title = on ? "답변을 소리 내어 읽습니다 (끄려면 누르세요)" : "답변을 소리 내어 읽지 않습니다 (켜려면 누르세요)";
    speaker.classList.toggle("is-on", on);
  };
  speaker.addEventListener("click", () => {
    const next = !readAloudOn();
    writeStored(TTS_KEY, next ? "on" : "off");
    if (!next) stopSpeaking();
    paint();
  });
  paint();

  input.before(mic);
  form.querySelector("button[type='submit']")?.before(speaker);
}
