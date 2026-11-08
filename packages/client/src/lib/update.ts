import { APP_VERSION } from '@kladde/shared';
import { registerSW } from 'virtual:pwa-register';

/**
 * Every deploy is applied soon, but not in the middle of the user's work. The service worker alone is not
 * enough: the browser only looks for a new one on a navigation, and an iOS home-screen app often resumes
 * from the background without one, so an old version could stay for days. So whenever the app starts,
 * comes back to the foreground or goes online again it asks the server for its version; if that differs
 * it updates the service worker, and if no new worker shows up soon it drops the service worker and its
 * caches instead.
 *
 * The reload itself waits for a calm moment (see `whenCalm`): the app in the background, right after
 * start, or the user not typing. After it the app skips its entry animations and shows the cached
 * account at once, so the update looks like nothing happened instead of the whole screen blinking.
 * Notes live in IndexedDB, not in these caches, so nothing is lost.
 */
const RESET_KEY = 'kladde_update_reset';
const UPDATED_KEY = 'kladde_updated';
const ATTACHMENT_CACHE = 'kladde-files';
/** Right after start the user has not done anything yet: a reload then is not noticed */
const STARTUP_MS = 2500;

let registration: ServiceWorkerRegistration | undefined;
let applyUpdate: ((reload?: boolean) => Promise<void>) | undefined;
let checking = false;
let pending: (() => void) | null = null;
const startedAt = Date.now();

function markUpdated() {
  try {
    sessionStorage.setItem(UPDATED_KEY, '1');
  } catch {
    // private mode: the app just animates in once
  }
}

/** Typing in the editor or a field: a reload now would take the cursor (and maybe a word) away */
function busy(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

/** Runs `fn` now if that does not disturb the user, otherwise when the app goes to the background or the user stops typing */
function whenCalm(fn: () => void) {
  if (document.visibilityState === 'hidden' || Date.now() - startedAt < STARTUP_MS || !busy()) {
    fn();
    return;
  }
  pending = fn;
}

function runPending() {
  const fn = pending;
  if (fn && (document.visibilityState === 'hidden' || !busy())) {
    pending = null;
    fn();
  }
}

async function serverVersion(): Promise<string | undefined> {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    if (!res.ok) return undefined;
    return ((await res.json()) as { version?: string }).version;
  } catch {
    return undefined; // offline: keep the running version
  }
}

async function hardReset(target: string) {
  // Only once per server version, so a broken deploy cannot loop the app through reloads
  try {
    if (sessionStorage.getItem(RESET_KEY) === target) return;
    sessionStorage.setItem(RESET_KEY, target);
  } catch {
    return;
  }
  const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
  await Promise.all(regs.map((r) => r.unregister()));
  const keys = 'caches' in window ? await caches.keys() : [];
  await Promise.all(keys.filter((k) => k !== ATTACHMENT_CACHE).map((k) => caches.delete(k)));
  markUpdated();
  location.reload();
}

async function check() {
  if (checking) return;
  checking = true;
  try {
    const version = await serverVersion();
    if (!version || version === APP_VERSION) return;
    await registration?.update().catch(() => undefined);
    // A new worker reports itself through onNeedRefresh; if none came after a while, start clean
    setTimeout(() => whenCalm(() => void hardReset(version)), 8000);
  } finally {
    checking = false;
  }
}

export function keepUpToDate() {
  if (!('serviceWorker' in navigator)) return;
  applyUpdate = registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      registration = reg;
      void check();
    },
    // A new version is installed and waiting: take it over (and reload) once that does not disturb
    onNeedRefresh() {
      whenCalm(() => {
        markUpdated();
        void applyUpdate?.(true);
      });
    },
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
    else runPending();
  });
  document.addEventListener('focusout', () => setTimeout(runPending, 300));
  window.addEventListener('online', () => void check());
}

/** True once after a reload for an update: the app then appears without entry animations */
export function justUpdated(): boolean {
  try {
    if (sessionStorage.getItem(UPDATED_KEY) !== '1') return false;
    sessionStorage.removeItem(UPDATED_KEY);
    return true;
  } catch {
    return false;
  }
}
