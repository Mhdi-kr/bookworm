import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Book } from "../types";
import { readEpubMetadata } from "./epubMeta";
import {
  deleteStoredBook,
  getStoredBook,
  listStoredBooks,
  putStoredBook,
  requestPersistentStorage,
  type StoredWebBook,
} from "./offline/idb";

const DEMO_LIBRARY_PATH = "/samples/little-test-book.epub";

const DEMO_FALLBACK: Book = {
  id: "demo-epub",
  format: "epub",
  title: "The Open Page",
  authors: ["Ada Lovelace"],
  isbn: "9781990000121",
  description:
    "A short tour of Bookworm settings: type, theme, layout, voice, speed, and auto-play.",
  publisher: "Bookworm Press",
  publishedDate: "2026",
  language: "en",
  libraryPath: DEMO_LIBRARY_PATH,
  coverPath: null,
  coverSource: null,
  pageCount: 4,
  addedAt: 0,
  lastOpenedAt: null,
  updatedAt: 0,
  progress: null,
};

let demoBookPromise: Promise<Book> | null = null;

/** Live blob: URLs for IndexedDB-backed books in this tab. */
const webObjectUrls = new Map<string, { library?: string; cover?: string }>();

function titleFromFilename(name: string) {
  return name.replace(/\.epub$/i, "").replace(/[_-]+/g, " ").trim() || name;
}

function pickBookFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".epub,application/epub+zip";
    input.multiple = true;
    input.addEventListener("change", () => {
      resolve(Array.from(input.files ?? []));
    });
    input.click();
  });
}

function revokeWebUrls(id: string) {
  const urls = webObjectUrls.get(id);
  if (!urls) return;
  if (urls.library) URL.revokeObjectURL(urls.library);
  if (urls.cover) URL.revokeObjectURL(urls.cover);
  webObjectUrls.delete(id);
}

function bookFromStored(stored: StoredWebBook): Book {
  revokeWebUrls(stored.id);
  const libraryPath = URL.createObjectURL(stored.epubBlob);
  const coverPath = stored.coverBlob ? URL.createObjectURL(stored.coverBlob) : null;
  webObjectUrls.set(stored.id, {
    library: libraryPath,
    cover: coverPath ?? undefined,
  });
  return {
    id: stored.id,
    format: "epub",
    title: stored.title,
    authors: stored.authors,
    isbn: stored.isbn,
    description: stored.description,
    publisher: stored.publisher,
    publishedDate: stored.publishedDate,
    language: stored.language,
    libraryPath,
    coverPath,
    coverSource: stored.coverSource,
    pageCount: stored.pageCount,
    addedAt: stored.addedAt,
    lastOpenedAt: stored.lastOpenedAt,
    updatedAt: stored.updatedAt,
    progress: stored.progress,
  };
}

async function loadDemoBook(): Promise<Book> {
  if (!demoBookPromise) {
    demoBookPromise = (async () => {
      try {
        const response = await fetch(DEMO_LIBRARY_PATH);
        if (!response.ok) return DEMO_FALLBACK;
        const meta = await readEpubMetadata(await response.arrayBuffer());
        const coverPath = meta.coverBlob ? URL.createObjectURL(meta.coverBlob) : null;
        return {
          ...DEMO_FALLBACK,
          title: meta.title || DEMO_FALLBACK.title,
          authors: meta.authors.length ? meta.authors : DEMO_FALLBACK.authors,
          isbn: meta.isbn ?? DEMO_FALLBACK.isbn,
          description: meta.description ?? DEMO_FALLBACK.description,
          publisher: meta.publisher ?? DEMO_FALLBACK.publisher,
          publishedDate: meta.publishedDate,
          language: meta.language ?? DEMO_FALLBACK.language,
          pageCount: meta.pageCount ?? DEMO_FALLBACK.pageCount,
          coverPath,
          coverSource: coverPath ? "file" : null,
        };
      } catch {
        return DEMO_FALLBACK;
      }
    })();
  }
  return demoBookPromise;
}

