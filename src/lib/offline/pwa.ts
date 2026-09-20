import { isWebKit } from "../browser";
import { requestPersistentStorage } from "./idb";

const WASM_CACHE = "bookworm-wasm";

export const BOOKS_CHANGED_EVENT = "bookworm:books-changed";

export function notifyBooksChanged() {
  window.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

export function isIosDevice(): boolean {
  const nav = globalThis.navigator;
  if (!nav) return false;
  const ua = nav.userAgent ?? "";
  const platform = "platform" in nav ? String((nav as Navigator).platform ?? "") : "";
  return /iP(hone|ad|od)/.test(ua) || (platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const promptListeners = new Set<() => void>();

function emitPromptChange() {
  promptListeners.forEach((listener) => listener());
}

export function hasNativeInstallPrompt(): boolean {
  return deferredPrompt != null;
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  promptListeners.add(listener);
  return () => promptListeners.delete(listener);
}

export function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emitPromptChange();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    emitPromptChange();
  });
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  void requestPersistentStorage();
  if (!deferredPrompt) return "unavailable";
  const prompt = deferredPrompt;
  deferredPrompt = null;
  emitPromptChange();
  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    return outcome;
  } catch {
    return "unavailable";
  }
}

export function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

type LaunchFile = { getFile: () => Promise<File> };

export function listenForFileLaunches(handler: (files: File[]) => void): () => void {
  const queue = (
    window as Window & {
      launchQueue?: { setConsumer: (cb: (params: { files?: LaunchFile[] }) => void) => void };
    }
  ).launchQueue;
  if (!queue) return () => {};
  queue.setConsumer((params) => {
    void (async () => {
      const files: File[] = [];
      for (const handle of params.files ?? []) {
        files.push(await handle.getFile());
      }
      if (files.length) handler(files);
    })();
  });
  return () => {};
}

/** Cache the ONNX runtime files the service worker does not precache (21 MiB wasm). */
export async function prefetchRuntimeAssets(): Promise<void> {
  if (!("caches" in window)) return;
  const base = import.meta.env.BASE_URL;
  const urls = [
    `${base}assets/ort-wasm-simd-threaded.jsep.wasm`,
    `${base}assets/ort-wasm-simd-threaded.jsep.mjs`,
  ].map((path) => new URL(path, window.location.origin).href);

  try {
    const cache = await caches.open(WASM_CACHE);
    await Promise.all(
      urls.map(async (url) => {
        if (await cache.match(url)) return;
        const response = await fetch(url, { credentials: "same-origin" });
        if (response.ok) await cache.put(url, response);
      }),
    );
  } catch {
    /* first visit, private window, or missing production assets */
  }
}

export function installHelpText(): { title: string; body: string } {
  if (isIosDevice()) {
    return {
      title: "Add to Home Screen",
      body: "Tap Share, then Add to Home Screen. Bookworm opens like an app and keeps your books and voice on this device.",
    };
  }
  if (isWebKit()) {
    return {
      title: "Add to Dock",
      body: "In Safari, choose File → Add to Dock (or Share → Add to Dock). After that, Bookworm runs in its own window and works offline.",
    };
  }
  return {
    title: "Install Bookworm",
    body: "Use Install in the address bar, or your browser’s app menu. Once installed, the library and speech stay on this device even without a network.",
  };
}
