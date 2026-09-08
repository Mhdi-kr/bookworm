import { useEffect, useId, useRef } from "react";
import type { TocItem } from "../types";

function ListIcon() {
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
      <line x1="8" x2="21" y1="6" y2="6" />
      <line x1="8" x2="21" y1="12" y2="12" />
      <line x1="8" x2="21" y1="18" y2="18" />
      <line x1="3" x2="3.01" y1="6" y2="6" />
      <line x1="3" x2="3.01" y1="12" y2="12" />
      <line x1="3" x2="3.01" y1="18" y2="18" />
    </svg>
  );
}

function normalizeHref(href: string) {
  return decodeURIComponent(href.split("#")[0].replace(/^\.\//, "")).toLowerCase();
}

function isActiveHref(itemHref: string, currentHref: string | null) {
  if (!currentHref) return false;
  const item = normalizeHref(itemHref);
  const current = normalizeHref(currentHref);
  return item === current || current.endsWith(item) || item.endsWith(current);
}

function TocTree({
  items,
  depth,
  currentHref,
  onSelect,
}: {
  items: TocItem[];
  depth: number;
  currentHref: string | null;
  onSelect: (href: string) => void;
}) {
  return (
    <ul className={depth === 0 ? "space-y-0.5" : "mt-0.5 space-y-0.5 border-l border-white/10 pl-2"}>
      {items.map((item) => {
        const active = isActiveHref(item.href, currentHref);
        return (
          <li key={`${item.id}-${item.href}`}>
            <button
              type="button"
              onClick={() => onSelect(item.href)}
              className={`w-full rounded-lg px-2.5 py-2 text-left text-sm transition ${
                active ? "bg-sepia/20 text-gold" : "text-sepia hover:bg-white/10"
              }`}
              style={{ paddingLeft: `${0.625 + depth * 0.55}rem` }}
            >
              <span className="line-clamp-2 font-serif leading-snug">{item.label.trim() || "Untitled"}</span>
            </button>
            {item.subitems?.length ? (
              <TocTree
                items={item.subitems}
                depth={depth + 1}
                currentHref={currentHref}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function TocPanel({
  open,
  items,
  currentHref,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  items: TocItem[];
  currentHref: string | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (href: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Table of contents"
        aria-expanded={open}
        aria-controls={panelId}
        title="Contents"
        onClick={() => onOpenChange(!open)}
        disabled={items.length === 0}
        className={`flex h-9 w-9 items-center justify-center rounded-full transition disabled:opacity-40 ${
          open ? "bg-sepia text-ink" : "bg-white/10 text-sepia hover:bg-white/15"
        }`}
      >
        <ListIcon />
      </button>

      {open ? (
        <aside
          id={panelId}
          role="dialog"
          aria-label="Table of contents"
          className="absolute right-0 top-full z-50 mt-2 flex max-h-[min(70vh,28rem)] w-[min(20rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-paper-deep bg-ink text-sepia shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.2em] text-gold">Contents</p>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="text-xs text-sepia/70 hover:text-sepia"
            >
              Close
            </button>
          </div>
          <div className="overflow-y-auto px-2 py-2">
            {items.length === 0 ? (
              <p className="px-2.5 py-4 text-sm text-sepia/70">No table of contents in this book.</p>
            ) : (
              <TocTree
                items={items}
                depth={0}
                currentHref={currentHref}
                onSelect={(href) => {
                  onSelect(href);
                  onOpenChange(false);
                }}
              />
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
