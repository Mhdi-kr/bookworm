import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import ePub, { type Contents, type Location, type NavItem, type Rendition } from "epubjs";
import type Section from "epubjs/types/section";
import { fileSrc } from "../lib/api";
import { attachSpeakableBlocks, clearSpeakingHighlights, type SpeakSectionItem } from "../lib/tts/speakable";
import { ttsEngine } from "../lib/tts/engine";
import type { Book, ReaderOrientation, ReaderTheme, SelectionPayload, TocItem } from "../types";

const THEMES: Record<ReaderTheme, Record<string, Record<string, string>>> = {
  paper: {
    body: {
      background: "#eef3f0 !important",
      color: "#14201b !important",
      "font-family": "Georgia, 'Palatino Linotype', Palatino, serif",
      "line-height": "1.7",
      padding: "0 7%",
      "-webkit-user-select": "text",
      "user-select": "text",
    },
    p: { color: "#14201b !important" },
    a: { color: "#1f6b62 !important" },
  },
  fog: {
    body: {
      background: "#dfe6eb !important",
      color: "#1a2430 !important",
      "font-family": "Georgia, 'Palatino Linotype', Palatino, serif",
      "line-height": "1.7",
      padding: "0 7%",
      "-webkit-user-select": "text",
      "user-select": "text",
    },
    p: { color: "#1a2430 !important" },
    a: { color: "#2a6b7c !important" },
  },
  dark: {
    body: {
      background: "#121a17 !important",
      color: "#d5e0db !important",
      "font-family": "Georgia, 'Palatino Linotype', Palatino, serif",
      "line-height": "1.7",
      padding: "0 7%",
      "-webkit-user-select": "text",
      "user-select": "text",
    },
    p: { color: "#d5e0db !important" },
    a: { color: "#8ebfb4 !important" },
  },
};

type EpubView = { contents?: Contents };

