import { normalizeSpeakable } from "./extract";

/** Keep "1. Item" together — a leading numbered marker is not a sentence end. */
const NUMBERED_PREFIX = /^(\d{1,3}[.)]\s+)/;

/** Split prose into TTS chunks — shorter first chunk = faster time-to-first-audio. */
export function splitForTts(text: string): string[] {
  const normalized = normalizeSpeakable(text);
  if (!normalized) return [];

  const prefix = normalized.match(NUMBERED_PREFIX)?.[1] ?? "";
  const rest = prefix ? normalized.slice(prefix.length) : normalized;
  const sentences =
    rest.match(/[^.!?…]+(?:[.!?…]+|$)|[^.!?…]+$/g)?.map((part) => part.trim()).filter(Boolean) ??
    (rest ? [rest] : []);

  if (!sentences.length) return [normalized];
  sentences[0] = `${prefix}${sentences[0]}`.trim();

  const parts: string[] = [];
  for (const sentence of sentences.filter(Boolean)) {
    if (sentence.length <= 100) {
      parts.push(sentence);
      continue;
    }
    const clauses = sentence.split(/(?<=[,;:—–-])\s+/).filter((part) => part.trim());
    if (clauses.length > 1) {
      parts.push(...clauses.map((part) => part.trim()).filter(Boolean));
    } else {
      parts.push(sentence);
    }
  }
  return parts;
}

export function ttsCacheKey(text: string, voice: string): string {
  return `${voice}:${normalizeSpeakable(text) || text.replace(/\s+/g, " ").trim()}`;
}
