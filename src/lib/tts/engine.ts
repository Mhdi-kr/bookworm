import type { VoiceInfo } from "../../types";
import { getMeta, modelCacheStats, preloadModelCacheIntoMemory, requestPersistentStorage, setMeta } from "../offline/idb";
import KokoroWorker from "./kokoro.worker.ts?worker";
import { ttsCacheKey } from "./split";
import { encodeWav } from "./wav";

type Status = "idle" | "loading" | "preparing" | "ready" | "speaking" | "paused" | "error";

type Listener = () => void;

type ProgressInfo = {
  status?: string;
  file?: string;
  progress?: number;
};

type MediaMeta = {
  title?: string;
  artist?: string;
  album?: string;
};

/**
 * Kokoro TTS playback: Web Audio for reliable output, HTMLAudio fallback for
 * lock-screen / Media Session on mobile webviews.
 */
export class TtsEngine {
  private worker: Worker | null = null;
  private listeners = new Set<Listener>();
  private generation = 0;
  private pendingText: string | null = null;
  private pendingMeta: MediaMeta | null = null;
  private workerReady = false;
  private ctx: AudioContext | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private nextTime = 0;
  private htmlAudio: HTMLAudioElement | null = null;
  private htmlQueue: string[] = [];
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
    onBlockStart?: (index: number) => void;
  } | null = null;
  private onSectionBlockStart: ((index: number) => void) | null = null;
  version = 0;

  status: Status = "idle";
  error: string | null = null;
  voices: VoiceInfo[] = [];
  voice = "af_heart";
  speed = 1;
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

  /** Call from a user gesture (Speak / Play book) to satisfy autoplay policies. */
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
    const [stats, , preferredDevice] = await Promise.all([
      modelCacheStats(),
      preloadModelCacheIntoMemory(),
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
      this.error = event.message || "Kokoro worker failed to start";
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
    const key = ttsCacheKey(trimmed, this.voice, this.speed);
    if (this.prefetchKey === key) return;
    this.prefetchKey = key;
    this.prefetchId += 1;
    this.worker?.postMessage({
      type: "prefetch",
      text: trimmed,
      voice: this.voice,
      speed: this.speed,
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
    this.onSectionBlockStart = null;
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
    this.emit();

    const result = new Promise<boolean>((resolve) => {
      this.waiters.set(generation, resolve);
    });

    if (!this.workerReady) {
      this.pendingText = trimmed;
      this.pendingMeta = meta ?? null;
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
      speed: this.speed,
      generation,
    });
    return result;
  }

  async speakSequence(
    texts: string[],
    meta?: MediaMeta,
    onBlockStart?: (index: number) => void,
  ): Promise<boolean> {
    const trimmed = texts.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!trimmed.length) return true;

    const generation = this.interrupt(false);
    this.onSectionBlockStart = onBlockStart ?? null;
    this.currentText = trimmed[0];
    this.error = null;
    if (meta) this.setMediaMeta(meta);
    this.emit();

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
        speed: this.speed,
        generation,
      });
    };

    if (!this.workerReady) {
      this.pendingSequence = { texts: trimmed, meta: meta ?? null, onBlockStart };
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
    if (this.status === "preparing") {
      this.generation += 1;
      this.worker?.postMessage({ type: "cancel", generation: this.generation });
      this.rejectWaiters(false);
      this.streamDone = false;
    }
    void this.audioContext().suspend();
    this.htmlAudio?.pause();
    this.status = "paused";
    this.syncMediaSession();
    this.emit();
  }

  async resume() {
    if (this.status !== "paused") return;
    await this.unlockAudio();
    void this.audioContext().resume();
    if (this.useHtmlFallback) void this.pumpHtml();
    this.status = "speaking";
    void this.requestWakeLock();
    this.syncMediaSession();
    this.emit();
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
    this.emit();
  }

  setSpeed(speed: number) {
    this.speed = speed;
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
    } else if (this.sources.length > 0) {
      return;
    }
    this.status = "ready";
    this.resolveWaiter(generation, true);
    this.onSectionBlockStart = null;
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

  private stopPlayback() {
    this.streamDone = false;
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    });
    this.sources = [];
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
    this.htmlQueue.forEach((url) => URL.revokeObjectURL(url));
    this.htmlQueue = [];
    this.htmlPlaying = false;
  }

  private playChunkWeb(audio: Float32Array, sampleRate: number, generation: number) {
    const ctx = this.audioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const buffer = ctx.createBuffer(1, audio.length, sampleRate);
    buffer.copyToChannel(audio, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.push(source);
    source.onended = () => {
      this.sources = this.sources.filter((item) => item !== source);
      this.maybeFinishUtterance(generation);
    };
  }

  private enqueueHtmlChunk(audio: Float32Array, sampleRate: number, generation: number) {
    const blob = encodeWav(audio, sampleRate);
    const url = URL.createObjectURL(blob);
    this.htmlQueue.push(url);
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
    audio.src = next;
    this.syncMediaSession();
    try {
      await audio.play();
    } catch (error) {
      console.warn("[tts] HTML audio failed, switching to Web Audio", error);
      this.useHtmlFallback = false;
      URL.revokeObjectURL(next);
      this.htmlPlaying = false;
      void this.pumpHtml(generation);
    }
  }

  private playChunk(audio: Float32Array, sampleRate: number, generation: number) {
    if (this.useHtmlFallback) {
      this.enqueueHtmlChunk(audio, sampleRate, generation);
      return;
    }
    try {
      this.playChunkWeb(audio, sampleRate, generation);
    } catch (error) {
      console.warn("[tts] Web Audio failed, trying HTML fallback", error);
      this.useHtmlFallback = true;
      this.enqueueHtmlChunk(audio, sampleRate, generation);
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
      if (data.progress?.status === "cache") {
        this.downloadLabel = `Using cached ${data.progress.file ?? "model"}`;
      } else {
        const file = data.progress?.file ? ` ${data.progress.file}` : "";
        const pct =
          typeof data.progress?.progress === "number"
            ? ` ${Math.round(data.progress.progress)}%`
            : "";
        this.downloadLabel = `Downloading Kokoro${file}${pct}`;
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
        const { texts, meta, onBlockStart } = this.pendingSequence;
        this.pendingSequence = null;
        this.onSectionBlockStart = onBlockStart ?? null;
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
          speed: this.speed,
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
          speed: this.speed,
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
    if (data.type === "blockStart") {
      const blockIndex = data.blockIndex ?? 0;
      const text = data.text ?? "";
      if (text) this.currentText = text;
      this.onSectionBlockStart?.(blockIndex);
      if (this.status !== "paused") {
        this.status = "preparing";
      }
      this.emit();
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
      this.playChunk(samples, data.sampleRate, generation);
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
