import { useEffect, useState } from "react";
import { fileSrc } from "../lib/api";
import type { Book } from "../types";

export function Cover({ book, className = "" }: { book: Book; className?: string }) {
  const src = book.coverPath ? fileSrc(book.coverPath, book.updatedAt) : null;
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(src) && !imageFailed;
  const initial = (book.title.trim()[0] || "B").toUpperCase();

  useEffect(() => {
    setImageFailed(false);
  }, [src]);

  return (
    <div className={`relative overflow-hidden bg-oxblood text-sepia ${className}`}>
      {showImage ? (
        <img
          key={src}
          src={src ?? undefined}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full flex-col justify-between p-4">
          <p className="font-serif text-5xl opacity-80">{initial}</p>
          <p className="font-serif text-sm leading-snug">{book.title}</p>
        </div>
      )}
    </div>
  );
}
