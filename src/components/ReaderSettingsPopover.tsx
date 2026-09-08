import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { onPointerDownOutside } from "../lib/outsidePointer";
import { ttsEngine } from "../lib/tts/engine";
import type { ReaderOrientation, ReaderTheme } from "../types";

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function inferenceDeviceLabel(device: "webgpu" | "wasm" | null): string {
  if (!device) return "Detecting…";
  return device === "webgpu" ? "GPU · WebGPU" : "CPU · WASM";
}

export function ReaderSettingsPopover({
  theme,
  fontSize,
  orientation,
  onThemeChange,
  onFontSizeChange,
  onOrientationChange,
  onOpenChange,
}: {
  theme: ReaderTheme;
  fontSize: number;
  orientation: ReaderOrientation;
  onThemeChange: (theme: ReaderTheme) => void;
  onFontSizeChange: (size: number) => void;
  onOrientationChange: (orientation: ReaderOrientation) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const engineVersion = useSyncExternalStore(
    (listener) => ttsEngine.subscribe(listener),
    () => ttsEngine.version,
  );
  void engineVersion;
  const engine = ttsEngine;
  const voices = engine.voices.length
    ? engine.voices
    : [{ id: "af_heart", name: "Heart", language: "en", gender: "f" }];
  const speechBusy = engine.status === "loading" || engine.status === "preparing";

  function setOpenState(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenState(false);
    };
    const stopOutside = onPointerDownOutside(root, () => setOpenState(false));
    window.addEventListener("keydown", onKeyDown);
    return () => {
      stopOutside();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Settings"
        aria-expanded={open}
        aria-controls={panelId}
        title="Settings"
        onClick={() => setOpenState(!open)}
        className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
          open ? "bg-sepia text-ink" : "bg-white/10 text-sepia hover:bg-white/15"
        }`}
      >
        <GearIcon />
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Reader settings"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-paper-deep bg-ink p-4 text-sepia shadow-2xl"
        >
          <Section title="Reading">
            <label className="mb-3 block text-xs">
              <span className="mb-1.5 flex items-center justify-between text-sepia/70">
                <span>Font size</span>
                <span className="tabular-nums text-sepia">{fontSize}%</span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-white/10 px-2.5 py-1.5 text-sm hover:bg-white/15"
                  onClick={() => onFontSizeChange(Math.max(90, fontSize - 8))}
                >
                  A−
                </button>
                <input
                  type="range"
                  min={90}
                  max={160}
                  step={4}
                  value={fontSize}
                  onChange={(event) => onFontSizeChange(Number(event.target.value))}
                  className="w-full accent-gold"
                />
                <button
                  type="button"
                  className="rounded-lg bg-white/10 px-2.5 py-1.5 text-sm hover:bg-white/15"
                  onClick={() => onFontSizeChange(Math.min(160, fontSize + 8))}
                >
                  A+
                </button>
              </div>
            </label>
            <fieldset className="mb-3 block text-xs">
              <legend className="mb-1.5 text-sepia/70">Theme</legend>
              <div className="flex gap-1.5">
                {(["paper", "fog", "dark"] as ReaderTheme[]).map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => onThemeChange(name)}
                    className={`flex-1 rounded-lg px-2 py-2 capitalize transition ${
                      theme === name ? "bg-sepia text-ink" : "bg-white/10 hover:bg-white/15"
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="block text-xs">
              <legend className="mb-1.5 text-sepia/70">Orientation</legend>
              <div className="flex gap-1.5">
                {(
                  [
                    { id: "horizontal", label: "Horizontal" },
                    { id: "vertical", label: "Vertical" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onOrientationChange(option.id)}
                    className={`flex-1 rounded-lg px-2 py-2 transition ${
                      orientation === option.id
                        ? "bg-sepia text-ink"
                        : "bg-white/10 hover:bg-white/15"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-sepia/60">
                {orientation === "horizontal"
                  ? "Paginated pages — swipe or use side arrows."
                  : "Continuous vertical scrolling."}
              </p>
            </fieldset>
          </Section>

          <Section title="Speech">
            <label className="mb-3 block text-xs">
              <span className="mb-1.5 block text-sepia/70">Voice</span>
              <select
                value={engine.voice}
                onChange={(event) => engine.setVoice(event.target.value)}
                className="w-full rounded-lg bg-white/10 px-2.5 py-2 text-sm"
                disabled={speechBusy}
              >
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-3 block text-xs">
              <span className="mb-1.5 flex items-center justify-between text-sepia/70">
                <span>Speed</span>
                <span className="tabular-nums text-sepia">{engine.speed.toFixed(2)}×</span>
              </span>
              <input
                type="range"
                min={0.8}
                max={1.4}
                step={0.05}
                value={engine.speed}
                onChange={(event) => engine.setSpeed(Number(event.target.value))}
                className="w-full accent-gold"
                disabled={speechBusy}
              />
            </label>
            <div className="text-xs">
              <span className="text-sepia/70">Inference device</span>
              <p className="mt-1 font-medium text-sepia">
                {inferenceDeviceLabel(engine.inferenceDevice)}
              </p>
            </div>
          </Section>
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4 border-b border-white/10 pb-4 last:mb-0 last:border-b-0 last:pb-0">
      <p className="mb-3 text-[11px] uppercase tracking-[0.2em] text-gold">{title}</p>
      {children}
    </div>
  );
}
