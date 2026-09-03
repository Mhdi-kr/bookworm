import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useState } from "react";
import {
  deleteBook,
  importBooks,
  listBooks,
  onBookEnriched,
  openBook,
} from "../lib/api";
import type { Book } from "../types";
import { Cover } from "./Cover";

export function Library({ onOpen }: { onOpen: (book: Book) => void }) {
  const [books, setBooks] = useState<Book[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBooks(await listBooks());
  }

  useEffect(() => {
    void refresh().catch((err) => setError(String(err)));
    let unlisten: (() => void) | undefined;
    void onBookEnriched((book) => {
      if (book.format !== "epub") return;
      setBooks((current) => current.map((item) => (item.id === book.id ? book : item)));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return books;
    return books.filter((book) => {
      const hay = `${book.title} ${book.authors.join(" ")} ${book.isbn ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [books, query]);

  async function onImport() {
    setError(null);
    setBusy(true);
    try {
      const imported = await importBooks();
      if (!imported.length) return;
      for (const book of imported) {
        setBooks((current) => [book, ...current.filter((item) => item.id !== book.id)]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(event: MouseEvent, book: Book) {
    event.stopPropagation();
    if (!window.confirm(`Remove “${book.title}” from your library?`)) return;
    await deleteBook(book.id);
    setBooks((current) => current.filter((item) => item.id !== book.id));
  }

  async function handleOpen(book: Book) {
    const opened = await openBook(book.id);
    onOpen(opened);
  }

  return (
    <div className="paper-grain min-h-full px-8 pb-16 pt-10">
      <header className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-oxblood">Private library</p>
          <h1 className="mt-2 font-serif text-5xl tracking-tight">Bookworm</h1>
          <p className="mt-2 max-w-xl text-ink-soft">
            Import an EPUB — books and voice models stay on this device for offline reading.
          </p>
        </div>
        <button
          onClick={() => void onImport()}
          disabled={busy}
          className="rounded-full bg-oxblood px-5 py-2.5 text-sm font-medium text-sepia shadow-sm transition hover:bg-oxblood-dark disabled:opacity-60"
        >
          {busy ? "Importing…" : "Import EPUB"}
        </button>
      </header>

      <div className="mx-auto mt-10 max-w-6xl">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search title, author, ISBN"
          className="w-full max-w-md rounded-full border border-paper-deep bg-white/50 px-4 py-2 text-sm outline-none ring-oxblood/30 placeholder:text-ink-soft/70 focus:ring-2"
        />
        {error ? <p className="mt-3 text-sm text-oxblood">{error}</p> : null}
      </div>

      {filtered.length === 0 ? (
        <div className="mx-auto mt-24 max-w-lg text-center">
          <p className="font-serif text-3xl">An empty shelf</p>
          <p className="mt-3 text-ink-soft">
            Drop in an EPUB and Bookworm will extract its file metadata, then look up a high-quality
            cover to keep in your library.
          </p>
        </div>
      ) : (
        <ul className="mx-auto mt-10 grid max-w-6xl grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((book) => (
            <li key={book.id}>
              <button
                onClick={() => void handleOpen(book)}
                className="group w-full text-left"
              >
                <Cover
                  book={book}
                  className="cover-shadow aspect-[2/3] rounded-sm transition duration-300 group-hover:-translate-y-1"
                />
                <div className="mt-3 flex items-start justify-between gap-2">
                  <div>
                    <p className="font-serif text-lg leading-tight">{book.title}</p>
                    <p className="mt-1 text-sm text-ink-soft">
                      {book.authors.join(", ") || "Unknown author"}
                    </p>
                  </div>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => void onDelete(event, book)}
                    onKeyDown={(event: KeyboardEvent) => {
                      if (event.key === "Enter") void onDelete(event as unknown as MouseEvent, book);
                    }}
                    className="text-xs text-ink-soft/70 hover:text-oxblood"
                  >
                    Remove
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