async function loadEpubData(path: string): Promise<ArrayBuffer> {
  const src = fileSrc(path);
  // ArrayBuffer avoids epubjs path-resolution bugs with blob: URLs in the browser.
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Could not load EPUB (${response.status})`);
  }
  return response.arrayBuffer();
}

function mapNavItems(items: NavItem[] | undefined): TocItem[] {
  if (!items?.length) return [];
  return items.map((item, index) => ({
    id: item.id || `toc-${index}-${item.href}`,
    href: item.href,
    label: item.label?.replace(/\s+/g, " ").trim() || "Untitled",
    subitems: mapNavItems(item.subitems),
  }));
}

function spineFallbackToc(book: ReturnType<typeof ePub>): TocItem[] {
  const items: TocItem[] = [];
  book.spine.each((section: Section) => {
    if (!section.linear) return;
    const leaf = section.href.split("/").pop()?.split("#")[0] || section.href;
    items.push({
      id: section.idref || `spine-${section.index}`,
      href: section.href,
      label: decodeURIComponent(leaf.replace(/\.(xhtml|html|htm)$/i, "")).replace(/[-_]+/g, " "),
    });
  });
  return items;
}

function applyOrientation(rendition: Rendition, orientation: ReaderOrientation) {
  if (orientation === "vertical") {
    rendition.flow("scrolled");
  } else {
    rendition.flow("paginated");
  }
}

export type EpubReaderHandle = {
  goTo: (href: string) => Promise<void>;
};

export const EpubReader = forwardRef<
  EpubReaderHandle,
  {
    book: Book;
    theme: ReaderTheme;
    fontSize: number;
    orientation: ReaderOrientation;
    onProgress: (progress: { cfi: string; percent: number; href?: string }) => void;
    onToc?: (items: TocItem[]) => void;
    onSpeakBlock?: (payload: SelectionPayload) => void;
    onSpeakSection?: (items: SpeakSectionItem[], contents: Contents) => void;
  }
>(function EpubReader(
  {
    book,
    theme,
    fontSize,
    orientation,
    onProgress,
    onToc,
    onSpeakBlock,
    onSpeakSection,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const bookRef = useRef<ReturnType<typeof ePub> | null>(null);
  const onProgressRef = useRef(onProgress);
  const onTocRef = useRef(onToc);
  const onSpeakBlockRef = useRef(onSpeakBlock);
  const onSpeakSectionRef = useRef(onSpeakSection);
  const orientationRef = useRef(orientation);
  const detachSpeakableRef = useRef<(() => void) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  onProgressRef.current = onProgress;
  onTocRef.current = onToc;
  onSpeakBlockRef.current = onSpeakBlock;
  onSpeakSectionRef.current = onSpeakSection;
  orientationRef.current = orientation;

  useImperativeHandle(ref, () => ({
    goTo: async (href: string) => {
      const rendition = renditionRef.current;
      if (!rendition || !href) return;
      await rendition.display(href);
    },
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let instance: ReturnType<typeof ePub> | null = null;

    setLoadError(null);
    onTocRef.current?.([]);
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
          flow: orientationRef.current === "vertical" ? "scrolled" : "paginated",
        });
        renditionRef.current = rendition;
        applyOrientation(rendition, orientationRef.current);
        (Object.keys(THEMES) as ReaderTheme[]).forEach((name) => {
          rendition.themes.register(name, THEMES[name]);
        });
        rendition.themes.select(theme);
        rendition.themes.fontSize(`${fontSize}%`);

        await instance.ready;
        if (cancelled) return;
        let toc = mapNavItems(instance.navigation?.toc);
        if (!toc.length) {
          try {
            const navigation = await instance.loaded.navigation;
            toc = mapNavItems(navigation.toc);
          } catch {
            /* some EPUBs lack nav documents */
          }
        }
        if (!toc.length) toc = spineFallbackToc(instance);
        if (!cancelled) onTocRef.current?.(toc);

        const wireSpeakable = (view: EpubView) => {
          const contents = view.contents;
          if (!contents?.document) return;
          detachSpeakableRef.current?.();
          detachSpeakableRef.current = attachSpeakableBlocks(
            contents,
            (payload) => {
              onSpeakBlockRef.current?.(payload);
            },
            (text) => ttsEngine.prefetch(text),
            (items) => {
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
            href: location.start.href,
          });
        });

        rendition.on("rendered", (_section: unknown, view: EpubView) => {
          wireSpeakable(view);
          const contents = view.contents;
          if (!contents?.document) return;
          const blockNativeMenu = (event: Event) => event.preventDefault();
          contents.document.addEventListener("contextmenu", blockNativeMenu);
        });

        await rendition.display(book.progress?.cfi);
        if (cancelled) return;
        attachSpeakableFromRendition();
        window.setTimeout(attachSpeakableFromRendition, 150);
        window.setTimeout(attachSpeakableFromRendition, 600);
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
      window.removeEventListener("keydown", onKey);
      detachSpeakableRef.current?.();
      detachSpeakableRef.current = null;
      onTocRef.current?.([]);
      renditionRef.current?.destroy();
      instance?.destroy();
      bookRef.current = null;
      renditionRef.current = null;
    };
  }, [book.id, book.libraryPath]);

  useEffect(() => {
    renditionRef.current?.themes.select(theme);
  }, [theme]);

  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${fontSize}%`);
  }, [fontSize]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    const location = rendition.currentLocation() as
      | { start?: { cfi?: string } }
      | Promise<{ start?: { cfi?: string } }>
      | undefined;
    applyOrientation(rendition, orientation);
    void Promise.resolve(location).then((loc) => {
      const cfi = loc && "start" in loc ? loc.start?.cfi : undefined;
      void rendition.display(cfi);
    });
  }, [orientation]);

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

  const showPageButtons = orientation === "horizontal";

  return (
    <div className="relative h-full w-full">
      {loadError ? (
        <p className="px-6 pt-24 text-center text-sm text-oxblood">
          Could not open this EPUB: {loadError}
        </p>
      ) : null}
      <div ref={hostRef} className="h-full w-full" data-epub-host />
      {showPageButtons ? (
        <>
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
        </>
      ) : null}
    </div>
  );
});
