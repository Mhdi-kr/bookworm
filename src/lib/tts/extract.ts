export const SKIP_SELECTOR = [
  "pre",
  "code",
  "samp",
  "kbd",
  "script",
  "style",
  "svg",
  "math",
  "img",
  "picture",
  "figure",
  "figcaption",
  "video",
  "audio",
  "object",
  "iframe",
  "canvas",
  "noscript",
  "template",
  "[role='img']",
  "[aria-hidden='true']",
  ".code",
  ".highlight",
  ".hljs",
  ".listing",
  ".sourceCode",
  ".programlisting",
].join(",");

export const SPEAKABLE_BLOCK_SELECTOR =
  "p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, td, th";

export const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** Injected reader UI — must never be spoken. */
export const UI_CHROME_SELECTOR = ".bookworm-play-btn";

const BLOCK_SELECTOR = SPEAKABLE_BLOCK_SELECTOR;

export function headingLevel(el: Element): number | null {
  const match = /^h([1-6])$/i.exec(el.localName);
  return match ? Number(match[1]) : null;
}

/** Blocks under a heading until the next heading of equal or higher level. */
export function collectSectionBlocks(orderedBlocks: Element[], startBlock: Element): Element[] {
  const startIndex = orderedBlocks.indexOf(startBlock);
  if (startIndex < 0) return [startBlock];

  const startLevel = headingLevel(startBlock);
  if (startLevel === null) return [startBlock];

  const section: Element[] = [startBlock];
  for (let index = startIndex + 1; index < orderedBlocks.length; index += 1) {
    const block = orderedBlocks[index];
    const level = headingLevel(block);
    if (level !== null && level <= startLevel) break;
    section.push(block);
  }
  return section;
}

export function speakableTextFromElement(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(UI_CHROME_SELECTOR).forEach((node) => node.remove());
  return normalizeSpeakable(clone.textContent ?? "");
}

/** Pull speakable prose from an EPUB section document, skipping code and image chrome. */
export function extractSpeakableBlocks(doc: Document): string[] {
  const root = doc.body ?? doc.documentElement;
  if (!root) return [];

  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(`${SKIP_SELECTOR}, ${UI_CHROME_SELECTOR}`).forEach((node) =>
    node.remove(),
  );

  // Drop leftover empty containers and pure-whitespace nodes.
  const blocks = Array.from(clone.querySelectorAll(BLOCK_SELECTOR));
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.closest(SKIP_SELECTOR)) continue;
    // Nested blocks: only keep leaf-ish text to avoid duplicates (e.g. li > p).
    if (block.querySelector(BLOCK_SELECTOR)) continue;
    const text = normalizeSpeakable(block.textContent ?? "");
    if (text) texts.push(text);
  }

  if (texts.length) return texts;

  // Fallback: whole cleaned body when markup is atypical.
  const fallback = normalizeSpeakable(clone.textContent ?? "");
  return fallback ? [fallback] : [];
}

export function extractSpeakableText(doc: Document): string {
  return extractSpeakableBlocks(doc).join("\n\n");
}

export function normalizeSpeakable(raw: string): string {
  return raw
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\d.]+\s*$/g, ""); // skip lone page numbers
}
