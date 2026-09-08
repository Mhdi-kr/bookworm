/**
 * Run `handler` when a pointer goes down outside `root`.
 * Also listens on same-origin iframe documents (EPUB content), because those
 * events do not bubble to the parent window.
 */
export function onPointerDownOutside(root: HTMLElement, handler: () => void): () => void {
  const onPointerDown = (event: Event) => {
    const target = event.target as Node | null;
    if (target && root.contains(target)) return;
    handler();
  };

  const cleanups: Array<() => void> = [];

  window.addEventListener("pointerdown", onPointerDown, true);
  cleanups.push(() => window.removeEventListener("pointerdown", onPointerDown, true));

  document.querySelectorAll("iframe").forEach((iframe) => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      doc.addEventListener("pointerdown", onPointerDown, true);
      cleanups.push(() => doc.removeEventListener("pointerdown", onPointerDown, true));
    } catch {
      /* cross-origin */
    }
  });

  // Focus entering the book iframe blurs the parent without a parent pointerdown.
  const onBlur = () => {
    requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLIFrameElement) handler();
    });
  };
  window.addEventListener("blur", onBlur);
  cleanups.push(() => window.removeEventListener("blur", onBlur));

  return () => cleanups.forEach((fn) => fn());
}
