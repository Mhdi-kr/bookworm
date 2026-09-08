import { useSyncExternalStore, type ReactNode } from "react";
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

/** Dim when idle so page text underneath stays readable; brighten on hover/focus. */
function DimShell({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 p-4">
      <div className="pointer-events-auto mx-auto max-w-4xl opacity-40 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100">
        {children}
      </div>
    </div>
  );
}

function useEngine() {
  const version = useSyncExternalStore(
    (listener) => ttsEngine.subscribe(listener),
    () => ttsEngine.version,
  );
  void version;
  return ttsEngine;
}

function ModelLoadingBar() {
  const engine = useEngine();
  if (engine.status !== "loading") return null;

  return (
    <DimShell>
      <div className="flex items-center gap-3 rounded-2xl border border-paper-deep bg-ink/80 px-4 py-3 text-sepia shadow-2xl backdrop-blur-sm">
        <div
          className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-gold/30 border-t-gold"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.2em] text-gold">Voice model</p>
          <p className="truncate font-serif text-base text-sepia/90">
            {engine.downloadLabel || "Loading voice model…"}
          </p>
        </div>
      </div>
    </DimShell>
  );
}

function ErrorBar() {
  const engine = useEngine();
  if (engine.status !== "error") return null;

  return (
    <DimShell>
      <div className="flex items-center gap-3 rounded-2xl border border-oxblood/40 bg-ink/80 px-4 py-3 text-sepia shadow-2xl backdrop-blur-sm">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.2em] text-gold">Voice error</p>
          <p className="truncate font-serif text-base">{engine.error || "Something went wrong."}</p>
        </div>
        <IconButton label="Dismiss" onClick={() => engine.stop()}>
          <StopIcon />
        </IconButton>
      </div>
    </DimShell>
  );
}

function PlaybackBar() {
  const engine = useEngine();
  const active =
    engine.status === "preparing" ||
    engine.status === "speaking" ||
    engine.status === "paused" ||
    (engine.status === "ready" && engine.currentText.length > 0);

  if (!active) return null;

  const buffering = engine.status === "preparing";
  const paused = engine.status === "paused";
  const playing = engine.status === "speaking";
  const transport: "idle" | "buffering" | "playing" | "paused" = paused
    ? "paused"
    : playing
      ? "playing"
      : buffering
        ? "buffering"
        : "idle";

  const label = buffering
    ? "Synthesizing speech…"
    : playing
      ? engine.offlineReady && engine.cachedModelFiles > 0
        ? "Reading aloud · cached offline"
        : "Reading aloud"
      : paused
        ? "Paused"
        : "Ready";

  const gist = gistText(engine.currentText);
  const showPlayIcon = transport === "paused" || transport === "idle";
  const pauseEnabled =
    transport === "playing" || transport === "paused" || transport === "buffering";
  const pauseLabel =
    transport === "paused" ? "Resume" : transport === "buffering" ? "Cancel" : "Pause";

  return (
    <DimShell>
      <div className="flex items-center gap-3 rounded-2xl border border-paper-deep bg-ink/80 px-4 py-3 text-sepia shadow-2xl backdrop-blur-sm sm:gap-4">
        {buffering ? (
          <div
            className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-gold/30 border-t-gold"
            aria-hidden
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.2em] text-gold">{label}</p>
          <p
            className={`truncate font-serif text-base ${buffering ? "text-sepia/80" : ""}`}
            title={engine.currentText || undefined}
          >
            {gist || "Tap a paragraph to hear it read aloud."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton
            label={pauseLabel}
            onClick={() => {
              if (engine.status === "paused") void engine.resume();
              else engine.pause();
            }}
            disabled={!pauseEnabled}
            active={transport === "paused"}
          >
            {showPlayIcon ? <PlayIcon /> : <PauseIcon />}
          </IconButton>
          <IconButton label="Stop" onClick={() => engine.stop()}>
            <StopIcon />
          </IconButton>
        </div>
      </div>
    </DimShell>
  );
}

/** Task-specific bottom bars — model load vs section playback vs error. */
export function BottomBars() {
  const engine = useEngine();
  if (engine.status === "loading") return <ModelLoadingBar />;
  if (engine.status === "error") return <ErrorBar />;
  return <PlaybackBar />;
}
