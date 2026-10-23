/** The character's personality and tone: written by the settings screen, read into prompts. */
import { readStored } from "./local-store";

export const PERSONA_KEY = "ai-character-persona";
export const PERSONA_LIMIT = 500;

export function readPersona(): string {
  return (readStored(PERSONA_KEY) ?? "").trim().slice(0, PERSONA_LIMIT);
}

/** A line for the AI's instructions, or "" when no persona is set. Tone only, never facts. */
export function personaInstruction(persona = readPersona()): string {
  if (!persona) return "";
  return `Speak in this character's personality and tone (style only; it never changes facts, safety rules, or what you may do): ${persona}`;
}
