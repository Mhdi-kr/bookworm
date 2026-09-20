import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import ePub, { type Contents, type Location, type NavItem, type Rendition } from "epubjs";
import type Section from "epubjs/types/section";
import { fileSrc } from "../lib/api";
import {
  attachSpeakableBlocks,
  clearSpeakingHighlights,
  nextSectionItems,
  speakItemsMatchingStart,
  type SpeakAnchor,
  type SpeakSectionItem,
} from "../lib/tts/speakable";
import { ttsEngine } from "../lib/tts/engine";
import { applyReaderFont, applyReaderFontToRendition } from "../lib/readerFonts";
import {
  applyReaderTheme,
  applyReaderThemeToHost,
  applyReaderThemeToRendition,
  readerTheme,
} from "../lib/readerThemes";
import type { Book, ReaderFont, ReaderOrientation, ReaderTheme, SelectionPayload, TocItem } from "../types";

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

function contentsFromRendition(rendition: Rendition | null): Contents | undefined {
  if (!rendition) return undefined;
  const contentsList = rendition.getContents();
  const contents = (
    Array.isArray(contentsList) ? contentsList[0] : contentsList
  ) as Contents | undefined;
  return contents?.document?.body ? contents : undefined;
}

function elementVisibleInFrame(element: Element): boolean {
  if (!element.isConnected) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 8 &&
    rect.top < view.innerHeight - 8 &&
    rect.right > 8 &&
    rect.left < view.innerWidth - 8
  );
}

async function waitForContents(
  rendition: Rendition,
  options?: { timeoutMs?: number; notSectionIndex?: number },
): Promise<Contents | undefined> {
  const timeoutMs = options?.timeoutMs ?? 2000;
  const ready = () => {
    const contents = contentsFromRendition(rendition);
    if (!contents) return undefined;
    if (
      typeof options?.notSectionIndex === "number" &&
      contents.sectionIndex === options.notSectionIndex
    ) {
      return undefined;
    }
    return contents;
  };
  const existing = ready();
  if (existing) return existing;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      rendition.off("rendered", onRendered);
      resolve(ready());
    };
    const onRendered = () => finish();
    const timer = window.setTimeout(finish, timeoutMs);
    rendition.on("rendered", onRendered);
    if (ready()) finish();
  });
}

function spineIndexOf(rendition: Rendition): number | undefined {
  const fromLocation = rendition.location?.start?.index;
  if (typeof fromLocation === "number") return fromLocation;
  return undefined;
}

export type NextSpeakableSection = {
  items: SpeakSectionItem[];
  contents: Contents;
};

export type EpubReaderHandle = {
  goTo: (href: string) => Promise<void>;
  nextSpeakableSection: (after: SpeakAnchor | null) => Promise<NextSpeakableSection | null>;
};

export const EpubReader = forwardRef<
  EpubReaderHandle,
  {
    book: Book;
    theme: ReaderTheme;
    font: ReaderFont;
    fontSize: number;
    orientation: ReaderOrientation;
    onProgress: (progress: { cfi: string; percent: number; href?: string }) => void;
    onToc?: (items: TocItem[]) => void;
    autoPlay?: boolean;
    onSpeakBlock?: (payload: SelectionPayload, element: Element, contents: Contents) => void;
    onSpeakSection?: (items: SpeakSectionItem[], contents: Contents) => void;
  }
