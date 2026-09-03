import { useSyncExternalStore, type ReactNode } from "react";
import { continuousNarrator } from "../lib/tts/narrator";
import { ttsEngine } from "../lib/tts/engine";

function gistText(text: string, maxLength = 84): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  const slice = normalized.slice(0, maxLength);
  const breakAt = slice.lastIndexOf(" ");
  const head = (breakAt > maxLength * 0.45 ? slice.slice(0, breakAt) : slice).trim();
  return `${head}…`;
}

function inferenceDeviceLabel(device: "webgpu" | "wasm" | null): string {
  if (!device) return "Detecting…";
  return device === "webgpu" ? "GPU · WebGPU" : "CPU · WASM";
}

type TransportMode = "idle" | "buffering" | "playing" | "paused";

function transportMode(engine: typeof ttsEngine, continuous: boolean): TransportMode {
  if (continuous) {
    if (continuousNarrator.state === "paused") return "paused";
    if (continuousNarrator.state === "running") {
      if (engine.status === "speaking") return "playing";
      if (engine.status === "paused") return "paused";
      return "buffering";
    }
    return "idle";
  }
  if (engine.status === "paused") return "paused";
  if (engine.status === "speaking") return "playing";
  if (engine.status === "loading" || engine.status === "preparing") return "buffering";
  return "idle";
}

function statusLabel(engine: typeof ttsEngine, continuous: boolean): string {
  if (engine.status === "loading") {
    return engine.downloadLabel || "Loading voice model";
  }
  if (engine.status === "preparing") {
    return "Synthesizing speech…";
  }
  if (engine.status === "error") {
    return "Voice error";
  }
  if (continuous) {
    if (continuousNarrator.state === "paused") return "Paused · continuous play";
    return `Playing book · ${continuousNarrator.sectionLabel || "reading"}`;
  }
  if (engine.status === "speaking") {
    return engine.offlineReady && engine.cachedModelFiles > 0
      ? "Reading aloud · cached offline"
      : "Reading aloud";
  }
  if (engine.status === "paused") {
    return "Paused";
  }
  return "Ready";
}

function IconButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
        active
          ? "bg-sepia text-ink"
          : "border border-sepia/35 text-sepia hover:bg-white/10 disabled:opacity-40"
      }`}
    >
      {children}
    </button>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="3.5" y="2.5" width="3" height="11" rx="0.75" />
      <rect x="9.5" y="2.5" width="3" height="11" rx="0.75" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4.5 2.8c0-.9 1-.4 1-.4l7.2 4.4c.7.4.7 1.4 0 1.8L5.5 13c0 0-1 .5-1-.4V2.8z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.25" />
    </svg>
  );
}

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

export function TtsBar() {
  const engineVersion = useSyncExternalStore(
    (listener) => ttsEngine.subscribe(listener),
    () => ttsEngine.version,
  );
  const narratorVersion = useSyncExternalStore(
    (listener) => continuousNarrator.subscribe(listener),
    () => continuousNarrator.version,
  );
  void engineVersion;
  void narratorVersion;

  const engine = ttsEngine;
  const continuous = continuousNarrator.state !== "idle";
  const busy = engine.status === "loading" || engine.status === "preparing";
  const visible =
    continuous ||
    engine.status === "loading" ||
    engine.status === "preparing" ||
    engine.status === "speaking" ||
    engine.status === "paused" ||
    engine.status === "error" ||
    (engine.status === "ready" && engine.currentText.length > 0);

  if (!visible) return null;

  const label = statusLabel(engine, continuous);
  const transport = transportMode(engine, continuous);
  const gist = engine.error ? "" : gistText(engine.currentText);
  const showPlayIcon = transport === "paused" || transport === "idle";
  const pauseEnabled =
    transport === "playing" || transport === "paused" || transport === "buffering";
  const pauseLabel =
    transport === "paused" ? "Resume" : transport === "buffering" ? "Cancel" : "Pause";

  function onPauseToggle() {
    if (continuous) {
      if (continuousNarrator.state === "paused") continuousNarrator.resume();
      else continuousNarrator.pause();
      return;
    }
    if (engine.status === "paused") void engine.resume();
    else engine.pause();
  }

  function onStop() {
    if (continuous) continuousNarrator.stop();
    else engine.stop();
  }

  const voices = engine.voices.length
    ? engine.voices
    : [{ id: "af_heart", name: "Heart", language: "en", gender: "f" }];

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 p-4">
      <div className="pointer-events-auto mx-auto flex max-w-4xl items-center gap-3 rounded-2xl border border-paper-deep bg-ink/95 px-4 py-3 text-sepia shadow-2xl sm:gap-4">
        {busy ? (
          <div
            className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-gold/30 border-t-gold"
            aria-hidden
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.2em] text-gold">{label}</p>
          <p
            className={`truncate font-serif text-base ${busy ? "text-sepia/80" : ""}`}
            title={engine.error ? undefined : engine.currentText || undefined}
          >
            {engine.error || gist || "Tap a paragraph to hear it read aloud."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton
            label={pauseLabel}
            onClick={onPauseToggle}
            disabled={!pauseEnabled}
            active={transport === "paused"}
          >
            {showPlayIcon ? <PlayIcon /> : <PauseIcon />}
          </IconButton>
          <IconButton label="Stop" onClick={onStop}>
            <StopIcon />
          </IconButton>
          <div className="group/settings relative -mb-2 pb-2">
            <button
              type="button"
              aria-label="Speech settings"
              title="Speech settings"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-sepia/35 text-sepia transition hover:bg-white/10"
            >
              <GearIcon />
            </button>
            <div className="pointer-events-none absolute bottom-full right-0 z-50 w-64 translate-y-1 pt-2 opacity-0 transition duration-150 group-hover/settings:pointer-events-auto group-hover/settings:translate-y-0 group-hover/settings:opacity-100">
              <div className="rounded-xl border border-paper-deep bg-ink p-4 text-sepia shadow-2xl">
                <p className="mb-3 text-[11px] uppercase tracking-[0.2em] text-gold">Speech</p>
                <label className="mb-3 block text-xs">
                  <span className="mb-1.5 block text-sepia/70">Voice</span>
                  <select
                    value={engine.voice}
                    onChange={(event) => engine.setVoice(event.target.value)}
                    className="w-full rounded-lg bg-white/10 px-2.5 py-2 text-sm"
                    disabled={busy}
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
                    disabled={busy}
                  />
                </label>
                <div className="border-t border-white/10 pt-3 text-xs">
                  <span className="text-sepia/70">Inference device</span>
                  <p className="mt-1 font-medium text-sepia">
                    {inferenceDeviceLabel(engine.inferenceDevice)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
