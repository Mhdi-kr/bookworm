import type { VoiceInfo } from "../../types";
import { getMeta, modelCacheStats, requestPersistentStorage, setMeta } from "../offline/idb";
import { loadReaderSettings, saveReaderSettings } from "../readerSettings";
import KokoroWorker from "./kokoro.worker.ts?worker";
import { ttsCacheKey } from "./split";
import { timeStretch } from "./stretch";
import { encodeWav } from "./wav";

type Status = "idle" | "loading" | "preparing" | "ready" | "speaking" | "paused" | "error";

type Listener = () => void;

type ProgressInfo = {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
};

type MediaMeta = {
  title?: string;
  artist?: string;
  album?: string;
};

export type SpeakSequenceCallbacks = {
  /** Fired when a block's audio actually begins playing. */
  onBlockPlay?: (index: number) => void;
  /** Fired when the next block starts synthesizing (preload). */
  onBlockLoading?: (index: number) => void;
};

type HeldClip = {
  pcm: Float32Array;
  sampleRate: number;
  generation: number;
  blockIndex?: number;
};

type ScheduledClip = {
  source: AudioBufferSourceNode;
  buffer: AudioBuffer;
  pcm: Float32Array;
  sampleRate: number;
  startAt: number;
  generation: number;
  blockIndex?: number;
};

const initialSpeechPrefs = loadReaderSettings();

/**
 * Kokoro TTS playback: Web Audio for reliable output, HTMLAudio fallback for
 * lock-screen / Media Session on mobile webviews. Synthesis is always 1×;
 * tempo is applied with pitch-preserving time-stretch (Web Audio) or
 * `preservesPitch` (HTML).
 */
export class TtsEngine {
  private worker: Worker | null = null;
  private listeners = new Set<Listener>();
  private generation = 0;
  private pendingText: string | null = null;
  private pendingMeta: MediaMeta | null = null;
  private workerReady = false;
  private ctx: AudioContext | null = null;
  private clips: ScheduledClip[] = [];
  private held: HeldClip[] = [];
  private nextTime = 0;
  private htmlAudio: HTMLAudioElement | null = null;
  private htmlQueue: Array<{ url: string; blockIndex?: number }> = [];
  private htmlPlaying = false;
  private streamDone = false;
  private waiters = new Map<number, (completed: boolean) => void>();
  private wakeLock: WakeLockSentinel | null = null;
  private useHtmlFallback = false;
  private bootPromise: Promise<void> | null = null;
  private readyWaiters: Array<() => void> = [];
  private prefetchId = 0;
  private prefetchKey = "";
  private pendingSequence: {
    texts: string[];
    meta: MediaMeta | null;
    callbacks?: SpeakSequenceCallbacks;
  } | null = null;
  private onSectionBlockPlay: ((index: number) => void) | null = null;
  private onSectionBlockLoading: ((index: number) => void) | null = null;
  private scheduledPlayBlockIndex = -1;
  private playNotifyTimers: number[] = [];
  private sequenceTexts: string[] = [];
  version = 0;

