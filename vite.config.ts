import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

const root = path.dirname(fileURLToPath(import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["samples/little-test-book.epub", "tauri.svg"],
      manifest: {
        name: "Bookworm",
        short_name: "Bookworm",
        description: "Private EPUB library with on-device speech",
        theme_color: "#9c3b2a",
        background_color: "#ebe1d0",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "tauri.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,svg,woff2,epub,wasm}"],
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              /huggingface\.co$|\.huggingface\.co$|\.hf\.co$|cdn-lfs|xethub\.hf\.co|jsdelivr\.net|unpkg\.com/.test(
                url.hostname,
              ),
            handler: "CacheFirst",
            options: {
              cacheName: "bookworm-model-cdn",
              expiration: {
                maxEntries: 80,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: ({ request }) => request.destination === "font",
            handler: "CacheFirst",
            options: {
              cacheName: "bookworm-fonts",
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  worker: {
    format: "es" as const,
  },
  resolve: {
    alias: {
      // Force the browser build so Node path/fs imports are not pulled into the worker.
      "kokoro-js": path.resolve(root, "node_modules/kokoro-js/dist/kokoro.web.js"),
    },
  },
  optimizeDeps: {
    exclude: ["kokoro-js"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
