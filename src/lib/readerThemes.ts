import type { Contents, Rendition } from "epubjs";
import type { ReaderTheme } from "../types";

export const READER_THEMES = {
  paper: {
    id: "paper" as const,
    background: "#e3e9e6",
    color: "#14201b",
    link: "#1f6b62",
  },
  fog: {
    id: "fog" as const,
    background: "#dfe6eb",
    color: "#1a2430",
    link: "#2a6b7c",
  },
  dark: {
    id: "dark" as const,
    background: "#121a17",
    color: "#d5e0db",
    link: "#8ebfb4",
  },
} as const satisfies Record<
  ReaderTheme,
  { id: ReaderTheme; background: string; color: string; link: string }
>;

const STYLE_KEY = "bookworm-reader-theme";

const TEXT_SELECTOR =
  "html, body, p, div, span, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, article, section, header, footer, aside, figcaption, dt, dd, em, i, strong, b";

export function readerTheme(theme: ReaderTheme) {
  return READER_THEMES[theme] ?? READER_THEMES.paper;
}

function stylesheetFor(theme: ReaderTheme): string {
  const { background, color, link } = readerTheme(theme);
  return [
    `html,body{background:${background} !important;color:${color} !important;}`,
    `body{padding:0 7% !important;-webkit-user-select:text !important;user-select:text !important;}`,
    `${TEXT_SELECTOR}{color:${color} !important;}`,
    `a,a:link,a:visited{color:${link} !important;}`,
  ].join("");
}

export function applyReaderTheme(contents: Contents | undefined, theme: ReaderTheme) {
  if (!contents?.document) return;
  void contents.addStylesheetCss(stylesheetFor(theme), STYLE_KEY);
  const bg = readerTheme(theme).background;
  const doc = contents.document;
  doc.documentElement.style.background = bg;
  if (doc.body) doc.body.style.background = bg;
  const frame = doc.defaultView?.frameElement as HTMLElement | null;
  if (frame) frame.style.background = bg;
}

export function applyReaderThemeToRendition(rendition: Rendition | null, theme: ReaderTheme) {
  if (!rendition) return;
  const contentsList = rendition.getContents();
  const list = Array.isArray(contentsList) ? contentsList : [contentsList];
  for (const contents of list) {
    applyReaderTheme(contents as Contents | undefined, theme);
  }
}

export function applyReaderThemeToHost(host: HTMLElement | null, theme: ReaderTheme) {
  if (!host) return;
  const bg = readerTheme(theme).background;
  host.style.background = bg;
  host.querySelectorAll("iframe").forEach((frame) => {
    (frame as HTMLElement).style.background = bg;
  });
}