  status: Status = "idle";
  error: string | null = null;
  voices: VoiceInfo[] = [];
  voice = initialSpeechPrefs.voice;
  speed = initialSpeechPrefs.speed;
  currentText = "";
  downloadLabel = "";
  offlineReady = false;
  cachedModelFiles = 0;
  cachedModelBytes = 0;
  inferenceDevice: "webgpu" | "wasm" | null = null;
  mediaMeta: MediaMeta = { title: "Bookworm", artist: "Reading aloud" };

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }

  setMediaMeta(meta: MediaMeta) {
    this.mediaMeta = { ...this.mediaMeta, ...meta };
    this.syncMediaSession();
  }

  /** Call from a user gesture (Speak) to satisfy autoplay policies. */
  async unlockAudio() {
    const ctx = this.audioContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    const html = this.ensureHtmlAudio();
    html.muted = true;
    try {
      await html.play();
      html.pause();
      html.currentTime = 0;
    } catch {
      /* optional unlock path */
    } finally {
      html.muted = false;
    }
  }

  async ensureReady() {
    if (this.workerReady) return;
    if (!this.bootPromise) {
      this.bootPromise = this.bootWorker();
    }
    await this.bootPromise;
    if (!this.workerReady) {
      await new Promise<void>((resolve) => {
        this.readyWaiters.push(resolve);
      });
    }
  }

  private resolveReadyWaiters() {
    for (const resolve of this.readyWaiters) resolve();
    this.readyWaiters = [];
    this.bootPromise = null;
  }

  private rejectReadyWaiters() {
    for (const resolve of this.readyWaiters) resolve();
    this.readyWaiters = [];
    this.bootPromise = null;
  }

  private async bootWorker() {
    if (this.worker) return;
    this.status = "loading";
    this.error = null;
    this.downloadLabel = "Preparing voice cache…";
    this.emit();
    void requestPersistentStorage();
    const [stats, preferredDevice] = await Promise.all([
      modelCacheStats(),
      getMeta<"webgpu" | "wasm">("tts-inference-device"),
    ]);
    this.cachedModelFiles = stats.files;
    this.cachedModelBytes = stats.bytes;
    if (stats.files > 0) {
      this.downloadLabel = `Loading voice from cache (${stats.files} files)…`;
      this.emit();
    }
    this.worker = new KokoroWorker();
    this.worker.onmessage = (event: MessageEvent) => this.onMessage(event.data);
    this.worker.onerror = (event: ErrorEvent) => {
      this.error =
        event.message && event.message !== "Script error."
          ? event.message
          : "Voice engine failed to start in this browser";
      this.status = "error";
      this.downloadLabel = "";
      this.worker?.terminate();
      this.worker = null;
      this.workerReady = false;
      this.rejectReadyWaiters();
      this.rejectWaiters(false);
      this.emit();
    };
    this.worker.postMessage({ type: "init", preferredDevice });
  }

  /** Start loading the voice model in the background (call on app launch). */
  warmup() {
    if (this.workerReady) return;
    void this.ensureReady();
  }

  /** Synthesize the first chunk on hover so click-to-speak feels instant. */
  prefetch(text: string) {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed || !this.workerReady) return;
    const key = ttsCacheKey(trimmed, this.voice);
    if (this.prefetchKey === key) return;
    this.prefetchKey = key;
    this.prefetchId += 1;
    this.worker?.postMessage({
      type: "prefetch",
      text: trimmed,
      voice: this.voice,
      prefetchId: this.prefetchId,
    });
  }

  async speak(text: string, meta?: MediaMeta) {
    await this.speakAndWait(text, meta);
  }

  /** Stop playback/inference and optionally clear the visible utterance. */
  private interrupt(clearText: boolean): number {
    this.rejectWaiters(false);
    this.stopPlayback();
    this.generation += 1;
    const generation = this.generation;
    this.worker?.postMessage({ type: "cancel", generation });
    this.streamDone = false;
    this.pendingText = null;
    this.pendingMeta = null;
    this.prefetchKey = "";
    this.pendingSequence = null;
    this.onSectionBlockPlay = null;
    this.onSectionBlockLoading = null;
    this.scheduledPlayBlockIndex = -1;
    this.sequenceTexts = [];
    this.clearPlayNotifyTimers();
    if (clearText) this.currentText = "";
    return generation;
  }

  async speakAndWait(text: string, meta?: MediaMeta): Promise<boolean> {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return true;

    const generation = this.interrupt(false);
    this.currentText = trimmed;
    this.error = null;
    if (meta) this.setMediaMeta(meta);

    const result = new Promise<boolean>((resolve) => {
      this.waiters.set(generation, resolve);
    });

    if (!this.workerReady) {
      this.pendingText = trimmed;
      this.pendingMeta = meta ?? null;
      // Emit only after leaving ready/idle — otherwise the reader clears the speaking highlight.
      if (this.status !== "loading") {
        this.status = "loading";
        this.emit();
      }
      void this.unlockAudio();
      await this.ensureReady();
      return result;
    }

    this.status = "preparing";
    this.emit();
    void this.unlockAudio();
    void this.requestWakeLock();
    this.worker?.postMessage({
      type: "speak",
      text: trimmed,
      voice: this.voice,
      generation,
    });
    return result;
  }

  async speakSequence(
    texts: string[],
    meta?: MediaMeta,
    callbacks?: SpeakSequenceCallbacks,
  ): Promise<boolean> {
    const trimmed = texts.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!trimmed.length) return true;

    const generation = this.interrupt(false);
    this.onSectionBlockPlay = callbacks?.onBlockPlay ?? null;
    this.onSectionBlockLoading = callbacks?.onBlockLoading ?? null;
    this.scheduledPlayBlockIndex = -1;
    this.sequenceTexts = trimmed;
    this.currentText = trimmed[0];
    this.error = null;
    if (meta) this.setMediaMeta(meta);

    const result = new Promise<boolean>((resolve) => {
      this.waiters.set(generation, resolve);
    });

    const startSequence = () => {
      this.status = "preparing";
      this.emit();
      void this.requestWakeLock();
      this.worker?.postMessage({
        type: "speakSequence",
        texts: trimmed,
        voice: this.voice,
        generation,
      });
    };

    if (!this.workerReady) {
      this.pendingSequence = { texts: trimmed, meta: meta ?? null, callbacks };
      this.pendingText = null;
      this.pendingMeta = null;
      if (this.status !== "loading") {
        this.status = "loading";
        this.emit();
      }
      void this.unlockAudio();
      await this.ensureReady();
      return result;
    }

    void this.unlockAudio();
    startSequence();
    return result;
  }

  pause() {
    if (this.status !== "speaking" && this.status !== "preparing") return;
    this.status = "paused";
    this.holdScheduledClips();
    this.htmlAudio?.pause();
    this.syncMediaSession();
    this.emit();
  }

  async resume() {
    if (this.status !== "paused") return;
    if (this.useHtmlFallback) {
      this.status = "speaking";
      void this.requestWakeLock();
      const html = this.htmlAudio;
      if (this.htmlPlaying && html?.src) {
        this.applyHtmlPlaybackRate(html);
        try {
          await html.play();
        } catch {
          this.htmlPlaying = false;
          void this.pumpHtml();
        }
      } else {
        void this.pumpHtml();
      }
    } else {
      const queued = this.held;
      this.held = [];
      const ctx = this.audioContext();
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      const late = this.held;
      this.held = [];
      this.status = "speaking";
      void this.requestWakeLock();
      this.nextTime = ctx.currentTime;
      for (const item of queued.concat(late)) {
        this.startClip(item.pcm, item.sampleRate, item.generation, item.blockIndex);
      }
    }
    this.syncMediaSession();
    this.emit();
    this.maybeFinishUtterance(this.generation);
  }

  stop() {
    this.interrupt(true);
    this.status = this.workerReady ? "ready" : "idle";
    this.releaseWakeLock();
    this.syncMediaSession();
    this.emit();
  }

  setVoice(voice: string) {
    this.voice = voice;
    saveReaderSettings({ voice });
    this.emit();
  }

  setSpeed(speed: number) {
    this.speed = saveReaderSettings({ speed }).speed;
    this.applyPlaybackSpeed();
    this.emit();
  }

  private rejectWaiters(completed: boolean) {
    for (const [, resolve] of this.waiters) resolve(completed);
    this.waiters.clear();
  }

  private resolveWaiter(generation: number, completed: boolean) {
    const resolve = this.waiters.get(generation);
    if (!resolve) return;
    this.waiters.delete(generation);
    resolve(completed);
  }

  private maybeFinishUtterance(generation: number) {
    if (!this.streamDone) return;
    if (this.status === "paused") return;
    if (this.useHtmlFallback) {
      if (this.htmlPlaying || this.htmlQueue.length > 0) return;
    } else if (this.clips.length > 0 || this.held.length > 0) {
      return;
    }
    this.status = "ready";
    this.resolveWaiter(generation, true);
    this.onSectionBlockPlay = null;
    this.onSectionBlockLoading = null;
    this.releaseWakeLock();
    this.syncMediaSession();
    this.emit();
  }

  private audioContext() {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext();
      this.nextTime = 0;
    }
    return this.ctx;
  }

  private ensureHtmlAudio() {
    if (this.htmlAudio) return this.htmlAudio;
    const audio = document.createElement("audio");
    audio.setAttribute("playsinline", "true");
    audio.preload = "auto";
    audio.style.display = "none";
    this.applyHtmlPlaybackRate(audio);
    document.body.appendChild(audio);
    audio.addEventListener("ended", () => {
      this.htmlPlaying = false;
      void this.pumpHtml();
    });
    audio.addEventListener("error", () => {
      this.htmlPlaying = false;
      void this.pumpHtml();
    });
    this.htmlAudio = audio;
    this.installMediaSessionHandlers();
    return audio;
  }

  private installMediaSessionHandlers() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", () => void this.resume());
      navigator.mediaSession.setActionHandler("pause", () => this.pause());
      navigator.mediaSession.setActionHandler("stop", () => this.stop());
    } catch {
      /* unsupported */
    }
  }

  private syncMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.mediaMeta.title || "Bookworm",
        artist: this.mediaMeta.artist || "Reading aloud",
        album: this.mediaMeta.album || "Bookworm",
      });
      navigator.mediaSession.playbackState =
        this.status === "speaking"
          ? "playing"
          : this.status === "paused"
            ? "paused"
            : "none";
    } catch {
      /* MediaMetadata unavailable */
    }
  }

  private async requestWakeLock() {
    try {
      if (document.visibilityState === "visible" && navigator.wakeLock?.request) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => {
          this.wakeLock = null;
        });
      }
    } catch {
      /* optional */
    }
  }

  private releaseWakeLock() {
    void this.wakeLock?.release();
    this.wakeLock = null;
  }

  private clearPlayNotifyTimers() {
    for (const timer of this.playNotifyTimers) window.clearTimeout(timer);
    this.playNotifyTimers = [];
  }

  private notifyBlockPlay(blockIndex: number, generation: number, delayMs = 0) {
    if (blockIndex === this.scheduledPlayBlockIndex) return;
    this.scheduledPlayBlockIndex = blockIndex;
    const fire = () => {
      if (generation !== this.generation) return;
      const text = this.sequenceTexts[blockIndex];
      if (text) this.currentText = text;
      this.onSectionBlockPlay?.(blockIndex);
      this.emit();
    };
    if (delayMs <= 0) {
      fire();
      return;
    }
    const timer = window.setTimeout(fire, delayMs);
    this.playNotifyTimers.push(timer);
  }

  private stopPlayback() {
    this.streamDone = false;
    this.clearPlayNotifyTimers();
    this.scheduledPlayBlockIndex = -1;
    this.clips.forEach((clip) => {
      clip.source.onended = null;
      try {
        clip.source.stop();
      } catch {
        /* already stopped */
      }
    });
    this.clips = [];
    this.held = [];
    this.nextTime = 0;
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.suspend();
    }
    const html = this.htmlAudio;
    if (html) {
      html.pause();
      html.removeAttribute("src");
      html.load();
    }
    this.htmlQueue.forEach((item) => URL.revokeObjectURL(item.url));
    this.htmlQueue = [];
    this.htmlPlaying = false;
  }

  private holdScheduledClips() {
    if (!this.ctx) {
      this.clips = [];
      return;
    }
    const now = this.ctx.currentTime;
    const remaining: HeldClip[] = [];
    const ordered = [...this.clips].sort((a, b) => a.startAt - b.startAt);
    for (const clip of ordered) {
      clip.source.onended = null;
      try {
        clip.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        clip.source.disconnect();
      } catch {
        /* already disconnected */
      }
      if (clip.startAt > now) {
        remaining.push({
          pcm: clip.pcm.slice(),
          sampleRate: clip.sampleRate,
          generation: clip.generation,
          blockIndex: clip.blockIndex,
        });
        continue;
      }
      const elapsed = Math.max(0, now - clip.startAt);
      const frac = clip.buffer.duration > 0 ? Math.min(1, elapsed / clip.buffer.duration) : 1;
      const offset = Math.min(clip.pcm.length, Math.floor(frac * clip.pcm.length));
      if (offset < clip.pcm.length - 32) {
        remaining.push({
          pcm: clip.pcm.slice(offset),
          sampleRate: clip.sampleRate,
          generation: clip.generation,
          blockIndex: clip.blockIndex,
        });
      }
    }
    this.clips = [];
    this.nextTime = now;
    this.clearPlayNotifyTimers();
    this.held = remaining.concat(this.held);
  }

  private applyHtmlPlaybackRate(audio: HTMLAudioElement) {
    const pitched = audio as HTMLAudioElement & {
      preservesPitch?: boolean;
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    pitched.preservesPitch = true;
    pitched.mozPreservesPitch = true;
    pitched.webkitPreservesPitch = true;
    audio.playbackRate = this.speed;
    audio.defaultPlaybackRate = this.speed;
  }

  private applyPlaybackSpeed() {
    if (this.htmlAudio) this.applyHtmlPlaybackRate(this.htmlAudio);
    if (!this.ctx || this.clips.length === 0) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const playing: ScheduledClip[] = [];
    const pending: ScheduledClip[] = [];
    for (const clip of this.clips) {
      if (clip.startAt <= now) playing.push(clip);
      else pending.push(clip);
    }

    const restart: Array<{
      pcm: Float32Array;
      sampleRate: number;
      generation: number;
      blockIndex?: number;
    }> = [];

    for (const clip of playing) {
      const elapsed = Math.max(0, now - clip.startAt);
      const frac = clip.buffer.duration > 0 ? Math.min(1, elapsed / clip.buffer.duration) : 1;
      const offset = Math.min(clip.pcm.length, Math.floor(frac * clip.pcm.length));
      clip.source.onended = null;
      try {
        clip.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        clip.source.disconnect();
      } catch {
        /* already disconnected */
      }
      if (offset < clip.pcm.length - 32) {
        restart.push({
          pcm: clip.pcm.subarray(offset),
          sampleRate: clip.sampleRate,
          generation: clip.generation,
          blockIndex: clip.blockIndex,
        });
      }
    }

    for (const clip of pending) {
      clip.source.onended = null;
      try {
        clip.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        clip.source.disconnect();
      } catch {
        /* already disconnected */
      }
      restart.push({
        pcm: clip.pcm,
        sampleRate: clip.sampleRate,
        generation: clip.generation,
        blockIndex: clip.blockIndex,
      });
    }

    this.clips = [];
    this.nextTime = now;
    this.clearPlayNotifyTimers();
    this.scheduledPlayBlockIndex = -1;

    for (const item of restart) {
      this.startClip(item.pcm, item.sampleRate, item.generation, item.blockIndex);
    }
  }

  private startClip(
    pcm: Float32Array,
    sampleRate: number,
    generation: number,
    blockIndex?: number,
  ) {
    const ctx = this.audioContext();
    const stretched = timeStretch(pcm, this.speed, sampleRate);
    const frames = Math.max(1, stretched.length);
    const buffer = ctx.createBuffer(1, frames, sampleRate);
    if (stretched.length > 0) {
      buffer.getChannelData(0).set(stretched.subarray(0, frames));
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 1;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.nextTime);
    if (typeof blockIndex === "number") {
      this.notifyBlockPlay(blockIndex, generation, Math.max(0, (startAt - ctx.currentTime) * 1000));
    }
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.clips.push({ source, buffer, pcm, sampleRate, startAt, generation, blockIndex });
    source.onended = () => {
      if (this.status === "paused") return;
      this.clips = this.clips.filter((item) => item.source !== source);
      this.maybeFinishUtterance(generation);
    };
  }

  private playChunkWeb(
    audio: Float32Array,
    sampleRate: number,
    generation: number,
    blockIndex?: number,
  ) {
    const ctx = this.audioContext();
    if (ctx.state === "suspended" && this.status !== "paused") void ctx.resume();
    this.startClip(audio, sampleRate, generation, blockIndex);
  }

  private enqueueHtmlChunk(
    audio: Float32Array,
    sampleRate: number,
    generation: number,
    blockIndex?: number,
  ) {
    const blob = encodeWav(audio, sampleRate);
    const url = URL.createObjectURL(blob);
    this.htmlQueue.push({ url, blockIndex });
    void this.pumpHtml(generation);
  }

  private async pumpHtml(generation = this.generation) {
    if (this.htmlPlaying || this.status === "paused") return;
    const next = this.htmlQueue.shift();
    if (!next) {
      this.maybeFinishUtterance(generation);
      return;
    }
    const audio = this.ensureHtmlAudio();
    this.htmlPlaying = true;
    if (typeof next.blockIndex === "number") {
      this.notifyBlockPlay(next.blockIndex, generation);
    }
    audio.src = next.url;
    this.applyHtmlPlaybackRate(audio);
    this.syncMediaSession();
    try {
      await audio.play();
    } catch (error) {
      console.warn("[tts] HTML audio failed, switching to Web Audio", error);
      this.useHtmlFallback = false;
      URL.revokeObjectURL(next.url);
      this.htmlPlaying = false;
      void this.pumpHtml(generation);
    }
  }

  private playChunk(
    audio: Float32Array,
    sampleRate: number,
    generation: number,
    blockIndex?: number,
  ) {
    if (this.status === "paused") {
      if (this.useHtmlFallback) {
        this.enqueueHtmlChunk(audio, sampleRate, generation, blockIndex);
      } else {
        this.held.push({ pcm: audio, sampleRate, generation, blockIndex });
      }
      return;
    }
    if (this.useHtmlFallback) {
      this.enqueueHtmlChunk(audio, sampleRate, generation, blockIndex);
      return;
    }
    try {
      this.playChunkWeb(audio, sampleRate, generation, blockIndex);
    } catch (error) {
      console.warn("[tts] Web Audio failed, trying HTML fallback", error);
      this.useHtmlFallback = true;
      this.enqueueHtmlChunk(audio, sampleRate, generation, blockIndex);
    }
  }

  private onMessage(data: {
    type: string;
    voices?: VoiceInfo[];
    device?: "webgpu" | "wasm";
    blockIndex?: number;
    text?: string;
    progress?: ProgressInfo;
    audio?: Float32Array;
    sampleRate?: number;
    generation?: number;
    message?: string;
  }) {
    if (data.type === "progress") {
      const file = data.progress?.file ? ` ${data.progress.file}` : "";
      const rawPct = data.progress?.progress;
      // transformers reports 0–100; guard against a 0–1 fraction if a caller slips through
      const pct =
        typeof rawPct === "number"
          ? Math.round(rawPct > 0 && rawPct <= 1 ? rawPct * 100 : Math.min(100, Math.max(0, rawPct)))
          : null;
      const pctLabel = pct !== null ? ` ${pct}%` : "";

      if (data.progress?.status === "cache") {
        this.downloadLabel = `Using cached${file}${pctLabel}`;
      } else if (data.progress?.status === "done") {
        this.downloadLabel = pct !== null && pct < 100 ? `Downloading Kokoro${pctLabel}` : `Loaded Kokoro${file}`;
      } else if (data.progress?.status === "initiate") {
        this.downloadLabel = `Starting Kokoro${file}…`;
      } else {
        this.downloadLabel = `Downloading Kokoro${pctLabel || file}`;
      }
      this.emit();
      return;
    }
    if (data.type === "ready") {
      this.voices = data.voices ?? [];
      this.workerReady = true;
      this.offlineReady = true;
      this.inferenceDevice = data.device ?? "wasm";
      this.downloadLabel = "";
      this.resolveReadyWaiters();
      if (this.inferenceDevice === "webgpu") {
        void setMeta("tts-inference-device", "webgpu");
      }
      void modelCacheStats().then((stats) => {
        this.cachedModelFiles = stats.files;
        this.cachedModelBytes = stats.bytes;
        this.emit();
      });
      if (this.pendingSequence) {
        const { texts, meta, callbacks } = this.pendingSequence;
        this.pendingSequence = null;
        this.onSectionBlockPlay = callbacks?.onBlockPlay ?? null;
        this.onSectionBlockLoading = callbacks?.onBlockLoading ?? null;
        this.scheduledPlayBlockIndex = -1;
        this.sequenceTexts = texts;
        this.currentText = texts[0] ?? "";
        this.streamDone = false;
        this.status = "preparing";
        this.emit();
        void this.requestWakeLock();
        if (meta) this.setMediaMeta(meta);
        this.worker?.postMessage({
          type: "speakSequence",
          texts,
          voice: this.voice,
          generation: this.generation,
        });
      } else if (this.pendingText) {
        const text = this.pendingText;
        const meta = this.pendingMeta;
        this.pendingText = null;
        this.pendingMeta = null;
        this.streamDone = false;
        this.status = "preparing";
        this.emit();
        void this.requestWakeLock();
        if (meta) this.setMediaMeta(meta);
        this.worker?.postMessage({
          type: "speak",
          text,
          voice: this.voice,
          generation: this.generation,
        });
      } else {
        this.status = "ready";
        this.emit();
      }
      return;
    }
    if (data.type === "error") {
      if (data.generation !== undefined && data.generation !== this.generation) return;
      this.error = data.message ?? "Kokoro failed";
      this.status = "error";
      this.rejectWaiters(false);
      this.emit();
      return;
    }
    if (data.generation !== undefined && data.generation !== this.generation) return;
    if (data.type === "blockLoading") {
      const blockIndex = data.blockIndex ?? 0;
      this.onSectionBlockLoading?.(blockIndex);
      return;
    }
    if (data.type === "blockStart") {
      // Text/title updates on actual playback via notifyBlockPlay — not here,
      // where the next preloaded block becomes ready ahead of audio.
      if (this.status !== "paused" && this.status !== "speaking") {
        this.status = "preparing";
        this.emit();
      }
      return;
    }
    if (data.type === "chunk" && data.audio && data.sampleRate) {
      const generation = data.generation ?? this.generation;
      const samples = new Float32Array(data.audio);
      if (samples.length === 0) return;
      if (this.status !== "paused") {
        this.status = "speaking";
        this.syncMediaSession();
      }
      this.playChunk(samples, data.sampleRate, generation, data.blockIndex);
      this.emit();
      return;
    }
    if (data.type === "done") {
      const generation = data.generation ?? this.generation;
      if (generation !== this.generation) return;
      this.streamDone = true;
      this.maybeFinishUtterance(generation);
    }
  }
}

export const ttsEngine = new TtsEngine();
