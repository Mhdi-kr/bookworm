import type { SelectionPayload } from "../types";

export function SelectionMenu({
  selection,
  onSpeak,
}: {
  selection: SelectionPayload;
  onSpeak: () => void;
}) {
  const top = Math.max(12, selection.rect.top - 48);
  const left = Math.min(window.innerWidth - 220, Math.max(12, selection.rect.left));
  return (
    <div
      data-selection-menu
      className="fixed z-[100] flex overflow-hidden rounded-full bg-ink text-sepia shadow-xl"
      style={{ top, left }}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
    >
      <button type="button" onClick={onSpeak} className="px-4 py-2 text-sm hover:bg-white/10">
        Speak
      </button>
    </div>
  );
}
