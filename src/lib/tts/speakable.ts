import type { Contents } from "epubjs";
import {
  collectSectionBlocks,
  headingLevel,
  listSpeakableBlocks,
  speakableTextFromElement,
} from "./extract";
import type { SelectionPayload } from "../../types";

export type SpeakSectionItem = {
  element: Element;
  payload: SelectionPayload;
};

export type SpeakAnchor = {
  element?: Element | null;
  cfi?: string;
  text?: string;
};

const SPEAKABLE_CLASS = "bookworm-speakable";
const SPEAKING_CLASS = "bookworm-speaking";
const LOADING_CLASS = "bookworm-loading";
const PLAY_BTN_CLASS = "bookworm-play-btn";

const SPEAKABLE_STYLE = `
.${SPEAKABLE_CLASS} {
  cursor: pointer !important;
  position: relative !important;
  border-radius: 6px !important;
  padding-top: 0.2em !important;
  padding-right: 0.45em !important;
  padding-bottom: 0.2em !important;
  padding-left: 2.35em !important;
  margin-top: 0.2em !important;
  margin-bottom: 0.2em !important;
  transition: background 0.15s ease !important;
  -webkit-tap-highlight-color: rgba(31, 107, 98, 0.15) !important;
}
ul, ol {
  overflow: visible !important;
}
li.${SPEAKABLE_CLASS} {
  list-style-position: inside !important;
}
.${SPEAKABLE_CLASS}::before {
  content: "" !important;
  position: absolute !important;
  left: 1.85em !important;
  top: 0.15em !important;
  bottom: 0.15em !important;
  width: 3px !important;
  border-radius: 2px !important;
  background: rgba(31, 107, 98, 0.85) !important;
  opacity: 0 !important;
  transition: opacity 0.15s ease !important;
}
.${PLAY_BTN_CLASS} {
  position: absolute !important;
  left: 0.2em !important;
  top: 0.35em !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  box-sizing: border-box !important;
  width: 1.35em !important;
  height: 1.35em !important;
  padding: 0 !important;
  margin: 0 !important;
  color: #1f6b62 !important;
  background: rgba(31, 107, 98, 0.14) !important;
  border-radius: 999px !important;
  pointer-events: none !important;
  user-select: none !important;
  opacity: 0 !important;
  transition: opacity 0.15s ease !important;
  font-size: 1em !important;
  line-height: 1 !important;
}
.${PLAY_BTN_CLASS}::before {
  content: "" !important;
  display: block !important;
  width: 0 !important;
  height: 0 !important;
  /* CSS triangle — no font metrics to fight */
  border-style: solid !important;
  border-width: 0.2em 0 0.2em 0.34em !important;
  border-color: transparent transparent transparent currentColor !important;
  /* Optical: right-pointing triangles read centered with a slight nudge */
  margin: 0 0 0 0.08em !important;
  transform: none !important;
  background: none !important;
}
.${SPEAKABLE_CLASS}:hover,
.${SPEAKABLE_CLASS}:focus-visible,
.${SPEAKABLE_CLASS}:active,
.${SPEAKING_CLASS} {
  background: rgba(31, 107, 98, 0.1) !important;
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
.${SPEAKING_CLASS} .${PLAY_BTN_CLASS},
.${LOADING_CLASS} .${PLAY_BTN_CLASS} {
  opacity: 1 !important;
}
.${SPEAKING_CLASS} {
  background: rgba(31, 107, 98, 0.2) !important;
  outline: 2px solid rgba(31, 107, 98, 0.3) !important;
  outline-offset: 2px !important;
}
.${SPEAKING_CLASS}::before {
  background: rgba(31, 107, 98, 1) !important;
}
.${LOADING_CLASS} .${PLAY_BTN_CLASS} {
  animation: bookworm-spin 0.7s linear infinite !important;
}
.${LOADING_CLASS} .${PLAY_BTN_CLASS}::before {
  content: "" !important;
  box-sizing: border-box !important;
  width: 0.55em !important;
  height: 0.55em !important;
  margin: 0 !important;
  border-style: solid !important;
  border-width: 2px !important;
  border-color: rgba(31, 107, 98, 0.25) !important;
  border-top-color: #1f6b62 !important;
  border-radius: 50% !important;
  transform: none !important;
  background: none !important;
}
@keyframes bookworm-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
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

export { listSpeakableBlocks };

function itemsFromElements(contents: Contents, elements: Element[]): SpeakSectionItem[] {
  const items: SpeakSectionItem[] = [];
  for (const element of elements) {
    const payload = payloadFromElement(element, contents);
    if (payload) items.push({ element, payload });
  }
  return items;
}

/** Speak from a heading (full section) or from a body block until the next heading. */
export function speakItemsFrom(contents: Contents, startBlock: Element): SpeakSectionItem[] {
  const blocks = listSpeakableBlocks(contents.document);
  if (headingLevel(startBlock) !== null) {
    return itemsFromElements(contents, collectSectionBlocks(blocks, startBlock));
  }
  const from = blocks.indexOf(startBlock);
  if (from < 0) {
    const payload = payloadFromElement(startBlock, contents);
    return payload ? [{ element: startBlock, payload }] : [];
  }
  const rest: Element[] = [];
  for (let index = from; index < blocks.length; index += 1) {
    if (index > from && headingLevel(blocks[index]) !== null) break;
    rest.push(blocks[index]);
  }
  return itemsFromElements(contents, rest);
}

export function speakItemsMatchingStart(
  contents: Contents,
  start: { cfi?: string; text: string },
): SpeakSectionItem[] {
  const blocks = listSpeakableBlocks(contents.document);
  let startBlock: Element | undefined;
  if (start.cfi) {
    startBlock = blocks.find((element) => {
      try {
        return contents.cfiFromNode(element) === start.cfi;
      } catch {
        return false;
      }
    });
  }
  if (!startBlock) {
    startBlock = blocks.find((element) => speakableTextFromElement(element) === start.text);
  }
  return startBlock ? speakItemsFrom(contents, startBlock) : [];
}

function indexOfSpokenBlock(
  contents: Contents,
  blocks: Element[],
  after: SpeakAnchor | Element,
): number {
  const element = after instanceof Element ? after : after.element ?? null;
  const cfi = after instanceof Element ? undefined : after.cfi;
  const text = after instanceof Element ? undefined : after.text;

  if (element && element.ownerDocument === contents.document) {
    const index = blocks.indexOf(element);
    if (index >= 0) return index;
  }
  if (cfi) {
    const index = blocks.findIndex((block) => {
      try {
        return contents.cfiFromNode(block) === cfi;
      } catch {
        return false;
      }
    });
    if (index >= 0) return index;
  }
  if (text) {
    const index = blocks.findIndex((block) => speakableTextFromElement(block) === text);
    if (index >= 0) return index;
  }
  return -1;
}

/** Next section after a spoken block, or the first section when `after` is null. */
export function nextSectionItems(
  contents: Contents,
  after: SpeakAnchor | Element | null,
): SpeakSectionItem[] {
  const blocks = listSpeakableBlocks(contents.document);
  if (!blocks.length) return [];

  let from = 0;
  if (after) {
    const index = indexOfSpokenBlock(contents, blocks, after);
    if (index < 0) return [];
    from = index + 1;
  }
  if (from >= blocks.length) return [];
  return speakItemsFrom(contents, blocks[from]);
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
    doc.head.appendChild(style);
  }
  style.textContent = SPEAKABLE_STYLE;

  const cleanups: Array<() => void> = [];
  const blocks = listSpeakableBlocks(doc);

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
    doc.querySelectorAll(`.${LOADING_CLASS}`).forEach((node) => {
      node.classList.remove(LOADING_CLASS);
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
      doc.querySelectorAll(`.${LOADING_CLASS}`).forEach((node) => {
        node.classList.remove(LOADING_CLASS);
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
      block.classList.remove(SPEAKABLE_CLASS, SPEAKING_CLASS, LOADING_CLASS);
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
    doc.querySelectorAll(`.${LOADING_CLASS}`).forEach((node) => {
      node.classList.remove(LOADING_CLASS);
    });
  };
}

export function setSpeakingHighlight(doc: Document, element: Element | null) {
  doc.querySelectorAll(`.${SPEAKING_CLASS}`).forEach((node) => {
    node.classList.remove(SPEAKING_CLASS);
  });
  if (element) {
    element.classList.remove(LOADING_CLASS);
    element.classList.add(SPEAKING_CLASS);
  }
}

export function setBlockLoading(element: Element | null, loading: boolean) {
  if (!element) return;
  if (loading) {
    // Don't decorate the block that is already being spoken.
    if (element.classList.contains(SPEAKING_CLASS)) return;
    element.classList.add(LOADING_CLASS);
  } else {
    element.classList.remove(LOADING_CLASS);
  }
}

export function clearBlockLoading(doc: Document) {
  doc.querySelectorAll(`.${LOADING_CLASS}`).forEach((node) => {
    node.classList.remove(LOADING_CLASS);
  });
}

export function clearSpeakingHighlights(doc: Document) {
  clearBlockLoading(doc);
  setSpeakingHighlight(doc, null);
}
