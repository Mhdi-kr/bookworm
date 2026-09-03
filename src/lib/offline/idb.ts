const DB_NAME = "bookworm-offline";
const DB_VERSION = 1;
const MODEL_STORE = "models";
const BOOK_STORE = "books";
const META_STORE = "meta";

export type CachedModelFile = {
  url: string;
  blob: Blob;
  contentType: string;
  updatedAt: number;
};

export type StoredWebBook = {
  id: string;
  format: "epub";
  title: string;
  authors: string[];
  isbn: string | null;
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  coverBlob: Blob | null;
  coverSource: string | null;
  pageCount: number | null;
  addedAt: number;
  lastOpenedAt: number | null;
  updatedAt: number;
  progress: { cfi?: string; percent?: number; page?: number } | null;
  /** Raw EPUB bytes for offline opens */
  epubBlob: Blob;
};

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

let sharedDb: Promise<IDBDatabase> | null = null;
const modelMemCache = new Map<string, CachedModelFile>();

function getSharedDb(): Promise<IDBDatabase> {
  if (sharedDb) return sharedDb;
  sharedDb = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      sharedDb = null;
      reject(request.error ?? new Error("IndexedDB open failed"));
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MODEL_STORE)) {
        db.createObjectStore(MODEL_STORE, { keyPath: "url" });
      }
      if (!db.objectStoreNames.contains(BOOK_STORE)) {
        db.createObjectStore(BOOK_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
  });
  return sharedDb;
}

function openDb(): Promise<IDBDatabase> {
  return getSharedDb();
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    /* ignore */
  }
  return false;
}

export async function getModelFile(url: string): Promise<CachedModelFile | undefined> {
  const cached = modelMemCache.get(url);
  if (cached) return cached;
  const db = await openDb();
  const record = await idbReq(
    db.transaction(MODEL_STORE, "readonly").objectStore(MODEL_STORE).get(url),
  ) as CachedModelFile | undefined;
  if (record) modelMemCache.set(url, record);
  return record;
}

export async function putModelFile(url: string, blob: Blob, contentType: string): Promise<void> {
  const record: CachedModelFile = {
    url,
    blob,
    contentType: contentType || blob.type || "application/octet-stream",
    updatedAt: Date.now(),
  };
  modelMemCache.set(url, record);
  const db = await openDb();
  await idbReq(db.transaction(MODEL_STORE, "readwrite").objectStore(MODEL_STORE).put(record));
}

/** Warm all cached model blobs into memory so worker fetch hits avoid per-file IDB reads. */
export async function preloadModelCacheIntoMemory(): Promise<{ files: number; bytes: number }> {
  const db = await openDb();
  const rows = (await idbReq(
    db.transaction(MODEL_STORE, "readonly").objectStore(MODEL_STORE).getAll(),
  )) as CachedModelFile[];
  for (const row of rows) {
    modelMemCache.set(row.url, row);
  }
  return {
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.blob.size, 0),
  };
}

export async function listCachedModelUrls(): Promise<string[]> {
  const db = await openDb();
  return await idbReq(db.transaction(MODEL_STORE, "readonly").objectStore(MODEL_STORE).getAllKeys()).then(
    (keys) => keys.map(String),
  );
}

export async function modelCacheStats(): Promise<{ files: number; bytes: number }> {
  if (modelMemCache.size > 0) {
    let bytes = 0;
    for (const row of modelMemCache.values()) bytes += row.blob.size;
    return { files: modelMemCache.size, bytes };
  }
  const db = await openDb();
  const rows = (await idbReq(
    db.transaction(MODEL_STORE, "readonly").objectStore(MODEL_STORE).getAll(),
  )) as CachedModelFile[];
  return {
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.blob.size, 0),
  };
}

/** Hosts whose GET responses should be persisted for offline TTS. */
export function isModelDownloadUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "huggingface.co" ||
      host.endsWith(".huggingface.co") ||
      host.endsWith(".hf.co") ||
      host.includes("cdn-lfs") ||
      host.includes("xethub.hf.co") ||
      host.includes("jsdelivr.net") ||
      host.includes("unpkg.com")
    );
  } catch {
    return false;
  }
}

/**
 * Patch fetch in this realm (main or worker) so Hugging Face / CDN model
 * files are served from IndexedDB when present and written on first download.
 * Must run before Kokoro/transformers start downloading.
 */
export async function installModelFetchCache(options?: {
  onCacheHit?: (url: string) => void;
  onCacheMiss?: (url: string) => void;
  onCached?: (url: string, bytes: number) => void;
}): Promise<() => void> {
  const original = globalThis.fetch.bind(globalThis);
  let installed = true;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : String(input);

    if (!installed || method !== "GET" || !isModelDownloadUrl(url)) {
      return original(input as RequestInfo, init);
    }

    const cached = await getModelFile(url).catch(() => undefined);
    if (cached) {
      options?.onCacheHit?.(url);
      return new Response(cached.blob, {
        status: 200,
        headers: {
          "Content-Type": cached.contentType,
          "X-Bookworm-Cache": "hit",
        },
      });
    }

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error(
        "Kokoro model files are not cached yet. Connect once to download them for offline use.",
      );
    }

    options?.onCacheMiss?.(url);
    const response = await original(input as RequestInfo, init);
    if (response.ok) {
      try {
        const clone = response.clone();
        const buffer = await clone.arrayBuffer();
        const contentType = response.headers.get("Content-Type") || "application/octet-stream";
        const blob = new Blob([buffer], { type: contentType });
        await putModelFile(url, blob, contentType);
        options?.onCached?.(url, buffer.byteLength);
      } catch {
        /* caching is best-effort */
      }
    }
    return response;
  };

  return () => {
    installed = false;
    globalThis.fetch = original;
  };
}

export async function listStoredBooks(): Promise<StoredWebBook[]> {
  const db = await openDb();
  const rows = (await idbReq(
    db.transaction(BOOK_STORE, "readonly").objectStore(BOOK_STORE).getAll(),
  )) as StoredWebBook[];
  return rows.sort((a, b) => b.addedAt - a.addedAt);
}

export async function getStoredBook(id: string): Promise<StoredWebBook | undefined> {
  const db = await openDb();
  return await idbReq(db.transaction(BOOK_STORE, "readonly").objectStore(BOOK_STORE).get(id));
}

export async function putStoredBook(book: StoredWebBook): Promise<void> {
  const db = await openDb();
  await idbReq(db.transaction(BOOK_STORE, "readwrite").objectStore(BOOK_STORE).put(book));
}

export async function deleteStoredBook(id: string): Promise<void> {
  const db = await openDb();
  await idbReq(db.transaction(BOOK_STORE, "readwrite").objectStore(BOOK_STORE).delete(id));
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await idbReq(db.transaction(META_STORE, "readwrite").objectStore(META_STORE).put({ key, value }));
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const row = await idbReq(db.transaction(META_STORE, "readonly").objectStore(META_STORE).get(key));
  return row?.value as T | undefined;
}
