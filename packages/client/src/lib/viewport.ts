/**
 * iOS scrolls the window to keep the caret visible while the keyboard is open and does not always
 * scroll back when it closes. The document is not meant to scroll (see index.css), so any window
 * scroll is such a leftover: reset it once the keyboard closes, focus leaves a field or the device turns.
 */
export function pinViewport() {
  const reset = () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  const vv = window.visualViewport;
  let lastHeight = vv?.height ?? 0;
  vv?.addEventListener('resize', () => {
    // Height grows back: the keyboard closed
    if (vv.height > lastHeight) reset();
    lastHeight = vv.height;
  });
  // Focus may move straight to another field; only reset when nothing editable keeps it
  document.addEventListener('focusout', () =>
    setTimeout(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !(el.isContentEditable || el.matches('input, textarea, select'))) reset();
    }, 50)
  );
  window.addEventListener('orientationchange', () => setTimeout(reset, 300));
}