async function bookFromFile(file: File): Promise<Book> {
  if (!file.name.toLowerCase().endsWith(".epub")) {
    throw new Error(`Only EPUB files are supported (got ${file.name})`);
  }
  await requestPersistentStorage();
  const now = Date.now();
  let meta;
  try {
    meta = await readEpubMetadata(await file.arrayBuffer());
  } catch {
    meta = null;
  }
  const stored: StoredWebBook = {
    id: crypto.randomUUID(),
    format: "epub",
    title: meta?.title || titleFromFilename(file.name),
    authors: meta?.authors ?? [],
    isbn: meta?.isbn ?? null,
    description: meta?.description ?? null,
    publisher: meta?.publisher ?? null,
    publishedDate: meta?.publishedDate ?? null,
    language: meta?.language ?? null,
    coverBlob: meta?.coverBlob ?? null,
    coverSource: meta?.coverBlob ? "file" : null,
    pageCount: meta?.pageCount ?? null,
    addedAt: now,
    lastOpenedAt: null,
    updatedAt: now,
    progress: null,
    epubBlob: file,
  };
  await putStoredBook(stored);
  return bookFromStored(stored);
}

export async function pickBooks(): Promise<string[]> {
  if (!isTauri()) {
    throw new Error("Use importBooks() in the browser.");
  }
  const selected = await open({
    multiple: true,
    filters: [{ name: "Books", extensions: ["epub"] }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export function importBook(path: string) {
  return invoke<Book>("import_book", { path });
}

/** Import one or more EPUBs in desktop (native dialog) or browser (file input). */
export async function importBooks(): Promise<Book[]> {
  if (isTauri()) {
    const paths = await pickBooks();
    const imported: Book[] = [];
    for (const path of paths) {
      const book = await importBook(path);
      if (book.format !== "epub") {
        throw new Error("Only EPUB files are supported right now.");
      }
      imported.push(book);
    }
    return imported;
  }
  const files = await pickBookFiles();
  const imported: Book[] = [];
  for (const file of files) {
    imported.push(await bookFromFile(file));
  }
  return imported;
}

export async function listBooks() {
  if (!isTauri()) {
    const stored = await listStoredBooks();
    const imported = stored.map(bookFromStored);
    const demo = await loadDemoBook();
    return [...imported, demo].sort((a, b) => b.addedAt - a.addedAt);
  }
  const books = await invoke<Book[]>("list_books");
  return books.filter((book) => book.format === "epub");
}

export async function openBook(id: string) {
  if (!isTauri()) {
    if (id.startsWith("demo-")) {
      return loadDemoBook();
    }
    const stored = await getStoredBook(id);
    if (!stored) throw new Error("book not found");
    stored.lastOpenedAt = Date.now();
    await putStoredBook(stored);
    return bookFromStored(stored);
  }
  const book = await invoke<Book>("open_book", { id });
  if (book.format !== "epub") throw new Error("Only EPUB files are supported right now.");
  return book;
}

export async function deleteBook(id: string) {
  if (!isTauri()) {
    if (id.startsWith("demo-")) return;
    revokeWebUrls(id);
    await deleteStoredBook(id);
    return;
  }
  return invoke<void>("delete_book", { id });
}

export async function saveProgress(id: string, progress: Book["progress"]) {
  if (!isTauri()) {
    if (id.startsWith("demo-")) return;
    const stored = await getStoredBook(id);
    if (!stored) return;
    stored.progress = progress;
    stored.updatedAt = Date.now();
    await putStoredBook(stored);
    return;
  }
  return invoke<void>("save_progress", { id, progress });
}

export async function saveCover(id: string, bytes: Uint8Array, source: string) {
  if (!isTauri()) {
    const stored = await getStoredBook(id);
    if (!stored) throw new Error("book not found");
    const copy = new Uint8Array(bytes);
    stored.coverBlob = new Blob([copy], { type: "image/jpeg" });
    stored.coverSource = source;
    stored.updatedAt = Date.now();
    await putStoredBook(stored);
    return bookFromStored(stored);
  }
  return invoke<Book>("save_cover", { id, bytes, source });
}

export function fileSrc(path: string, cacheKey?: number) {
  if (
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("blob:") ||
    path.startsWith("data:")
  ) {
    return path;
  }
  if (!isTauri()) {
    return path;
  }
  const src = convertFileSrc(path);
  return cacheKey ? `${src}${src.includes("?") ? "&" : "?"}v=${cacheKey}` : src;
}
