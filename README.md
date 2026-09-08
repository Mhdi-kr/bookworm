# Bookworm

A native Tauri reader for PDF and EPUB books. Import a file, keep its metadata and cover in a local library, read in a paper-like UI, and speak selected text with Kokoro TTS.

## Run

```bash
pnpm install
pnpm run tauri:dev
```

Requires Rust and Node.js. The first time you use Speak, Kokoro downloads its ONNX model locally (then it is cached).

Optional debug import on launch:

```bash
BOOKWORM_IMPORT="/path/to/book.epub" pnpm run tauri:dev
```