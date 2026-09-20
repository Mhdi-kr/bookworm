import { isTauri } from "@tauri-apps/api/core";
import { requestPersistentStorage } from "./idb";
import { captureInstallPrompt, prefetchRuntimeAssets } from "./pwa";

/** Register the Vite PWA service worker for browser-only offline shell + CDN caching. */
export async function registerWebOffline(): Promise<void> {
  if (isTauri()) return;

  captureInstallPrompt();
  void requestPersistentStorage();

  if (!("serviceWorker" in navigator)) return;

  try {
    const { registerSW } = await import("virtual:pwa-register");
    registerSW({
      immediate: true,
      onRegisteredSW(swUrl: string) {
        console.info("[bookworm] service worker ready", swUrl);
        void prefetchRuntimeAssets();
      },
      onOfflineReady() {
        console.info("[bookworm] ready to work offline");
        void prefetchRuntimeAssets();
      },
      onRegisterError(error: unknown) {
        console.warn("[bookworm] service worker failed", error);
      },
    });
  } catch (error) {
    console.warn("[bookworm] PWA register unavailable", error);
  }

  if (navigator.serviceWorker.controller) {
    void prefetchRuntimeAssets();
  }
}
