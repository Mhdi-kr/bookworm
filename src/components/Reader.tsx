import { useEffect, useRef, useState } from "react";
import { saveProgress } from "../lib/api";
import { ensureParentReaderFontFaces } from "../lib/readerFonts";
import { readerTheme } from "../lib/readerThemes";
import { loadReaderSettings, saveReaderSettings } from "../lib/readerSettings";
import { ttsEngine } from "../lib/tts/engine";
import type { Book, ReaderFont, ReaderOrientation, ReaderTheme, SelectionPayload, TocItem } from "../types";
import { EpubReader, type EpubReaderHandle } from "./EpubReader";
import { ReaderSettingsPopover } from "./ReaderSettingsPopover";
import { TocPanel } from "./TocPanel";
import {
  clearBlockLoading,
  setBlockLoading,
  setSpeakingHighlight,
  speakItemsFrom,
  type SpeakAnchor,
  type SpeakSectionItem,
} from "../lib/tts/speakable";
import type { Contents } from "epubjs";

function ChevronUpIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function Reader({ book, onBack }: { book: Book; onBack: () => void }) {
  const [theme, setTheme] = useState<ReaderTheme>(() => loadReaderSettings().theme);
  const [font, setFont] = useState<ReaderFont>(() => loadReaderSettings().font);
  const [fontSize, setFontSize] = useState(() => loadReaderSettings().fontSize);
  const [orientation, setOrientation] = useState<ReaderOrientation>(
    () => loadReaderSettings().orientation,
  );
  const [chromeVisible, setChromeVisible] = useState(() => loadReaderSettings().chromeVisible);
  const [autoPlay, setAutoPlay] = useState(() => loadReaderSettings().autoPlay);
  const [tapHint, setTapHint] = useState(true);
  const [tocOpen, setTocOpen] = useState(false);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const progressTimer = useRef<number | null>(null);
  const readerRef = useRef<EpubReaderHandle | null>(null);
  const autoPlayRef = useRef(autoPlay);
  const playSessionRef = useRef(0);
  autoPlayRef.current = autoPlay;

  useEffect(() => {
    setToc([]);
    setCurrentHref(null);
    setTocOpen(false);
  }, [book.id]);

  useEffect(() => {
    ensureParentReaderFontFaces();
  }, []);

  useEffect(() => {
    saveReaderSettings({ theme, font, fontSize, orientation, autoPlay });
  }, [theme, font, fontSize, orientation, autoPlay]);

  useEffect(() => {
    return () => ttsEngine.stop();
  }, [book.id]);

  useEffect(() => {
    let prevStatus = ttsEngine.status;
    return ttsEngine.subscribe(() => {
      const status = ttsEngine.status;
      const stopped =
        ttsEngine.currentText === "" &&
        (status === "ready" || status === "idle") &&
        (prevStatus === "speaking" || prevStatus === "paused" || prevStatus === "preparing");
      prevStatus = status;
      if (stopped) playSessionRef.current += 1;
    });
  }, []);

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

  function mediaMeta() {
    return {
      title: book.title,
      artist: book.authors.join(", ") || "Bookworm",
    };
  }

  function speakAnchorFrom(item: SpeakSectionItem): SpeakAnchor {
    return {
      element: item.element,
      cfi: item.payload.locator.kind === "epub" ? item.payload.locator.cfi : undefined,
      text: item.payload.text,
    };
  }

  async function goToChapter(href: string) {
    playSessionRef.current += 1;
    ttsEngine.stop();
    await readerRef.current?.goTo(href);
  }

  async function speakItems(items: SpeakSectionItem[], contents: Contents, fromUser: boolean) {
    if (!items.length) return;
    if (fromUser) playSessionRef.current += 1;
    const session = playSessionRef.current;
    setTapHint(false);

    let currentItems = items;
    let currentContents = contents;

    while (session === playSessionRef.current) {
      const sectionItems = currentItems;
      const sectionContents = currentContents;
      const doc = sectionContents.document;
      try {
        const completed = await ttsEngine.speakSequence(
          sectionItems.map((item) => item.payload.text),
          mediaMeta(),
          {
            onBlockPlay: (index) => {
              setSpeakingHighlight(doc, sectionItems[index]?.element ?? null);
            },
            onBlockLoading: (index) => {
              setBlockLoading(sectionItems[index]?.element ?? null, true);
            },
          },
        );
        if (!completed || session !== playSessionRef.current || !autoPlayRef.current) return;
        const last = sectionItems[sectionItems.length - 1];
        const next = await readerRef.current?.nextSpeakableSection(
          last ? speakAnchorFrom(last) : null,
        );
        if (!next?.items.length || session !== playSessionRef.current || !autoPlayRef.current) {
          return;
        }
        const nextStart = next.items[0];
        if (
          last &&
          nextStart.payload.text === last.payload.text &&
          nextStart.payload.locator.kind === "epub" &&
          last.payload.locator.kind === "epub" &&
          last.payload.locator.cfi &&
          nextStart.payload.locator.cfi === last.payload.locator.cfi
        ) {
          return;
        }
        currentItems = next.items;
        currentContents = next.contents;
      } finally {
        clearBlockLoading(doc);
      }
    }
  }

  async function speakBlock(payload: SelectionPayload, element: Element, contents: Contents) {
    if (autoPlayRef.current) {
      const items = speakItemsFrom(contents, element);
      if (items.length) {
        await speakItems(items, contents, true);
        return;
      }
    }
    playSessionRef.current += 1;
    const session = playSessionRef.current;
    setTapHint(false);
    const completed = await ttsEngine.speakAndWait(payload.text, mediaMeta());
    if (!completed || session !== playSessionRef.current || !autoPlayRef.current) return;
    const next = await readerRef.current?.nextSpeakableSection({
      element,
      cfi: payload.locator.kind === "epub" ? payload.locator.cfi : undefined,
      text: payload.text,
    });
    if (!next?.items.length || session !== playSessionRef.current || !autoPlayRef.current) return;
    await speakItems(next.items, next.contents, false);
  }

  function setChromeVisibleState(visible: boolean) {
    setChromeVisible(visible);
    saveReaderSettings({ chromeVisible: visible });
    if (!visible) setTocOpen(false);
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      style={{ background: readerTheme(theme).background }}
    >
      {chromeVisible ? (
        <header
          data-reader-chrome
          className="relative z-40 shrink-0 border-b border-white/10 bg-ink px-4 py-3 text-sepia shadow-lg"
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
                font={font}
                fontSize={fontSize}
                orientation={orientation}
                autoPlay={autoPlay}
                onThemeChange={setTheme}
                onFontChange={setFont}
                onFontSizeChange={setFontSize}
                onOrientationChange={setOrientation}
                onAutoPlayChange={setAutoPlay}
              />
              <button
                type="button"
                aria-label="Hide reader bar"
                title="Hide bar"
                onClick={() => setChromeVisibleState(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-sepia transition hover:bg-white/15"
              >
                <ChevronUpIcon />
              </button>
            </div>
          </div>
        </header>
      ) : (
        <button
          type="button"
          aria-label="Show reader bar"
          title="Show bar"
          onClick={() => setChromeVisibleState(true)}
          className="absolute left-1/2 top-0 z-40 flex h-7 w-10 -translate-x-1/2 items-center justify-center rounded-b-lg border border-t-0 border-white/10 bg-ink text-sepia shadow-lg transition hover:bg-white/10"
        >
          <ChevronDownIcon />
        </button>
      )}

      <div className="min-h-0 flex-1">
        <EpubReader
          ref={readerRef}
          book={book}
          theme={theme}
          font={font}
          fontSize={fontSize}
          orientation={orientation}
          autoPlay={autoPlay}
          onProgress={queueProgress}
          onToc={setToc}
          onSpeakBlock={(payload, element, contents) => void speakBlock(payload, element, contents)}
          onSpeakSection={(items, contents) => void speakItems(items, contents, true)}
        />
      </div>

      {tapHint ? (
        <div
          data-reader-tap-hint
          className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center px-4"
        >
          <div className="rounded-full border border-oxblood/30 bg-ink px-5 py-2.5 text-center text-sm text-sepia shadow-xl">
            <span className="font-medium text-gold">Hover a paragraph</span> to reveal ▶, then click to hear
            it
          </div>
        </div>
      ) : null}
    </div>
  );
}
