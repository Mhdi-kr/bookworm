/// <reference lib="webworker" />

import { isWebKit } from "../browser";
import { installModelFetchCache, preloadModelCacheIntoMemory } from "../offline/idb";
import type { VoiceInfo } from "../../types";
import { AudioLruCache } from "./audioCache";
import { splitForTts, ttsCacheKey } from "./split";

type Incoming =
  | { type: "init"; preferredDevice?: "webgpu" | "wasm" }
  | { type: "prefetch"; text: string; voice: string; prefetchId: number }
  | { type: "speak"; text: string; voice: string; generation: number }
  | {
      type: "speakSequence";
      texts: string[];
      voice: string;
      generation: number;
    }
  | { type: "cancel"; generation: number };

type SynthesizedChunk = {
  text: string;
  audio: Float32Array;
  sampleRate: number;
};

type VoiceMeta = {
  name: string;
  language: string;
  gender: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tts: any = null;
let initDone = false;
let initInProgress = false;
let inferenceDevice: "webgpu" | "wasm" = "wasm";
let cachedVoices: VoiceInfo[] = [];
let activeGeneration = 0;
let speakRunId = 0;
let speakChain: Promise<void> = Promise.resolve();
let cacheReady = false;
let activePrefetchId = 0;
const audioLru = new AudioLruCache();
const inflight = new Map<string, Promise<SynthesizedChunk>>();

const WEBGPU_ADAPTER_TIMEOUT_MS = 5_000;

/** Approximate sizes when Content-Length is missing (HF LFS redirects). */
const KNOWN_FILE_BYTES: Record<string, number> = {
  "model_quantized.onnx": 92 * 1024 * 1024,
  "model.onnx": 325 * 1024 * 1024,
  "tokenizer.json": 3.5 * 1024,
  "tokenizer_config.json": 128,
  "config.json": 2 * 1024,
  "voices.bin": 14 * 1024 * 1024,
};

type FileByteProgress = { loaded: number; total: number };

function fileBaseName(path: string): string {
  return path.split("/").pop() || path;
}

function estimateTotal(file: string, reported: number): number {
  if (reported > 0) return reported;
  const base = fileBaseName(file);
  return KNOWN_FILE_BYTES[base] ?? 0;
}

/** Aggregate multi-file download progress into a single 0–100 percentage. */
function createProgressAggregator() {
  const files = new Map<string, FileByteProgress>();
  let lastPostedPct = -1;
  let lastPostedAt = 0;

  function overallPct(): number | null {
    let loaded = 0;
    let total = 0;
    for (const entry of files.values()) {
      loaded += entry.loaded;
      total += entry.total > 0 ? entry.total : entry.loaded;
    }
    if (total <= 0) return null;
    return Math.min(100, Math.max(0, (loaded / total) * 100));
  }

  function track(progress: {
    status?: string;
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
  }) {
    const file = progress.file;
    if (!file) return { overall: overallPct(), file: undefined as string | undefined };

    const key = fileBaseName(file);
    const prev = files.get(key) ?? { loaded: 0, total: 0 };

    if (progress.status === "initiate" || progress.status === "download") {
      files.set(key, {
        loaded: 0,
        total: estimateTotal(file, progress.total ?? prev.total),
      });
    } else if (progress.status === "progress") {
      const loaded = typeof progress.loaded === "number" ? progress.loaded : prev.loaded;
      let total = estimateTotal(file, progress.total ?? prev.total);
      const known = KNOWN_FILE_BYTES[key];
      // hub.js without Content-Length sets total === loaded every chunk → fake 100%.
      if (known && loaded < known && (total <= loaded || total === 0)) {
        total = known;
      } else if (total < loaded) {
        total = loaded;
      }
      files.set(key, { loaded, total });
    } else if (progress.status === "done" || progress.status === "cache") {
      const total = Math.max(prev.total, prev.loaded, estimateTotal(file, 0));
      files.set(key, { loaded: total, total });
    }

    return { overall: overallPct(), file: key };
  }

  function shouldPost(pct: number | null): boolean {
    const now = Date.now();
    if (pct === null) return true;
    const rounded = Math.round(pct);
    if (rounded === lastPostedPct && now - lastPostedAt < 200) return false;
    if (rounded !== 100 && Math.abs(rounded - lastPostedPct) < 1 && now - lastPostedAt < 150) {
      return false;
    }
    lastPostedPct = rounded;
    lastPostedAt = now;
    return true;
  }

  return { track, shouldPost };
}

function enqueueSpeak(task: () => Promise<void>) {
  speakChain = speakChain.then(task).catch(() => {});
}

function postChunk(
  generation: number,
  text: string,
  raw: { audio: ArrayLike<number>; sampling_rate: number },
  blockIndex?: number,
) {
  const audio = new Float32Array(raw.audio);
  self.postMessage(
    {
      type: "chunk",
      generation,
      text,
      sampleRate: raw.sampling_rate,
      audio,
      ...(blockIndex !== undefined ? { blockIndex } : {}),
    },
    { transfer: [audio.buffer] },
  );
}

/** Skip Cache API writes for huge ONNX bodies — Safari hangs on Cache.put of 90–300MB. */
function softenCacheApi() {
  if (!("Cache" in self)) return;
  const origPut = Cache.prototype.put;
  Cache.prototype.put = function put(request, response) {
    try {
      const url =
        typeof request === "string"
          ? request
          : request instanceof Request
            ? request.url
            : request instanceof URL
              ? request.href
              : "";
      const length = Number(response.headers.get("content-length") || 0);
      if (/\.onnx(\?|$)/i.test(url) || length > 16 * 1024 * 1024) {
        return Promise.resolve();
      }
    } catch {
      /* fall through to native put */
    }
    return origPut.call(this, request, response).catch(() => undefined);
  };
}

function wasmAssetDir(): string {
  return new URL("assets/", new URL(import.meta.env.BASE_URL, self.location.origin)).href;
}

async function loadTts(device: "webgpu" | "wasm") {
  const { KokoroTTS, env } = await import("kokoro-js");
  env.wasmPaths = wasmAssetDir();
  const aggregator = createProgressAggregator();
  return KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: device === "webgpu" ? "fp32" : "q8",
    device,
    progress_callback: (progress: {
      status?: string;
      file?: string;
      progress?: number;
      loaded?: number;
      total?: number;
    }) => {
      const { overall, file } = aggregator.track(progress);
      if (!aggregator.shouldPost(overall) && progress.status === "progress") return;
      const status =
        progress.status === "done"
          ? "done"
          : progress.status === "initiate"
            ? "initiate"
            : progress.status === "cache"
              ? "cache"
              : "download";
      self.postMessage({
        type: "progress",
        progress: {
          status,
          file: file ?? progress.file,
          progress: overall ?? progress.progress,
          loaded: progress.loaded,
          total: progress.total,
        },
      });
    },
  });
}

