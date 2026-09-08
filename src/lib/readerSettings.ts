import type { ReaderOrientation, ReaderTheme } from "../types";

const STORAGE_KEY = "bookworm.reader-settings";

export type StoredReaderSettings = {
  theme: ReaderTheme;
  fontSize: number;
  orientation: ReaderOrientation;
  voice: string;
  speed: number;
};

const DEFAULTS: StoredReaderSettings = {
  theme: "paper",
  fontSize: 112,
  orientation: "horizontal",
  voice: "af_heart",
  speed: 1,
};

function isTheme(value: unknown): value is ReaderTheme {
  return value === "paper" || value === "fog" || value === "dark";
}

function isOrientation(value: unknown): value is ReaderOrientation {
  return value === "horizontal" || value === "vertical";
}

function clampFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULTS.fontSize;
  return Math.min(160, Math.max(90, Math.round(value)));
}

function clampSpeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULTS.speed;
  return Math.min(1.4, Math.max(0.8, Math.round(value * 20) / 20));
}

export function loadReaderSettings(): StoredReaderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<StoredReaderSettings>;
    return {
      theme: isTheme(parsed.theme) ? parsed.theme : DEFAULTS.theme,
      fontSize: clampFontSize(parsed.fontSize),
      orientation: isOrientation(parsed.orientation) ? parsed.orientation : DEFAULTS.orientation,
      voice: typeof parsed.voice === "string" && parsed.voice ? parsed.voice : DEFAULTS.voice,
      speed: clampSpeed(parsed.speed),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveReaderSettings(patch: Partial<StoredReaderSettings>): StoredReaderSettings {
  const next: StoredReaderSettings = {
    ...loadReaderSettings(),
    ...patch,
  };
  next.fontSize = clampFontSize(next.fontSize);
  next.speed = clampSpeed(next.speed);
  if (!isTheme(next.theme)) next.theme = DEFAULTS.theme;
  if (!isOrientation(next.orientation)) next.orientation = DEFAULTS.orientation;
  if (typeof next.voice !== "string" || !next.voice) next.voice = DEFAULTS.voice;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
  return next;
}
