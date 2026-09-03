import { useEffect, useRef, useState } from "react";
import { deleteHighlight, listHighlights, saveHighlight, saveProgress } from "../lib/api";
import { continuousNarrator } from "../lib/tts/narrator";
import { ttsEngine } from "../lib/tts/engine";
import type { Book, Highlight, ReaderTheme, SelectionPayload } from "../types";
import { EpubReader, type EpubReaderHandle } from "./EpubReader";
import { HighlightsPanel } from "./HighlightsPanel";
import { SelectionMenu } from "./SelectionMenu";
import type { SpeakSectionItem } from "../lib/tts/speakable";
import { setSpeakingHighlight } from "../lib/tts/speakable";
import type { Contents } from "epubjs";

export function Reader({ book, onBack }: { book: Book; onBack: () => void }) {
  const [theme, setTheme] = useState<ReaderTheme>("paper");
  const [fontSize, setFontSize] = useState(112);
  const [idle, setIdle] = useState(false);
  const [selection, setSelection] = useState<SelectionPayload | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [showHighlights, setShowHighlights] = useState(false);
  const [listening, setListening] = useState(false);
  const [tapHint, setTapHint] = useState(true);
  const progressTimer = useRef<number | null>(null);
  const readerHandle = useRef<EpubReaderHandle | null>(null);

  useEffect(() => {
    void listHighlights(book.id).then(setHighlights).catch(() => setHighlights([]));
  }, [book.id]);

  useEffect(() => {
    const unsubscribe = continuousNarrator.subscribe(() => {
      setListening(continuousNarrator.state !== "idle");
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let timer = 0;
    const bump = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 2600);
    };
    window.addEventListener("mousemove", bump);
    bump();
    return () => {
      window.removeEventListener("mousemove", bump);
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!selection) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("[data-selection-menu]")) return;
      // Clicks inside the EPUB iframe don't bubble here — ignore.
      if (target?.tagName === "IFRAME") return;
      setSelection(null);
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("pointerdown", dismiss, true);
    }, 500);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", dismiss, true);
    };
  }, [selection]);

  useEffect(() => {
    return () => continuousNarrator.stop();
  }, [book.id]);

  function queueProgress(progress: Book["progress"]) {
    if (progressTimer.current) window.clearTimeout(progressTimer.current);
    progressTimer.current = window.setTimeout(() => {
      void saveProgress(book.id, progress);
    }, 700);
  }

  async function highlightSelection() {
    if (!selection || selection.locator.kind !== "epub" || !selection.locator.cfi) return;
    const saved = await saveHighlight(book.id, selection.locator, selection.text);
    setHighlights((current) => [saved, ...current]);
    setSelection(null);
  }

  async function speakSection(items: SpeakSectionItem[], contents: Contents) {
    setTapHint(false);
    continuousNarrator.stop();
    setSelection(null);
    const doc = contents.document;
    await ttsEngine.speakSequence(
      items.map((item) => item.payload.text),
      {
        title: book.title,
        artist: book.authors.join(", ") || "Bookworm",
      },
      (index) => setSpeakingHighlight(doc, items[index]?.element ?? null),
    );
  }

  async function speakBlock(payload: SelectionPayload) {
    setTapHint(false);
    continuousNarrator.stop();
    setSelection(null);
    await ttsEngine.speak(payload.text, {
      title: book.title,
      artist: book.authors.join(", ") || "Bookworm",
    });
  }

  async function toggleListen() {
    if (continuousNarrator.state !== "idle") {
      continuousNarrator.stop();
      return;
    }
    await ttsEngine.unlockAudio();
    await readerHandle.current?.startListening();
  }

  const chromeHidden = idle && !selection && !showHighlights && !listening;

  return (
    <div className="relative h-full overflow-hidden bg-paper">
      <div
        className={`absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-4 px-4 py-3 transition ${
          chromeHidden ? "pointer-events-none opacity-0" : "opacity-100"
        } bg-gradient-to-b from-ink/80 to-transparent text-sepia`}
      >
        <button onClick={onBack} className="rounded-full bg-white/10 px-3 py-1 text-sm">
          Library
        </button>
        <div className="min-w-0 text-center">
          <p className="truncate font-serif text-lg">{book.title}</p>
          <p className="truncate text-xs text-sepia/70">{book.authors.join(", ")}</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => void toggleListen()}
            className={`rounded-full px-3 py-1 ${
              listening ? "bg-sepia text-ink" : "bg-white/10 text-sepia"
            }`}
          >
            {listening ? "Stop play" : "Play book"}
          </button>
          <button onClick={() => setFontSize((value) => Math.max(90, value - 8))}>A−</button>
          <button onClick={() => setFontSize((value) => Math.min(160, value + 8))}>A+</button>
          {(["paper", "sepia", "dark"] as ReaderTheme[]).map((name) => (
            <button
              key={name}
              onClick={() => setTheme(name)}
              className={`capitalize ${theme === name ? "text-gold" : "text-sepia/70"}`}
            >
              {name}
            </button>
          ))}
          <button onClick={() => setShowHighlights((value) => !value)}>Highlights</button>
        </div>
      </div>

      <div className="h-full pt-0">
        <EpubReader
          book={book}
          theme={theme}
          fontSize={fontSize}
          onSelection={setSelection}
          onProgress={(progress) => queueProgress(progress)}
          onSpeakBlock={(payload) => void speakBlock(payload)}
          onSpeakSection={(items, contents) => void speakSection(items, contents)}
          onReady={(handle) => {
            readerHandle.current = handle;
          }}
        />
      </div>

      {tapHint ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center px-4">
          <div className="rounded-full border border-oxblood/30 bg-ink px-5 py-2.5 text-center text-sm text-sepia shadow-xl">
            <span className="font-medium text-gold">Hover a paragraph</span> to reveal ▶, then click to hear
            it
          </div>
        </div>
      ) : null}

      {selection ? (
        <SelectionMenu
          selection={selection}
          onSpeak={() => {
            continuousNarrator.stop();
            void ttsEngine.unlockAudio().then(() =>
              ttsEngine.speak(selection.text, {
                title: book.title,
                artist: book.authors.join(", ") || "Bookworm",
              }),
            );
            setSelection(null);
          }}
          onHighlight={() => void highlightSelection()}
        />
      ) : null}

      <HighlightsPanel
        open={showHighlights}
        highlights={highlights}
        onClose={() => setShowHighlights(false)}
        onSpeak={(highlight) => {
          continuousNarrator.stop();
          void ttsEngine.unlockAudio().then(() =>
            ttsEngine.speak(highlight.quote, {
              title: book.title,
              artist: book.authors.join(", ") || "Bookworm",
            }),
          );
        }}
        onDelete={(id) => {
          void deleteHighlight(id);
          setHighlights((current) => current.filter((item) => item.id !== id));
        }}
      />
    </div>
  );
}