/** Cheap probe — do not wrap the 300MB+ model download in a short timeout. */
async function webGpuAdapterAvailable(): Promise<boolean> {
  // WorkerNavigator.gpu typings vary by TS lib; probe at runtime.
  const gpu = (self.navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } })
    ?.gpu;
  if (!gpu) return false;
  try {
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), WEBGPU_ADAPTER_TIMEOUT_MS);
      }),
    ]);
    return adapter != null;
  } catch {
    return false;
  }
}

async function initTts(preferred?: "webgpu" | "wasm"): Promise<"webgpu" | "wasm"> {
  // Safari / iOS WebGPU + fp32 (~325MB) is unreliable; prefer quantized WASM unless
  // the user already succeeded with WebGPU on this device.
  if (preferred === "wasm" || (preferred !== "webgpu" && isWebKit())) {
    self.postMessage({
      type: "progress",
      progress: { status: "initiate", file: "CPU · WASM" },
    });
    tts = await loadTts("wasm");
    return "wasm";
  }

  const canWebGpu = preferred === "webgpu" || (await webGpuAdapterAvailable());
  if (canWebGpu) {
    try {
      self.postMessage({
        type: "progress",
        progress: { status: "initiate", file: "GPU · WebGPU" },
      });
      // No wall-clock timeout around from_pretrained — first GitHub Pages fetch of
      // model.onnx is ~325MB and routinely exceeds 90s, which used to false-fallback to WASM.
      tts = await loadTts("webgpu");
      return "webgpu";
    } catch (error) {
      console.warn("[tts] WebGPU init failed, falling back to WASM", error);
      self.postMessage({
        type: "progress",
        progress: { status: "initiate", file: "CPU · WASM (WebGPU failed)" },
      });
      tts = await loadTts("wasm");
      return "wasm";
    }
  }

  self.postMessage({
    type: "progress",
    progress: { status: "initiate", file: "CPU · WASM" },
  });
  tts = await loadTts("wasm");
  return "wasm";
}

async function warmInference() {
  try {
    await tts.generate("Hello.", { voice: "af_heart", speed: 1 });
  } catch {
    /* optional graph warmup */
  }
}

function voicesFromModel(): VoiceInfo[] {
  return Object.entries(tts.voices as Record<string, VoiceMeta>).map(([id, info]) => ({
    id,
    name: info.name,
    language: info.language,
    gender: info.gender,
  }));
}

function postReady() {
  self.postMessage({ type: "ready", voices: cachedVoices, device: inferenceDevice });
}

