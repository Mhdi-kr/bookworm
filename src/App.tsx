import { useEffect, useState } from "react";
import { Library } from "./components/Library";
import { Reader } from "./components/Reader";
import { TtsBar } from "./components/TtsBar";
import { ttsEngine } from "./lib/tts/engine";
import type { Book } from "./types";

export default function App() {
  const [book, setBook] = useState<Book | null>(null);

  useEffect(() => {
    ttsEngine.warmup();
  }, []);

  return (
    <div className="h-full">
      {book ? (
        <Reader book={book} onBack={() => setBook(null)} />
      ) : (
        <Library onOpen={setBook} />
      )}
      <TtsBar />
    </div>
  );
}
