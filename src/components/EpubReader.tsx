import { useEffect, useRef, useState } from "react";
import ePub, { type Contents, type Location, type Rendition } from "epubjs";
import { fileSrc } from "../lib/api";
import { attachSpeakableBlocks, clearSpeakingHighlights, type SpeakSectionItem } from "../lib/tts/speakable";
import { continuousNarrator } from "../lib/tts/narrator";
import { ttsEngine } from "../lib/tts/engine";
import type { Book, ReaderTheme, SelectionPayload } from "../types";

const THEMES: Record<ReaderTheme, Record<string, Record<string, string>>> = {
  paper: {
    body: {
      background: "#f4ead5 !important",
      color: "#1c140e !important",
      "font-family": "Georgia, 'Palatino Linotype', Palatino, serif",
      "line-height": "1.7",
      padding: "0 7%",
      "-webkit-user-select": "text",
      "user-select": "text",
    },
    p: { color: "#1c140e !important" },
    a: { color: "#9c3b2a !important" },
  },
  sepia: {
    body: {
      background: "#f0dcb4 !important",
      color: "#3b2a1a !important",
      "font-family": "Georgia, 'Palatino Linotype', Palatino, serif",
      "line-height": "1.7",
      padding: "0 7%",
      "-webkit-user-select": "text",
      "user-select": "text",
    },
    p: { color: "#3b2a1a !important" },
    a: { color: "#9c3b2a !important" },
  },
  dark: {
    body: {
      background: "#1a1612 !important",
      color: "#e8dcc8 !important",
      "font-family": "Georgia, 'Palatino Linotype', Palatino, serif",
      "line-height": "1.7",
      padding: "0 7%",
      "-webkit-user-select": "text",
      "user-select": "text",
    },
    p: { color: "#e8dcc8 !important" },
    a: { color: "#e2c08d !important" },
  },
};

type EpubView = { contents?: Contents };

function frameOffset(contents: Contents) {
  const frame = contents.document.defaultView?.frameElement as HTMLElement | null;
  return frame?.getBoundingClientRect();
}

function rectFromRange(range: Range, contents: Contents) {
  const box = range.getBoundingClientRect();
  const offset = frameOffset(contents);
  const top = box.top + (offset?.top ?? 0);
  const left = box.left + (offset?.left ?? 0);
  const bottom = box.bottom + (offset?.top ?? 0);
  if (!box.width && !box.height) {
    return { top: 72, left: 24, bottom: 112 };
  }
  return { top, left, bottom };
}

function selectionFromContents(contents: Contents): SelectionPayload | null {
  const live = contents.window.getSelection();
  const text = live?.toString().trim() ?? "";
  if (!text || !live || live.rangeCount === 0 || live.isCollapsed) return null;

  const domRange = live.getRangeAt(0);
  let cfi = "";
  try {
    cfi = contents.cfiFromRange(domRange);
  } catch {
    /* CFI optional — still show Speak overlay */
  }

  return {
    text,
    locator: { kind: "epub", cfi },
    rect: rectFromRange(domRange, contents),
  };
}

function publishSelection(
  contents: Contents,
  onSelection: (selection: SelectionPayload | null) => void,
) {
  const payload = selectionFromContents(contents);
  if (payload) onSelection(payload);
}