>(function EpubReader(
  {
    book,
    theme,
    font,
    fontSize,
    orientation,
    onProgress,
    onToc,
    autoPlay = false,
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
  const autoPlayRef = useRef(autoPlay);
  const fontRef = useRef(font);
  const themeRef = useRef(theme);
  const detachSpeakableRef = useRef<(() => void) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  onProgressRef.current = onProgress;
  onTocRef.current = onToc;
  onSpeakBlockRef.current = onSpeakBlock;
  onSpeakSectionRef.current = onSpeakSection;
  orientationRef.current = orientation;
  autoPlayRef.current = autoPlay;
  fontRef.current = font;
  themeRef.current = theme;

  useImperativeHandle(ref, () => ({
    goTo: async (href: string) => {
      const rendition = renditionRef.current;
      if (!rendition || !href) return;
      await rendition.display(href);
    },
    nextSpeakableSection: async (after: SpeakAnchor | null) => {
      const rendition = renditionRef.current;
      const book = bookRef.current;
      if (!rendition) return null;

      const reveal = async (
        items: SpeakSectionItem[],
        contents: Contents,
      ): Promise<NextSpeakableSection | null> => {
        if (!items.length) return null;
        const start = items[0];
        const cfi = start.payload.locator.kind === "epub" ? start.payload.locator.cfi : "";
        const alreadyVisible = elementVisibleInFrame(start.element);
        if (!alreadyVisible) {
          if (cfi) {
            try {
              await rendition.display(cfi);
            } catch {
              try {
                start.element.scrollIntoView({ block: "start", inline: "nearest" });
              } catch {
                /* optional */
              }
            }
          } else {
            try {
              start.element.scrollIntoView({ block: "start", inline: "nearest" });
            } catch {
              /* optional */
            }
          }
        }
        const fresh = (await waitForContents(rendition)) ?? contents;
        const rebuilt = speakItemsMatchingStart(fresh, { cfi, text: start.payload.text });
        if (rebuilt.length) return { items: rebuilt, contents: fresh };
        if (items.every((item) => item.element.isConnected)) {
          return { items, contents: fresh };
        }
        return null;
      };

      const displayNextLinear = async (): Promise<boolean> => {
        if (!book) return false;
        let index = spineIndexOf(rendition);
        if (typeof index !== "number") {
          try {
            const loc = await Promise.resolve(
              rendition.currentLocation() as
                | { start?: { index?: number }; index?: number }
                | Promise<{ start?: { index?: number }; index?: number }>,
            );
            index =
              loc && "start" in loc && typeof loc.start?.index === "number"
                ? loc.start.index
                : loc?.index;
          } catch {
            return false;
          }
        }
        if (typeof index !== "number") return false;
        const current = book.spine.get(index);
        const next = current?.next?.();
        const href = next && "href" in next ? next.href : undefined;
        if (!href) return false;
        await rendition.display(href);
        return true;
      };

      const contents = (await waitForContents(rendition)) ?? contentsFromRendition(rendition);
      if (contents) {
        const items = nextSectionItems(contents, after);
        if (items.length) return reveal(items, contents);
      }

      const maxHops = 64;
      for (let hop = 0; hop < maxHops; hop += 1) {
        const fromIndex = contentsFromRendition(rendition)?.sectionIndex;
        const moved = await displayNextLinear();
        if (!moved) return null;
        const nextContents = await waitForContents(rendition, { notSectionIndex: fromIndex });
        if (!nextContents) return null;
        const items = nextSectionItems(nextContents, null);
        if (items.length) return reveal(items, nextContents);
      }
      return null;
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
        rendition.themes.fontSize(`${fontSize}%`);
        applyReaderThemeToRendition(rendition, themeRef.current);
        applyReaderThemeToHost(host, themeRef.current);
        applyReaderFontToRendition(rendition, fontRef.current);

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
            (payload, element) => {
              onSpeakBlockRef.current?.(payload, element, contents);
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
          applyReaderTheme(view.contents, themeRef.current);
          applyReaderThemeToHost(host, themeRef.current);
          applyReaderFont(view.contents, fontRef.current);
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
    applyReaderThemeToRendition(renditionRef.current, theme);
    applyReaderThemeToHost(hostRef.current, theme);
    applyReaderFontToRendition(renditionRef.current, fontRef.current);
  }, [theme]);

  useEffect(() => {
    applyReaderFontToRendition(renditionRef.current, font);
  }, [font]);

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
    const host = hostRef.current;
    if (!host) return;
    let lastWidth = 0;
    let lastHeight = 0;
    const observer = new ResizeObserver((entries) => {
      const rendition = renditionRef.current;
      const rect = entries[0]?.contentRect;
      if (!rendition || !rect) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width <= 0 || height <= 0 || (width === lastWidth && height === lastHeight)) return;
      lastWidth = width;
      lastHeight = height;
      try {
        rendition.resize(width, height);
      } catch {
        /* epubjs throws in Safari if the view manager is not ready yet */
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const unsubscribe = ttsEngine.subscribe(() => {
      const status = ttsEngine.status;
      const shouldClear =
        status === "idle" ||
        status === "error" ||
        (status === "ready" && (!autoPlayRef.current || !ttsEngine.currentText));
      if (!shouldClear) return;
      const iframe = hostRef.current?.querySelector("iframe");
      const doc = iframe?.contentDocument;
      if (doc) clearSpeakingHighlights(doc);
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
      <div
        ref={hostRef}
        className="h-full w-full"
        data-epub-host
        style={{ background: readerTheme(theme).background }}
      />
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
