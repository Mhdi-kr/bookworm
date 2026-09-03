# Bookworm

A native Tauri reader for PDF and EPUB books. Import a file, keep its metadata and cover in a local library, read in a paper-like UI, and speak selected or highlighted text with Kokoro TTS.

## Features

- Import PDF / EPUB into a local SQLite library
- Extract file metadata and covers, then enrich from Open Library / Google Books
- EPUB and PDF readers with themes, progress, and saved highlights
- Kokoro TTS (local ONNX via `kokoro-js`) for selected or highlighted text

## Run

```bash
npm install
npm run tauri:dev
```

Requires Rust and Node.js. The first time you use Speak, Kokoro downloads its ONNX model locally (then it is cached).

Optional debug import on launch:

```bash
BOOKWORM_IMPORT="/path/to/book.epub:/path/to/book.pdf" npm run tauri:dev
```
