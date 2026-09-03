import { fileSrc } from "../lib/api";
import type { Book } from "../types";

export function Cover({ book, className = "" }: { book: Book; className?: string }) {
  const src = book.coverPath ? fileSrc(book.coverPath, book.updatedAt) : null;
  const initial = (book.title.trim()[0] || "B").toUpperCase();
  return (
    <div className={`relative overflow-hidden bg-oxblood text-sepia ${className}`}>
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col justify-between p-4">
          <p className="font-serif text-5xl opacity-80">{initial}</p>
          <p className="font-serif text-sm leading-snug">{book.title}</p>
        </div>
      )}
    </div>
  );
}
