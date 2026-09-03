import { isTauri } from "@tauri-apps/api/core";
import { requestPersistentStorage } from "./idb";

/** Register the Vite PWA service worker for browser-only offline shell + CDN caching. */
export async function registerWebOffline(): Promise<void> {
  if (isTauri()) return;
  if (!("serviceWorker" in navigator)) return;

  void requestPersistentStorage();

  try {
    const { registerSW } = await import("virtual:pwa-register");
    registerSW({
      immediate: true,
      onRegisteredSW(swUrl: string) {
        console.info("[bookworm] service worker ready", swUrl);
      },
      onRegisterError(error: unknown) {
        console.warn("[bookworm] service worker failed", error);
      },
    });
  } catch (error) {
    console.warn("[bookworm] PWA register unavailable", error);
  }
}
