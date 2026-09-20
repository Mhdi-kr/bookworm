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

/** Live blob: URLs for IndexedDB-backed books in this tab. */
const webObjectUrls = new Map<string, { library?: string; cover?: string }>();

function titleFromFilename(name: string) {
  return name.replace(/\.epub$/i, "").replace(/[_-]+/g, " ").trim() || name;
}

function pickBookFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".epub,.EPUB,application/epub+zip";
    input.multiple = true;
    input.setAttribute("aria-hidden", "true");
    input.tabIndex = -1;
    // Safari ignores click() on a file input that is not in the document, and
    // iOS Safari often skips display:none inputs too.
    Object.assign(input.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "1px",
      height: "1px",
      opacity: "0",
    });
    document.body.appendChild(input);

    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => finish([]));
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
  const bytes = new Uint8Array(await file.arrayBuffer());
  let meta;
  try {
    const forMeta = new Uint8Array(bytes.byteLength);
    forMeta.set(bytes);
    meta = await readEpubMetadata(forMeta.buffer);
  } catch {
    meta = null;
  }
  const storedCopy = new Uint8Array(bytes.byteLength);
  storedCopy.set(bytes);
  const epubBlob = new Blob([storedCopy], { type: file.type || "application/epub+zip" });
  const coverBlob = meta?.coverBlob ?? null;
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
    coverBlob,
    coverSource: coverBlob ? "file" : null,
    pageCount: meta?.pageCount ?? null,
    addedAt: now,
    lastOpenedAt: null,
    updatedAt: now,
    progress: null,
    epubBlob,
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

/** Import EPUB File objects (file picker, drag-and-drop, or OS file handler). */
export async function importFromFiles(files: File[]): Promise<Book[]> {
  const imported: Book[] = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".epub")) continue;
    imported.push(await bookFromFile(file));
  }
  if (!imported.length && files.length) {
    throw new Error("Only EPUB files are supported.");
  }
  return imported;
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
  return importFromFiles(await pickBookFiles());
}

export async function listBooks() {
  if (!isTauri()) {
    const stored = await listStoredBooks();
    return stored.map(bookFromStored).sort((a, b) => b.addedAt - a.addedAt);
  }
  const books = await invoke<Book[]>("list_books");
  return books.filter((book) => book.format === "epub");
}

export async function openBook(id: string) {
  if (!isTauri()) {
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
    revokeWebUrls(id);
    await deleteStoredBook(id);
    return;
  }
  return invoke<void>("delete_book", { id });
}

export async function saveProgress(id: string, progress: Book["progress"]) {
  if (!isTauri()) {
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
