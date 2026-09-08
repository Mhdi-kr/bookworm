import { useEffect, useRef, useState } from "react";
import { saveProgress } from "../lib/api";
import { ttsEngine } from "../lib/tts/engine";
import type { Book, ReaderOrientation, ReaderTheme, SelectionPayload, TocItem } from "../types";
import { EpubReader, type EpubReaderHandle } from "./EpubReader";
import { ReaderSettingsPopover } from "./ReaderSettingsPopover";
import { SelectionMenu } from "./SelectionMenu";
import { TocPanel } from "./TocPanel";
import type { SpeakSectionItem } from "../lib/tts/speakable";
import { clearBlockLoading, setBlockLoading, setSpeakingHighlight } from "../lib/tts/speakable";
import type { Contents } from "epubjs";

export function Reader({ book, onBack }: { book: Book; onBack: () => void }) {
  const [theme, setTheme] = useState<ReaderTheme>("paper");
  const [fontSize, setFontSize] = useState(112);
  const [orientation, setOrientation] = useState<ReaderOrientation>("horizontal");
  const [hoveringTop, setHoveringTop] = useState(false);
  const [selection, setSelection] = useState<SelectionPayload | null>(null);
  const [tapHint, setTapHint] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const progressTimer = useRef<number | null>(null);
  const readerRef = useRef<EpubReaderHandle | null>(null);

  useEffect(() => {
    setToc([]);
    setCurrentHref(null);
    setTocOpen(false);
    setHoveringTop(false);
  }, [book.id]);

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
    return () => ttsEngine.stop();
  }, [book.id]);

  function queueProgress(progress: { cfi: string; percent: number; href?: string }) {
    if (progress.href) setCurrentHref(progress.href);
    if (progressTimer.current) window.clearTimeout(progressTimer.current);
    progressTimer.current = window.setTimeout(() => {
      void saveProgress(book.id, {
        cfi: progress.cfi,
        percent: progress.percent,
      });
    }, 700);
  }

  async function goToChapter(href: string) {
    ttsEngine.stop();
    setSelection(null);
    await readerRef.current?.goTo(href);
  }

  async function speakSection(items: SpeakSectionItem[], contents: Contents) {
    setTapHint(false);
    setSelection(null);
    const doc = contents.document;
    try {
      await ttsEngine.speakSequence(
        items.map((item) => item.payload.text),
        {
          title: book.title,
          artist: book.authors.join(", ") || "Bookworm",
        },
        {
          onBlockPlay: (index) => {
            setSpeakingHighlight(doc, items[index]?.element ?? null);
          },
          onBlockLoading: (index) => {
            setBlockLoading(items[index]?.element ?? null, true);
          },
        },
      );
    } finally {
      clearBlockLoading(doc);
    }
  }

  async function speakBlock(payload: SelectionPayload) {
    setTapHint(false);
    setSelection(null);
    await ttsEngine.speak(payload.text, {
      title: book.title,
      artist: book.authors.join(", ") || "Bookworm",
    });
  }

  const chromePinned = settingsOpen || tocOpen;
  const chromeVisible = hoveringTop || chromePinned;

  return (
    <div className="relative h-full overflow-hidden bg-paper">
      {/* Invisible hot zone — reveal chrome without layout shift */}
      <div
        className="absolute inset-x-0 top-0 z-30 h-12"
        onMouseEnter={() => setHoveringTop(true)}
      />

      <header
        data-reader-chrome
        onMouseEnter={() => setHoveringTop(true)}
        onMouseLeave={() => {
          if (!chromePinned) setHoveringTop(false);
        }}
        className={`absolute inset-x-0 top-0 z-40 border-b border-white/10 bg-ink px-4 py-3 text-sepia shadow-lg transition duration-200 ${
          chromeVisible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-full opacity-0"
        }`}
      >
        <div className="flex items-center justify-between gap-4">
          <button onClick={onBack} className="rounded-full bg-white/10 px-3 py-1 text-sm">
            Library
          </button>
          <div className="min-w-0 text-center">
            <p className="truncate font-serif text-lg">{book.title}</p>
            <p className="truncate text-xs text-sepia/70">{book.authors.join(", ")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <TocPanel
              open={tocOpen}
              items={toc}
              currentHref={currentHref}
              onOpenChange={setTocOpen}
              onSelect={(href) => void goToChapter(href)}
            />
            <ReaderSettingsPopover
              theme={theme}
              fontSize={fontSize}
              orientation={orientation}
              onThemeChange={setTheme}
              onFontSizeChange={setFontSize}
              onOrientationChange={setOrientation}
              onOpenChange={setSettingsOpen}
            />
          </div>
        </div>
      </header>

      <div className="h-full">
        <EpubReader
          ref={readerRef}
          book={book}
          theme={theme}
          fontSize={fontSize}
          orientation={orientation}
          onSelection={setSelection}
          onProgress={queueProgress}
          onToc={setToc}
          onSpeakBlock={(payload) => void speakBlock(payload)}
          onSpeakSection={(items, contents) => void speakSection(items, contents)}
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
            void ttsEngine.unlockAudio().then(() =>
              ttsEngine.speak(selection.text, {
                title: book.title,
                artist: book.authors.join(", ") || "Bookworm",
              }),
            );
            setSelection(null);
          }}
        />
      ) : null}
    </div>
  );
}
