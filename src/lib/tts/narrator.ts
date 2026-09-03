import type { Book as EpubBook } from "epubjs";
import type Section from "epubjs/types/section";
import type { Rendition } from "epubjs";
import { extractSpeakableText } from "./extract";
import { ttsEngine } from "./engine";

export type NarratorState = "idle" | "running" | "paused";

type Listener = () => void;

/**
 * Continuous EPUB narration: spine section by section, skips code/image-only
 * sections, advances the visible page, and keeps TTS going for lock-screen listening.
 */
export class ContinuousNarrator {
  private book: EpubBook | null = null;
  private rendition: Rendition | null = null;
  private title = "Bookworm";
  private authors = "";
  private runId = 0;
  private spineIndex = 0;
  private listeners = new Set<Listener>();
  version = 0;
  state: NarratorState = "idle";
  sectionLabel = "";

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.version += 1;
    this.listeners.forEach((fn) => fn());
  }

  bind(options: {
    book: EpubBook;
    rendition: Rendition;
    title: string;
    authors: string;
  }) {
    this.book = options.book;
    this.rendition = options.rendition;
    this.title = options.title;
    this.authors = options.authors;
  }

  unbind() {
    this.stop();
    this.book = null;
    this.rendition = null;
  }

  async startFromCurrent() {
    if (!this.book || !this.rendition) {
      throw new Error("Open a book before starting continuous play.");
    }
    await ttsEngine.unlockAudio();
    await this.book.ready;
    const location = this.rendition.currentLocation() as
      | { start?: { index?: number } }
      | Array<{ start?: { index?: number } }>
      | undefined;
    const start = Array.isArray(location) ? location[0]?.start : location?.start;
    this.spineIndex = typeof start?.index === "number" ? start.index : 0;
    this.runId += 1;
    const runId = this.runId;
    this.state = "running";
    this.emit();
    ttsEngine.setMediaMeta({
      title: this.title,
      artist: this.authors || "Bookworm",
    });
    void this.loop(runId);
  }

  pause() {
    if (this.state !== "running") return;
    this.state = "paused";
    ttsEngine.pause();
    this.emit();
  }

  resume() {
    if (this.state !== "paused") return;
    this.state = "running";
    ttsEngine.resume();
    this.emit();
  }

  stop() {
    this.runId += 1;
    this.state = "idle";
    this.sectionLabel = "";
    ttsEngine.stop();
    this.emit();
  }

  private async loop(runId: number) {
    const book = this.book;
    const rendition = this.rendition;
    if (!book || !rendition) return;

    while (runId === this.runId) {
      const section = book.spine.get(this.spineIndex) as Section | undefined;
      if (!section) {
        this.state = "idle";
        this.sectionLabel = "Finished";
        this.emit();
        return;
      }

      const linear = section.linear as boolean | string | undefined;
      if (linear === false || linear === "no") {
        this.spineIndex += 1;
        continue;
      }

      this.sectionLabel = section.href || `Section ${this.spineIndex + 1}`;
      this.emit();

      try {
        await rendition.display(section.href);
      } catch {
        /* keep audio going even if the view fails to flip */
      }

      let text = "";
      try {
        await Promise.resolve(section.load(book.load.bind(book)));
        const doc = section.document;
        text = doc ? extractSpeakableText(doc) : "";
        section.unload();
      } catch (error) {
        console.warn("[narrator] section load failed", section.href, error);
        this.spineIndex += 1;
        continue;
      }

      if (!text) {
        // Image/code-only (or empty) — skip and advance.
        this.spineIndex += 1;
        continue;
      }

      const completed = await ttsEngine.speakAndWait(text, {
        title: this.title,
        artist: this.authors || "Bookworm",
        album: this.sectionLabel,
      });

      if (runId !== this.runId) return;

      if (!completed) {
        // Stopped by user or error.
        this.state = ttsEngine.status === "error" ? "idle" : this.state === "paused" ? "paused" : "idle";
        this.emit();
        return;
      }

      this.spineIndex += 1;
    }
  }
}

export const continuousNarrator = new ContinuousNarrator();
