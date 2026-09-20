import type { Contents, Rendition } from "epubjs";
import type { ReaderFont } from "../types";

import literataLatin from "@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url";
import literataLatinItalic from "@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url";
import literataLatinExt from "@fontsource-variable/literata/files/literata-latin-ext-wght-normal.woff2?url";
import literataLatinExtItalic from "@fontsource-variable/literata/files/literata-latin-ext-wght-italic.woff2?url";
import baskerville400 from "@fontsource/libre-baskerville/files/libre-baskerville-latin-400-normal.woff2?url";
import baskerville400Italic from "@fontsource/libre-baskerville/files/libre-baskerville-latin-400-italic.woff2?url";
import baskerville700 from "@fontsource/libre-baskerville/files/libre-baskerville-latin-700-normal.woff2?url";
import baskerville700Italic from "@fontsource/libre-baskerville/files/libre-baskerville-latin-700-italic.woff2?url";
import openDyslexic400 from "@fontsource/opendyslexic/files/opendyslexic-latin-400-normal.woff2?url";
import openDyslexic400Italic from "@fontsource/opendyslexic/files/opendyslexic-latin-400-italic.woff2?url";
import openDyslexic700 from "@fontsource/opendyslexic/files/opendyslexic-latin-700-normal.woff2?url";
import openDyslexic700Italic from "@fontsource/opendyslexic/files/opendyslexic-latin-700-italic.woff2?url";

export const READER_FONTS = [
  {
    id: "literata",
    label: "Literata",
    cssFamily: '"Literata Variable", Literata, Georgia, serif',
    lineHeight: "1.7",
  },
  {
    id: "georgia",
    label: "Georgia",
    cssFamily: 'Georgia, "Palatino Linotype", Palatino, serif',
    lineHeight: "1.7",
  },
  {
    id: "baskerville",
    label: "Baskerville",
    cssFamily: '"Libre Baskerville", Baskerville, Georgia, serif',
    lineHeight: "1.7",
  },
  {
    id: "opendyslexic",
    label: "OpenDyslexic",
    cssFamily: 'OpenDyslexic, sans-serif',
    lineHeight: "1.85",
  },
] as const satisfies ReadonlyArray<{
  id: ReaderFont;
  label: string;
  cssFamily: string;
  lineHeight: string;
}>;

export const DEFAULT_READER_FONT: ReaderFont = "literata";

const STYLE_KEY = "bookworm-reader-font";
const PARENT_STYLE_ID = "bookworm-reader-font-faces";

const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

const TEXT_SELECTOR =
  "html, body, p, div, span, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, article, section, header, footer, aside, figcaption, dt, dd";

export function isReaderFont(value: unknown): value is ReaderFont {
  return READER_FONTS.some((font) => font.id === value);
}

export function readerFontOption(id: ReaderFont) {
  return READER_FONTS.find((font) => font.id === id) ?? READER_FONTS[0];
}

function absoluteUrl(assetUrl: string): string {
  try {
    return new URL(assetUrl, window.location.href).href;
  } catch {
    return assetUrl;
  }
}

function fontFace(options: {
  family: string;
  url: string;
  style?: string;
  weight?: string;
  format?: string;
  unicodeRange?: string;
}): string {
  const style = options.style ?? "normal";
  const weight = options.weight ?? "400";
  const format = options.format ?? "woff2";
  const range = options.unicodeRange ? `unicode-range:${options.unicodeRange};` : "";
  return `@font-face{font-family:${options.family};font-style:${style};font-weight:${weight};font-display:swap;src:url("${absoluteUrl(options.url)}") format("${format}");${range}}`;
}

function fontFaceCss(): string {
  return [
    fontFace({
      family: '"Literata Variable"',
      url: literataLatin,
      weight: "200 900",
      format: "woff2-variations",
      unicodeRange: LATIN,
    }),
    fontFace({
      family: '"Literata Variable"',
      url: literataLatinItalic,
      style: "italic",
      weight: "200 900",
      format: "woff2-variations",
      unicodeRange: LATIN,
    }),
    fontFace({
      family: '"Literata Variable"',
      url: literataLatinExt,
      weight: "200 900",
      format: "woff2-variations",
      unicodeRange: LATIN_EXT,
    }),
    fontFace({
      family: '"Literata Variable"',
      url: literataLatinExtItalic,
      style: "italic",
      weight: "200 900",
      format: "woff2-variations",
      unicodeRange: LATIN_EXT,
    }),
    fontFace({ family: '"Libre Baskerville"', url: baskerville400 }),
    fontFace({ family: '"Libre Baskerville"', url: baskerville400Italic, style: "italic" }),
    fontFace({ family: '"Libre Baskerville"', url: baskerville700, weight: "700" }),
    fontFace({
      family: '"Libre Baskerville"',
      url: baskerville700Italic,
      style: "italic",
      weight: "700",
    }),
    fontFace({ family: "OpenDyslexic", url: openDyslexic400 }),
    fontFace({ family: "OpenDyslexic", url: openDyslexic400Italic, style: "italic" }),
    fontFace({ family: "OpenDyslexic", url: openDyslexic700, weight: "700" }),
    fontFace({ family: "OpenDyslexic", url: openDyslexic700Italic, style: "italic", weight: "700" }),
  ].join("");
}

function overrideCss(font: ReaderFont): string {
  const option = readerFontOption(font);
  return `${TEXT_SELECTOR}{font-family:${option.cssFamily} !important;line-height:${option.lineHeight} !important;}code,kbd,pre,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace !important;}`;
}

function stylesheetFor(font: ReaderFont): string {
  return `${fontFaceCss()}${overrideCss(font)}`;
}

/** Load faces in the app chrome so the settings picker can preview them. */
export function ensureParentReaderFontFaces() {
  if (typeof document === "undefined") return;
  if (document.getElementById(PARENT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PARENT_STYLE_ID;
  style.textContent = fontFaceCss();
  document.head.appendChild(style);
}

export function applyReaderFont(contents: Contents | undefined, font: ReaderFont) {
  if (!contents?.document) return;
  void contents.addStylesheetCss(stylesheetFor(font), STYLE_KEY);
}

export function applyReaderFontToRendition(rendition: Rendition | null, font: ReaderFont) {
  if (!rendition) return;
  const contentsList = rendition.getContents();
  const list = Array.isArray(contentsList) ? contentsList : [contentsList];
  for (const contents of list) {
    applyReaderFont(contents as Contents | undefined, font);
  }
}
