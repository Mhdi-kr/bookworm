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
  "pre.listing",
  ".listingblock",
  ".sourceCode",
  ".programlisting",
].join(",");

const SPEAKABLE_TAGS = [
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
  "div",
  "aside",
  "section",
  "article",
  "header",
  "footer",
  "figcaption",
  "caption",
  "summary",
] as const;

const SPEAKABLE_TAG_SET = new Set<string>(SPEAKABLE_TAGS);

export const SPEAKABLE_BLOCK_SELECTOR = `${SPEAKABLE_TAGS.join(", ")}, [role='listitem']`;

export const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** Injected reader UI — must never be spoken. */
export const UI_CHROME_SELECTOR = ".bookworm-play-btn";

/** Block-level chrome to drop from a parent’s “own” text. Inline `code` stays. */
const OWN_TEXT_STRIP_SELECTOR = [
  UI_CHROME_SELECTOR,
  SPEAKABLE_BLOCK_SELECTOR,
  "pre",
  "svg",
  "math",
  "picture",
  "video",
  "audio",
  "object",
  "iframe",
  "canvas",
  "noscript",
  "template",
  "script",
  "style",
  "img",
  "[role='img']",
  "[aria-hidden='true']",
].join(",");

/** Decorative list markers. ASCII * / - / + only when followed by a space. */
const LEADING_UNICODE_BULLET =
  /^(?:[\s\u00a0]*[•◦‣⁃∙▪▫●○■□◆◇►▶▸▹➢➤※❖★☆✦✧✱✲\u2043\u25E6]\s*)+/;
const LEADING_ASCII_MARKER = /^(?:[\s\u00a0]*[-*+\u2013\u2014\u2212]\s+)/;

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

export function isSpeakableTag(el: Element): boolean {
  if (SPEAKABLE_TAG_SET.has(el.localName.toLowerCase())) return true;
  return el.getAttribute("role")?.toLowerCase() === "listitem";
}

export function isSpeakableBlock(el: Element): boolean {
  if (!isSpeakableTag(el)) return false;
  if (el.closest(SKIP_SELECTOR)) return false;
  return speakableTextFromElement(el).length > 0;
}

export function listSpeakableBlocks(doc: Document | null | undefined): Element[] {
  if (!doc) return [];
  return Array.from(doc.querySelectorAll(SPEAKABLE_BLOCK_SELECTOR)).filter(isSpeakableBlock);
}

/**
 * Text this block should speak — excluding nested speakable blocks so a parent
 * list item keeps its own line without swallowing children.
 */
export function speakableTextFromElement(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(OWN_TEXT_STRIP_SELECTOR).forEach((node) => node.remove());
  return normalizeSpeakable(clone.textContent ?? "");
}

/** Pull speakable prose from an EPUB section document, skipping code and image chrome. */
export function extractSpeakableBlocks(doc: Document): string[] {
  const texts = listSpeakableBlocks(doc).map((block) => speakableTextFromElement(block));
  if (texts.length) return texts;

  const root = doc.body ?? doc.documentElement;
  if (!root) return [];
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll(`${SKIP_SELECTOR}, ${UI_CHROME_SELECTOR}`).forEach((node) => node.remove());
  const fallback = normalizeSpeakable(clone.textContent ?? "");
  return fallback ? [fallback] : [];
}

export function extractSpeakableText(doc: Document): string {
  return extractSpeakableBlocks(doc).join("\n\n");
}

export function normalizeSpeakable(raw: string): string {
  let text = raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(LEADING_UNICODE_BULLET, "").trim();
  text = text.replace(LEADING_ASCII_MARKER, "").trim();
  if (!text || /^[\d.]+\s*$/.test(text)) return "";
  return text;
}
