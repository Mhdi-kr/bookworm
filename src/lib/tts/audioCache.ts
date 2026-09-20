export type CachedPcm = {
  audio: Float32Array;
  sampleRate: number;
};

/**
 * In-memory LRU for synthesized PCM. sessionStorage is a bad fit: ~5MB string
 * quota, no binary types, and workers cannot read it.
 *
 * ~32MB of 24kHz float32 ≈ 5–6 minutes of speech — enough to replay recent
 * paragraphs this session without pinning a whole chapter in RAM.
 */
export const TTS_AUDIO_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const TTS_AUDIO_CACHE_MAX_ENTRIES = 256;

export class AudioLruCache {
  private readonly entries = new Map<string, CachedPcm>();
  private usedBytes = 0;
  readonly maxBytes: number;
  readonly maxEntries: number;

  constructor(
    maxBytes: number = TTS_AUDIO_CACHE_MAX_BYTES,
    maxEntries: number = TTS_AUDIO_CACHE_MAX_ENTRIES,
  ) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.usedBytes;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): CachedPcm | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, value: CachedPcm): void {
    const size = value.audio.byteLength;
    if (size > this.maxBytes) return;

    const existing = this.entries.get(key);
    if (existing) {
      this.usedBytes -= existing.audio.byteLength;
      this.entries.delete(key);
    }

    this.entries.set(key, value);
    this.usedBytes += size;
    this.evict();
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.usedBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.usedBytes -= oldest.audio.byteLength;
    }
  }
}
