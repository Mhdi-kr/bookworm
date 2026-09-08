export type BookFormat = "pdf" | "epub";

export type ReaderProgress = {
  cfi?: string;
  percent?: number;
  page?: number;
};

export type Book = {
  id: string;
  format: BookFormat;
  title: string;
  authors: string[];
  isbn: string | null;
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  libraryPath: string;
  coverPath: string | null;
  coverSource: string | null;
  pageCount: number | null;
  addedAt: number;
  lastOpenedAt: number | null;
  updatedAt: number;
  progress: ReaderProgress | null;
};

export type Locator =
  | { kind: "epub"; cfi: string }
  | { kind: "pdf"; page: number };

export type SelectionPayload = {
  text: string;
  locator: Locator;
  rect: { top: number; left: number; bottom: number };
};

export type VoiceInfo = {
  id: string;
  name: string;
  language: string;
  gender: string;
};

export type ReaderTheme = "paper" | "sepia" | "dark";

/** Horizontal = paginated pages; vertical = continuous scroll. */
export type ReaderOrientation = "horizontal" | "vertical";

export type TocItem = {
  id: string;
  href: string;
  label: string;
  subitems?: TocItem[];
};
