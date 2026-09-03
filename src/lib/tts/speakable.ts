import type { Contents } from "epubjs";
import {
  collectSectionBlocks,
  headingLevel,
  SKIP_SELECTOR,
  SPEAKABLE_BLOCK_SELECTOR,
  speakableTextFromElement,
} from "./extract";
import type { SelectionPayload } from "../../types";

export type SpeakSectionItem = {
  element: Element;
  payload: SelectionPayload;
};

const SPEAKABLE_CLASS = "bookworm-speakable";
const SPEAKING_CLASS = "bookworm-speaking";
const PLAY_BTN_CLASS = "bookworm-play-btn";

const SPEAKABLE_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "dd",
  "dt",
  "td",
  "th",
]);

const SPEAKABLE_STYLE = `
.${SPEAKABLE_CLASS} {
  cursor: pointer !important;
  position: relative !important;
  border-radius: 6px !important;
  padding: 0.2em 0.45em 0.2em 2.35em !important;
  margin: 0.2em 0 !important;
  transition: background 0.15s ease !important;
  -webkit-tap-highlight-color: rgba(156, 59, 42, 0.15) !important;
}
.${SPEAKABLE_CLASS}::before {
  content: "" !important;
  position: absolute !important;
  left: 1.85em !important;
  top: 0.15em !important;
  bottom: 0.15em !important;
  width: 3px !important;
  border-radius: 2px !important;
  background: rgba(156, 59, 42, 0.85) !important;
  opacity: 0 !important;
  transition: opacity 0.15s ease !important;
}
.${PLAY_BTN_CLASS} {
  position: absolute !important;
  left: 0.2em !important;
  top: 0.35em !important;
  width: 1.35em !important;
  height: 1.35em !important;
  line-height: 1.35em !important;
  text-align: center !important;
  font-size: 0.68em !important;
  font-weight: bold !important;
  color: #9c3b2a !important;
  background: rgba(156, 59, 42, 0.14) !important;
  border-radius: 999px !important;
  pointer-events: none !important;
  user-select: none !important;
  opacity: 0 !important;
  transition: opacity 0.15s ease !important;
}
.${PLAY_BTN_CLASS}::before {
  content: "▶" !important;
}
.${SPEAKABLE_CLASS}:hover,
.${SPEAKABLE_CLASS}:focus-visible,
.${SPEAKABLE_CLASS}:active,
.${SPEAKING_CLASS} {
  background: rgba(156, 59, 42, 0.1) !important;
}
.${SPEAKABLE_CLASS}:hover::before,
.${SPEAKABLE_CLASS}:focus-visible::before,
.${SPEAKABLE_CLASS}:active::before,
.${SPEAKING_CLASS}::before {
  opacity: 1 !important;
}
.${SPEAKABLE_CLASS}:hover .${PLAY_BTN_CLASS},
.${SPEAKABLE_CLASS}:focus-visible .${PLAY_BTN_CLASS},
.${SPEAKABLE_CLASS}:active .${PLAY_BTN_CLASS},
.${SPEAKING_CLASS} .${PLAY_BTN_CLASS} {
  opacity: 1 !important;
}
.${SPEAKING_CLASS} {
  background: rgba(156, 59, 42, 0.2) !important;
  outline: 2px solid rgba(156, 59, 42, 0.3) !important;
  outline-offset: 2px !important;
}
.${SPEAKING_CLASS}::before {
  background: rgba(156, 59, 42, 1) !important;
}
`;

function frameOffset(contents: Contents) {
  const frame = contents.document.defaultView?.frameElement as Element | null;
  return frame?.getBoundingClientRect();
}

function rectFromElement(el: Element, contents: Contents) {
  const box = el.getBoundingClientRect();
  const offset = frameOffset(contents);
  return {
    top: box.top + (offset?.top ?? 0),
    left: box.left + (offset?.left ?? 0),
    bottom: box.bottom + (offset?.top ?? 0),
  };
}

function isSpeakableTag(el: Element): boolean {
  return SPEAKABLE_TAGS.has(el.localName.toLowerCase());
}

function isSpeakableBlock(el: Element): boolean {
  if (!isSpeakableTag(el)) return false;
  if (el.closest(SKIP_SELECTOR)) return false;
  // Skip containers that wrap smaller blocks (e.g. li > p keeps p, skips li).
  for (const child of el.querySelectorAll(SPEAKABLE_BLOCK_SELECTOR)) {
    if (child !== el && isSpeakableTag(child) && !child.closest(SKIP_SELECTOR)) {
      return false;
    }
  }
  return speakableTextFromElement(el).length > 0;
}

function payloadFromElement(el: Element, contents: Contents): SelectionPayload | null {
  const text = speakableTextFromElement(el);
  if (!text) return null;
  let cfi = "";
  try {
    cfi = contents.cfiFromNode(el);
  } catch {
    /* optional */
  }
  return {
    text,
    locator: { kind: "epub", cfi },
    rect: rectFromElement(el, contents),
  };
}

function injectPlayButton(doc: Document, block: Element) {
  if (block.querySelector(`.${PLAY_BTN_CLASS}`)) return;
  const btn = doc.createElement("span");
  btn.className = PLAY_BTN_CLASS;
  btn.setAttribute("aria-hidden", "true");
  block.insertBefore(btn, block.firstChild);
}