async function loadEpubData(path: string): Promise<ArrayBuffer> {
  const src = fileSrc(path);
  // ArrayBuffer avoids epubjs path-resolution bugs with blob: URLs in the browser.
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Could not load EPUB (${response.status})`);
  }
  return response.arrayBuffer();
}

export type EpubReaderHandle = {
  startListening: () => Promise<void>;
  stopListening: () => void;
};

export function EpubReader({
  book,
  theme,
  fontSize,
  onSelection,
  onProgress,
  onReady,
  onSpeakBlock,
  onSpeakSection,
}: {
  book: Book;
  theme: ReaderTheme;
  fontSize: number;
  onSelection: (selection: SelectionPayload | null) => void;
  onProgress: (progress: { cfi: string; percent: number }) => void;
  onReady?: (handle: EpubReaderHandle | null) => void;
  onSpeakBlock?: (payload: SelectionPayload) => void;
  onSpeakSection?: (items: SpeakSectionItem[], contents: Contents) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const bookRef = useRef<ReturnType<typeof ePub> | null>(null);
  const onSelectionRef = useRef(onSelection);
  const onProgressRef = useRef(onProgress);
  const onReadyRef = useRef(onReady);
  const onSpeakBlockRef = useRef(onSpeakBlock);
  const onSpeakSectionRef = useRef(onSpeakSection);
  const detachSpeakableRef = useRef<(() => void) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  onSelectionRef.current = onSelection;
  onProgressRef.current = onProgress;
  onReadyRef.current = onReady;
  onSpeakBlockRef.current = onSpeakBlock;
  onSpeakSectionRef.current = onSpeakSection;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let instance: ReturnType<typeof ePub> | null = null;
    let poll = 0;

    setLoadError(null);
    host.innerHTML = "";

    void (async () => {
      try {
        const data = await loadEpubData(book.libraryPath);
        if (cancelled) return;
        instance = ePub(data);
        bookRef.current = instance;
        const rendition = instance.renderTo(host, {
          width: "100%",
          height: "100%",
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;
        continuousNarrator.bind({
          book: instance,
          rendition,
          title: book.title,
          authors: book.authors.join(", "),
        });
        onReadyRef.current?.({
          startListening: () => continuousNarrator.startFromCurrent(),
          stopListening: () => continuousNarrator.stop(),
        });
        (Object.keys(THEMES) as ReaderTheme[]).forEach((name) => {
          rendition.themes.register(name, THEMES[name]);
        });
        rendition.themes.select(theme);
        rendition.themes.fontSize(`${fontSize}%`);

        const publishFromContents = (contents: Contents) => {
          publishSelection(contents, onSelectionRef.current);
        };

        const wireSpeakable = (view: EpubView) => {
          const contents = view.contents;
          if (!contents?.document) return;
          detachSpeakableRef.current?.();
          detachSpeakableRef.current = attachSpeakableBlocks(
            contents,
            (payload) => {
              onSelectionRef.current(null);
              onSpeakBlockRef.current?.(payload);
            },
            (text) => ttsEngine.prefetch(text),
            (items) => {
              onSelectionRef.current(null);
              onSpeakSectionRef.current?.(items, contents);
            },
          );
        };

        const attachSpeakableFromRendition = () => {
          const contentsList = rendition.getContents();
          const contents = (
            Array.isArray(contentsList) ? contentsList[0] : contentsList
          ) as Contents | undefined;
          if (contents) wireSpeakable({ contents });
        };

        rendition.on("relocated", (location: Location) => {
          onProgressRef.current({
            cfi: location.start.cfi,
            percent: location.start.percentage ?? 0,
          });
        });

        rendition.on("selected", (cfiRange: string, contents: Contents) => {
          try {
            const range = contents.range(cfiRange);
            const text = range?.toString().trim() ?? "";
            if (!text || !range) {
              publishFromContents(contents);
              return;
            }
            onSelectionRef.current({
              text,
              locator: { kind: "epub", cfi: cfiRange },
              rect: rectFromRange(range, contents),
            });
          } catch {
            publishFromContents(contents);
          }
        });

        const afterPointer = (_event: Event, contents: Contents) => {
          window.setTimeout(() => publishFromContents(contents), 30);
        };
        rendition.on("mouseup", afterPointer);
        rendition.on("touchend", afterPointer);

        rendition.on("rendered", (_section: unknown, view: EpubView) => {
          wireSpeakable(view);
          const contents = view.contents;
          if (!contents?.document) return;
          const doc = contents.document;
          const blockNativeMenu = (event: Event) => event.preventDefault();
          const onUp = () => {
            window.setTimeout(() => publishFromContents(contents), 30);
          };
          doc.addEventListener("contextmenu", blockNativeMenu);
          doc.addEventListener("mouseup", onUp);
          doc.addEventListener("touchend", onUp);
          doc.addEventListener("pointerup", onUp);
        });

        await rendition.display(book.progress?.cfi);
        if (cancelled) return;
        attachSpeakableFromRendition();
        window.setTimeout(attachSpeakableFromRendition, 150);
        window.setTimeout(attachSpeakableFromRendition, 600);

        let lastText = "";
        poll = window.setInterval(() => {
          const iframe = host.querySelector("iframe");
          const win = iframe?.contentWindow;
          if (!win) return;
          const live = win.getSelection();
          const text = live?.toString().trim() ?? "";
          if (!text || !live || live.rangeCount === 0 || live.isCollapsed) {
            if (lastText) onSelectionRef.current(null);
            lastText = "";
            return;
          }
          if (text === lastText) return;
          lastText = text;
          const contentsList = rendition.getContents();
          const contents = (
            Array.isArray(contentsList) ? contentsList[0] : contentsList
          ) as Contents | undefined;
          if (contents) publishSelection(contents, onSelectionRef.current);
        }, 200);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") void renditionRef.current?.next();
      if (event.key === "ArrowLeft") void renditionRef.current?.prev();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.removeEventListener("keydown", onKey);
      detachSpeakableRef.current?.();
      detachSpeakableRef.current = null;
      continuousNarrator.unbind();
      onReadyRef.current?.(null);
      renditionRef.current?.destroy();
      instance?.destroy();
      bookRef.current = null;
      renditionRef.current = null;
    };
  }, [book.id, book.libraryPath, book.title, book.authors]);

  useEffect(() => {
    renditionRef.current?.themes.select(theme);
  }, [theme]);

  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${fontSize}%`);
  }, [fontSize]);

  useEffect(() => {
    const unsubscribe = ttsEngine.subscribe(() => {
      if (ttsEngine.status === "idle" || ttsEngine.status === "ready" || ttsEngine.status === "error") {
        const iframe = hostRef.current?.querySelector("iframe");
        const doc = iframe?.contentDocument;
        if (doc) clearSpeakingHighlights(doc);
      }
    });
    return unsubscribe;
  }, []);

  return (
    <div className="relative h-full w-full">
      {loadError ? (
        <p className="px-6 pt-24 text-center text-sm text-oxblood">
          Could not open this EPUB: {loadError}
        </p>
      ) : null}
      <div ref={hostRef} className="h-full w-full" data-epub-host />
      <button
        type="button"
        className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-ink/70 px-3 py-2 text-sepia"
        onClick={() => void renditionRef.current?.prev()}
      >
        ‹
      </button>
      <button
        type="button"
        className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-ink/70 px-3 py-2 text-sepia"
        onClick={() => void renditionRef.current?.next()}
      >
        ›
      </button>
    </div>
  );
}
