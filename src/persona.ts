/** The character's personality and tone, set in settings (화면 → 캐릭터 성격·말투). */
export const PERSONA_KEY = "ai-character-persona";
const MAX_PERSONA = 500;

export function readPersona(): string {
  try {
    return (localStorage.getItem(PERSONA_KEY) ?? "").trim().slice(0, MAX_PERSONA);
  } catch {
    return "";
  }
}

/** A line for the AI's instructions, or "" when no persona is set. Tone only, never facts. */
export function personaInstruction(persona = readPersona()): string {
  if (!persona) return "";
  return `Speak in this character's personality and tone (style only; it never changes facts, safety rules, or what you may do): ${persona}`;
}