/** Mark paragraphs/headings as tap-to-speak inside an EPUB chapter iframe. */
export function attachSpeakableBlocks(
  contents: Contents,
  onSpeak: (payload: SelectionPayload, element: Element) => void,
  onPrefetch?: (text: string) => void,
  onSpeakSection?: (items: SpeakSectionItem[]) => void,
): () => void {
  const doc = contents.document;
  const win = contents.window;
  if (!doc?.body) return () => {};

  let style = doc.getElementById("bookworm-speakable-style") as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = "bookworm-speakable-style";
    style.textContent = SPEAKABLE_STYLE;
    doc.head.appendChild(style);
  }

  const cleanups: Array<() => void> = [];
  const blocks = Array.from(doc.querySelectorAll(SPEAKABLE_BLOCK_SELECTOR)).filter(isSpeakableBlock);

  const speakSectionFrom = (startBlock: Element) => {
    if (!onSpeakSection) return false;
    const level = headingLevel(startBlock);
    if (level === null) return false;
    const section = collectSectionBlocks(blocks, startBlock);
    const items: SpeakSectionItem[] = [];
    for (const element of section) {
      const payload = payloadFromElement(element, contents);
      if (payload) items.push({ element, payload });
    }
    if (!items.length) return false;
    doc.querySelectorAll(`.${SPEAKING_CLASS}`).forEach((node) => {
      node.classList.remove(SPEAKING_CLASS);
    });
    items[0].element.classList.add(SPEAKING_CLASS);
    onSpeakSection(items);
    return true;
  };

  for (const block of blocks) {
    block.classList.add(SPEAKABLE_CLASS);
    block.setAttribute("tabindex", "0");
    injectPlayButton(doc, block);

    let downX = 0;
    let downY = 0;
    let dragged = false;
    let prefetchTimer = 0;

    const onPointerEnter = () => {
      if (!onPrefetch) return;
      prefetchTimer = win.setTimeout(() => {
        const level = headingLevel(block);
        if (level !== null && onSpeakSection) {
          const section = collectSectionBlocks(blocks, block);
          const first = section[0];
          if (first) {
            const text = speakableTextFromElement(first);
            if (text) onPrefetch(text);
          }
          return;
        }
        const text = speakableTextFromElement(block);
        if (text) onPrefetch(text);
      }, 280);
    };

    const onPointerLeave = () => {
      win.clearTimeout(prefetchTimer);
    };

    const onPointerDown = (event: Event) => {
      const e = event as PointerEvent;
      downX = e.clientX;
      downY = e.clientY;
      dragged = false;
    };

    const onPointerMove = (event: Event) => {
      const e = event as PointerEvent;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10) {
        dragged = true;
      }
    };

    const activate = (event: Event) => {
      if (dragged) return;
      const live = win.getSelection();
      const selected = live?.toString().trim() ?? "";
      const blockText = speakableTextFromElement(block);
      if (selected && selected.length > 0 && selected.length < blockText.length * 0.85) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      doc.querySelectorAll(`.${SPEAKING_CLASS}`).forEach((node) => {
        node.classList.remove(SPEAKING_CLASS);
      });

      if (speakSectionFrom(block)) return;

      block.classList.add(SPEAKING_CLASS);

      const payload = payloadFromElement(block, contents);
      if (payload) onSpeak(payload, block);
    };

    const onPointerUp = (event: Event) => {
      const e = event as PointerEvent;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      activate(event);
    };
    const onKeyDown = (event: Event) => {
      const e = event as KeyboardEvent;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate(event);
      }
    };

    block.addEventListener("pointerdown", onPointerDown);
    block.addEventListener("pointermove", onPointerMove);
    block.addEventListener("pointerup", onPointerUp);
    block.addEventListener("pointerenter", onPointerEnter);
    block.addEventListener("pointerleave", onPointerLeave);
    block.addEventListener("keydown", onKeyDown);

    cleanups.push(() => {
      win.clearTimeout(prefetchTimer);
      block.classList.remove(SPEAKABLE_CLASS, SPEAKING_CLASS);
      block.removeAttribute("tabindex");
      block.querySelector(`.${PLAY_BTN_CLASS}`)?.remove();
      block.removeEventListener("pointerdown", onPointerDown);
      block.removeEventListener("pointermove", onPointerMove);
      block.removeEventListener("pointerup", onPointerUp);
      block.removeEventListener("pointerenter", onPointerEnter);
      block.removeEventListener("pointerleave", onPointerLeave);
      block.removeEventListener("keydown", onKeyDown);
    });
  }

  return () => {
    cleanups.forEach((fn) => fn());
    doc.querySelectorAll(`.${SPEAKING_CLASS}`).forEach((node) => {
      node.classList.remove(SPEAKING_CLASS);
    });
  };
}

export function setSpeakingHighlight(doc: Document, element: Element | null) {
  doc.querySelectorAll(`.${SPEAKING_CLASS}`).forEach((node) => {
    node.classList.remove(SPEAKING_CLASS);
  });
  element?.classList.add(SPEAKING_CLASS);
}

export function clearSpeakingHighlights(doc: Document) {
  setSpeakingHighlight(doc, null);
}
