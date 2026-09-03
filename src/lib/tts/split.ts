/** Split prose into TTS chunks — shorter first chunk = faster time-to-first-audio. */
export function splitForTts(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const sentences =
    normalized.match(/[^.!?…]+(?:[.!?…]+|$)|[^.!?…]+$/g)?.map((part) => part.trim()) ?? [normalized];

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

export function ttsCacheKey(text: string, voice: string, speed: number): string {
  return `${voice}:${speed}:${text.replace(/\s+/g, " ").trim()}`;
}
