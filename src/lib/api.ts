import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Book, Highlight, Locator } from "../types";
import {
  deleteStoredBook,
  getStoredBook,
  listStoredBooks,
  putStoredBook,
  requestPersistentStorage,
  type StoredWebBook,
} from "./offline/idb";

const DEMO_BOOKS: Book[] = [
  {
    id: "demo-epub",
    format: "epub",
    title: "The Little Test Book",
    authors: ["Ada Lovelace"],
    isbn: "9780141439518",
    description: "A short sample used to verify reading and speech.",
    publisher: "Bookworm Press",
    publishedDate: null,
    language: "en",
    libraryPath: "/samples/little-test-book.epub",
    coverPath: null,
    coverSource: "file",
    pageCount: 1,
    addedAt: 0,
    lastOpenedAt: null,
    updatedAt: 0,
    progress: null,
  },
];

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

async function bookFromFile(file: File): Promise<Book> {
  if (!file.name.toLowerCase().endsWith(".epub")) {
    throw new Error(`Only EPUB files are supported (got ${file.name})`);
  }
  await requestPersistentStorage();
  const now = Date.now();
  const stored: StoredWebBook = {
    id: crypto.randomUUID(),
    format: "epub",
    title: titleFromFilename(file.name),
    authors: [],
    isbn: null,
    description: null,
    publisher: null,
    publishedDate: null,
    language: null,
    coverBlob: null,
    coverSource: null,
    pageCount: null,
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
    return [...imported, ...DEMO_BOOKS].sort((a, b) => b.addedAt - a.addedAt);
  }
  const books = await invoke<Book[]>("list_books");
  return books.filter((book) => book.format === "epub");
}

export async function openBook(id: string) {
  if (!isTauri()) {
    if (id.startsWith("demo-")) {
      const book = DEMO_BOOKS.find((item) => item.id === id);
      if (!book) throw new Error("book not found");
      return book;
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

export async function saveHighlight(bookId: string, locator: Locator, quote: string) {
  if (!isTauri()) {
    return {
      id: crypto.randomUUID(),
      bookId,
      locator,
      quote,
      createdAt: Date.now(),
    } satisfies Highlight;
  }
  return invoke<Highlight>("save_highlight", { bookId, locator, quote });
}

export async function listHighlights(_bookId: string) {
  if (!isTauri()) return [];
  return invoke<Highlight[]>("list_highlights", { bookId: _bookId });
}

export async function deleteHighlight(id: string) {
  if (!isTauri()) return;
  return invoke<void>("delete_highlight", { id });
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

export async function onBookEnriched(handler: (book: Book) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<Book>("book-enriched", (event) => handler(event.payload));
}
