import { useEffect, useState } from 'react';

/** True when the primary input mechanism is a touch screen / coarse pointer */
export const isCoarsePointer = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

/**
 * Tracks the visual viewport. When an on-screen keyboard appears on mobile devices,
 * this provides the visible area offset and height so modals and sheets stay visible.
 */
export function useVisualViewport(): { top: number; height: number; keyboardOpen: boolean } | null {
  const [vp, setVp] = useState<{ top: number; height: number; keyboardOpen: boolean } | null>(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return null;
    const vv = window.visualViewport;
    const keyboardOpen = window.innerHeight - vv.height > 100;
    return { top: vv.offsetTop, height: vv.height, keyboardOpen };
  });

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const keyboardOpen = window.innerHeight - vv.height > 100;
      setVp({ top: vv.offsetTop, height: vv.height, keyboardOpen });
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return vp;
}

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
 * iOS keeps the layout as tall as the screen while the keyboard is open and pans the window so the
 * caret stays visible. The document does not scroll (index.css), so the part above, with the note's
 * header bar, could no longer be reached. While the keyboard is open the app is made exactly as tall as
 * the visible area (`html.keyboard-open`, `--kb-vh`) and the window stays at the top, so every
 * scroll happens inside the app's own scroll areas. Android resizes the layout itself
 * (interactive-widget=resizes-content), so the gap stays below the threshold there.
 */
export function fitKeyboardViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let frame = 0;
  let wasOpen = false;
  /** Once the app has shrunk, the caret may sit below the visible area: scroll its container */
  const revealCaret = () => {
    const sel = document.getSelection();
    const el = document.activeElement as HTMLElement | null;
    if (!sel?.rangeCount || !el) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.height) return;
    const overflow = rect.bottom - (vv.height - 72);
    const underTop = rect.top - 72;
    if (overflow <= 0 && underTop >= 0) return;
    let box: HTMLElement | null = el.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    box?.scrollBy({ top: overflow > 0 ? overflow : underTop });
  };
  const update = () => {
    frame = 0;
    const editing = !!document.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
    const open = editing && window.innerHeight - vv.height > 100;
    root.classList.toggle('keyboard-open', open);
    if (open) {
      root.style.setProperty('--kb-vh', `${Math.round(vv.height)}px`);
      if (window.scrollY !== 0 || vv.offsetTop !== 0) window.scrollTo(0, 0);
      if (!wasOpen) requestAnimationFrame(revealCaret);
    } else {
      root.style.removeProperty('--kb-vh');
    }
    wasOpen = open;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', () => setTimeout(schedule, 60));
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

/** Snapshot of everything the iOS layout depends on, for the diagnostics in Settings */
export function viewportReport(): Record<string, unknown> {
  const inset = (side: 'top' | 'bottom') => {
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;left:0;top:0;width:0;height:env(safe-area-inset-${side});visibility:hidden;pointer-events:none`;
    document.body.append(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return h;
  };
  // Where a fixed box with bottom:0 actually ends: the bottom of the layout viewport as the page sees it
  const edge = document.createElement('div');
  edge.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:1px;visibility:hidden;pointer-events:none';
  document.body.append(edge);
  const fixedBottom = edge.getBoundingClientRect().bottom;
  edge.remove();
  const root = document.documentElement;
  const vv = window.visualViewport;
  const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
  const box = (sel: string) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { top: r.top, bottom: r.bottom, height: r.height, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom };
  };
  return {
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone ?? null,
    displayModeStandalone: matchMedia('(display-mode: standalone)').matches,
    statusBarMeta: meta('apple-mobile-web-app-status-bar-style'),
    insetTop: inset('top'),
    insetBottom: inset('bottom'),
    screen: [screen.width, screen.height, screen.availHeight],
    inner: [window.innerWidth, window.innerHeight],
    outer: [window.outerWidth, window.outerHeight],
    client: [root.clientWidth, root.clientHeight],
    visualViewport: vv ? [vv.width, vv.height, vv.offsetTop, vv.pageTop, vv.scale] : null,
    fixedBottom,
    html: box('html'),
    body: box('body'),
    root: box('#root'),
    header: box('header'),
    main: box('main'),
    nav: box('nav'),
    htmlStyleHeight: root.style.height || null,
    scroll: [window.scrollX, window.scrollY],
    vpGap: root.style.getPropertyValue('--vp-gap') || null,
    shortClass: root.classList.contains('short-viewport'),
    orientation: screen.orientation?.type ?? null,
    userAgent: navigator.userAgent,
  };
}

/**
 * Diagnostics experiment: make the page as tall as the screen. If iOS then hands over the full
 * viewport (WebKit 301108 behaves like that), innerHeight grows to screen height. Undone on reload.
 */
export function toggleTallPageTest(): boolean {
  const root = document.documentElement;
  if (root.style.height) {
    root.style.height = '';
    return false;
  }
  const portrait = window.innerHeight >= window.innerWidth;
  root.style.height = `${portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height)}px`;
  return true;
}

/** The report right after start: iOS may hand over a different viewport once the app has run a while */
export let startupReport: Record<string, unknown> | null = null;
export function recordStartupReport() {
  const take = () => setTimeout(() => (startupReport = viewportReport()), 500);
  if (document.readyState === 'complete') take();
  else window.addEventListener('load', take, { once: true });
}