async function synthesizePart(part: string, voice: string): Promise<SynthesizedChunk> {
  const key = ttsCacheKey(part, voice);
  const hit = audioLru.get(key);
  if (hit) {
    return { text: part, audio: hit.audio, sampleRate: hit.sampleRate };
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const raw = await tts.generate(part, { voice: voice as "af_heart", speed: 1 });
    const chunk: SynthesizedChunk = {
      text: part,
      audio: new Float32Array(raw.audio),
      sampleRate: raw.sampling_rate,
    };
    audioLru.set(key, { audio: chunk.audio, sampleRate: chunk.sampleRate });
    return chunk;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}

async function synthesizeBlock(text: string, voice: string): Promise<SynthesizedChunk[]> {
  const chunks: SynthesizedChunk[] = [];
  for (const part of splitForTts(text)) {
    chunks.push(await synthesizePart(part, voice));
  }
  return chunks;
}

function isFullyCached(text: string, voice: string): boolean {
  const parts = splitForTts(text);
  return parts.length > 0 && parts.every((part) => audioLru.has(ttsCacheKey(part, voice)));
}

async function speakSequencePipelined(
  texts: string[],
  voice: string,
  generation: number,
  runId: number,
) {
  if (!texts.length) return;

  let nextPromise = synthesizeBlock(texts[0], voice);
  for (let blockIndex = 0; blockIndex < texts.length; blockIndex += 1) {
    if (runId !== speakRunId || activeGeneration !== generation) return;
    const chunks = await nextPromise;
    if (blockIndex + 1 < texts.length) {
      const nextText = texts[blockIndex + 1];
      if (!isFullyCached(nextText, voice)) {
        self.postMessage({
          type: "blockLoading",
          generation,
          blockIndex: blockIndex + 1,
        });
      }
      nextPromise = synthesizeBlock(nextText, voice);
    }
    self.postMessage({
      type: "blockStart",
      generation,
      blockIndex,
      text: texts[blockIndex],
    });
    for (const chunk of chunks) {
      if (runId !== speakRunId || activeGeneration !== generation) return;
      postChunk(
        generation,
        chunk.text,
        {
          audio: chunk.audio,
          sampling_rate: chunk.sampleRate,
        },
        blockIndex,
      );
    }
  }
}

async function synthesizeParts(
  parts: string[],
  voice: string,
  generation: number,
  runId: number,
  startIndex = 0,
) {
  for (let index = startIndex; index < parts.length; index += 1) {
    if (runId !== speakRunId || activeGeneration !== generation) return;
    const part = parts[index];
    const chunk = await synthesizePart(part, voice);
    if (runId !== speakRunId || activeGeneration !== generation) return;
    postChunk(generation, part, {
      audio: chunk.audio,
      sampling_rate: chunk.sampleRate,
    });
  }
}

async function ensureCache() {
  if (cacheReady) return;
  softenCacheApi();
  await installModelFetchCache({
    onCacheHit: (url) => {
      const file = url.split("/").pop() || url;
      self.postMessage({
        type: "progress",
        progress: { status: "cache", file: `${file} (cached)`, progress: 100 },
      });
    },
    onCacheMiss: (url) => {
      const file = url.split("/").pop() || url;
      self.postMessage({
        type: "progress",
        progress: { status: "download", file, progress: 0 },
      });
    },
  });
  cacheReady = true;
}

self.onmessage = async (event: MessageEvent<Incoming>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      if (initDone && tts) {
        postReady();
        return;
      }
      if (initInProgress) return;
      initInProgress = true;
      try {
        await ensureCache();
        // Loading every cached ONNX blob into the worker heap on boot OOMs Safari.
        if (!isWebKit()) {
          await preloadModelCacheIntoMemory();
        }
        inferenceDevice = await initTts(message.preferredDevice);
        await warmInference();
        cachedVoices = voicesFromModel();
        initDone = true;
        postReady();
      } finally {
        initInProgress = false;
      }
      return;
    }

    if (message.type === "cancel") {
      activeGeneration = message.generation;
      speakRunId += 1;
      return;
    }

    if (message.type === "prefetch") {
      if (!tts) return;
      const prefetchId = message.prefetchId;
      activePrefetchId = prefetchId;
      const first = splitForTts(message.text)[0];
      if (!first) return;
      try {
        await synthesizePart(first, message.voice);
        if (prefetchId !== activePrefetchId) return;
        self.postMessage({
          type: "prefetched",
          prefetchId,
          key: ttsCacheKey(message.text, message.voice),
        });
      } catch {
        /* hover prefetch is best-effort */
      }
      return;
    }

    if (message.type === "speakSequence") {
      activeGeneration = message.generation;
      speakRunId += 1;
      const runId = speakRunId;
      const generation = message.generation;
      const texts = message.texts;
      const voice = message.voice;
      enqueueSpeak(async () => {
        try {
          if (!tts) throw new Error("Kokoro is not ready");
          await speakSequencePipelined(texts, voice, generation, runId);
          if (runId === speakRunId && activeGeneration === generation) {
            self.postMessage({ type: "done", generation });
          }
        } catch (error) {
          if (runId !== speakRunId || activeGeneration !== generation) return;
          self.postMessage({
            type: "error",
            generation,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
      return;
    }

    if (message.type === "speak") {
      activeGeneration = message.generation;
      speakRunId += 1;
      const runId = speakRunId;
      const generation = message.generation;
      const text = message.text;
      const voice = message.voice;
      enqueueSpeak(async () => {
        try {
          if (!tts) throw new Error("Kokoro is not ready");
          if (runId !== speakRunId || activeGeneration !== generation) return;

          await synthesizeParts(splitForTts(text), voice, generation, runId, 0);

          if (runId === speakRunId && activeGeneration === generation) {
            self.postMessage({ type: "done", generation });
          }
        } catch (error) {
          if (runId !== speakRunId || activeGeneration !== generation) return;
          self.postMessage({
            type: "error",
            generation,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
      return;
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
