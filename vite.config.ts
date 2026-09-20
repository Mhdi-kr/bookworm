import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

const root = path.dirname(fileURLToPath(import.meta.url));

const ORT_WASM_FILES = [
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
] as const;

/** Serve/emit ORT wasm next to bundled kokoro.web.js — Vite does not rewrite new URL() inside that file. */
function copyOrtWasm(): Plugin {
  const srcDir = path.resolve(root, "node_modules/@huggingface/transformers/dist");

  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split("?")[0] ?? "";
    const name = ORT_WASM_FILES.find((file) => url.endsWith(`/${file}`));
    if (!name) {
      next();
      return;
    }
    const file = path.join(srcDir, name);
    res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    fs.createReadStream(file).pipe(res);
  };

  return {
    name: "copy-ort-wasm",
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
    generateBundle() {
      for (const name of ORT_WASM_FILES) {
        this.emitFile({
          type: "asset",
          fileName: `assets/${name}`,
          source: fs.readFileSync(path.join(srcDir, name)),
        });
      }
    },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// GitHub Pages project sites need a subpath (e.g. /bookworm/). Tauri/dev stay at /.
// @ts-expect-error process is a nodejs global
const base = process.env.BASE_PATH || "/";

export default defineConfig(async () => ({
  base,
  plugins: [
    react(),
    tailwindcss(),
    copyOrtWasm(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["tauri.svg"],
      manifest: {
        name: "Bookworm",
        short_name: "Bookworm",
        description: "Private EPUB library with on-device speech",
        theme_color: "#1f6b62",
        background_color: "#e3e9e6",
        display: "standalone",
        start_url: "./",
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
        globPatterns: ["**/*.{js,css,html,ico,svg,woff2}"],
        // kokoro.web.js is ~2.1 MiB; default precache cap is 2 MiB.
        // Do not precache the 21 MiB ORT wasm — Safari SW install would stall.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: "index.html",
        // Safari has classified module-worker fetches as navigations; don't serve HTML.
        navigateFallbackDenylist: [/\.[a-zA-Z0-9]+$/i],
        runtimeCaching: [
          // Do NOT CacheFirst Hugging Face / LFS model files in the service worker.
          // Those are 90–300MB; Safari's Cache API + clone races hang first download
          // (UI freezes on "Downloading Kokoro tokenizer.json"). Offline models go
          // through IndexedDB via installModelFetchCache instead.
          {
            urlPattern: ({ url }) => url.pathname.endsWith(".wasm"),
            handler: "CacheFirst",
            options: {
              cacheName: "bookworm-wasm",
              expiration: {
                maxEntries: 8,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
          {
            urlPattern: ({ request }) => request.destination === "font",
            handler: "CacheFirst",
            options: {
              cacheName: "bookworm-fonts",
              expiration: {
                maxEntries: 40,
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
