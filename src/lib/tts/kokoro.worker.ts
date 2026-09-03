/// <reference lib="webworker" />

import { installModelFetchCache, preloadModelCacheIntoMemory } from "../offline/idb";
import type { VoiceInfo } from "../../types";
import { splitForTts, ttsCacheKey } from "./split";

type Incoming =
  | { type: "init"; preferredDevice?: "webgpu" | "wasm" }
  | { type: "prefetch"; text: string; voice: string; speed: number; prefetchId: number }
  | { type: "speak"; text: string; voice: string; speed: number; generation: number }
  | {
      type: "speakSequence";
      texts: string[];
      voice: string;
      speed: number;
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

type PrefetchSlot = {
  key: string;
  prefetchId: number;
  first: { audio: Float32Array; sampleRate: number; text: string };
  rest: string[];
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
let prefetchSlot: PrefetchSlot | null = null;
let activePrefetchId = 0;

const WEBGPU_LOAD_TIMEOUT_MS = 90_000;

function enqueueSpeak(task: () => Promise<void>) {
  speakChain = speakChain.then(task).catch(() => {});
}

function postChunk(
  generation: number,
  text: string,
  raw: { audio: ArrayLike<number>; sampling_rate: number },
) {
  const audio = new Float32Array(raw.audio);
  self.postMessage(
    {
      type: "chunk",
      generation,
      text,
      sampleRate: raw.sampling_rate,
      audio,
    },
    { transfer: [audio.buffer] },
  );
}

async function loadTts(device: "webgpu" | "wasm") {
  const { KokoroTTS } = await import("kokoro-js");
  return KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: device === "webgpu" ? "fp32" : "q8",
    device,
    progress_callback: (progress: {
      status?: string;
      file?: string;
      progress?: number;
    }) => {
      const pct = progress.progress;
      if (typeof pct === "number" && pct < 100 && Math.floor(pct) % 5 !== 0) {
        return;
      }
      self.postMessage({ type: "progress", progress });
    },
  });
}

async function tryWebGpuWithTimeout() {
  return Promise.race([
    loadTts("webgpu"),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("webgpu-timeout")), WEBGPU_LOAD_TIMEOUT_MS);
    }),
  ]);
}

async function initTts(preferred?: "webgpu" | "wasm"): Promise<"webgpu" | "wasm"> {
  if ("gpu" in navigator) {
    try {
      tts = await tryWebGpuWithTimeout();
      return "webgpu";
    } catch {
      tts = await loadTts("wasm");
      return "wasm";
    }
  }
  if (preferred === "webgpu") {
    try {
      tts = await tryWebGpuWithTimeout();
      return "webgpu";
    } catch {
      tts = await loadTts("wasm");
      return "wasm";
    }
  }
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

async function synthesizeBlock(
  text: string,
  voice: string,
  speed: number,
): Promise<SynthesizedChunk[]> {
  const chunks: SynthesizedChunk[] = [];
  for (const part of splitForTts(text)) {
    const raw = await tts.generate(part, { voice: voice as "af_heart", speed });
    chunks.push({
      text: part,
      audio: new Float32Array(raw.audio),
      sampleRate: raw.sampling_rate,
    });
  }
  return chunks;
}

async function speakSequencePipelined(
  texts: string[],
  voice: string,
  speed: number,
  generation: number,
  runId: number,
) {
  if (!texts.length) return;

  let nextPromise = synthesizeBlock(texts[0], voice, speed);
  for (let blockIndex = 0; blockIndex < texts.length; blockIndex += 1) {
    if (runId !== speakRunId || activeGeneration !== generation) return;
    const chunks = await nextPromise;
    if (blockIndex + 1 < texts.length) {
      nextPromise = synthesizeBlock(texts[blockIndex + 1], voice, speed);
    }
    self.postMessage({
      type: "blockStart",
      generation,
      blockIndex,
      text: texts[blockIndex],
    });
    for (const chunk of chunks) {
      if (runId !== speakRunId || activeGeneration !== generation) return;
      postChunk(generation, chunk.text, {
        audio: chunk.audio,
        sampling_rate: chunk.sampleRate,
      });
    }
  }
}

async function synthesizeParts(
  parts: string[],
  voice: string,
  speed: number,
  generation: number,
  runId: number,
  startIndex = 0,
) {
  for (let index = startIndex; index < parts.length; index += 1) {
    if (runId !== speakRunId || activeGeneration !== generation) return;
    const part = parts[index];
    const raw = await tts.generate(part, { voice: voice as "af_heart", speed });
    if (runId !== speakRunId || activeGeneration !== generation) return;
    postChunk(generation, part, raw);
  }
}

async function ensureCache() {
  if (cacheReady) return;
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
        await preloadModelCacheIntoMemory();
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
      prefetchSlot = null;
      return;
    }

    if (message.type === "prefetch") {
      if (!tts) return;
      const key = ttsCacheKey(message.text, message.voice, message.speed);
      if (prefetchSlot?.key === key) return;
      const prefetchId = message.prefetchId;
      activePrefetchId = prefetchId;
      const parts = splitForTts(message.text);
      const first = parts[0];
      if (!first) return;
      try {
        const raw = await tts.generate(first, {
          voice: message.voice as "af_heart",
          speed: message.speed,
        });
        if (prefetchId !== activePrefetchId) return;
        prefetchSlot = {
          key,
          prefetchId,
          first: {
            audio: new Float32Array(raw.audio),
            sampleRate: raw.sampling_rate,
            text: first,
          },
          rest: parts.slice(1),
        };
        self.postMessage({ type: "prefetched", prefetchId, key });
      } catch {
        prefetchSlot = null;
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
      const speed = message.speed;
      prefetchSlot = null;
      enqueueSpeak(async () => {
        try {
          if (!tts) throw new Error("Kokoro is not ready");
          await speakSequencePipelined(texts, voice, speed, generation, runId);
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
      const speed = message.speed;
      const key = ttsCacheKey(text, voice, speed);
      enqueueSpeak(async () => {
        try {
          if (!tts) throw new Error("Kokoro is not ready");
          if (runId !== speakRunId || activeGeneration !== generation) return;

          const cached = prefetchSlot?.key === key ? prefetchSlot : null;
          prefetchSlot = null;

          if (cached) {
            postChunk(generation, cached.first.text, {
              audio: cached.first.audio,
              sampling_rate: cached.first.sampleRate,
            });
            await synthesizeParts(cached.rest, voice, speed, generation, runId, 0);
          } else {
            await synthesizeParts(splitForTts(text), voice, speed, generation, runId, 0);
          }

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
