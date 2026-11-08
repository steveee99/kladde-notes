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

/**
 * iOS 26.1+ bug (WebKit 301108): a home-screen app installed with the translucent status bar lays out
 * in a box that ends short of the screen bottom by the status bar's height, and paints nothing below.
 * iOS keeps the status bar style an app was installed with, so old installs still have it.
 * Measure the shortfall and let the bottom bar end there: --vp-gap shrinks its safe-area padding and
 * the strip below takes the bar's color.
 */
export function fitShortViewport() {
  if ((navigator as Navigator & { standalone?: boolean }).standalone !== true) return;
  const root = document.documentElement;
  const measure = () => {
    // While typing the keyboard changes the height: keep the last measurement
    if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:env(safe-area-inset-top);visibility:hidden;pointer-events:none';
    document.body.append(probe);
    const insetTop = probe.getBoundingClientRect().height;
    probe.remove();
    const portrait = window.innerHeight >= window.innerWidth;
    const screenHeight = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    // The layout covers the status bar (inset > 0) and still ends short: that is the bug, not the keyboard
    const gap = screenHeight - window.innerHeight;
    const short = insetTop > 0 && gap > 10 && gap <= 80;
    root.style.setProperty('--vp-gap', short ? `${gap}px` : '0px');
    root.classList.toggle('short-viewport', short);
  };
  measure();
  window.addEventListener('resize', measure);
  window.addEventListener('orientationchange', () => setTimeout(measure, 300));
}
