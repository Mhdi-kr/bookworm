import type { Highlight } from "../types";

export function HighlightsPanel({
  open,
  highlights,
  onClose,
  onSpeak,
  onDelete,
}: {
  open: boolean;
  highlights: Highlight[];
  onClose: () => void;
  onSpeak: (highlight: Highlight) => void;
  onDelete: (id: string) => void;
}) {
  if (!open) return null;
  return (
    <aside className="absolute inset-y-0 right-0 z-30 w-80 overflow-y-auto border-l border-paper-deep bg-paper/95 p-4 shadow-xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-serif text-xl">Highlights</h2>
        <button onClick={onClose} className="text-sm text-ink-soft">
          Close
        </button>
      </div>
      {highlights.length === 0 ? (
        <p className="text-sm text-ink-soft">Select a passage and save it to speak later.</p>
      ) : (
        <ul className="space-y-4">
          {highlights.map((highlight) => (
            <li key={highlight.id} className="rounded-xl bg-white/50 p-3">
              <p className="font-serif text-sm leading-relaxed">“{highlight.quote}”</p>
              <div className="mt-2 flex gap-3 text-xs">
                <button onClick={() => onSpeak(highlight)} className="text-oxblood">
                  Speak
                </button>
                <button onClick={() => onDelete(highlight.id)} className="text-ink-soft">
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
