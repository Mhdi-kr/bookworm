import { useEffect, useState } from "react";
import { Library } from "./components/Library";
import { Reader } from "./components/Reader";
import { BottomBars } from "./components/BottomBars";
import { isWebKit } from "./lib/browser";
import { ttsEngine } from "./lib/tts/engine";
import type { Book } from "./types";

export default function App() {
  const [book, setBook] = useState<Book | null>(null);

  useEffect(() => {
    // WebKit freezes the tab if we compile the 90MB+ voice model during first paint.
    if (isWebKit()) return;
    ttsEngine.warmup();
  }, []);

  return (
    <div className="h-full">
      {book ? (
        <Reader book={book} onBack={() => setBook(null)} />
      ) : (
        <Library onOpen={setBook} />
      )}
      <BottomBars />
    </div>
  );
}
